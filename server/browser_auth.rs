//! Cookies are host scoped, never port scoped. Local HTTP owner sessions must
//! live in origin-bound browser storage, not in a cookie sent to every local app.
use super::*;
use hmac::{Hmac, Mac};

const OWNER_COOKIE: &str = "__Host-locdoc_owner";
const LEGACY_COOKIE: &str = "locdoc_owner";
const SESSION_PROTOCOL: &str = "locdoc-session.";

pub(super) fn migrate(db: &Connection) -> Result<()> {
    let exists = db
        .prepare("PRAGMA table_info(sessions)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<std::result::Result<Vec<_>, _>>()?
        .iter()
        .any(|name| name == "transport");
    if !exists {
        db.execute(
            "ALTER TABLE sessions ADD COLUMN transport TEXT NOT NULL DEFAULT 'cookie'",
            [],
        )?;
    }
    Ok(())
}

pub(super) fn transport(s: &Store, h: &HeaderMap) -> &'static str {
    if cookie_session(s, h) {
        "cookie"
    } else {
        "origin"
    }
}

fn valid_token(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

pub(super) fn cookie_session(s: &Store, h: &HeaderMap) -> bool {
    let host = h
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| url::Url::parse(&format!("http://{v}")).ok());
    let loopback = host.as_ref().is_some_and(|host| match host.host() {
        Some(url::Host::Domain(name)) => name == "localhost",
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    });
    !loopback
        && url::Url::parse(&s.public_url).ok().is_some_and(|public| {
            public.scheme() == "https"
                && host.as_ref().is_some_and(|host| {
                    host.host_str() == public.host_str()
                        && host.port().unwrap_or(443)
                            == public.port_or_known_default().unwrap_or(443)
                })
        })
}

fn session_hash(s: &Store, value: &str, transport: &str) -> Option<String> {
    if !valid_token(value) {
        return None;
    }
    let digest = hash(value);
    s.db.lock()
        .unwrap()
        .query_row(
            "SELECT 1 FROM sessions WHERE hash=? AND expires>? AND transport=?",
            params![digest, now(), transport],
            |r| r.get::<_, i64>(0),
        )
        .ok()
        .map(|_| digest)
}

pub(super) fn websocket_protocol(h: &HeaderMap) -> Option<String> {
    h.get(header::SEC_WEBSOCKET_PROTOCOL)?
        .to_str()
        .ok()?
        .split(',')
        .map(str::trim)
        .find(|value| {
            value
                .strip_prefix(SESSION_PROTOCOL)
                .is_some_and(valid_token)
        })
        .map(str::to_owned)
}

pub(super) fn session(s: &Store, h: &HeaderMap) -> Option<String> {
    let bearer = h
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    if let Some(value) = bearer
        && let Some(digest) = session_hash(s, value, "origin")
    {
        return Some(digest);
    }
    if let Some(protocol) = websocket_protocol(h)
        && let Some(value) = protocol.strip_prefix(SESSION_PROTOCOL)
        && let Some(digest) = session_hash(s, value, "origin")
    {
        return Some(digest);
    }
    if !cookie_session(s, h) {
        return None;
    }
    // Valid legacy public cookies migrate on the first config response. Check
    // every occurrence so a narrower-path junk cookie cannot shadow a valid one.
    for name in [OWNER_COOKIE, LEGACY_COOKIE] {
        for value in h
            .get_all(header::COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|v| v.split(';'))
            .filter_map(|v| v.trim().split_once('='))
            .filter_map(|(key, value)| (key == name).then_some(value))
        {
            if let Some(digest) = session_hash(s, value, "cookie") {
                return Some(digest);
            }
        }
    }
    None
}

fn set_cookie(response: &mut Response, value: String) {
    response
        .headers_mut()
        .append(header::SET_COOKIE, value.parse().unwrap());
}

pub(super) fn login_response(s: &Store, h: &HeaderMap, token: &str) -> Response {
    if !cookie_session(s, h) {
        return Json(json!({"ok":true,"session":token})).into_response();
    }
    let mut response = Json(json!({"ok":true})).into_response();
    set_cookie(
        &mut response,
        format!(
            "{OWNER_COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000; Secure"
        ),
    );
    clear_legacy(&mut response);
    response
}

fn clear_legacy(response: &mut Response) {
    set_cookie(
        response,
        format!("{LEGACY_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure"),
    );
}

pub(super) fn migrate_cookie(s: &Store, h: &HeaderMap, response: &mut Response) {
    if !cookie_session(s, h) {
        return;
    }
    for value in h
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|v| v.trim().split_once('='))
        .filter_map(|(key, value)| (key == LEGACY_COOKIE).then_some(value))
    {
        if session_hash(s, value, "cookie").is_none() {
            continue;
        }
        let migrated: Result<Option<String>> = (|| {
            let mut db = s.db.lock().unwrap();
            let tx = db.transaction()?;
            let changed = tx.execute(
                "DELETE FROM sessions WHERE hash=? AND expires>? AND transport='cookie'",
                params![hash(value), now()],
            )?;
            if changed != 1 {
                return Ok(None);
            }
            let replacement = token();
            tx.execute(
                "INSERT INTO sessions(hash,expires,transport) VALUES(?,?,'cookie')",
                params![hash(&replacement), now() + 365 * 86400],
            )?;
            tx.commit()?;
            Ok(Some(replacement))
        })();
        match migrated {
            Ok(Some(value)) => set_cookie(
                response,
                format!(
                    "{OWNER_COOKIE}={value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000; Secure"
                ),
            ),
            Ok(None) => {}
            Err(error) => {
                tracing::warn!("owner cookie migration delayed: {error}");
                return;
            }
        }
        clear_legacy(response);
        break;
    }
}

pub(super) fn logout_response() -> Response {
    let mut response = Json(json!({"ok":true})).into_response();
    set_cookie(
        &mut response,
        format!("{OWNER_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure"),
    );
    clear_legacy(&mut response);
    response
}

fn media_signature(s: &Store, doc: &str, session: &str, expires: i64) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(s.key.as_bytes()).unwrap();
    mac.update(b"Locdoc media v1\0");
    mac.update(doc.as_bytes());
    mac.update(b"\0");
    mac.update(session.as_bytes());
    mac.update(b"\0");
    mac.update(&expires.to_be_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// A media-only capability is needed for local img/video requests, which cannot
/// attach the origin-bound Authorization header. It never grants document access
/// or editing, is bound to one document, and dies with its owner session.
pub(super) fn media_token(s: &Store, h: &HeaderMap, doc: &str) -> Option<String> {
    if cookie_session(s, h) {
        return None;
    }
    let session = session(s, h)?;
    let expires: i64 =
        s.db.lock()
            .unwrap()
            .query_row(
                "SELECT expires FROM sessions WHERE hash=? AND expires>? AND transport='origin'",
                params![session, now()],
                |row| row.get(0),
            )
            .ok()?;
    Some(format!(
        "m1.{session}.{expires}.{}",
        media_signature(s, doc, &session, expires)
    ))
}

pub(super) fn media_allowed(s: &Store, doc: &str, token: &str) -> bool {
    let Some((session, rest)) = token.strip_prefix("m1.").and_then(|v| v.split_once('.')) else {
        return false;
    };
    let Some((expires, signature)) = rest.split_once('.') else {
        return false;
    };
    let Ok(expires) = expires.parse::<i64>() else {
        return false;
    };
    if !valid_token(session)
        || !valid_token(signature)
        || expires <= now()
        || !secure_eq(signature, &media_signature(s, doc, session, expires))
    {
        return false;
    }
    s.db.lock()
        .unwrap()
        .query_row(
            "SELECT 1 FROM sessions WHERE hash=? AND expires>? AND transport='origin'",
            params![session, now()],
            |r| r.get::<_, i64>(0),
        )
        .is_ok()
}

/// Stable author identities and request-deduplication records are storage
/// details. Visitors only need to know whether this request may resolve a thread.
pub(super) fn comment_value(mut value: Value, editor: bool, guest: Option<&str>) -> Value {
    let own = guest.is_some_and(|guest| !guest.is_empty() && value["guest"] == guest);
    if let Some(object) = value.as_object_mut() {
        object.remove("guest");
        object.remove("requestId");
        object.remove("replyRequests");
        object.insert("canResolve".into(), json!(editor || own));
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_capability_expiry_signature_and_transport_are_enforced() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(
            dir.path().join("docs"),
            dir.path().join("state"),
            "https://notes.example.test".into(),
        )
        .unwrap();
        let credential = token();
        let session = hash(&credential);
        let session_expires = now() + 86400;
        s.db.lock()
            .unwrap()
            .execute(
                "INSERT INTO sessions(hash,expires,transport) VALUES(?,?,'origin')",
                params![session, session_expires],
            )
            .unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, "127.0.0.1:3477".parse().unwrap());
        headers.insert(
            header::AUTHORIZATION,
            format!("Bearer {credential}").parse().unwrap(),
        );
        let issued = media_token(&s, &headers, "doc").unwrap();
        assert_eq!(
            issued.split('.').nth(2).unwrap().parse::<i64>().unwrap(),
            session_expires
        );
        let expires = now() + 60;
        let valid = format!(
            "m1.{session}.{expires}.{}",
            media_signature(&s, "doc", &session, expires)
        );
        assert!(media_allowed(&s, "doc", &valid));
        assert!(!media_allowed(&s, "other-doc", &valid));
        assert!(!media_allowed(&s, "doc", &format!("{valid}0")));
        let expired = now() - 1;
        let expired_token = format!(
            "m1.{session}.{expired}.{}",
            media_signature(&s, "doc", &session, expired)
        );
        assert!(!media_allowed(&s, "doc", &expired_token));
        s.db.lock()
            .unwrap()
            .execute("UPDATE sessions SET transport='cookie'", [])
            .unwrap();
        assert!(!media_allowed(&s, "doc", &valid));
    }

    #[test]
    fn public_cookie_migration_only_uses_the_configured_secure_authority() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(
            dir.path().join("docs"),
            dir.path().join("state"),
            "https://notes.example.test".into(),
        )
        .unwrap();
        for (host, expected) in [
            ("notes.example.test", true),
            ("notes.example.test:443", true),
            ("notes.example.test:444", false),
            ("localhost:3477", false),
            ("127.0.0.1:3477", false),
            ("[::1]:3477", false),
            ("other.example.test", false),
        ] {
            let mut h = HeaderMap::new();
            h.insert(header::HOST, host.parse().unwrap());
            assert_eq!(cookie_session(&s, &h), expected, "{host}");
        }
    }
}
