//! MCP uses its own revocable OAuth grants. Browser sessions, share URLs and
//! the local setup key are deliberately not connector credentials.
//!
//! Registration and authorization are unauthenticated, so they write nothing.
//! Client IDs and pending requests are signed, self-contained handles; owner
//! consent is the first write and persists the client together with its code.
use super::*;
use axum::{extract::Form, response::Redirect};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use serde::de::DeserializeOwned;
use std::sync::RwLock;

const SCOPES: [&str; 3] = ["locdoc:read", "locdoc:write", "locdoc:share"];
const ACCESS_SECONDS: i64 = 3600;
const REFRESH_SECONDS: i64 = 30 * 86400;
const REQUEST_SECONDS: i64 = 600;
const CODE_SECONDS: i64 = 120;
const CLIENT_SECONDS: i64 = 3600;
const MAX_CODES: i64 = 256;
const MAX_CONNECTIONS: i64 = 64;
const MAX_REDIRECT_BYTES: usize = 4096;
// A token request carrying this ID and its longest redirect fits in 16 KiB.
const MAX_CLIENT_ID: usize = 8 * 1024;
const MAX_SIGNED: usize = 64 * 1024;
const SIGNED_VERSION: u8 = 1;

pub(super) fn migrate(db: &Connection) -> Result<()> {
    // Stored pending requests predate signed handles; their clients retry.
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS mcp_clients(
            id TEXT PRIMARY KEY,name TEXT NOT NULL,redirects TEXT NOT NULL,
            created INTEGER NOT NULL,expires INTEGER NOT NULL);
        DROP TABLE IF EXISTS mcp_requests;
        CREATE TABLE IF NOT EXISTS mcp_used_requests(
            hash TEXT PRIMARY KEY,expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS mcp_codes(
            hash TEXT PRIMARY KEY,client TEXT NOT NULL REFERENCES mcp_clients(id) ON DELETE CASCADE,
            redirect TEXT NOT NULL,scope TEXT NOT NULL,challenge TEXT NOT NULL,
            resource TEXT NOT NULL,expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS mcp_connections(
            id TEXT PRIMARY KEY,client TEXT NOT NULL REFERENCES mcp_clients(id) ON DELETE CASCADE,
            scope TEXT NOT NULL,access_hash TEXT NOT NULL UNIQUE,
            access_expires INTEGER NOT NULL,refresh_hash TEXT NOT NULL UNIQUE,
            expires INTEGER NOT NULL,created INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS mcp_used_refresh(
            hash TEXT PRIMARY KEY,connection TEXT NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
            expires INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS mcp_refresh_connection ON mcp_used_refresh(connection);",
    )?;
    Ok(())
}

#[derive(Clone, Debug)]
pub(super) struct Grant {
    pub id: String,
    pub scopes: HashSet<String>,
}
impl Grant {
    pub(super) fn require(&self, scope: &str) -> Result<()> {
        if self.scopes.contains(scope) {
            Ok(())
        } else {
            Err(ApiError(
                StatusCode::FORBIDDEN,
                format!("This connection needs the {scope} permission."),
            ))
        }
    }
    /// Re-check after a queued command receives its document admission slot.
    /// A connection revoked or narrowed while waiting must not perform writes.
    pub(super) fn require_current(&self, s: &Store, scope: &str) -> Result<()> {
        let values = s.mcp_credentials.0.read().unwrap();
        let current = values
            .values()
            .find(|entry| entry.grant.id == self.id && entry.expires > now());
        current
            .ok_or_else(|| {
                ApiError(
                    StatusCode::UNAUTHORIZED,
                    "This MCP connection was revoked or expired.".into(),
                )
            })?
            .grant
            .require(scope)
    }
}
#[derive(Clone)]
struct Credential {
    grant: Grant,
    expires: i64,
}

/// Admission never queries SQLite. Unknown bearer tokens cannot occupy a
/// storage worker, and revocation publishes only after its durable commit.
#[derive(Default)]
pub(super) struct Credentials(RwLock<HashMap<String, Credential>>);
impl Credentials {
    pub(super) fn load(db: &Connection) -> Result<Self> {
        let mut values = HashMap::new();
        let mut query = db.prepare(
            "SELECT id,scope,access_hash,access_expires FROM mcp_connections
             WHERE access_expires>? AND expires>? LIMIT 64",
        )?;
        for entry in query.query_map(params![now(), now()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })? {
            let (id, scope, digest, expires) = entry?;
            if let Ok(scopes) = scopes(&scope) {
                values.insert(
                    digest,
                    Credential {
                        grant: Grant { id, scopes },
                        expires,
                    },
                );
            }
        }
        Ok(Self(RwLock::new(values)))
    }
    fn publish(&self, connection: &str, replacement: Option<(String, Credential)>) {
        let time = now();
        let mut values = self.0.write().unwrap();
        values.retain(|_, value| value.grant.id != connection && value.expires > time);
        if let Some((digest, credential)) = replacement {
            values.insert(digest, credential);
        }
    }
}

pub(super) fn authorize(s: &Store, headers: &HeaderMap) -> Result<Grant> {
    let invalid = || {
        ApiError(
            StatusCode::UNAUTHORIZED,
            "Connect Locdoc to authorize MCP access.".into(),
        )
    };
    let mut values = headers.get_all(header::AUTHORIZATION).iter();
    let value = values.next().ok_or_else(invalid)?;
    if values.next().is_some() {
        return Err(invalid());
    }
    let (scheme, value) = value
        .to_str()
        .ok()
        .and_then(|v| v.split_once(' '))
        .ok_or_else(invalid)?;
    if !scheme.eq_ignore_ascii_case("bearer") || !credential(value, "mcp_a_") {
        return Err(invalid());
    }
    s.mcp_credentials
        .0
        .read()
        .unwrap()
        .get(&hash(value))
        .filter(|entry| entry.expires > now())
        .map(|entry| entry.grant.clone())
        .ok_or_else(invalid)
}

fn credential(value: &str, prefix: &str) -> bool {
    value.strip_prefix(prefix).is_some_and(|value| {
        value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}
fn opaque(prefix: &str) -> String {
    format!("{prefix}{}", token())
}
/// Legacy registrations used opaque hex IDs, which are also base64url text.
fn client_id(value: &str) -> bool {
    value.len() <= MAX_CLIENT_ID
        && value.strip_prefix("mcp_c_").is_some_and(|value| {
            !value.is_empty()
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
        })
}

/// Signed handles are self-contained until the owner approves a request.
#[derive(Serialize, Deserialize)]
struct SignedClient {
    v: u8,
    redirect_uris: Vec<String>,
    name: String,
    iat: i64,
}
#[derive(Serialize, Deserialize)]
struct SignedRequest {
    v: u8,
    client_id: String,
    client_name: String,
    redirect: String,
    scope: String,
    challenge: String,
    state: String,
    resource: String,
    exp: i64,
}
/// The owner key is never used directly as this MAC key.
fn signer(s: &Store) -> Hmac<Sha256> {
    let mut derived = Hmac::<Sha256>::new_from_slice(s.key.as_bytes()).unwrap();
    derived.update(b"locdoc mcp oauth v1");
    Hmac::<Sha256>::new_from_slice(&derived.finalize().into_bytes()).unwrap()
}
/// The MAC covers the prefix, so a client ID never verifies as a request.
fn sign<T: Serialize>(s: &Store, prefix: &str, claims: &T) -> String {
    let body = format!(
        "{prefix}{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).unwrap())
    );
    let mut mac = signer(s);
    mac.update(body.as_bytes());
    format!(
        "{body}.{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    )
}
fn verify<T: DeserializeOwned>(s: &Store, prefix: &str, value: &str) -> Option<T> {
    if value.len() > MAX_SIGNED {
        return None;
    }
    let (body, signature) = value.split_once('.')?;
    let payload = body.strip_prefix(prefix)?;
    let mut mac = signer(s);
    mac.update(body.as_bytes());
    // verify_slice compares in constant time.
    mac.verify_slice(&URL_SAFE_NO_PAD.decode(signature).ok()?)
        .ok()?;
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()
}
fn signed_client(s: &Store, id: &str) -> Option<SignedClient> {
    verify(s, "mcp_c_", id).filter(|client: &SignedClient| client.v == SIGNED_VERSION)
}
fn signed_request(s: &Store, value: &str) -> Option<SignedRequest> {
    verify(s, "mcp_q_", value)
        .filter(|request: &SignedRequest| request.v == SIGNED_VERSION && request.exp > now())
}
/// A signed registration authorizes for CLIENT_SECONDS without storage. Rows
/// persisted by consent, including legacy registrations, keep authorizing
/// while cleanup would retain them: unexpired, or used by a live code or grant.
fn registered(s: &Store, id: &str) -> OAuthResult<Option<(String, Vec<String>)>> {
    const READ_CLIENT: &str = "SELECT name,redirects FROM mcp_clients c WHERE id=?1 AND (
        expires>?2 OR EXISTS(SELECT 1 FROM mcp_codes k WHERE k.client=c.id AND k.expires>?2)
        OR EXISTS(SELECT 1 FROM mcp_connections g WHERE g.client=c.id AND g.expires>?2))";
    if let Some(client) = signed_client(s, id).filter(|client| now() < client.iat + CLIENT_SECONDS)
    {
        return Ok(Some((client.name, client.redirect_uris)));
    }
    let row: Option<(String, String)> =
        s.db.lock()
            .unwrap()
            .query_row(READ_CLIENT, params![id, now()], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .optional()?;
    Ok(row.and_then(|(name, redirects)| Some((name, serde_json::from_str(&redirects).ok()?))))
}
/// Owner decisions are single use. A handle is recorded only by authenticated
/// consent, and only until the handle itself expires.
fn undecided(s: &Store, db: &Connection, value: &str) -> rusqlite::Result<Option<SignedRequest>> {
    let Some(request) = signed_request(s, value) else {
        return Ok(None);
    };
    let used: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM mcp_used_requests WHERE hash=?)",
        [hash(value)],
        |row| row.get(0),
    )?;
    Ok((!used).then_some(request))
}
fn scopes(value: &str) -> OAuthResult<HashSet<String>> {
    let values: HashSet<String> = value.split_ascii_whitespace().map(str::to_owned).collect();
    if values.is_empty() || values.iter().any(|scope| !SCOPES.contains(&scope.as_str())) {
        return Err(oauth(
            "invalid_scope",
            "Choose Locdoc read, write or sharing permissions.",
        ));
    }
    Ok(values)
}
fn scope_string(values: &HashSet<String>) -> String {
    SCOPES
        .into_iter()
        .filter(|scope| values.contains(*scope))
        .collect::<Vec<_>>()
        .join(" ")
}
fn resource(s: &Store) -> String {
    format!("{}/mcp", s.public_url)
}
fn loopback(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(name)) => name == "localhost",
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}
fn redirect(value: &str) -> OAuthResult<url::Url> {
    let parsed =
        url::Url::parse(value).map_err(|_| oauth("invalid_request", "Invalid redirect URI."))?;
    if value.len() > 2048
        || parsed.host().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
        || !(parsed.scheme() == "https" || parsed.scheme() == "http" && loopback(&parsed))
        || parsed
            .query_pairs()
            .any(|(key, _)| matches!(key.as_ref(), "code" | "state" | "error"))
    {
        return Err(oauth(
            "invalid_request",
            "Use an HTTPS redirect URI, or HTTP loopback for local development.",
        ));
    }
    Ok(parsed)
}
fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}
fn valid_verifier(value: &str) -> bool {
    (43..=128).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b))
}
fn valid_challenge(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
}

#[derive(Debug)]
pub(super) struct OAuthError {
    code: &'static str,
    description: String,
    status: StatusCode,
}
type OAuthResult<T> = std::result::Result<T, OAuthError>;
fn oauth(code: &'static str, description: &str) -> OAuthError {
    OAuthError {
        code,
        description: description.into(),
        status: StatusCode::BAD_REQUEST,
    }
}
impl From<ApiError> for OAuthError {
    fn from(error: ApiError) -> Self {
        Self {
            code: "server_error",
            description: error.1,
            status: error.0,
        }
    }
}
impl From<rusqlite::Error> for OAuthError {
    fn from(error: rusqlite::Error) -> Self {
        ApiError::from(error).into()
    }
}
impl IntoResponse for OAuthError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({"error":self.code,"error_description":self.description})),
        )
            .into_response()
    }
}
async fn storage<T: Send + 'static>(
    s: App,
    f: impl FnOnce(&Store) -> OAuthResult<T> + Send + 'static,
) -> OAuthResult<T> {
    job(s, move |s| Ok(f(s))).await?
}
fn cleanup(db: &Connection) -> OAuthResult<()> {
    let time = now();
    db.execute("DELETE FROM mcp_used_requests WHERE expires<=?", [time])?;
    db.execute("DELETE FROM mcp_codes WHERE expires<=?", [time])?;
    db.execute("DELETE FROM mcp_used_refresh WHERE expires<=?", [time])?;
    db.execute("DELETE FROM mcp_connections WHERE expires<=?", [time])?;
    db.execute(
        "DELETE FROM mcp_clients WHERE expires<=?
         AND id NOT IN (SELECT client FROM mcp_connections)
         AND id NOT IN (SELECT client FROM mcp_codes)",
        [time],
    )?;
    Ok(())
}
fn count(db: &Connection, table: &'static str, maximum: i64) -> OAuthResult<()> {
    // Table names are compile-time module constants, never request input.
    let count: i64 = db.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
        row.get(0)
    })?;
    if count >= maximum {
        let mut error = oauth(
            "temporarily_unavailable",
            "Too many pending connections. Try again later or revoke an unused connection.",
        );
        error.status = StatusCode::TOO_MANY_REQUESTS;
        return Err(error);
    }
    Ok(())
}

pub(super) async fn resource_metadata(State(s): State<App>) -> Json<Value> {
    Json(json!({
        "resource":resource(&s), "authorization_servers":[s.public_url],
        "scopes_supported":SCOPES, "bearer_methods_supported":["header"],
        "resource_name":"Locdoc"
    }))
}
pub(super) async fn authorization_metadata(State(s): State<App>) -> Json<Value> {
    Json(json!({
        "issuer":s.public_url,
        "authorization_endpoint":format!("{}/oauth/authorize",s.public_url),
        "token_endpoint":format!("{}/oauth/token",s.public_url),
        "registration_endpoint":format!("{}/oauth/register",s.public_url),
        "revocation_endpoint":format!("{}/oauth/revoke",s.public_url),
        "scopes_supported":SCOPES, "response_types_supported":["code"],
        "grant_types_supported":["authorization_code","refresh_token"],
        "token_endpoint_auth_methods_supported":["none"],
        "code_challenge_methods_supported":["S256"]
    }))
}

#[derive(Clone, Deserialize)]
pub(super) struct Registration {
    redirect_uris: Vec<String>,
    client_name: Option<String>,
    token_endpoint_auth_method: Option<String>,
    grant_types: Option<Vec<String>>,
    response_types: Option<Vec<String>>,
}
fn register_client(s: &Store, request: Registration) -> OAuthResult<Value> {
    let oversized = || {
        oauth(
            "invalid_client_metadata",
            "Use fewer or shorter redirect URIs.",
        )
    };
    if request.redirect_uris.is_empty()
        || request.redirect_uris.len() > 8
        || request
            .token_endpoint_auth_method
            .as_deref()
            .is_some_and(|v| v != "none")
        || request.grant_types.as_ref().is_some_and(|types| {
            types.is_empty()
                || types
                    .iter()
                    .any(|v| !["authorization_code", "refresh_token"].contains(&v.as_str()))
        })
        || request
            .response_types
            .as_ref()
            .is_some_and(|types| types.len() != 1 || types[0] != "code")
    {
        return Err(oauth(
            "invalid_client_metadata",
            "Use a public authorization-code client with PKCE.",
        ));
    }
    if request.redirect_uris.iter().map(String::len).sum::<usize>() > MAX_REDIRECT_BYTES {
        return Err(oversized());
    }
    for value in &request.redirect_uris {
        redirect(value)?;
    }
    let name = request.client_name.unwrap_or_else(|| "MCP client".into());
    if name.trim().is_empty() || name.len() > 120 || name.chars().any(char::is_control) {
        return Err(oauth("invalid_client_metadata", "Use a short client name."));
    }
    let client = SignedClient {
        v: SIGNED_VERSION,
        redirect_uris: request.redirect_uris,
        name: name.trim().into(),
        iat: now(),
    };
    let id = sign(s, "mcp_c_", &client);
    // JSON escaping can still enlarge the ID past what token requests accept.
    if id.len() > MAX_CLIENT_ID {
        return Err(oversized());
    }
    Ok(
        json!({"client_id":id,"client_name":client.name,"redirect_uris":client.redirect_uris,
        "client_id_issued_at":client.iat,"token_endpoint_auth_method":"none",
        "grant_types":["authorization_code","refresh_token"],"response_types":["code"]}),
    )
}
/// Registration stores nothing, so it never waits for a storage worker.
pub(super) async fn register(
    State(s): State<App>,
    Json(request): Json<Registration>,
) -> OAuthResult<Response> {
    let client = register_client(&s, request)?;
    Ok((StatusCode::CREATED, Json(client)).into_response())
}

#[derive(Clone, Deserialize)]
pub(super) struct Authorization {
    response_type: String,
    client_id: String,
    redirect_uri: String,
    scope: Option<String>,
    state: Option<String>,
    code_challenge: String,
    code_challenge_method: String,
    resource: String,
}
fn begin(s: &Store, request: Authorization) -> OAuthResult<String> {
    if request.response_type != "code"
        || request.code_challenge_method != "S256"
        || !valid_challenge(&request.code_challenge)
        || request.resource != resource(s)
    {
        return Err(oauth(
            "invalid_request",
            "Use an authorization code, S256 PKCE and the Locdoc MCP resource.",
        ));
    }
    let state = request.state.unwrap_or_default();
    if state.len() > 2048 || state.chars().any(char::is_control) || !client_id(&request.client_id) {
        return Err(oauth("invalid_request", "Invalid authorization request."));
    }
    let scope = scope_string(&scopes(request.scope.as_deref().unwrap_or("locdoc:read"))?);
    redirect(&request.redirect_uri)?;
    let (client_name, _) = registered(s, &request.client_id)?
        .filter(|(_, redirects)| redirects.contains(&request.redirect_uri))
        .ok_or_else(|| {
            oauth(
                "invalid_request",
                "The client or redirect URI is not registered.",
            )
        })?;
    // The handle carries everything consent needs; nothing is stored yet.
    let pending = sign(
        s,
        "mcp_q_",
        &SignedRequest {
            v: SIGNED_VERSION,
            client_id: request.client_id,
            client_name,
            redirect: request.redirect_uri,
            scope,
            challenge: request.code_challenge,
            state,
            resource: request.resource,
            exp: now() + REQUEST_SECONDS,
        },
    );
    Ok(format!("{}/?mcp_authorize={pending}", s.public_url))
}
pub(super) async fn begin_authorization(
    State(s): State<App>,
    Query(request): Query<Authorization>,
) -> OAuthResult<Redirect> {
    let url = storage(s, move |s| begin(s, request)).await?;
    Ok(Redirect::to(&url))
}

#[derive(Deserialize)]
pub(super) struct ConsentQuery {
    request: String,
}
pub(super) async fn consent_preview(
    State(s): State<App>,
    _owner: security::Owner,
    Query(query): Query<ConsentQuery>,
) -> Result<Json<Value>> {
    job(s, move |s| {
        let request = undecided(s, &s.db.lock().unwrap(), &query.request)?
            .ok_or_else(|| bad("This connection request has expired."))?;
        Ok(Json(json!({
            "clientName":request.client_name, "redirectUri":request.redirect,
            "scopes":request.scope.split_ascii_whitespace().collect::<Vec<_>>()
        })))
    })
    .await
}
#[derive(Deserialize)]
pub(super) struct Consent {
    request: String,
    allow: bool,
}
fn decide(s: &Store, request: Consent) -> OAuthResult<String> {
    const INSERT_CLIENT: &str = "INSERT INTO mcp_clients(id,name,redirects,created,expires)
        VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING";
    const INSERT_CODE: &str = "INSERT INTO mcp_codes
        (hash,client,redirect,scope,challenge,resource,expires) VALUES(?,?,?,?,?,?,?)";
    let expired = || oauth("invalid_request", "This connection request has expired.");
    let mut db = s.db.lock().unwrap();
    let tx = db.transaction()?;
    let pending = undecided(s, &tx, &request.request)?.ok_or_else(expired)?;
    let mut url = redirect(&pending.redirect)?;
    tx.execute(
        "INSERT INTO mcp_used_requests(hash,expires) VALUES(?,?)",
        params![hash(&request.request), pending.exp],
    )?;
    if request.allow {
        cleanup(&tx)?;
        if let Some(client) = signed_client(s, &pending.client_id) {
            tx.execute(
                INSERT_CLIENT,
                params![
                    pending.client_id,
                    client.name,
                    serde_json::to_string(&client.redirect_uris).unwrap(),
                    client.iat,
                    client.iat + CLIENT_SECONDS
                ],
            )?;
        } else if !tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM mcp_clients WHERE id=?)",
            [&pending.client_id],
            |row| row.get::<_, bool>(0),
        )? {
            // A legacy client exists only as a row, which cleanup may have
            // retired since this request began.
            return Err(expired());
        }
        count(&tx, "mcp_codes", MAX_CODES)?;
        count(&tx, "mcp_connections", MAX_CONNECTIONS)?;
        let code = opaque("mcp_k_");
        tx.execute(
            INSERT_CODE,
            params![
                hash(&code),
                pending.client_id,
                pending.redirect,
                pending.scope,
                pending.challenge,
                pending.resource,
                now() + CODE_SECONDS
            ],
        )?;
        url.query_pairs_mut().append_pair("code", &code);
    } else {
        url.query_pairs_mut().append_pair("error", "access_denied");
    }
    if !pending.state.is_empty() {
        url.query_pairs_mut().append_pair("state", &pending.state);
    }
    tx.commit()?;
    Ok(url.into())
}
pub(super) async fn consent(
    State(s): State<App>,
    _owner: security::Owner,
    Json(request): Json<Consent>,
) -> OAuthResult<Json<Value>> {
    let redirect = storage(s, move |s| decide(s, request)).await?;
    Ok(Json(json!({"redirect":redirect})))
}

#[derive(Clone, Deserialize)]
pub(super) struct TokenRequest {
    grant_type: String,
    client_id: String,
    resource: String,
    code: Option<String>,
    redirect_uri: Option<String>,
    code_verifier: Option<String>,
    refresh_token: Option<String>,
    scope: Option<String>,
}
struct Issued {
    connection: String,
    client: String,
    scope: String,
    access: String,
    refresh: String,
    access_expires: i64,
    expires: i64,
    created: i64,
}
impl Issued {
    fn new(connection: String, client: String, scope: String, expires: i64, created: i64) -> Self {
        Self {
            connection,
            client,
            scope,
            access: opaque("mcp_a_"),
            refresh: opaque("mcp_r_"),
            access_expires: (now() + ACCESS_SECONDS).min(expires),
            expires,
            created,
        }
    }
    fn persist(&self, db: &Connection) -> OAuthResult<()> {
        const UPSERT: &str = "INSERT INTO mcp_connections
            (id,client,scope,access_hash,access_expires,refresh_hash,expires,created)
            VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET scope=excluded.scope,
            access_hash=excluded.access_hash,access_expires=excluded.access_expires,
            refresh_hash=excluded.refresh_hash";
        db.execute(
            UPSERT,
            params![
                self.connection,
                self.client,
                self.scope,
                hash(&self.access),
                self.access_expires,
                hash(&self.refresh),
                self.expires,
                self.created
            ],
        )?;
        Ok(())
    }
    fn publish(&self, s: &Store) -> Value {
        s.mcp_credentials.publish(
            &self.connection,
            Some((
                hash(&self.access),
                Credential {
                    grant: Grant {
                        id: self.connection.clone(),
                        scopes: self
                            .scope
                            .split_ascii_whitespace()
                            .map(str::to_owned)
                            .collect(),
                    },
                    expires: self.access_expires,
                },
            )),
        );
        json!({"access_token":self.access,"token_type":"Bearer","expires_in":(self.access_expires-now()).max(0),
            "refresh_token":self.refresh,"scope":self.scope})
    }
}
fn exchange_token(s: &Store, request: TokenRequest) -> OAuthResult<Value> {
    const READ_CODE: &str = "SELECT client,redirect,scope,challenge,resource
        FROM mcp_codes WHERE hash=? AND expires>?";
    const READ_REFRESH: &str = "SELECT id,client,scope,expires,created
        FROM mcp_connections WHERE refresh_hash=? AND expires>?";
    const READ_REPLAY: &str = "SELECT c.id FROM mcp_used_refresh u
        JOIN mcp_connections c ON c.id=u.connection WHERE u.hash=? AND c.client=?";
    let invalid = || {
        oauth(
            "invalid_grant",
            "This authorization has expired, was already used or does not match this client.",
        )
    };
    // Codes and grants name their client, so no signature check is needed.
    if !client_id(&request.client_id) || request.resource != resource(s) {
        return Err(invalid());
    }
    let mut db = s.db.lock().unwrap();
    let tx = db.transaction()?;
    cleanup(&tx)?;
    let issued = match request.grant_type.as_str() {
        "authorization_code" => {
            let code = request
                .code
                .as_deref()
                .filter(|value| credential(value, "mcp_k_"))
                .ok_or_else(invalid)?;
            let verifier = request
                .code_verifier
                .as_deref()
                .filter(|value| valid_verifier(value))
                .ok_or_else(invalid)?;
            let uri = request.redirect_uri.as_deref().ok_or_else(invalid)?;
            let value = tx
                .query_row(READ_CODE, params![hash(code), now()], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                })
                .optional()?
                .ok_or_else(invalid)?;
            if value.0 != request.client_id
                || value.1 != uri
                || !secure_eq(&value.3, &challenge(verifier))
                || value.4 != request.resource
            {
                return Err(invalid());
            }
            count(&tx, "mcp_connections", MAX_CONNECTIONS)?;
            tx.execute("DELETE FROM mcp_codes WHERE hash=?", [hash(code)])?;
            Issued::new(
                opaque("mcp_g_"),
                request.client_id,
                value.2,
                now() + REFRESH_SECONDS,
                now(),
            )
        }
        "refresh_token" => {
            let refresh = request
                .refresh_token
                .as_deref()
                .filter(|value| credential(value, "mcp_r_"))
                .ok_or_else(invalid)?;
            let digest = hash(refresh);
            let value = tx
                .query_row(READ_REFRESH, params![digest, now()], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                })
                .optional()?;
            let Some((id, client, scope, expires, created)) = value else {
                let replay: Option<String> = tx
                    .query_row(READ_REPLAY, params![digest, request.client_id], |row| {
                        row.get(0)
                    })
                    .optional()?;
                if let Some(id) = replay {
                    tx.execute("DELETE FROM mcp_connections WHERE id=?", [&id])?;
                    tx.commit()?;
                    s.mcp_credentials.publish(&id, None);
                }
                return Err(invalid());
            };
            if client != request.client_id {
                return Err(invalid());
            }
            let current = scopes(&scope)?;
            let scope = if let Some(requested) = request.scope {
                let requested = scopes(&requested)?;
                if !requested.is_subset(&current) {
                    return Err(oauth("invalid_scope", "A refresh cannot add permissions."));
                }
                scope_string(&requested)
            } else {
                scope
            };
            // A client cannot consume another connection's replay budget.
            // This allows more than two rotations an hour for a 30-day grant.
            let rotations: i64 = tx.query_row(
                "SELECT count(*) FROM mcp_used_refresh WHERE connection=?",
                [&id],
                |row| row.get(0),
            )?;
            if rotations >= 2048 {
                return Err(oauth(
                    "invalid_grant",
                    "Reconnect Locdoc to renew this connection.",
                ));
            }
            tx.execute(
                "INSERT INTO mcp_used_refresh(hash,connection,expires) VALUES(?,?,?)",
                params![digest, id, expires],
            )?;
            Issued::new(id, client, scope, expires, created)
        }
        _ => {
            return Err(oauth(
                "unsupported_grant_type",
                "Use an authorization code or refresh token.",
            ));
        }
    };
    issued.persist(&tx)?;
    tx.commit()?;
    // Keep the database lock until cache publication, so revocation cannot
    // commit between the transaction and its in-memory admission change.
    Ok(issued.publish(s))
}
pub(super) async fn exchange(
    State(s): State<App>,
    Form(request): Form<TokenRequest>,
) -> OAuthResult<Json<Value>> {
    storage(s, move |s| exchange_token(s, request))
        .await
        .map(Json)
}

#[derive(Deserialize)]
pub(super) struct Revocation {
    token: String,
    client_id: String,
}
fn revoke(s: &Store, request: Revocation) -> OAuthResult<()> {
    const READ_GRANT: &str = "SELECT id FROM mcp_connections
        WHERE client=? AND (access_hash=? OR refresh_hash=?)
        UNION SELECT c.id FROM mcp_used_refresh u
        JOIN mcp_connections c ON c.id=u.connection
        WHERE c.client=? AND u.hash=? LIMIT 1";
    if !client_id(&request.client_id)
        || !(credential(&request.token, "mcp_a_") || credential(&request.token, "mcp_r_"))
    {
        return Ok(());
    }
    let mut db = s.db.lock().unwrap();
    let tx = db.transaction()?;
    let digest = hash(&request.token);
    let id: Option<String> = tx
        .query_row(
            READ_GRANT,
            params![request.client_id, digest, digest, request.client_id, digest],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(id) = id {
        tx.execute("DELETE FROM mcp_connections WHERE id=?", [&id])?;
        tx.commit()?;
        s.mcp_credentials.publish(&id, None);
    }
    Ok(())
}
pub(super) async fn revoke_token(
    State(s): State<App>,
    Form(request): Form<Revocation>,
) -> OAuthResult<StatusCode> {
    storage(s, move |s| revoke(s, request)).await?;
    Ok(StatusCode::OK)
}
fn connection_value(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let scope = row.get::<_, String>(2)?;
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "clientName": row.get::<_, String>(1)?,
        "scopes": scope.split_ascii_whitespace().collect::<Vec<_>>(),
        "created": row.get::<_, i64>(3)?
    }))
}
pub(super) async fn connections(
    State(s): State<App>,
    _owner: security::Owner,
) -> Result<Json<Value>> {
    const LIST_CONNECTIONS: &str = "SELECT g.id,c.name,g.scope,g.created
        FROM mcp_connections g JOIN mcp_clients c ON c.id=g.client
        WHERE g.expires>? ORDER BY g.created DESC LIMIT 64";
    job(s, move |s| {
        let db = s.db.lock().unwrap();
        let mut query = db.prepare(LIST_CONNECTIONS)?;
        let values = query
            .query_map([now()], connection_value)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(Json(json!({"connections":values})))
    })
    .await
}
pub(super) async fn disconnect(
    State(s): State<App>,
    _owner: security::Owner,
    AxPath(id): AxPath<String>,
) -> Result<Json<Value>> {
    job(s, move |s| {
        let db = s.db.lock().unwrap();
        db.execute("DELETE FROM mcp_connections WHERE id=?", [&id])?;
        s.mcp_credentials.publish(&id, None);
        Ok(Json(json!({"ok":true})))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    const CALLBACK: &str = "https://chatgpt.example.test/oauth/callback";
    const VERIFIER: &str = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const TABLES: [&str; 5] = [
        "mcp_clients",
        "mcp_used_requests",
        "mcp_codes",
        "mcp_connections",
        "mcp_used_refresh",
    ];

    fn fixture() -> (tempfile::TempDir, App) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(
            dir.path().join("docs"),
            dir.path().join("state"),
            "https://notes.example.test".into(),
        )
        .unwrap();
        migrate(&store.db.lock().unwrap()).unwrap();
        (dir, store)
    }
    fn registration() -> Registration {
        Registration {
            redirect_uris: vec![CALLBACK.into()],
            client_name: Some("Test client".into()),
            token_endpoint_auth_method: Some("none".into()),
            grant_types: None,
            response_types: None,
        }
    }
    fn client(s: &Store) -> String {
        named_client(s, "Test client")
    }
    // Identical registrations in the same second share one signed ID.
    fn named_client(s: &Store, name: &str) -> String {
        let mut request = registration();
        request.client_name = Some(name.into());
        register_client(s, request).unwrap()["client_id"]
            .as_str()
            .unwrap()
            .into()
    }
    fn signed(s: &Store, name: &str, iat: i64) -> String {
        let client = SignedClient {
            v: SIGNED_VERSION,
            redirect_uris: vec![CALLBACK.into()],
            name: name.into(),
            iat,
        };
        sign(s, "mcp_c_", &client)
    }
    /// Opaque IDs were registered before clients were signed.
    fn legacy_client(s: &Store, expires: i64) -> String {
        let id = opaque("mcp_c_");
        s.db.lock()
            .unwrap()
            .execute(
                "INSERT INTO mcp_clients(id,name,redirects,created,expires) VALUES(?,?,?,?,?)",
                params![
                    id,
                    "Legacy client",
                    json!([CALLBACK]).to_string(),
                    now(),
                    expires
                ],
            )
            .unwrap();
        id
    }
    /// Re-encodes claims under the original MAC, as a tampering client would.
    fn forged<T: Serialize>(prefix: &str, claims: &T, original: &str) -> String {
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).unwrap());
        format!("{prefix}{payload}.{}", original.split_once('.').unwrap().1)
    }
    fn rows(s: &Store) -> i64 {
        let db = s.db.lock().unwrap();
        TABLES
            .iter()
            .map(|table| {
                db.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap()
            })
            .sum()
    }
    fn authorization(s: &Store, client: &str) -> Authorization {
        Authorization {
            response_type: "code".into(),
            client_id: client.into(),
            redirect_uri: CALLBACK.into(),
            scope: Some("locdoc:read locdoc:write".into()),
            state: Some("opaque-state".into()),
            code_challenge: challenge(VERIFIER),
            code_challenge_method: "S256".into(),
            resource: resource(s),
        }
    }
    fn pending(s: &Store, client: &str) -> String {
        requested(s, authorization(s, client))
    }
    // Identical parameters in the same second also share one signed handle.
    fn requested(s: &Store, request: Authorization) -> String {
        let result = begin(s, request).unwrap();
        url::Url::parse(&result)
            .unwrap()
            .query_pairs()
            .find(|(key, _)| key == "mcp_authorize")
            .unwrap()
            .1
            .into_owned()
    }
    fn approved(s: &Store, client: &str) -> String {
        let request = pending(s, client);
        let result = decide(
            s,
            Consent {
                request,
                allow: true,
            },
        )
        .unwrap();
        let url = url::Url::parse(&result).unwrap();
        assert_eq!(
            url.query_pairs().find(|(key, _)| key == "state").unwrap().1,
            "opaque-state"
        );
        url.query_pairs()
            .find(|(key, _)| key == "code")
            .unwrap()
            .1
            .into_owned()
    }
    fn code_request(s: &Store, client: &str, code: &str) -> TokenRequest {
        TokenRequest {
            grant_type: "authorization_code".into(),
            client_id: client.into(),
            resource: resource(s),
            code: Some(code.into()),
            redirect_uri: Some(CALLBACK.into()),
            code_verifier: Some(VERIFIER.into()),
            refresh_token: None,
            scope: None,
        }
    }
    fn issued(s: &Store, client: &str) -> Value {
        let code = approved(s, client);
        exchange_token(s, code_request(s, client, &code)).unwrap()
    }
    fn refresh(s: &Store, client: &str, value: &Value) -> TokenRequest {
        TokenRequest {
            grant_type: "refresh_token".into(),
            client_id: client.into(),
            resource: resource(s),
            code: None,
            redirect_uri: None,
            code_verifier: None,
            refresh_token: Some(value["refresh_token"].as_str().unwrap().into()),
            scope: None,
        }
    }
    fn bearer(token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            format!("Bearer {token}").parse().unwrap(),
        );
        headers
    }
    fn admitted(s: &Store, value: &Value) -> Result<Grant> {
        authorize(s, &bearer(value["access_token"].as_str().unwrap()))
    }

    #[test]
    fn pkce_matches_the_rfc7636_example() {
        assert_eq!(
            challenge(VERIFIER),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        assert!(valid_verifier(VERIFIER));
        assert!(!valid_verifier(&"!".repeat(43)));
        assert!(!valid_verifier(&"x".repeat(42)));
        assert!(!valid_verifier(&"x".repeat(129)));
    }
    #[test]
    fn registration_accepts_only_secure_exact_redirects_and_public_clients() {
        for uri in [
            CALLBACK,
            "http://localhost:6274/oauth/callback",
            "http://127.0.0.1:6274/callback",
            "http://[::1]:6274/callback",
        ] {
            assert!(redirect(uri).is_ok(), "{uri}");
        }
        for uri in [
            "http://remote.example.test/callback",
            "javascript:alert(1)",
            "https://user:password@example.test/callback",
            "https://example.test/callback#fragment",
            "https://example.test/callback?state=fake",
            "file:///tmp/callback",
        ] {
            assert!(redirect(uri).is_err(), "{uri}");
        }
        let (_dir, s) = fixture();
        let mut request = registration();
        request.token_endpoint_auth_method = Some("client_secret_post".into());
        assert!(register_client(&s, request).is_err());
        let mut request = registration();
        request.client_name = Some("\nMisleading".into());
        assert!(register_client(&s, request).is_err());
    }
    #[test]
    fn authorization_is_bound_to_client_redirect_resource_and_s256() {
        let (_dir, s) = fixture();
        let client = client(&s);
        for mutation in 0..5 {
            let mut request = authorization(&s, &client);
            match mutation {
                0 => request.redirect_uri.push('/'),
                1 => request.resource = "https://other.example.test/mcp".into(),
                2 => request.code_challenge_method = "plain".into(),
                3 => request.scope = Some("admin".into()),
                _ => request.client_id = opaque("mcp_c_"),
            }
            assert!(begin(&s, request).is_err());
        }
        assert!(begin(&s, authorization(&s, &client)).is_ok());
    }
    #[test]
    fn consent_is_explicit_single_use_and_denial_never_issues_a_code() {
        let (_dir, s) = fixture();
        let client = client(&s);
        let request = pending(&s, &client);
        assert_eq!(
            s.db.lock()
                .unwrap()
                .query_row("SELECT count(*) FROM mcp_codes", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            s.db.lock()
                .unwrap()
                .query_row("SELECT count(*) FROM mcp_connections", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        let url = decide(
            &s,
            Consent {
                request: request.clone(),
                allow: false,
            },
        )
        .unwrap();
        assert!(url.contains("error=access_denied"));
        assert!(!url.contains("code="));
        assert!(
            undecided(&s, &s.db.lock().unwrap(), &request)
                .unwrap()
                .is_none(),
            "A decided request no longer previews"
        );
        assert!(
            decide(
                &s,
                Consent {
                    request,
                    allow: true
                }
            )
            .is_err()
        );
    }
    #[test]
    fn code_exchange_requires_matching_pkce_client_redirect_and_resource_then_burns_code() {
        let (_dir, s) = fixture();
        let client = client(&s);
        let code = approved(&s, &client);
        let request = code_request(&s, &client, &code);
        for mutation in 0..4 {
            let mut wrong = request.clone();
            match mutation {
                0 => wrong.code_verifier = Some("x".repeat(43)),
                1 => wrong.client_id = opaque("mcp_c_"),
                2 => wrong.redirect_uri = Some(format!("{CALLBACK}/")),
                _ => wrong.resource = "https://other.example.test/mcp".into(),
            }
            assert!(exchange_token(&s, wrong).is_err());
        }
        let value = exchange_token(&s, request.clone()).unwrap();
        let grant = admitted(&s, &value).unwrap();
        assert!(grant.require("locdoc:read").is_ok());
        assert!(grant.require("locdoc:write").is_ok());
        assert!(grant.require("locdoc:share").is_err());
        assert!(exchange_token(&s, request).is_err());
        assert_eq!(s.mcp_credentials.0.read().unwrap().len(), 1);
    }
    #[test]
    fn expired_requests_and_codes_cannot_authorize() {
        let (_dir, s) = fixture();
        let client = client(&s);
        let mut claims: SignedRequest = verify(&s, "mcp_q_", &pending(&s, &client)).unwrap();
        claims.exp = now();
        let request = sign(&s, "mcp_q_", &claims);
        assert!(
            undecided(&s, &s.db.lock().unwrap(), &request)
                .unwrap()
                .is_none()
        );
        assert!(
            decide(
                &s,
                Consent {
                    request,
                    allow: true
                }
            )
            .is_err()
        );
        let code = approved(&s, &client);
        s.db.lock()
            .unwrap()
            .execute("UPDATE mcp_codes SET expires=0", [])
            .unwrap();
        assert!(exchange_token(&s, code_request(&s, &client, &code)).is_err());
    }
    #[test]
    fn credentials_are_hashed_and_never_reuse_owner_or_share_access() {
        let (_dir, s) = fixture();
        let client = client(&s);
        let value = issued(&s, &client);
        let (access, refresh): (String, String) =
            s.db.lock()
                .unwrap()
                .query_row(
                    "SELECT access_hash,refresh_hash FROM mcp_connections",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
        assert_eq!(access, hash(value["access_token"].as_str().unwrap()));
        assert_eq!(refresh, hash(value["refresh_token"].as_str().unwrap()));
        assert_ne!(access, value["access_token"].as_str().unwrap());
        assert_ne!(refresh, value["refresh_token"].as_str().unwrap());
        let owner_session = browser_auth::issue(&s, "origin").unwrap();
        for credential in [&s.key, &owner_session, &token()] {
            assert!(authorize(&s, &bearer(credential)).is_err());
        }
        let mut duplicate = bearer(value["access_token"].as_str().unwrap());
        duplicate.append(header::AUTHORIZATION, "Bearer junk".parse().unwrap());
        assert!(authorize(&s, &duplicate).is_err());
    }
    #[test]
    fn credential_admission_does_not_wait_for_the_database() {
        let (_dir, s) = fixture();
        let client = client(&s);
        let value = issued(&s, &client);
        let _locked = s.db.lock().unwrap();
        assert!(admitted(&s, &value).is_ok());
        assert!(authorize(&s, &bearer(&opaque("mcp_a_"))).is_err());
    }
    #[test]
    fn refresh_rotation_keeps_identity_rejects_escalation_and_reuse_revokes_family() {
        let (_dir, s) = fixture();
        let client = client(&s);
        let first = issued(&s, &client);
        let id = admitted(&s, &first).unwrap().id;
        let mut escalation = refresh(&s, &client, &first);
        escalation.scope = Some("locdoc:read locdoc:write locdoc:share".into());
        assert!(exchange_token(&s, escalation).is_err());
        assert!(admitted(&s, &first).is_ok());
        let mut reduction = refresh(&s, &client, &first);
        reduction.scope = Some("locdoc:read".into());
        let second = exchange_token(&s, reduction).unwrap();
        assert!(admitted(&s, &first).is_err());
        let grant = admitted(&s, &second).unwrap();
        assert_eq!(grant.id, id);
        assert!(grant.require("locdoc:write").is_err());
        assert_ne!(first["access_token"], second["access_token"]);
        assert_ne!(first["refresh_token"], second["refresh_token"]);
        assert!(exchange_token(&s, refresh(&s, &client, &first)).is_err());
        assert!(admitted(&s, &second).is_err());
        assert!(exchange_token(&s, refresh(&s, &client, &second)).is_err());
    }
    #[test]
    fn revocation_does_not_cross_clients_and_remains_revoked_after_reload() {
        let (dir, s) = fixture();
        let first_client = client(&s);
        let other_client = named_client(&s, "Other client");
        assert_ne!(first_client, other_client);
        let first = issued(&s, &first_client);
        let other = issued(&s, &other_client);
        revoke(
            &s,
            Revocation {
                token: first["access_token"].as_str().unwrap().into(),
                client_id: other_client.clone(),
            },
        )
        .unwrap();
        assert!(admitted(&s, &first).is_ok());
        revoke(
            &s,
            Revocation {
                token: first["refresh_token"].as_str().unwrap().into(),
                client_id: first_client,
            },
        )
        .unwrap();
        assert!(admitted(&s, &first).is_err());
        assert!(admitted(&s, &other).is_ok());
        drop(s);
        let s = Store::open(
            dir.path().join("docs"),
            dir.path().join("state"),
            "https://notes.example.test".into(),
        )
        .unwrap();
        assert!(admitted(&s, &first).is_err());
        assert!(admitted(&s, &other).is_ok());
    }
    #[test]
    fn failed_transactions_do_not_consume_codes_or_publish_or_revoke_credentials() {
        let (_dir, s) = fixture();
        let client = client(&s);
        let code = approved(&s, &client);
        s.db.lock()
            .unwrap()
            .execute_batch("PRAGMA query_only=ON")
            .unwrap();
        assert!(exchange_token(&s, code_request(&s, &client, &code)).is_err());
        assert!(s.mcp_credentials.0.read().unwrap().is_empty());
        s.db.lock()
            .unwrap()
            .execute_batch("PRAGMA query_only=OFF")
            .unwrap();
        let value = exchange_token(&s, code_request(&s, &client, &code)).unwrap();
        s.db.lock()
            .unwrap()
            .execute_batch("PRAGMA query_only=ON")
            .unwrap();
        assert!(
            revoke(
                &s,
                Revocation {
                    token: value["access_token"].as_str().unwrap().into(),
                    client_id: client.clone()
                }
            )
            .is_err()
        );
        assert!(admitted(&s, &value).is_ok());
        assert!(exchange_token(&s, refresh(&s, &client, &value)).is_err());
        assert!(admitted(&s, &value).is_ok());
    }
    #[test]
    fn access_expiry_cannot_outlive_its_refresh_grant() {
        let (_dir, s) = fixture();
        let client = client(&s);
        let first = issued(&s, &client);
        let expiry = now() + 10;
        s.db.lock()
            .unwrap()
            .execute("UPDATE mcp_connections SET expires=?", [expiry])
            .unwrap();
        let second = exchange_token(&s, refresh(&s, &client, &first)).unwrap();
        assert!(second["expires_in"].as_i64().unwrap() <= 10);
        assert!(
            s.mcp_credentials
                .0
                .read()
                .unwrap()
                .values()
                .all(|entry| entry.expires <= expiry)
        );
        assert_eq!(
            s.db.lock()
                .unwrap()
                .query_row("SELECT access_expires FROM mcp_connections", [], |row| row
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
            expiry
        );
    }
    #[test]
    fn unauthenticated_registration_and_authorization_write_no_shared_state() {
        let (_dir, s) = fixture();
        // Any write from registration or authorization would now fail.
        s.db.lock()
            .unwrap()
            .execute_batch("PRAGMA query_only=ON")
            .unwrap();
        let flooding = client(&s);
        for _ in 0..300 {
            pending(&s, &flooding);
        }
        let request = pending(&s, &named_client(&s, "Legitimate client"));
        s.db.lock()
            .unwrap()
            .execute_batch("PRAGMA query_only=OFF")
            .unwrap();
        assert_eq!(
            rows(&s),
            0,
            "Unapproved clients and requests are not stored"
        );
        let url = decide(
            &s,
            Consent {
                request,
                allow: true,
            },
        )
        .unwrap();
        assert!(
            url.contains("code="),
            "A flood cannot exhaust owner consent"
        );
    }
    #[test]
    fn consent_persists_the_client_and_stored_clients_authorize_while_retained() {
        let (_dir, s) = fixture();
        let client = client(&s);
        let iat = signed_client(&s, &client).unwrap().iat;
        let access = issued(&s, &client);
        let mut again = authorization(&s, &client);
        again.state = None;
        let request = requested(&s, again);
        let url = decide(
            &s,
            Consent {
                request,
                allow: true,
            },
        )
        .unwrap();
        assert!(
            url.contains("code="),
            "A connected client can authorize again"
        );
        const STORED: &str = "SELECT name,redirects,created,expires,
            (SELECT count(*) FROM mcp_clients) FROM mcp_clients WHERE id=?";
        let stored =
            s.db.lock()
                .unwrap()
                .query_row(STORED, [&client], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                })
                .unwrap();
        assert_eq!(
            stored,
            (
                "Test client".into(),
                json!([CALLBACK]).to_string(),
                iat,
                iat + CLIENT_SECONDS,
                1
            )
        );
        assert!(admitted(&s, &access).is_ok());
        // An expired signed registration authorizes only through a kept row.
        let stale = signed(&s, "Stale client", now() - CLIENT_SECONDS);
        assert!(begin(&s, authorization(&s, &stale)).is_err());
        {
            let db = s.db.lock().unwrap();
            db.execute(
                "INSERT INTO mcp_clients(id,name,redirects,created,expires) VALUES(?,?,?,0,0)",
                params![stale, "Stale client", json!([CALLBACK]).to_string()],
            )
            .unwrap();
            db.execute(
                "INSERT INTO mcp_connections(id,client,scope,access_hash,access_expires,
                 refresh_hash,expires,created) VALUES('stale-grant',?,'locdoc:read',
                 'stale-access',0,'stale-refresh',?,0)",
                params![stale, now() + 60],
            )
            .unwrap();
        }
        assert!(begin(&s, authorization(&s, &stale)).is_ok());
        s.db.lock()
            .unwrap()
            .execute("DELETE FROM mcp_connections WHERE id='stale-grant'", [])
            .unwrap();
        assert!(begin(&s, authorization(&s, &stale)).is_err());
    }
    #[test]
    fn tampered_expired_and_foreign_handles_are_rejected() {
        let (_dir, s) = fixture();
        let (_other_dir, other) = fixture();
        let attacker = "https://attacker.example.test/callback";
        let client = client(&s);
        let (body, mac) = client.split_once('.').unwrap();
        let mut redirected: SignedClient = verify(&s, "mcp_c_", &client).unwrap();
        redirected.redirect_uris = vec![attacker.into()];
        let flipped = if mac.starts_with('A') { "B" } else { "A" };
        let mut raw = Hmac::<Sha256>::new_from_slice(s.key.as_bytes()).unwrap();
        raw.update(body.as_bytes());
        let raw = URL_SAFE_NO_PAD.encode(raw.finalize().into_bytes());
        for (id, uri) in [
            (forged("mcp_c_", &redirected, &client), attacker),
            (format!("{body}.{flipped}{}", &mac[1..]), CALLBACK),
            (
                signed(&s, "Expired client", now() - CLIENT_SECONDS),
                CALLBACK,
            ),
            (signed(&other, "Foreign client", now()), CALLBACK),
            (format!("{body}.{raw}"), CALLBACK),
            (pending(&s, &client), CALLBACK),
        ] {
            let mut request = authorization(&s, &id);
            request.redirect_uri = uri.into();
            assert!(begin(&s, request).is_err(), "Rejected client {id}");
        }
        let request = pending(&s, &client);
        let mut escalated: SignedRequest = verify(&s, "mcp_q_", &request).unwrap();
        escalated.scope = "locdoc:read locdoc:write locdoc:share".into();
        let mut expired: SignedRequest = verify(&s, "mcp_q_", &request).unwrap();
        expired.exp = now();
        for value in [
            forged("mcp_q_", &escalated, &request),
            sign(&s, "mcp_q_", &expired),
            pending(&other, &signed(&other, "Foreign client", now())),
            format!("mcp_q_{}", client.strip_prefix("mcp_c_").unwrap()),
            client.clone(),
        ] {
            assert!(
                undecided(&s, &s.db.lock().unwrap(), &value)
                    .unwrap()
                    .is_none()
            );
            let consent = Consent {
                request: value,
                allow: true,
            };
            assert!(decide(&s, consent).is_err());
        }
        assert_eq!(rows(&s), 0, "Rejected handles are not recorded");
        let url = decide(
            &s,
            Consent {
                request,
                allow: true,
            },
        )
        .unwrap();
        assert!(url.contains("code="));
    }
    #[test]
    fn legacy_client_rows_keep_working_until_cleanup_retires_them() {
        let (_dir, s) = fixture();
        let legacy = legacy_client(&s, now() + CLIENT_SECONDS);
        let first = issued(&s, &legacy);
        let second = exchange_token(&s, refresh(&s, &legacy, &first)).unwrap();
        assert!(admitted(&s, &first).is_err());
        assert!(admitted(&s, &second).is_ok());
        revoke(
            &s,
            Revocation {
                token: second["access_token"].as_str().unwrap().into(),
                client_id: legacy,
            },
        )
        .unwrap();
        assert!(admitted(&s, &second).is_err());
        let retired = legacy_client(&s, now());
        assert!(begin(&s, authorization(&s, &retired)).is_err());
        let removed = legacy_client(&s, now() + CLIENT_SECONDS);
        let request = pending(&s, &removed);
        s.db.lock()
            .unwrap()
            .execute("DELETE FROM mcp_clients WHERE id=?", [&removed])
            .unwrap();
        let error = decide(
            &s,
            Consent {
                request,
                allow: true,
            },
        )
        .unwrap_err();
        assert_eq!(
            (error.code, error.status),
            ("invalid_request", StatusCode::BAD_REQUEST)
        );
    }
    #[test]
    fn registration_bounds_signed_client_ids() {
        let (_dir, s) = fixture();
        let register = |path: &str, count: usize| {
            let mut request = registration();
            request.redirect_uris = vec![format!("https://callback.example.test/{path}"); count];
            register_client(&s, request)
        };
        // A 30-byte origin and slash plus 482 path bytes is 512 bytes each.
        let largest = register(&"a".repeat(482), 8).unwrap();
        let id = largest["client_id"].as_str().unwrap();
        assert!(client_id(id) && signed_client(&s, id).is_some());
        assert!(register("a", 9).is_err());
        assert!(register(&"a".repeat(1000), 5).is_err());
        assert!(
            register(&"\"".repeat(482), 8).is_err(),
            "JSON escaping cannot enlarge an ID past token request limits"
        );
        assert_eq!(rows(&s), 0);
    }
    #[test]
    fn migration_drops_requests_stored_by_earlier_versions() {
        let (_dir, s) = fixture();
        let db = s.db.lock().unwrap();
        db.execute_batch(
            "INSERT INTO mcp_clients(id,name,redirects,created,expires) VALUES('old','Old','[]',0,0);
            CREATE TABLE mcp_requests(hash TEXT PRIMARY KEY,
                client TEXT NOT NULL REFERENCES mcp_clients(id) ON DELETE CASCADE);
            INSERT INTO mcp_requests(hash,client) VALUES('pending','old');",
        )
        .unwrap();
        migrate(&db).unwrap();
        let remaining: i64 = db
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name='mcp_requests'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining, 0);
    }
    #[test]
    fn queued_grants_observe_revocation_and_reduced_permissions() {
        let (_dir, s) = fixture();
        let client = client(&s);
        let first = issued(&s, &client);
        let queued = admitted(&s, &first).unwrap();
        assert!(queued.require_current(&s, "locdoc:write").is_ok());
        let mut request = refresh(&s, &client, &first);
        request.scope = Some("locdoc:read".into());
        let second = exchange_token(&s, request).unwrap();
        assert!(queued.require_current(&s, "locdoc:write").is_err());
        assert!(queued.require_current(&s, "locdoc:read").is_ok());
        revoke(
            &s,
            Revocation {
                token: second["access_token"].as_str().unwrap().into(),
                client_id: client,
            },
        )
        .unwrap();
        assert!(queued.require_current(&s, "locdoc:read").is_err());
    }
}
