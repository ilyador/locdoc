//! Cookies are host scoped, never port scoped. Local HTTP owner sessions must
//! live in origin-bound browser storage, not in a cookie sent to every local app.
use super::*;
use hmac::{Hmac, Mac};
use std::sync::RwLock;

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

#[derive(Clone)]
struct Session {
    expires: i64,
    transport: &'static str,
}

/// Authentication is an admission decision, so it must never wait for a
/// document's storage worker or query SQLite for an unknown credential. SQLite
/// remains the durable source at startup; successful mutations publish here
/// only after their transaction commits.
#[derive(Default)]
pub(super) struct Sessions(RwLock<HashMap<String, Session>>);
impl Sessions {
    pub(super) fn load(db: &Connection) -> Result<Self> {
        let entries = db
            .prepare("SELECT hash,expires,transport FROM sessions WHERE expires>?")?
            .query_map([now()], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?
            .into_iter()
            .filter_map(|(digest, expires, transport)| {
                let transport = match transport.as_str() {
                    "cookie" => "cookie",
                    "origin" => "origin",
                    _ => return None,
                };
                valid_token(&digest).then_some((digest, Session { expires, transport }))
            })
            .collect();
        Ok(Self(RwLock::new(entries)))
    }

    fn expires(&self, digest: &str, transport: &str) -> Option<i64> {
        self.0
            .read()
            .unwrap()
            .get(digest)
            .filter(|session| session.expires > now() && session.transport == transport)
            .map(|session| session.expires)
    }

    fn insert(&self, digest: String, session: Session) {
        let mut sessions = self.0.write().unwrap();
        let time = now();
        sessions.retain(|_, session| session.expires > time);
        sessions.insert(digest, session);
    }
}

fn new_session(transport: &'static str) -> (String, Session) {
    (
        token(),
        Session {
            expires: now() + 365 * 86400,
            transport,
        },
    )
}

fn insert_session(db: &Connection, token: &str, session: &Session) -> Result<()> {
    db.execute(
        "INSERT INTO sessions(hash,expires,transport) VALUES(?,?,?)",
        params![hash(token), session.expires, session.transport],
    )?;
    Ok(())
}

pub(super) fn issue(s: &Store, transport: &'static str) -> Result<String> {
    let (token, session) = new_session(transport);
    insert_session(&s.db.lock().unwrap(), &token, &session)?;
    s.sessions.insert(hash(&token), session);
    Ok(token)
}

pub(super) fn redeem(s: &Store, ticket: &str, transport: &'static str) -> Result<String> {
    let (token, session) = new_session(transport);
    let mut db = s.db.lock().unwrap();
    let tx = db.transaction()?;
    let valid = tx.execute(
        "DELETE FROM tickets WHERE hash=? AND expires>?",
        params![hash(ticket), now()],
    )?;
    if valid != 1 {
        return Err(denied());
    }
    insert_session(&tx, &token, &session)?;
    tx.commit()?;
    drop(db);
    s.sessions.insert(hash(&token), session);
    Ok(token)
}

pub(super) fn revoke(s: &Store, digest: &str) -> Result<()> {
    s.db.lock()
        .unwrap()
        .execute("DELETE FROM sessions WHERE hash=?", [digest])?;
    s.sessions.0.write().unwrap().remove(digest);
    s.permissions.invalidate();
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
    s.sessions.expires(&digest, transport).map(|_| digest)
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
        let old_digest = hash(value);
        let migrated: Result<Option<String>> = (|| {
            let (replacement, session) = new_session("cookie");
            let mut db = s.db.lock().unwrap();
            let tx = db.transaction()?;
            let changed = tx.execute(
                "DELETE FROM sessions WHERE hash=? AND expires>? AND transport='cookie'",
                params![old_digest, now()],
            )?;
            if changed != 1 {
                return Ok(None);
            }
            insert_session(&tx, &replacement, &session)?;
            tx.commit()?;
            drop(db);
            let mut sessions = s.sessions.0.write().unwrap();
            sessions.remove(&old_digest);
            sessions.insert(hash(&replacement), session);
            s.permissions.invalidate();
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
    let expires = s.sessions.expires(&session, "origin")?;
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
    s.sessions.expires(session, "origin").is_some()
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

    #[tokio::test]
    async fn exhausted_anonymous_requests_do_not_wait_for_storage_workers() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(
            dir.path().join("docs"),
            dir.path().join("state"),
            "https://notes.example.test".into(),
        )
        .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        s.rates
            .lock()
            .unwrap()
            .insert("127.0.0.1:api".into(), (now(), 600));
        let permits = s.work.clone().acquire_many_owned(4).await.unwrap();
        let app = router(s);
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
            .unwrap();
        });
        let result = reqwest::Client::new()
            .get(format!("http://{address}/api/config"))
            .bearer_auth("0".repeat(64))
            .timeout(std::time::Duration::from_millis(500))
            .send()
            .await;
        server.abort();
        drop(permits);
        assert!(
            result.is_ok(),
            "Rate limiting must not wait for storage admission"
        );
        assert_eq!(result.unwrap().status(), StatusCode::TOO_MANY_REQUESTS);
    }

    #[test]
    fn owner_sessions_survive_restart_and_revoke_both_transports() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("docs");
        let data = dir.path().join("state");
        let s = Store::open(
            root.clone(),
            data.clone(),
            "https://notes.example.test".into(),
        )
        .unwrap();
        let origin = issue(&s, "origin").unwrap();
        let public = issue(&s, "cookie").unwrap();
        let expired = token();
        insert_session(
            &s.db.lock().unwrap(),
            &expired,
            &Session {
                expires: now() - 1,
                transport: "origin",
            },
        )
        .unwrap();
        drop(s);
        let s = Store::open(root, data, "https://notes.example.test".into()).unwrap();
        assert_eq!(session_hash(&s, &origin, "origin"), Some(hash(&origin)));
        assert_eq!(session_hash(&s, &public, "cookie"), Some(hash(&public)));
        assert!(session_hash(&s, &origin, "cookie").is_none());
        assert!(session_hash(&s, &public, "origin").is_none());
        assert!(session_hash(&s, &expired, "origin").is_none());
        let generation = s.permissions.current();
        revoke(&s, &hash(&origin)).unwrap();
        revoke(&s, &hash(&public)).unwrap();
        assert!(s.permissions.current() > generation);
        assert!(session_hash(&s, &origin, "origin").is_none());
        assert!(session_hash(&s, &public, "cookie").is_none());
        assert_eq!(
            s.db.lock()
                .unwrap()
                .query_row(
                    "SELECT count(*) FROM sessions WHERE hash IN (?,?)",
                    params![hash(&origin), hash(&public)],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0,
        );
    }

    #[test]
    fn failed_session_mutations_do_not_publish_or_drop_owner_access() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(
            dir.path().join("docs"),
            dir.path().join("state"),
            "https://notes.example.test".into(),
        )
        .unwrap();
        let credential = issue(&s, "origin").unwrap();
        let generation = s.permissions.current();
        s.db.lock()
            .unwrap()
            .execute_batch("PRAGMA query_only=ON")
            .unwrap();
        assert!(issue(&s, "origin").is_err());
        assert!(revoke(&s, &hash(&credential)).is_err());
        assert_eq!(s.sessions.0.read().unwrap().len(), 1);
        assert_eq!(
            session_hash(&s, &credential, "origin"),
            Some(hash(&credential))
        );
        assert_eq!(s.permissions.current(), generation);
        s.db.lock()
            .unwrap()
            .execute_batch("PRAGMA query_only=OFF")
            .unwrap();
        revoke(&s, &hash(&credential)).unwrap();
        assert!(session_hash(&s, &credential, "origin").is_none());
    }

    #[test]
    fn ticket_redemption_is_atomic_with_durable_session_creation() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(
            dir.path().join("docs"),
            dir.path().join("state"),
            "https://notes.example.test".into(),
        )
        .unwrap();
        let ticket = token();
        s.db.lock()
            .unwrap()
            .execute(
                "INSERT INTO tickets(hash,expires) VALUES(?,?)",
                params![hash(&ticket), now() + 60],
            )
            .unwrap();
        s.db.lock().unwrap().execute_batch(
            "CREATE TRIGGER fail_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT,'unavailable'); END"
        ).unwrap();
        assert!(redeem(&s, &ticket, "origin").is_err());
        assert!(s.sessions.0.read().unwrap().is_empty());
        assert_eq!(
            s.db.lock()
                .unwrap()
                .query_row(
                    "SELECT count(*) FROM tickets WHERE hash=?",
                    [hash(&ticket)],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
        s.db.lock()
            .unwrap()
            .execute_batch("DROP TRIGGER fail_session")
            .unwrap();
        let credential = redeem(&s, &ticket, "origin").unwrap();
        assert_eq!(
            session_hash(&s, &credential, "origin"),
            Some(hash(&credential))
        );
        assert!(redeem(&s, &ticket, "origin").is_err());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn owner_and_unknown_credentials_do_not_wait_for_sqlite() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(
            dir.path().join("docs"),
            dir.path().join("state"),
            "https://notes.example.test".into(),
        )
        .unwrap();
        let credential = issue(&s, "origin").unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = router(s.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let (locked, waiting) = tokio::sync::oneshot::channel();
        let (release, released) = std::sync::mpsc::channel();
        let database = s.clone();
        let blocker = std::thread::spawn(move || {
            let _db = database.db.lock().unwrap();
            locked.send(()).unwrap();
            released.recv().unwrap();
        });
        waiting.await.unwrap();
        let client = reqwest::Client::new();
        let mut results = Vec::new();
        for credential in [credential, "0".repeat(64)] {
            results.push(
                client
                    .get(format!("http://{address}/api/config"))
                    .bearer_auth(credential)
                    .timeout(std::time::Duration::from_millis(500))
                    .send()
                    .await,
            );
        }
        release.send(()).unwrap();
        blocker.join().unwrap();
        server.abort();
        for (result, owner) in results.into_iter().zip([true, false]) {
            assert!(result.is_ok(), "Credential admission must not read SQLite");
            let response = result.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let body: Value = serde_json::from_str(&response.text().await.unwrap()).unwrap();
            assert_eq!(body["owner"], owner);
        }
    }

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
        let issued_session = Session {
            expires: session_expires,
            transport: "origin",
        };
        insert_session(&s.db.lock().unwrap(), &credential, &issued_session).unwrap();
        s.sessions.insert(session.clone(), issued_session);
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
        s.sessions.insert(
            session,
            Session {
                expires: session_expires,
                transport: "cookie",
            },
        );
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
