mod browser_auth;
mod comments;
mod disk;
mod documents;
mod engine;
#[cfg(test)]
mod engine_failure_tests;
mod folders;
mod links;
mod maintenance;
mod mcp;
mod mcp_access;
mod mcp_auth;
mod peers;
#[cfg(test)]
mod persistence_adversarial_tests;
#[cfg(test)]
mod persistence_tests;
mod projection;
mod save;
#[cfg(test)]
mod save_adversarial_tests;
mod security;
mod social;
mod text;
mod validation;
mod web;
mod work;
use disk::DiskFile;
use engine::process_frame;

use axum::{
    Json, Router,
    extract::{
        DefaultBodyLimit, Multipart, Path as AxPath, Query, State, WebSocketUpgrade,
        ws::{Message as WsMessage, WebSocket},
    },
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
    serve::ListenerExt,
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use futures_util::{SinkExt, StreamExt};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use tokio::sync::broadcast;
use tower_http::services::ServeDir;
use yrs::{
    Doc, GetString, OffsetKind, Options, ReadTxn, StateVector, Text, Transact,
    sync::{Awareness, DefaultProtocol, Message, Protocol, SyncMessage},
    updates::encoder::Encode,
};
#[cfg(test)]
use yrs::{Update, updates::decoder::Decode};

const MB: usize = 1_000_000;
const DOC_LIMIT: usize = 50 * MB;
type App = Arc<Store>;
type Result<T> = std::result::Result<T, ApiError>;
#[derive(Debug)]
struct ApiError(StatusCode, String);
impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.1)
    }
}
impl std::error::Error for ApiError {}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}
impl From<std::io::Error> for ApiError {
    fn from(e: std::io::Error) -> Self {
        tracing::warn!("filesystem operation failed: {e}");
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "The file operation failed. Check the local server log.".into(),
        )
    }
}
impl From<rusqlite::Error> for ApiError {
    fn from(e: rusqlite::Error) -> Self {
        tracing::warn!("database operation failed: {e}");
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "The storage operation failed. Check the local server log.".into(),
        )
    }
}
fn bad(s: &str) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, s.into())
}
fn denied() -> ApiError {
    ApiError(
        StatusCode::FORBIDDEN,
        "This action needs owner or editor access.".into(),
    )
}
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}
fn token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}
fn hash(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}
fn cookie(headers: &HeaderMap, key: &str) -> Option<String> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .filter_map(|s| s.trim().split_once('='))
        .find(|(k, _)| *k == key)
        .map(|(_, v)| v.to_string())
}
fn secure_eq(a: &str, b: &str) -> bool {
    bool::from(hash(a).as_bytes().ct_eq(hash(b).as_bytes()))
}
#[derive(Clone, Serialize, Deserialize, Debug)]
struct Document {
    id: String,
    path: String,
    permission: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    token: Option<String>,
}

struct Room {
    awareness: Awareness,
    tx: broadcast::Sender<Vec<u8>>,
    engine: engine::DocumentEngine,
}
struct Store {
    root: PathBuf,
    web_root: PathBuf,
    root_identity: documents::RootIdentity,
    _state_lock: disk::StateLock,
    work: Arc<tokio::sync::Semaphore>,
    document_jobs: work::Documents,
    uploads: Arc<tokio::sync::Semaphore>,
    visitors: Arc<peers::Visitors>,
    permissions: peers::PermissionEpoch,
    data: PathBuf,
    db: Mutex<Connection>,
    sessions: browser_auth::Sessions,
    mcp_credentials: mcp_auth::Credentials,
    rooms: Mutex<HashMap<String, Arc<Mutex<Room>>>>,
    room_loads: work::RoomLoads,
    key: String,
    public_url: String,
    bind: String,
    owner_name: String,
    http: reqwest::Client,
    rates: Mutex<HashMap<String, (i64, u32)>>,
    document_files: Mutex<()>,
}
// Blocking filesystem, SQLite and diff work never occupies Tokio's network
// workers. Four bounded jobs prevent rewrite storms from exhausting resources.
async fn job<T: Send + 'static>(
    s: App,
    f: impl FnOnce(&Store) -> Result<T> + Send + 'static,
) -> Result<T> {
    let permit = s
        .work
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| bad("Server is stopping."))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        f(&s)
    })
    .await
    .map_err(|_| {
        ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "Storage worker stopped. Your draft is kept locally.".into(),
        )
    })?
}

async fn doc_job<T: Send + 'static>(
    s: App,
    id: String,
    f: impl FnOnce(&Store) -> Result<T> + Send + 'static,
) -> Result<T> {
    let document = s.document_jobs.acquire(id).await;
    job(s, move |s| {
        // The closure owns admission until it actually finishes, including when
        // the waiting HTTP/socket task has already been cancelled.
        let _document = document;
        f(s)
    })
    .await
}

#[derive(Clone, Default, Deserialize)]
struct Access {
    token: Option<String>,
    client: Option<String>,
    epoch: Option<String>,
}
impl Store {
    fn open(root: PathBuf, data: PathBuf, public_url: String) -> Result<App> {
        let new_data = !data.exists();
        fs::create_dir_all(&data)?;
        let data = fs::canonicalize(data)?;
        if new_data {
            disk::sync_directories(&data, Path::new("/"))?;
        }
        let state_lock = disk::StateLock::acquire(&data)?;
        let (root, root_identity) = documents::prepare_root(&root, &data)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&data, fs::Permissions::from_mode(0o700))?;
        }
        let key_path = data.join("owner.key");
        let key = if key_path.exists() {
            fs::read_to_string(&key_path)?.trim().to_string()
        } else {
            use std::{io::Write, os::unix::fs::OpenOptionsExt};
            let k = token();
            let temporary = data.join(format!(".owner-key-{}.tmp", uuid::Uuid::new_v4()));
            let written: Result<()> = (|| {
                let mut file = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(&temporary)?;
                file.write_all(k.as_bytes())?;
                file.sync_all()?;
                disk::rename_new(&temporary, &key_path)?;
                fs::File::open(&data)?.sync_all()?;
                Ok(())
            })();
            if written.is_err() {
                let _ = fs::remove_file(&temporary);
            }
            written?;
            k
        };
        if key.is_empty() {
            return Err(bad(
                "The owner key is empty. Restore the state folder from backup before starting Locdoc.",
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&key_path, fs::Permissions::from_mode(0o600))?;
        }
        let db = Connection::open(data.join("locdoc.sqlite"))?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
   CREATE TABLE IF NOT EXISTS docs(id TEXT PRIMARY KEY,path TEXT UNIQUE NOT NULL,permission TEXT NOT NULL DEFAULT 'private',token TEXT,state BLOB);
   CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,expires INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS tickets(hash TEXT PRIMARY KEY,expires INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS comments(id TEXT PRIMARY KEY,doc TEXT NOT NULL,guest TEXT NOT NULL,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS assets(doc TEXT NOT NULL,path TEXT PRIMARY KEY,bytes INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS revisions(id TEXT PRIMARY KEY,doc TEXT NOT NULL,content TEXT NOT NULL,created INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS grants(doc TEXT NOT NULL,path TEXT NOT NULL,PRIMARY KEY(doc,path));
   CREATE TABLE IF NOT EXISTS trusted_references(doc TEXT NOT NULL,reference TEXT NOT NULL,PRIMARY KEY(doc,reference));
   CREATE TABLE IF NOT EXISTS fonts(family TEXT PRIMARY KEY,css TEXT NOT NULL);")?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS doc_updates(seq INTEGER PRIMARY KEY AUTOINCREMENT,doc TEXT NOT NULL,content BLOB NOT NULL); CREATE INDEX IF NOT EXISTS doc_updates_document ON doc_updates(doc,seq);")?;
        browser_auth::migrate(&db)?;
        documents::migrate(&db)?;
        folders::migrate(&db)?;
        mcp_access::migrate(&db)?;
        mcp_auth::migrate(&db)?;
        let sessions = browser_auth::Sessions::load(&db)?;
        let mcp_credentials = mcp_auth::Credentials::load(&db)?;
        let store = Arc::new(Self {
            root,
            web_root: std::env::var_os("LOCDOC_WEB")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("dist")),
            root_identity,
            _state_lock: state_lock,
            work: Arc::new(tokio::sync::Semaphore::new(4)),
            document_jobs: work::Documents::default(),
            uploads: Arc::new(tokio::sync::Semaphore::new(2)),
            visitors: Arc::new(peers::Visitors::default()),
            permissions: peers::PermissionEpoch::default(),
            data,
            db: Mutex::new(db),
            sessions,
            mcp_credentials,
            rooms: Mutex::new(HashMap::new()),
            room_loads: work::RoomLoads::default(),
            key,
            public_url: public_url.trim_end_matches('/').into(),
            bind: std::env::var("LOCDOC_BIND").unwrap_or_else(|_| "127.0.0.1:3477".into()),
            owner_name: std::env::var("LOCDOC_OWNER_NAME")
                .ok()
                .filter(|name| !name.trim().is_empty())
                .map(|name| name.trim().chars().take(60).collect())
                .unwrap_or_else(|| "Owner".into()),
            rates: Mutex::new(HashMap::new()),
            document_files: Mutex::new(()),
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(25))
                .build()
                .unwrap(),
        });
        store.recover_file_operations()?;
        store.discover_file_moves()?;
        Ok(store)
    }
    fn owner(&self, h: &HeaderMap) -> bool {
        if let Some(v) = h
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            && secure_eq(v, &self.key)
        {
            return true;
        }
        browser_auth::session(self, h).is_some()
    }
    fn access(&self, h: &HeaderMap, d: &Document, a: &Access) -> Result<(bool, bool)> {
        if self.owner(h) {
            return Ok((true, true));
        }
        let supplied = a.token.clone().or_else(|| {
            h.get("x-locdoc-share")
                .and_then(|v| v.to_str().ok())
                .map(String::from)
        });
        if d.permission != "private"
            && d.token
                .as_ref()
                .zip(supplied.as_ref())
                .is_some_and(|(a, b)| secure_eq(a, b))
        {
            Ok((false, d.permission == "edit"))
        } else {
            let grant = supplied
                .as_deref()
                .and_then(|token| folders::grant(self, token).ok());
            match grant {
                Some(grant) if grant.contains(&d.path) => Ok((false, grant.permission == "edit")),
                _ => Err(denied()),
            }
        }
    }
    fn media_path(&self, d: &Document, rel: &str) -> Result<PathBuf> {
        if rel.contains("://") || rel.starts_with('/') || rel.contains('\\') {
            return Err(bad("Only local attachments are supported."));
        }
        let decoded = percent_encoding::percent_decode_str(rel)
            .decode_utf8()
            .map_err(|_| bad("Invalid attachment path."))?;
        if decoded.starts_with('/') || decoded.contains('\\') {
            return Err(denied());
        }
        let parent = Path::new(&d.path).parent().unwrap();
        let path = self.root.join(parent).join(decoded.as_ref());
        let canonical = fs::canonicalize(path)
            .map_err(|_| ApiError(StatusCode::NOT_FOUND, "Attachment not found.".into()))?;
        if !canonical.starts_with(&self.root)
            || canonical.components().any(|p| p.as_os_str() == ".trash")
        {
            return Err(denied());
        }
        Ok(canonical)
    }
    fn references(content: &str) -> HashSet<String> {
        pulldown_cmark::Parser::new_ext(
            &comments::reading_source(content),
            pulldown_cmark::Options::all(),
        )
        .filter_map(|event| match event {
            pulldown_cmark::Event::Start(pulldown_cmark::Tag::Image { dest_url, .. }) => {
                Some(dest_url.to_string())
            }
            _ => None,
        })
        .collect()
    }
    fn grant_new_references(&self, d: &Document, before: &str, after: &str) -> Result<()> {
        let previous = Self::references(before);
        let current = Self::references(after);
        self.grant_references(d, current.difference(&previous))
    }
    fn grant_desktop_references(
        &self,
        d: &Document,
        baseline: &str,
        live: &str,
        after: &str,
    ) -> Result<()> {
        let previous = Self::references(baseline);
        let existing = Self::references(live);
        let current = Self::references(after);
        // An unrelated desktop save must not bless an anonymous reference
        // already present in accepted browser source, even before projection.
        self.grant_references(
            d,
            current
                .difference(&previous)
                .filter(|r| !existing.contains(*r)),
        )
    }
    fn grant_references<'a>(
        &self,
        d: &Document,
        references: impl Iterator<Item = &'a String>,
    ) -> Result<()> {
        let db = self.db.lock().unwrap();
        for reference in references {
            db.execute(
                "INSERT OR IGNORE INTO active_media(doc,reference) VALUES(?,?)",
                params![d.id, reference],
            )?;
            // Remember explicit owner references even before their file exists.
            // Loading a cached room never upgrades anonymous references to trusted ones.
            db.execute(
                "INSERT OR IGNORE INTO trusted_references(doc,reference) VALUES(?,?)",
                params![d.id, reference],
            )?;
        }
        Ok(())
    }
    fn attachment_allowed(&self, d: &Document, path: &Path) -> bool {
        let db = self.db.lock().unwrap();
        let grant = db
            .query_row(
                "SELECT 1 FROM grants WHERE doc=? AND path=?",
                params![d.id, path.to_string_lossy()],
                |r| r.get::<_, i64>(0),
            )
            .is_ok();
        let rel = path
            .strip_prefix(&self.root)
            .unwrap_or(path)
            .to_string_lossy();
        let uploaded = db
            .query_row(
                "SELECT 1 FROM assets WHERE doc=? AND path=?",
                params![d.id, rel],
                |r| r.get::<_, i64>(0),
            )
            .is_ok();
        if grant || uploaded {
            return true;
        }
        let references = db
            .prepare("SELECT reference FROM trusted_references WHERE doc=?")
            .and_then(|mut query| {
                query
                    .query_map([&d.id], |r| r.get::<_, String>(0))?
                    .collect::<std::result::Result<Vec<_>, _>>()
            })
            .unwrap_or_default();
        drop(db);
        references
            .iter()
            .any(|reference| self.media_path(d, reference).is_ok_and(|p| p == path))
    }

    fn usage(&self, d: &Document, content: &str) -> usize {
        self.reference_usage(d, &Self::references(content))
    }
    fn reference_usage(&self, d: &Document, references: &HashSet<String>) -> usize {
        let mut files: HashSet<PathBuf> = references
            .iter()
            .filter_map(|p| self.media_path(d, p).ok())
            .collect();
        let db = self.db.lock().unwrap();
        let mut st = db
            .prepare("SELECT path FROM assets WHERE doc=? AND pending_until>?")
            .unwrap();
        if let Ok(paths) = st.query_map(params![d.id, now()], |r| r.get::<_, String>(0)) {
            for p in paths.flatten() {
                if let Ok(p) = fs::canonicalize(self.root.join(p))
                    && p.starts_with(&self.root)
                {
                    files.insert(p);
                }
            }
        }
        files
            .into_iter()
            .filter_map(|p| fs::metadata(p).ok())
            .map(|m| m.len() as usize)
            .sum()
    }
    fn epoch(&self, id: &str) -> Result<String> {
        Ok(self.db.lock().unwrap().query_row(
            "SELECT collaboration_epoch FROM docs WHERE id=? AND active=1",
            [id],
            |row| row.get(0),
        )?)
    }
}

fn room_text(r: &Room) -> String {
    r.awareness
        .doc()
        .get_or_insert_text("content")
        .get_string(&r.awareness.doc().transact())
}

fn apply_text(doc: &Doc, old: &str, new: &str) {
    if old == new {
        return;
    }
    let text = doc.get_or_insert_text("content");
    let mut txn = doc.transact_mut();
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(40);
    fn runs(
        text: &yrs::TextRef,
        txn: &mut yrs::TransactionMut<'_>,
        pos: &mut u32,
        old: &str,
        new: &str,
        deadline: std::time::Instant,
        lines: bool,
    ) {
        let mut config = similar::TextDiff::configure();
        config.deadline(deadline);
        let diff = if lines {
            config.diff_lines(old, new)
        } else {
            config.diff_chars(old, new)
        };
        for op in diff.ops() {
            let removed = diff.old_slices()[op.old_range()].concat();
            let inserted = diff.new_slices()[op.new_range()].concat();
            if op.tag() == similar::DiffTag::Equal {
                *pos += removed.encode_utf16().count() as u32;
                continue;
            }
            // Refine only changed small line blocks. A bounded coarse edit still
            // produces exact source when a wholesale desktop rewrite is costly.
            if lines
                && removed.len() + inserted.len() < 16_384
                && std::time::Instant::now() < deadline
            {
                runs(text, txn, pos, &removed, &inserted, deadline, false);
                continue;
            }
            let len = removed.encode_utf16().count() as u32;
            if len != 0 {
                text.remove_range(txn, *pos, len);
            }
            if !inserted.is_empty() {
                text.insert(txn, *pos, &inserted);
                *pos += inserted.encode_utf16().count() as u32;
            }
        }
    }
    runs(
        &text,
        &mut txn,
        &mut 0,
        old,
        new,
        deadline,
        old.len() + new.len() >= 16_384,
    );
}

fn origin_check(s: &Store, h: &HeaderMap) -> Result<()> {
    if security::origin_allowed(&s.public_url, &s.bind, h) {
        Ok(())
    } else {
        Err(denied())
    }
}

fn configuration(s: &Store, h: &HeaderMap, document: Option<Value>) -> Response {
    configuration_extra(
        s,
        h,
        document
            .map(|document| json!({"document":document}))
            .unwrap_or_else(|| json!({})),
    )
}
fn configuration_extra(s: &Store, h: &HeaderMap, extra: Value) -> Response {
    let guest = cookie(h, "locdoc_guest")
        .filter(|x| x.len() == 64)
        .unwrap_or_else(token);
    let owner = s.owner(h);
    let mut value = json!({"owner":owner,"root":if owner{s.root.to_string_lossy().to_string()}else{String::new()},"guest":hash(&guest),"publicUrl":s.public_url,"limits":{"image":5*MB,"video":20*MB,"document":DOC_LIMIT}});
    if owner {
        value["ownerName"] = json!(s.owner_name);
    }
    value
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    let mut res = Json(value).into_response();
    res.headers_mut().insert(
        header::SET_COOKIE,
        format!(
            "locdoc_guest={guest}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000{}",
            if browser_auth::cookie_session(s, h) {
                "; Secure"
            } else {
                ""
            }
        )
        .parse()
        .unwrap(),
    );
    browser_auth::migrate_cookie(s, h, &mut res);
    res
}
async fn config(State(s): State<App>, h: HeaderMap) -> Response {
    configuration(&s, &h, None)
}
#[derive(Deserialize)]
struct Login {
    key: String,
}
async fn login(State(s): State<App>, h: HeaderMap, Json(b): Json<Login>) -> Result<Response> {
    if !secure_eq(b.key.trim(), &s.key) {
        tokio::time::sleep(std::time::Duration::from_millis(700)).await;
        return Err(denied());
    }
    let transport = browser_auth::transport(&s, &h);
    let t = job(s.clone(), move |s| browser_auth::issue(s, transport)).await?;
    Ok(browser_auth::login_response(&s, &h, &t))
}
async fn issue_ticket(State(s): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    let local = h
        .get(header::HOST)
        .and_then(|x| x.to_str().ok())
        .is_some_and(|x| x.starts_with("127.0.0.1:") || x.starts_with("localhost:"));
    let bearer = h
        .get(header::AUTHORIZATION)
        .and_then(|x| x.to_str().ok())
        .and_then(|x| x.strip_prefix("Bearer "))
        .is_some_and(|x| secure_eq(x, &s.key));
    if !local || !bearer {
        return Err(denied());
    }
    let t = token();
    let db = s.db.lock().unwrap();
    db.execute("DELETE FROM tickets WHERE expires<?", [now()])?;
    db.execute(
        "INSERT INTO tickets(hash,expires) VALUES(?,?)",
        params![hash(&t), now() + 60],
    )?;
    Ok(Json(json!({"ticket":t})))
}
#[derive(Deserialize)]
struct Redeem {
    ticket: String,
}
async fn redeem(State(s): State<App>, h: HeaderMap, Json(b): Json<Redeem>) -> Result<Response> {
    let transport = browser_auth::transport(&s, &h);
    let t = job(s.clone(), move |s| {
        browser_auth::redeem(s, &b.ticket, transport)
    })
    .await?;
    Ok(browser_auth::login_response(&s, &h, &t))
}
async fn logout(State(s): State<App>, h: HeaderMap) -> Result<Response> {
    if let Some(digest) = browser_auth::session(&s, &h) {
        job(s, move |s| browser_auth::revoke(s, &digest)).await?;
    }
    Ok(browser_auth::logout_response())
}
#[derive(Serialize)]
struct Entry {
    path: String,
    kind: &'static str,
    id: Option<String>,
    shared: bool,
    modified: u64,
    title: String,
    url: Option<String>,
}
fn scan(s: &Store, dir: &Path, entries: &mut Vec<Entry>) -> Result<()> {
    let mut children = fs::read_dir(dir)?.collect::<std::result::Result<Vec<_>, _>>()?;
    children.sort_by_key(|e| e.file_name());
    for e in children {
        let name = e.file_name();
        if name.to_string_lossy().starts_with('.') || e.file_type()?.is_symlink() {
            continue;
        }
        let p = e.path();
        let rel = p
            .strip_prefix(&s.root)
            .unwrap()
            .to_string_lossy()
            .to_string();
        if p.is_dir() {
            entries.push(Entry {
                path: rel,
                kind: "folder",
                id: None,
                shared: false,
                modified: 0,
                title: name.to_string_lossy().into_owned(),
                url: None,
            });
            scan(s, &p, entries)?;
        } else if documents::format(&rel).is_some() {
            let d = s.index_document(&rel)?;
            entries.push(Entry {
                path: rel,
                kind: "file",
                id: Some(d.id.clone()),
                shared: d.permission != "private",
                modified: fs::metadata(&p)?
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
                title: p.file_stem().unwrap().to_string_lossy().into_owned(),
                url: Some(if d.permission != "private" {
                    format!(
                        "{}/s/{}",
                        s.public_url,
                        d.token.as_deref().unwrap_or_default()
                    )
                } else {
                    format!("{}/d/{}", s.public_url, d.id)
                }),
            });
        }
    }
    Ok(())
}
async fn tree(State(s): State<App>, h: HeaderMap, Query(a): Query<Access>) -> Result<Json<Value>> {
    if let Some(token) = a.token.as_deref() {
        let folder = folders::grant(&s, token)?;
        return Ok(Json(json!({"entries":folders::entries(&s,&folder)?})));
    }
    if !s.owner(&h) {
        return Err(denied());
    }
    let mut entries = vec![];
    scan(&s, &s.root, &mut entries)?;
    let folders = folders::active(&s)?;
    for entry in &mut entries {
        entry.shared |= folders
            .iter()
            .any(|folder| folder.path == entry.path || folder.contains(&entry.path));
    }
    Ok(Json(json!({"entries":entries})))
}
#[derive(Deserialize)]
struct Create {
    path: String,
    kind: String,
}
async fn create(
    State(s): State<App>,
    _owner: security::Owner,
    Json(b): Json<Create>,
) -> Result<Json<Value>> {
    if b.kind == "folder" {
        s.create_folder(&b.path)?;
        Ok(Json(json!({"ok":true})))
    } else if b.kind == "file" {
        Ok(Json(json!(s.create_document(&b.path)?)))
    } else {
        Err(bad("Choose file or folder."))
    }
}
fn document_payload(s: &Store, h: &HeaderMap, d: &Document, access: &Access) -> Result<Value> {
    let (owner, mut edit) = s.access(h, d, access)?;
    let room = s.room(d)?;
    let mut room = room.lock().unwrap();
    room.reconcile(s, d)?;
    edit &= !room.conflicted();
    let content = room_text(&room);
    let state = room
        .awareness
        .doc()
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let usage = s.usage(d, &content);
    let link = if owner {
        d.token.as_ref().map(|t| format!("{}/s/{t}", s.public_url))
    } else {
        None
    };
    let path = if owner {
        d.path.clone()
    } else {
        Path::new(&d.path)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string()
    };
    let permission = if owner {
        d.permission.as_str()
    } else if edit {
        "edit"
    } else {
        "view"
    };
    let modified = s
        .safe(&d.path, false)
        .ok()
        .and_then(|path| fs::metadata(path).ok())
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs());
    let mut payload = json!({
        "id": d.id,
        "path": path,
        "owner": owner,
        "edit": edit,
        "permission": permission,
        "shareUrl": link,
        "usage": usage,
        "modified": modified,
        "content": content,
        "state": BASE64.encode(state),
        "diskConflict": room.conflicted(),
        "diskPending": room.engine.waiting(),
        "diskSaving": room.engine.needs_projection(),
        "lineEndingMigrated": room.engine.migrated(),
        "collaborationEpoch": s.epoch(&d.id)?,
        "mediaToken": if owner { browser_auth::media_token(s, h, &d.id) } else { None }
    });
    if owner {
        let access = mcp_access::document_access(s, d)?;
        payload["mcpAllowed"] = json!(access.mcp_allowed);
        payload["mcpDirect"] = json!(access.mcp_direct);
        payload["mcpInherited"] = json!(access.mcp_inherited);
    }
    Ok(payload)
}
async fn document(
    State(s): State<App>,
    AxPath(id): AxPath<String>,
    Query(a): Query<Access>,
    h: HeaderMap,
) -> Result<Json<Value>> {
    Ok(Json(
        doc_job(s, id.clone(), move |s| {
            document_payload(s, &h, &s.doc(&id)?, &a)
        })
        .await?,
    ))
}
fn shared_document(s: &Store, token: &str) -> Result<Document> {
    let id: Option<String> =
        s.db.lock()
            .unwrap()
            .query_row(
                "SELECT id FROM docs WHERE token=? AND permission!='private'",
                [token],
                |r| r.get(0),
            )
            .optional()?;
    let id = id.ok_or(ApiError(
        StatusCode::NOT_FOUND,
        "This link has been turned off or does not exist.".into(),
    ))?;
    s.doc(&id)
}
async fn shared(State(s): State<App>, AxPath(token): AxPath<String>) -> Result<Json<Value>> {
    if let Ok(folder) = folders::grant(&s, &token) {
        return Ok(Json(
            json!({"id":folders::document(&s,&folder,None)?.map(|doc|doc.id)}),
        ));
    }
    Ok(Json(json!({"id":shared_document(&s, &token)?.id})))
}
async fn open_shared(
    State(s): State<App>,
    AxPath(token): AxPath<String>,
    h: HeaderMap,
    Query(selection): Query<folders::Selection>,
) -> Result<Response> {
    let (document, folder, token) = job(s.clone(), move |s| {
        if let Ok(folder) = folders::grant(s, &token) {
            let entries = folders::entries(s, &folder)?;
            let selected = selection
                .doc
                .as_deref()
                .or_else(|| entries.iter().find_map(|entry| entry.id.as_deref()));
            let document = folders::document(s, &folder, selected)?;
            Ok((document, Some((folder.value(s), json!(entries))), token))
        } else {
            Ok((Some(shared_document(s, &token)?), None, token))
        }
    })
    .await?;
    let headers = h.clone();
    let document = if let Some(document) = document {
        Some(
            doc_job(s.clone(), document.id.clone(), move |s| {
                document_payload(
                    s,
                    &headers,
                    &document,
                    &Access {
                        token: Some(token),
                        ..Access::default()
                    },
                )
            })
            .await?,
        )
    } else {
        None
    };
    job(s, move |s| {
        Ok(match folder {
            Some((folder, entries)) => configuration_extra(
                s,
                &h,
                json!({"folder":folder,"entries":entries,"document":document}),
            ),
            None => configuration(s, &h, document),
        })
    })
    .await
}
#[derive(Deserialize)]
struct Share {
    permission: String,
    #[serde(default)]
    rotate: bool,
}
async fn share(
    State(s): State<App>,
    AxPath(id): AxPath<String>,
    _owner: security::Owner,
    Json(b): Json<Share>,
) -> Result<Json<Value>> {
    doc_job(s, id.clone(), move |s| share_document(s, id, b))
        .await
        .map(Json)
}
fn share_document(s: &Store, id: String, b: Share) -> Result<Value> {
    if !["private", "view", "edit"].contains(&b.permission.as_str()) {
        return Err(bad("Choose private, view, or edit."));
    }
    let d = s.doc(&id)?;
    let t = if b.permission == "private" {
        None
    } else {
        Some(match (b.rotate, d.permission.as_str(), d.token) {
            (false, permission, Some(existing)) if permission != "private" => existing,
            _ => token(),
        })
    };
    s.db.lock().unwrap().execute(
        "UPDATE docs SET permission=?,token=? WHERE id=?",
        params![b.permission, t, id],
    )?;
    s.permissions.invalidate();
    // Existing visitors reconnect with the new mode. Cached passive checks
    // are invalidated even if a busy room cannot be notified immediately.
    let room = s.rooms.lock().unwrap().get(&id).cloned();
    if let Some(room) = room {
        let _ = room.lock().unwrap().tx.send(vec![126]);
    }
    let share_url = t.map(|token| format!("{}/s/{token}", s.public_url));
    Ok(json!({
        "permission": b.permission,
        "shareUrl": share_url,
    }))
}
#[derive(Deserialize)]
struct Rename {
    path: String,
}
async fn rename(
    State(s): State<App>,
    AxPath(id): AxPath<String>,
    _owner: security::Owner,
    Json(b): Json<Rename>,
) -> Result<Json<Value>> {
    doc_job(s, id.clone(), move |s| {
        s.rename_document(&id, &b.path)?;
        Ok(Json(json!({"ok":true})))
    })
    .await
}
fn guest_id(h: &HeaderMap) -> Result<String> {
    cookie(h, "locdoc_guest")
        .filter(|x| x.len() == 64)
        .map(|x| hash(&x))
        .ok_or_else(|| bad("Reload the page before commenting."))
}
async fn upload(
    State(s): State<App>,
    AxPath(id): AxPath<String>,
    Query(a): Query<Access>,
    h: HeaderMap,
    mut multipart: Multipart,
) -> Result<Json<Value>> {
    let d = s.doc(&id)?;
    if !s.access(&h, &d, &a)?.1 {
        return Err(denied());
    }
    let permit = s.uploads.clone().try_acquire_owned().map_err(|_| {
        ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "Two uploads are already running. Try again when one finishes.".into(),
        )
    })?;
    let field = multipart
        .next_field()
        .await
        .map_err(|_| bad("Choose an image or video."))?
        .ok_or_else(|| bad("Choose a file."))?;
    let name = field.file_name().unwrap_or("attachment").to_string();
    let bytes = field
        .bytes()
        .await
        .map_err(|_| bad("The file is too large. Images: 5 MB; videos: 20 MB."))?;
    doc_job(s, id.clone(), move |s| {
        let _permit = permit;
        let current = s.doc(&d.id)?;
        if !s.access(&h, &current, &a)?.1 {
            return Err(denied());
        }
        upload_payload(s, current, id, name, &bytes)
    })
    .await
    .map(Json)
}
fn upload_payload(s: &Store, d: Document, id: String, name: String, bytes: &[u8]) -> Result<Value> {
    let kind = infer::get(bytes).ok_or_else(|| {
        bad("Unsupported file. Use PNG, JPEG, GIF, WebP, AVIF, MP4, WebM, or MOV.")
    })?;
    let mime = kind.mime_type();
    let video = mime.starts_with("video/");
    if !allowed_mime(mime) {
        return Err(bad("Unsupported image or video format."));
    }
    if bytes.len() > if video { 20 * MB } else { 5 * MB } {
        return Err(bad(if video {
            "Videos must be 20 MB or smaller."
        } else {
            "Images must be 5 MB or smaller."
        }));
    }
    let room = s.room(&d)?;
    let usage = s.usage(&d, &room_text(&room.lock().unwrap()));
    if usage + bytes.len() > DOC_LIMIT {
        return Err(bad(
            "This document would exceed its 50 MB attachment limit.",
        ));
    }
    let rel = format!(
        ".assets/{}/{}.{}",
        id,
        uuid::Uuid::new_v4(),
        kind.extension()
    );
    s.write_upload(&d, &rel, bytes)?;
    let depth = Path::new(&d.path).parent().unwrap().components().count();
    let reference = format!("{}{rel}", "../".repeat(depth));
    let usage = s.usage(&d, &room_text(&room.lock().unwrap()));
    Ok(json!({"path":reference,"name":name,"bytes":bytes.len(),"video":video,"usage":usage}))
}
#[derive(Deserialize)]
struct Media {
    path: String,
    token: Option<String>,
}
async fn media(
    State(s): State<App>,
    AxPath(id): AxPath<String>,
    Query(q): Query<Media>,
    h: HeaderMap,
) -> Result<Response> {
    let authorize = h.clone();
    let (path, len, mime) =
        doc_job(s, id.clone(), move |s| media_file(s, &id, &q, &authorize)).await?;
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let mut start = 0;
    let mut end = len - 1;
    let mut partial = false;
    if let Some(value) = h
        .get(header::RANGE)
        .and_then(|x| x.to_str().ok())
        .and_then(|x| x.strip_prefix("bytes="))
    {
        let (a, b) = value.split_once('-').ok_or_else(|| bad("Invalid range"))?;
        if a.is_empty() {
            let suffix: usize = b.parse().map_err(|_| bad("Invalid range"))?;
            if suffix == 0 {
                return Err(bad("Invalid range"));
            }
            start = len.saturating_sub(suffix);
        } else {
            start = a.parse().map_err(|_| bad("Invalid range"))?;
            if !b.is_empty() {
                end = b.parse().map_err(|_| bad("Invalid range"))?;
            }
        }
        if start >= len || end < start {
            return Err(ApiError(
                StatusCode::RANGE_NOT_SATISFIABLE,
                "Invalid byte range".into(),
            ));
        }
        end = end.min(len - 1);
        partial = true;
    }
    let mut file = tokio::fs::File::open(&path).await?;
    file.seek(std::io::SeekFrom::Start(start as u64)).await?;
    let body = axum::body::Body::from_stream(tokio_util::io::ReaderStream::new(
        file.take((end - start + 1) as u64),
    ));
    let mut res = (
        if partial {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        },
        body,
    )
        .into_response();
    res.headers_mut()
        .insert(header::CONTENT_TYPE, mime.parse().unwrap());
    res.headers_mut().insert(
        header::CONTENT_LENGTH,
        (end - start + 1).to_string().parse().unwrap(),
    );
    res.headers_mut()
        .insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
    res.headers_mut()
        .insert(header::CACHE_CONTROL, "private, no-store".parse().unwrap());
    if partial {
        res.headers_mut().insert(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{len}").parse().unwrap(),
        );
    }

    Ok(res)
}
fn media_file(
    s: &Store,
    id: &str,
    q: &Media,
    h: &HeaderMap,
) -> Result<(PathBuf, usize, &'static str)> {
    let d = s.doc(id)?;
    let capability = q
        .token
        .as_deref()
        .is_some_and(|token| browser_auth::media_allowed(s, &d.id, token));
    let owner = capability
        || s.access(
            h,
            &d,
            &Access {
                token: q.token.clone(),
                ..Access::default()
            },
        )?
        .0;
    let path = s.media_path(&d, &q.path)?;
    if !owner || capability {
        // Never open the Markdown file here: even a read would break our
        // projection lease. Room source is committed before its lock is freed.
        let existing = s.rooms.lock().unwrap().get(&d.id).cloned();
        let room = match existing {
            Some(room) => room,
            None => s.room(&d)?,
        };
        let mut room = room.lock().unwrap();
        let allowed = room
            .references(s, &d)?
            .iter()
            .filter_map(|p| s.media_path(&d, p).ok())
            .any(|p| p == path);
        if !allowed || (!capability && !s.active_attachment_allowed(&d, &path)) {
            return Err(denied());
        }
    }
    use std::io::Read;
    let len = fs::metadata(&path)?.len() as usize;
    if len == 0 || len > 20 * MB {
        return Err(bad("Attachment is empty or exceeds the 20 MB maximum."));
    }
    let mut prefix = [0; 512];
    let n = fs::File::open(&path)?.read(&mut prefix)?;
    let kind = infer::get(&prefix[..n]).ok_or_else(|| bad("Unsupported attachment."))?;
    if !allowed_mime(kind.mime_type()) {
        return Err(denied());
    }
    if kind.mime_type().starts_with("image/") && len > 5 * MB {
        return Err(bad("Image exceeds 5 MB."));
    }
    Ok((path, len, kind.mime_type()))
}
async fn font_list(State(s): State<App>) -> Result<Json<Value>> {
    let db = s.db.lock().unwrap();
    let mut q = db.prepare("SELECT family FROM fonts ORDER BY family")?;
    Ok(Json(
        json!({"fonts":q.query_map([],|r|r.get::<_,String>(0))?.filter_map(|x|x.ok()).collect::<Vec<_>>()}),
    ))
}
async fn font_css(State(s): State<App>) -> Result<Response> {
    let db = s.db.lock().unwrap();
    let mut q = db.prepare("SELECT css FROM fonts")?;
    let css = q
        .query_map([], |r| r.get::<_, String>(0))?
        .filter_map(|x| x.ok())
        .collect::<Vec<_>>()
        .join("\n");
    Ok((
        [
            (header::CONTENT_TYPE, "text/css"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        css,
    )
        .into_response())
}
#[derive(Deserialize)]
struct FontRequest {
    family: String,
}
async fn install_font(
    State(s): State<App>,
    _owner: security::Owner,
    Json(b): Json<FontRequest>,
) -> Result<Json<Value>> {
    let family = b.family.trim();
    if family.is_empty()
        || family.len() > 80
        || !family
            .chars()
            .all(|c| c.is_alphanumeric() || c == ' ' || c == '-')
    {
        return Err(bad("Enter a Google Fonts family name, for example Lora."));
    }
    let count: i64 =
        s.db.lock()
            .unwrap()
            .query_row("SELECT count(*) FROM fonts", [], |r| r.get(0))?;
    if count >= 50 {
        return Err(bad("The 50-family font library is full."));
    }
    let mut url = url::Url::parse("https://fonts.googleapis.com/css2").unwrap();
    url.query_pairs_mut()
        .append_pair("family", &format!("{family}:wght@400;500;600;700"))
        .append_pair("display", "swap");
    let css = s
        .http
        .get(url)
        .header("User-Agent", "Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36")
        .send()
        .await
        .map_err(|_| bad("Google Fonts is unreachable. Try again."))?
        .error_for_status()
        .map_err(|_| bad("Font not found. Check the exact Google Fonts family name."))?
        .text()
        .await
        .map_err(|_| bad("Font download failed."))?;
    let re = regex::Regex::new(r"https://fonts\.gstatic\.com/[^)\s]+").unwrap();
    let urls: Vec<String> = re
        .find_iter(&css)
        .map(|m| m.as_str().to_string())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    if urls.is_empty() || urls.len() > 100 {
        return Err(bad("No downloadable font files found."));
    }
    fs::create_dir_all(s.data.join("fonts"))?;
    let mut installed = css;
    for source in urls {
        let name = format!("{}.woff2", hash(&source));
        let dest = s.data.join("fonts").join(&name);
        if !dest.exists() {
            let response = s
                .http
                .get(&source)
                .send()
                .await
                .map_err(|_| bad("Font download failed."))?
                .error_for_status()
                .map_err(|_| bad("Font download failed."))?;
            if response.content_length().unwrap_or(0) > 5 * MB as u64 {
                return Err(bad("Font file is too large."));
            }
            let bytes = response
                .bytes()
                .await
                .map_err(|_| bad("Font download failed."))?;
            if bytes.len() > 5 * MB {
                return Err(bad("Font file is too large."));
            }
            fs::write(dest, bytes)?;
        }
        installed = installed.replace(&source, &format!("/fonts/{name}"));
    }
    s.db.lock().unwrap().execute(
        "INSERT OR REPLACE INTO fonts(family,css) VALUES(?,?)",
        params![family, installed],
    )?;
    Ok(Json(json!({"family":family})))
}
async fn websocket(
    State(s): State<App>,
    AxPath(id): AxPath<String>,
    Query(a): Query<Access>,
    axum::extract::ConnectInfo(remote): axum::extract::ConnectInfo<std::net::SocketAddr>,
    h: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response> {
    let d = s.doc(&id)?;
    let (owner, _) = s.access(&h, &d, &a)?;
    let visitor = if owner {
        None
    } else {
        Some(s.visitors.enter(peers::address(&h, remote.ip()))?)
    };
    let target = d.clone();
    let r = doc_job(s.clone(), d.id.clone(), move |s| s.room(&target)).await?;
    let protocols = browser_auth::websocket_protocol(&h)
        .into_iter()
        .collect::<Vec<_>>();
    Ok(ws
        .protocols(protocols)
        .max_message_size(6 * MB)
        .on_upgrade(move |socket| async move {
            let _visitor = visitor;
            socket_loop(socket, s, d.id, r, h, a).await
        }))
}
async fn socket_access(
    s: &App,
    id: &str,
    headers: &HeaderMap,
    access: &Access,
    checked: &mut peers::PermissionCheck,
    force: bool,
) -> Result<()> {
    loop {
        let generation = s.permissions.current();
        if !checked.needs_check(generation, force) {
            return Ok(());
        }
        let document = id.to_string();
        let headers = headers.clone();
        let access = access.clone();
        let result = job(s.clone(), move |s| {
            s.doc(&document)
                .and_then(|d| s.access(&headers, &d, &access))?;
            Ok(())
        })
        .await;
        if s.permissions.current() != generation {
            // Never cache an old result under a newer generation when a share
            // or session mutation completed while the check was queued.
            continue;
        }
        result?;
        checked.checked(generation);
        return Ok(());
    }
}
async fn send_socket(
    sender: &mut futures_util::stream::SplitSink<WebSocket, WsMessage>,
    frame: WsMessage,
) -> bool {
    // A peer which never reads must not keep a visitor slot by blocking the
    // heartbeat in a full TCP send buffer. Slow clients retain their draft.
    tokio::time::timeout(peers::PING_INTERVAL * 2, sender.send(frame))
        .await
        .is_ok_and(|result| result.is_ok())
}
async fn close_socket(
    sender: &mut futures_util::stream::SplitSink<WebSocket, WsMessage>,
    receiver: &mut futures_util::stream::SplitStream<WebSocket>,
) {
    // Drain the peer's already queued handshake through the close exchange.
    // Dropping a TCP socket with unread data can reset it and lose the error
    // frame which tells an older editor to preserve and recover its draft.
    let _ = tokio::time::timeout(std::time::Duration::from_millis(250), async {
        if sender.send(WsMessage::Close(None)).await.is_err() {
            return;
        }
        while let Some(frame) = receiver.next().await {
            if matches!(frame, Ok(WsMessage::Close(_)) | Err(_)) {
                break;
            }
        }
    })
    .await;
}
async fn socket_loop(
    socket: WebSocket,
    s: App,
    id: String,
    room: Arc<Mutex<Room>>,
    h: HeaderMap,
    a: Access,
) {
    let (mut sender, mut receiver) = socket.split();
    let document_id = id.clone();
    let access_epoch = a.epoch.clone();
    let outdated = job(s.clone(), move |s| {
        Ok(s.epoch(&document_id)
            .is_ok_and(|epoch| access_epoch.as_deref().unwrap_or("") != epoch))
    })
    .await
    .unwrap_or(true);
    if (h.contains_key(header::ORIGIN) && a.client.as_deref() != Some("plain-text-v2")) || outdated
    {
        // Old editors cannot safely interpret the new source records. Their
        // existing error handler stops reconnecting and preserves local drafts.
        let _ = send_socket(&mut sender, WsMessage::Binary(Message::Custom(125,
            b"Locdoc was updated. Reload to continue. Your unsaved browser draft is kept here.".to_vec()
        ).encode_v1().into())).await;
        close_socket(&mut sender, &mut receiver).await;
        return;
    }
    let mut peer = Peer::default();
    let target = room.clone();
    let document_id = id.clone();
    let headers = h.clone();
    let access = a.clone();
    let initial = doc_job(s.clone(), id.clone(), move |s| {
        s.doc(&document_id)
            .and_then(|d| s.access(&headers, &d, &access))?;
        let mut r = target.lock().unwrap();
        r.ensure_committed(s, &s.doc(&document_id)?)?;
        let rx = r.tx.subscribe();
        let mut frames = vec![
            r.projection_status(),
            Message::Sync(SyncMessage::SyncStep1(
                r.awareness.doc().transact().state_vector(),
            ))
            .encode_v1(),
        ];
        if let Ok(u) = r.awareness.update() {
            frames.push(Message::Awareness(u).encode_v1());
        }
        Ok((rx, frames))
    })
    .await;
    let Ok((mut rx, initial)) = initial else {
        return;
    };
    for data in initial {
        if !send_socket(&mut sender, WsMessage::Binary(data.into())).await {
            return;
        }
    }
    let mut pulse = tokio::time::interval(peers::PING_INTERVAL);
    pulse.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut heartbeat = peers::Heartbeat::default();
    let mut permission = peers::PermissionCheck::default();
    let mut frames = 0u32;
    'connection: loop {
        tokio::select! {
            incoming = receiver.next() => match incoming {
                Some(Ok(WsMessage::Binary(bytes))) => {
                    frames += 1;
                    if frames > 1500 { break; }
                    let document_id = id.clone();
                    let mut state = std::mem::take(&mut peer);
                    let target = room.clone();
                    let headers = h.clone();
                    let access = a.clone();
                    let outcome = doc_job(s.clone(), id.clone(), move |s| {
                        // Authorization belongs after the work queue as well:
                        // a link may have been revoked while this job waited.
                        let result = s.doc(&document_id).and_then(|current| {
                            let (owner, edit) = s.access(&headers, &current, &access)?;
                            process_frame(s, &current, &target, &bytes, edit, owner, &mut state)
                        });
                        Ok((state, result))
                    }).await;
                    let result = match outcome { Ok((state, result)) => { peer = state; result }, Err(error) => Err(error) };
                    match result {
                        Ok(responses) => {
                            for frame in responses {
                                if !send_socket(&mut sender, WsMessage::Binary(frame.into())).await { break 'connection; }
                            }
                        }
                        Err(e) => {
                            tracing::warn!("sync rejected: {}", e.1);
                            let _ = send_socket(&mut sender, WsMessage::Binary(Message::Custom(if e.0.is_server_error() {120} else {125}, e.1.into_bytes()).encode_v1().into())).await;
                            break;
                        }
                    }
                }
                Some(Ok(WsMessage::Pong(bytes))) => heartbeat.pong(&bytes),
                Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            },
            outgoing = rx.recv() => match outgoing {
                Ok(data) => {
                    if data == [126] { break; }
                    if socket_access(&s, &id, &h, &a, &mut permission, false).await.is_err() { break; }
                    let Some(data) = peer.presence.outgoing(data) else { continue; };
                    if !send_socket(&mut sender, WsMessage::Binary(data.into())).await { break; }
                }
                Err(_) => break,
            },
            _ = pulse.tick() => {
                frames = 0;
                // Filesystem replacement and natural session expiry need a
                // live check even when no settings generation has changed.
                if socket_access(&s, &id, &h, &a, &mut permission, true).await.is_err() { break; }
                let Some(nonce) = heartbeat.ping() else { break; };
                if !send_socket(&mut sender, WsMessage::Ping(nonce.to_vec().into())).await { break; }
            }
        }
    }
    let _ = doc_job(s.clone(), id, move |_| {
        let mut r = room.lock().unwrap();
        r.detach(&peer);
        Ok(())
    })
    .await;
    close_socket(&mut sender, &mut receiver).await;
}
fn valid_presence(json: &str) -> bool {
    fn color(v: &Value, alpha: bool) -> bool {
        v.as_str().is_some_and(|s| {
            (s.len() == 7 || (alpha && s.len() == 9))
                && s.starts_with('#')
                && s[1..].bytes().all(|b| b.is_ascii_hexdigit())
        })
    }
    fn position(v: &Value) -> bool {
        let Some(p) = v.as_object() else {
            return false;
        };
        let id = |v: &Value| {
            v.as_object().is_some_and(|o| {
                o.get("client")
                    .and_then(Value::as_u64)
                    .is_some_and(|n| n <= 9_007_199_254_740_991)
                    && o.get("clock")
                        .and_then(Value::as_u64)
                        .is_some_and(|n| n <= u32::MAX as u64)
            })
        };
        p.get("type").is_none_or(|v| v.is_null() || id(v))
            && p.get("item").is_none_or(|v| v.is_null() || id(v))
            && p.get("tname")
                .is_none_or(|v| v.is_null() || v.as_str().is_some_and(|s| s.len() <= 100))
            && p.get("assoc")
                .is_none_or(|v| v.as_i64().is_some_and(|n| i32::try_from(n).is_ok()))
    }
    let Ok(value) = serde_json::from_str::<Value>(json) else {
        return false;
    };
    if value.is_null() {
        return true;
    }
    let Some(state) = value.as_object() else {
        return false;
    };
    let user_ok = state.get("user").is_none_or(|user| {
        user.as_object().is_some_and(|u| {
            u.get("name").and_then(Value::as_str).is_some_and(|n| {
                !n.trim().is_empty() && n.chars().count() <= 60 && !n.chars().any(char::is_control)
            }) && u.get("color").is_none_or(|v| color(v, false))
                && u.get("colorLight").is_none_or(|v| color(v, true))
        })
    });
    user_ok
        && state.get("cursor").is_none_or(|cursor| {
            cursor.is_null()
                || cursor.as_object().is_some_and(|c| {
                    c.get("anchor").is_some_and(position) && c.get("head").is_some_and(position)
                })
        })
}
struct Peer {
    id: uuid::Uuid,
    presence: peers::Presence,
    media_paths: HashSet<PathBuf>,
    awaiting_sync: bool,
    held_receipt: Option<String>,
}
impl Default for Peer {
    fn default() -> Self {
        Self {
            id: uuid::Uuid::new_v4(),
            presence: peers::Presence::default(),
            media_paths: HashSet::new(),
            awaiting_sync: false,
            held_receipt: None,
        }
    }
}

async fn versions(
    State(s): State<App>,
    AxPath(id): AxPath<String>,
    _owner: security::Owner,
) -> Result<Json<Value>> {
    versions_payload(&s, &id).map(Json)
}
fn versions_payload(s: &Store, id: &str) -> Result<Value> {
    s.doc(id)?;
    let db = s.db.lock().unwrap();
    let mut query = db.prepare(
        "SELECT id,substr(content,1,120),length(content),created FROM revisions WHERE doc=? ORDER BY rowid DESC",
    )?;
    let rows = query
        .query_map([id], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "preview": row.get::<_, String>(1)?,
                "bytes": row.get::<_, i64>(2)?,
                "created": row.get::<_, i64>(3)?,
            }))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(json!({"versions": rows}))
}
async fn version(
    State(s): State<App>,
    AxPath((id, revision)): AxPath<(String, String)>,
    _owner: security::Owner,
) -> Result<Json<Value>> {
    version_content(&s, &id, &revision).map(|content| Json(json!({"content": content})))
}
fn version_content(s: &Store, id: &str, revision: &str) -> Result<String> {
    s.doc(id)?;
    s.db.lock()
        .unwrap()
        .query_row(
            "SELECT content FROM revisions WHERE id=? AND doc=?",
            params![revision, id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| bad("Version not found."))
}
async fn restore(
    State(s): State<App>,
    AxPath((id, revision)): AxPath<(String, String)>,
    _owner: security::Owner,
) -> Result<Json<Value>> {
    doc_job(s, id.clone(), move |s| restore_document(s, id, revision))
        .await
        .map(Json)
}
fn restore_document(s: &Store, id: String, revision: String) -> Result<Value> {
    let d = s.doc(&id)?;
    let content: Option<String> =
        s.db.lock()
            .unwrap()
            .query_row(
                "SELECT content FROM revisions WHERE id=? AND doc=?",
                params![revision, id],
                |r| r.get(0),
            )
            .optional()?;
    let content = content.ok_or_else(|| bad("Version not found."))?;
    let room = s.room(&d)?;
    let mut r = room.lock().unwrap();
    r.restore(s, &d, &content)?;
    Ok(json!({"ok":true}))
}
fn allowed_mime(mime: &str) -> bool {
    [
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "image/avif",
        "video/mp4",
        "video/webm",
        "video/quicktime",
    ]
    .contains(&mime)
}
async fn guard(
    State(s): State<App>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    let parsed = url::Url::parse(&format!("http://{host}"));
    let hostname = parsed
        .as_ref()
        .ok()
        .and_then(|u| u.host_str())
        .unwrap_or("");
    let public = url::Url::parse(&s.public_url).ok();
    if !["localhost", "127.0.0.1", "[::1]"].contains(&hostname)
        && public.as_ref().and_then(|u| u.host_str()) != Some(hostname)
    {
        return denied().into_response();
    }
    let path = req.uri().path();
    let oauth_exchange = matches!(path, "/oauth/register" | "/oauth/token" | "/oauth/revoke");
    let mcp = path == "/mcp";
    if mcp
        && req.headers().contains_key(header::ORIGIN)
        && !security::origin_allowed(&s.public_url, &s.bind, req.headers())
        && !req.headers().get(header::ORIGIN).is_some_and(|origin| {
            matches!(
                origin.as_bytes(),
                b"https://chatgpt.com" | b"https://platform.openai.com"
            )
        })
    {
        return denied().into_response();
    }
    if (path.starts_with("/ws/")
        || !matches!(
            *req.method(),
            axum::http::Method::GET | axum::http::Method::HEAD | axum::http::Method::OPTIONS
        ))
        && !oauth_exchange
        && !mcp
        && let Err(error) = origin_check(&s, req.headers())
    {
        return error.into_response();
    }
    if path.starts_with("/api/")
        || path.starts_with("/ws/")
        || path.starts_with("/s/")
        || path.starts_with("/oauth/")
        || path.starts_with("/.well-known/")
        || mcp
    {
        let peer = req
            .extensions()
            .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
            .map(|p| p.0.ip());
        let ip = peer
            .map(|peer| peers::address(req.headers(), peer).to_string())
            .unwrap_or_else(|| "local".into());
        let (method, limit) = if path == "/api/login"
            || path == "/api/redeem"
            || path == "/oauth/register"
            || path == "/oauth/authorize"
        {
            ("login", 15)
        } else if path == "/api/fonts" && req.method() == axum::http::Method::POST {
            ("fonts", 6)
        } else if path.ends_with("/link-preview") || path.starts_with("/s/") {
            ("previews", 30)
        } else if path.ends_with("/upload") {
            ("uploads", 40)
        } else if path.starts_with("/ws/") {
            ("socket", 80)
        } else {
            ("api", 600)
        };
        let owner = s.owner(req.headers());
        let mut rates = s.rates.lock().unwrap();
        let time = now();
        if rates.len() > 10_000 {
            rates.retain(|_, v| time - v.0 < 60);
        }
        let bucket = if owner {
            format!("owner:{method}")
        } else {
            format!("{ip}:{method}")
        };
        if rates.len() >= 20_000 && !owner && !rates.contains_key(&bucket) {
            return ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                "Server is busy. Try again shortly.".into(),
            )
            .into_response();
        }
        let entry = rates.entry(bucket).or_insert((time, 0));
        if time - entry.0 >= 60 {
            *entry = (time, 0)
        }
        entry.1 += 1;
        if entry.1 > limit {
            return ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                "Too many requests. Try again in a minute.".into(),
            )
            .into_response();
        }
    }
    if mcp
        && *req.method() != axum::http::Method::OPTIONS
        && let Err(error) = mcp_auth::authorize(&s, req.headers())
    {
        let mut response = error.into_response();
        if let Ok(challenge) = axum::http::HeaderValue::from_str(&format!(
            "Bearer resource_metadata=\"{}/.well-known/oauth-protected-resource/mcp\"",
            s.public_url
        )) {
            response
                .headers_mut()
                .insert(header::WWW_AUTHENTICATE, challenge);
        }
        mcp_cors(req.headers(), response.headers_mut());
        return response;
    }
    if *req.method() == axum::http::Method::OPTIONS
        && (mcp || oauth_exchange || path.starts_with("/.well-known/"))
    {
        let mut response = StatusCode::NO_CONTENT.into_response();
        mcp_cors(req.headers(), response.headers_mut());
        return response;
    }
    next.run(req).await
}
fn mcp_cors(request: &HeaderMap, response: &mut HeaderMap) {
    if let Some(origin) = request.get(header::ORIGIN) {
        response.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin.clone());
        response.insert(header::VARY, axum::http::HeaderValue::from_static("Origin"));
    }
    response.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        axum::http::HeaderValue::from_static("GET, POST, DELETE, OPTIONS"),
    );
    response.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        axum::http::HeaderValue::from_static(
            "Content-Type, Authorization, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
        ),
    );
    response.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        axum::http::HeaderValue::from_static(
            "WWW-Authenticate, Mcp-Session-Id, MCP-Protocol-Version",
        ),
    );
}
const CONTENT_SECURITY_POLICY: &str = concat!(
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; ",
    "font-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; ",
    "connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; object-src 'none'"
);
async fn response_headers(req: axum::extract::Request, next: axum::middleware::Next) -> Response {
    let cacheable = req.uri().path().starts_with("/assets/");
    let connector = req.uri().path() == "/mcp"
        || req.uri().path().starts_with("/oauth/")
        || req.uri().path().starts_with("/.well-known/");
    let request_headers = connector.then(|| req.headers().clone());
    let mut response = next.run(req).await;
    let ok = response.status().is_success();
    let headers = response.headers_mut();
    if let Some(request) = &request_headers {
        mcp_cors(request, headers);
    }
    let html = headers
        .get(header::CONTENT_TYPE)
        .is_some_and(|v| v.as_bytes().starts_with(b"text/html"));
    let caching = if cacheable && ok {
        "public, max-age=31536000, immutable"
    } else if html {
        "no-store, no-transform"
    } else {
        "no-store"
    };
    headers.insert(
        header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static(caching),
    );
    for (name, value) in [
        ("x-content-type-options", "nosniff"),
        ("referrer-policy", "no-referrer"),
        ("x-frame-options", "SAMEORIGIN"),
        ("content-security-policy", CONTENT_SECURITY_POLICY),
    ] {
        headers.insert(name, axum::http::HeaderValue::from_static(value));
    }
    response
}
fn router(s: App) -> Router {
    Router::new()
        .route_service("/mcp", mcp::service(s.clone()))
        .route(
            "/.well-known/oauth-protected-resource/mcp",
            get(mcp_auth::resource_metadata),
        )
        .route(
            "/.well-known/oauth-protected-resource",
            get(mcp_auth::resource_metadata),
        )
        .route(
            "/.well-known/oauth-authorization-server",
            get(mcp_auth::authorization_metadata),
        )
        .route(
            "/oauth/register",
            post(mcp_auth::register).layer(DefaultBodyLimit::max(16 * 1024)),
        )
        .route("/oauth/authorize", get(mcp_auth::begin_authorization))
        .route(
            "/oauth/token",
            post(mcp_auth::exchange).layer(DefaultBodyLimit::max(16 * 1024)),
        )
        .route(
            "/oauth/revoke",
            post(mcp_auth::revoke_token).layer(DefaultBodyLimit::max(16 * 1024)),
        )
        .route(
            "/api/mcp/authorize",
            get(mcp_auth::consent_preview).post(mcp_auth::consent),
        )
        .route("/api/mcp/connections", get(mcp_auth::connections))
        .route(
            "/api/mcp/connections/{id}/revoke",
            post(mcp_auth::disconnect),
        )
        .route("/api/recovery/removed", get(maintenance::removed))
        .route("/api/docs/{id}/recovery", get(maintenance::export))
        .route("/api/docs/{id}/rebuild", post(maintenance::rebuild))
        .route("/api/open/{token}", get(open_shared))
        .route("/api/docs/{id}/versions", get(versions))
        .route("/api/docs/{id}/versions/{revision}", get(version))
        .route("/api/docs/{id}/versions/{revision}/restore", post(restore))
        .route("/api/ticket", post(issue_ticket))
        .route("/api/redeem", post(redeem))
        .route("/api/config", get(config))
        .route("/api/login", post(login))
        .route("/api/logout", post(logout))
        .route(
            "/api/folders/share",
            get(folders::read).post(folders::share),
        )
        .route(
            "/api/folders/mcp",
            get(mcp_access::read_folder).post(mcp_access::change_folder),
        )
        .route("/api/tree", get(tree))
        .route("/api/files", post(create))
        .route("/api/shared/{token}", get(shared))
        .route("/api/docs/{id}", get(document).patch(rename))
        .route("/api/docs/{id}/share", post(share))
        .route(
            "/api/docs/{id}/mcp",
            get(mcp_access::read_document).post(mcp_access::change_document),
        )
        .route("/api/docs/{id}/link-preview", get(links::preview))
        .route(
            "/api/docs/{id}/comments",
            get(comments::list).post(comments::add),
        )
        .route("/api/docs/{id}/comments/{cid}", patch(comments::edit))
        .route(
            "/api/docs/{id}/upload",
            post(upload).layer(DefaultBodyLimit::max(21 * MB)),
        )
        .route("/api/docs/{id}/media", get(media))
        .route("/api/fonts", get(font_list).post(install_font))
        .route("/api/fonts.css", get(font_css))
        .route("/ws/{id}", get(websocket))
        .nest_service("/fonts", ServeDir::new(s.data.join("fonts")))
        .route("/", get(web::shell))
        .route("/index.html", get(web::shell))
        .route("/d/{id}", get(web::shell))
        .route("/d/{id}/", get(web::shell))
        .route("/s/{token}", get(web::shell))
        .route("/s/{token}/", get(web::shell))
        .route("/s/{token}/preview.png", get(web::preview_image))
        .fallback_service(ServeDir::new(s.web_root.clone()))
        .layer(DefaultBodyLimit::max(64 * 1024))
        .layer(axum::middleware::from_fn(response_headers))
        .layer(axum::middleware::from_fn_with_state(s.clone(), guard))
        .layer(axum::middleware::from_fn(web::observe_crawlers))
        .with_state(s)
}
#[tokio::main]
async fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "locdoc=info".into()),
        )
        .init();
    let root = std::env::var("LOCDOC_DOCS").unwrap_or_else(|_| "docs".into());
    let data = std::env::var("LOCDOC_STATE").unwrap_or_else(|_| ".locdoc".into());
    let public =
        std::env::var("LOCDOC_PUBLIC_URL").unwrap_or_else(|_| "http://127.0.0.1:3477".into());
    let bind = std::env::var("LOCDOC_BIND").unwrap_or_else(|_| "127.0.0.1:3477".into());
    let s = Store::open(root.into(), data.into(), public)?;
    job(s.clone(), |s| s.recover_pending()).await?;
    let _watcher = projection::watch(s.clone())?;
    tracing::info!(
        "Locdoc listening at http://{bind}; owner key: {}/owner.key",
        s.data.display()
    );
    axum::serve(
        tokio::net::TcpListener::bind(&bind)
            .await?
            .tap_io(|stream| {
                // Small real-time deltas should not wait for TCP's delayed-ACK /
                // Nagle interaction. Persistence and save receipts remain unchanged.
                if let Err(error) = stream.set_nodelay(true) {
                    tracing::warn!("could not enable low-latency connections: {error}");
                }
            }),
        router(s).into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn peer_update(room: &Arc<Mutex<Room>>, append: &str) -> Vec<u8> {
        let peer = Doc::with_options(Options {
            offset_kind: OffsetKind::Utf16,
            ..Options::default()
        });
        let state = room
            .lock()
            .unwrap()
            .awareness
            .doc()
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        peer.transact_mut()
            .apply_update(Update::decode_v1(&state).unwrap())
            .unwrap();
        let before = peer.transact().state_vector();
        let text = peer.get_or_insert_text("content");
        let len = text.len(&peer.transact());
        text.insert(&mut peer.transact_mut(), len, append);
        Message::Sync(SyncMessage::Update(
            peer.transact().encode_state_as_update_v1(&before),
        ))
        .encode_v1()
    }
    #[test]
    fn save_checkpoint_confirms_an_ordered_persisted_operation() {
        let (_dir, s) = store();
        fs::write(s.root.join("ack.md"), "Hello 👋").unwrap();
        let d = s.index_document("ack.md").unwrap();
        let room = s.room(&d).unwrap();
        let update = peer_update(&room, " saved");
        let mut peer = Peer::default();
        process_frame(&s, &d, &room, &update, true, true, &mut peer).unwrap();
        assert_eq!(
            fs::read_to_string(s.root.join("ack.md")).unwrap(),
            "Hello 👋"
        );
        let mut events = room.lock().unwrap().tx.subscribe();
        let receipt = uuid::Uuid::new_v4().to_string();
        let frame = Message::Custom(124, receipt.as_bytes().to_vec()).encode_v1();
        let replies = process_frame(&s, &d, &room, &frame, true, true, &mut peer).unwrap();
        let Message::Custom(122, payload) = Message::decode_v1(replies.last().unwrap()).unwrap()
        else {
            panic!("Missing pending acknowledgement");
        };
        assert_eq!(payload, receipt.as_bytes());
        assert!(s.persist(&d, &mut room.lock().unwrap()).unwrap());
        let mut saved = false;
        while let Ok(event) = events.try_recv() {
            if let Message::Custom(127, payload) = Message::decode_v1(&event).unwrap() {
                saved |= payload == receipt.as_bytes();
            }
        }
        assert!(saved, "Save receipt must follow the fsynced projection");
        assert_eq!(
            fs::read_to_string(s.root.join("ack.md")).unwrap(),
            "Hello 👋 saved"
        );
    }
    #[test]
    fn open_desktop_writer_defers_projection_and_receipt_until_the_complete_save() {
        use std::io::Write;
        use std::os::unix::fs::MetadataExt;
        let (_dir, s) = store();
        let path = s.root.join("writer.md");
        fs::write(&path, "Original").unwrap();
        let d = s.index_document("writer.md").unwrap();
        let room = s.room(&d).unwrap();
        s.persist(&d, &mut room.lock().unwrap()).unwrap();
        let inode = fs::metadata(&path).unwrap().ino();
        let mut desktop = fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&path)
            .unwrap();
        desktop.write_all(b"Desktop first half.").unwrap();
        let update = peer_update(&room, " Browser addition.");
        process_frame(&s, &d, &room, &update, true, true, &mut Peer::default()).unwrap();
        let receipt = uuid::Uuid::new_v4().to_string();
        let frame = Message::Custom(124, receipt.as_bytes().to_vec()).encode_v1();
        let mut events = room.lock().unwrap().tx.subscribe();
        let deferred =
            process_frame(&s, &d, &room, &frame, true, true, &mut Peer::default()).unwrap();
        assert!(matches!(
            Message::decode_v1(&deferred[0]).unwrap(),
            Message::Custom(122, _)
        ));
        for _ in 0..3 {
            assert!(!s.persist(&d, &mut room.lock().unwrap()).unwrap());
        }
        assert_eq!(fs::read_to_string(&path).unwrap(), "Desktop first half.");
        assert!(!room_text(&room.lock().unwrap()).contains("first half"));
        while let Ok(event) = events.try_recv() {
            assert!(
                matches!(Message::decode_v1(&event).unwrap(), Message::Custom(121, _)),
                "A held writer may update status but cannot publish partial source or a save receipt"
            );
        }
        desktop.write_all(b" Desktop second half.").unwrap();
        drop(desktop);
        assert!(s.persist(&d, &mut room.lock().unwrap()).unwrap());
        let actual = fs::read_to_string(&path).unwrap();
        assert_eq!(
            actual.replace(" Browser addition.", ""),
            "Desktop first half. Desktop second half."
        );
        assert!(actual.contains("Browser addition."), "{actual}");
        assert_eq!(fs::metadata(&path).unwrap().ino(), inode);
        let mut received = false;
        while let Ok(event) = events.try_recv() {
            if let Ok(Message::Custom(127, bytes)) = Message::decode_v1(&event) {
                received |= bytes == receipt.as_bytes();
            }
        }
        assert!(received);
    }
    #[test]
    fn readers_allow_desktop_imports_but_never_acknowledge_unprojected_browser_writes() {
        let (_dir, s) = store();
        let path = s.root.join("reader.md");
        fs::write(&path, "Original").unwrap();
        let d = s.index_document("reader.md").unwrap();
        let reader = fs::File::open(&path).unwrap();
        // A reader also cannot block the first authenticated snapshot.
        let room = s.room(&d).unwrap();
        s.persist(&d, &mut room.lock().unwrap()).unwrap();
        fs::write(&path, "Completed desktop save").unwrap();
        let mut events = room.lock().unwrap().tx.subscribe();
        assert!(s.persist(&d, &mut room.lock().unwrap()).unwrap());
        assert_eq!(room_text(&room.lock().unwrap()), "Completed desktop save");
        assert!(matches!(
            Message::decode_v1(&events.try_recv().unwrap()).unwrap(),
            Message::Sync(SyncMessage::Update(_))
        ));

        let update = peer_update(&room, " Browser addition.");
        process_frame(&s, &d, &room, &update, true, true, &mut Peer::default()).unwrap();
        let receipt = uuid::Uuid::new_v4().to_string();
        let checkpoint = Message::Custom(124, receipt.as_bytes().to_vec()).encode_v1();
        let response =
            process_frame(&s, &d, &room, &checkpoint, true, true, &mut Peer::default()).unwrap();
        assert!(matches!(
            Message::decode_v1(&response[0]).unwrap(),
            Message::Custom(122, _)
        ));
        assert_eq!(fs::read_to_string(&path).unwrap(), "Completed desktop save");
        fs::write(&path, "Another completed desktop save").unwrap();
        assert!(!s.persist(&d, &mut room.lock().unwrap()).unwrap());
        assert_eq!(
            room_text(&room.lock().unwrap()),
            "Another completed desktop save Browser addition."
        );
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "Another completed desktop save"
        );
        drop(reader);
        assert!(s.persist(&d, &mut room.lock().unwrap()).unwrap());
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "Another completed desktop save Browser addition."
        );
        assert!(room.lock().unwrap().engine.receipts.is_empty());
    }
    #[test]
    fn pending_browser_edits_and_the_disk_baseline_survive_restart_with_a_writer_open() {
        use std::io::Write;
        let (dir, s) = store();
        let path = s.root.join("restart.md");
        fs::write(&path, "Original").unwrap();
        let d = s.index_document("restart.md").unwrap();
        let room = s.room(&d).unwrap();
        s.persist(&d, &mut room.lock().unwrap()).unwrap();
        let mut desktop = fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&path)
            .unwrap();
        desktop.write_all(b"Complete ").unwrap();
        let frame = peer_update(&room, " Browser survives");
        process_frame(&s, &d, &room, &frame, true, true, &mut Peer::default()).unwrap();
        drop(room);
        drop(s);
        let s = Store::open(
            dir.path().join("docs"),
            dir.path().join("state"),
            "http://localhost:3477".into(),
        )
        .unwrap();
        let room = s.room(&d).unwrap();
        assert!(!s.persist(&d, &mut room.lock().unwrap()).unwrap());
        desktop.write_all(b"desktop save").unwrap();
        drop(desktop);
        assert!(s.persist(&d, &mut room.lock().unwrap()).unwrap());
        let actual = fs::read_to_string(path).unwrap();
        assert_eq!(
            actual.replace(" Browser survives", ""),
            "Complete desktop save"
        );
        assert!(actual.contains("Browser survives"), "{actual}");
    }
    #[test]
    fn interrupted_projection_recovers_from_wal_and_preserves_observed_disk_as_a_version() {
        let (dir, s) = store();
        let path = s.root.join("crash.md");
        fs::write(&path, "Original").unwrap();
        let d = s.index_document("crash.md").unwrap();
        let room = s.room(&d).unwrap();
        s.persist(&d, &mut room.lock().unwrap()).unwrap();
        {
            let mut r = room.lock().unwrap();
            let text = r.awareness.doc().get_or_insert_text("content");
            text.insert(
                &mut r.awareness.doc().transact_mut(),
                8,
                " committed browser text",
            );
            let target = text::render(&room_text(&r), r.engine.ending()).into_bytes();
            r.freeze_projection(target);
            s.store_room(&d, &mut r).unwrap();
        }
        fs::write(&path, "Original committed").unwrap();
        drop(room);
        drop(s);
        let s = Store::open(
            dir.path().join("docs"),
            dir.path().join("state"),
            "http://localhost:3477".into(),
        )
        .unwrap();
        let room = s.room(&d).unwrap();
        s.persist(&d, &mut room.lock().unwrap()).unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "Original committed browser text"
        );
        let count: i64 =
            s.db.lock()
                .unwrap()
                .query_row(
                    "SELECT count(*) FROM revisions WHERE doc=? AND content='Original committed'",
                    [&d.id],
                    |r| r.get(0),
                )
                .unwrap();
        assert_eq!(count, 1);
    }
    #[test]
    fn attachment_capacity_tracks_references_and_expiring_reservations_without_deleting_media() {
        let (_dir, s) = store();
        fs::write(s.root.join("assets.md"), "Hello").unwrap();
        let d = s.index_document("assets.md").unwrap();
        fs::create_dir_all(s.root.join(".assets")).unwrap();
        let path = s.root.join(".assets/picture.png");
        fs::write(&path, vec![0; 5 * MB]).unwrap();
        s.db.lock()
            .unwrap()
            .execute(
                "INSERT INTO assets(doc,path,bytes,pending_until) VALUES(?,?,?,?)",
                params![d.id, ".assets/picture.png", (5 * MB) as i64, now() + 600],
            )
            .unwrap();
        assert_eq!(s.usage(&d, "Hello"), 5 * MB);
        s.settle_uploads(&d, "![picture](.assets/picture.png)")
            .unwrap();
        assert_eq!(s.usage(&d, "![picture](.assets/picture.png)"), 5 * MB);
        assert_eq!(s.usage(&d, "Hello"), 0);
        assert!(path.exists(), "Undo/version restore must retain the file");
        s.db.lock()
            .unwrap()
            .execute("UPDATE assets SET pending_until=?", [now() - 1])
            .unwrap();
        assert_eq!(s.usage(&d, "Hello"), 0);
        assert!(s.attachment_allowed(&d, &path));
    }
    #[test]
    fn malformed_viewer_presence_is_rejected_before_broadcast() {
        let (_dir, s) = store();
        fs::write(s.root.join("presence.md"), "Hello").unwrap();
        let d = s.index_document("presence.md").unwrap();
        let room = s.room(&d).unwrap();
        let mut peer = Awareness::new(Doc::new());
        peer.set_local_state(json!({"user":{"name":42,"color":"#487495"}}))
            .unwrap();
        let frame = Message::Awareness(peer.update().unwrap()).encode_v1();
        assert!(process_frame(&s, &d, &room, &frame, false, false, &mut Peer::default()).is_err());
        peer.set_local_state(json!({"user":{"name":"Alice","color":"#487495"}}))
            .unwrap();
        let frame = Message::Awareness(peer.update().unwrap()).encode_v1();
        assert!(process_frame(&s, &d, &room, &frame, false, false, &mut Peer::default()).is_ok());
        for invalid in [
            json!({"user":{"name":"Alice","color":"red;position:fixed"}}),
            json!({"cursor":{"anchor":{"item":{"client":1,"clock":"bad"}},"head":{}}}),
            json!({"user":{"name":"\n"}}),
        ] {
            assert!(!valid_presence(&invalid.to_string()));
        }
    }
    #[test]
    fn owner_typing_does_not_bless_existing_anonymous_references() {
        let (dir, s) = store();
        fs::write(s.root.join("trust.md"), "Hello").unwrap();
        let d = s.index_document("trust.md").unwrap();
        let room = s.room(&d).unwrap();
        let update = peer_update(&room, "\n![planted](future.png)");
        assert!(process_frame(&s, &d, &room, &update, true, false, &mut Peer::default()).is_err());
        let update = peer_update(&room, "\n![planted](future.png");
        process_frame(&s, &d, &room, &update, true, false, &mut Peer::default()).unwrap();
        let update = peer_update(&room, "\nOwner types an unrelated sentence.");
        process_frame(&s, &d, &room, &update, true, true, &mut Peer::default()).unwrap();
        let update = peer_update(&room, "\n![owner added](intentional.png)");
        process_frame(&s, &d, &room, &update, true, true, &mut Peer::default()).unwrap();
        fs::write(s.root.join("future.png"), b"private").unwrap();
        fs::write(s.root.join("intentional.png"), b"public").unwrap();
        // Trust provenance must survive a full process restart, not only room eviction.
        drop(room);
        drop(s);
        let s = Store::open(
            dir.path().join("docs"),
            dir.path().join("state"),
            "http://localhost:3477".into(),
        )
        .unwrap();
        let _room = s.room(&d).unwrap();
        assert!(!s.attachment_allowed(&d, &s.media_path(&d, "future.png").unwrap()));
        assert!(!s.attachment_allowed(&d, &s.media_path(&d, "intentional.png").unwrap()));
        s.grant_new_references(&d, "", "![approved](intentional.png)")
            .unwrap();
        assert!(s.attachment_allowed(&d, &s.media_path(&d, "intentional.png").unwrap()));
    }
    #[test]
    fn desktop_import_only_activates_references_introduced_by_that_change() {
        let (_dir, s) = store();
        fs::write(s.root.join("trust.md"), "Hello").unwrap();
        let d = s.index_document("trust.md").unwrap();
        let room = s.room(&d).unwrap();
        let planted = "\n![planted](future.png";
        process_frame(
            &s,
            &d,
            &room,
            &peer_update(&room, planted),
            true,
            false,
            &mut Peer::default(),
        )
        .unwrap();
        // Finishing guest markup in the browser does not publish the image.
        process_frame(
            &s,
            &d,
            &room,
            &peer_update(&room, ")"),
            true,
            true,
            &mut Peer::default(),
        )
        .unwrap();
        fs::write(s.root.join("future.png"), b"private").unwrap();
        let untrusted = s.media_path(&d, "future.png").unwrap();
        // A desktop save while browser projection is pending must not bless
        // a reference already present in accepted source.
        fs::write(
            s.root.join("trust.md"),
            "Hello\n![planted](future.png)\nDesktop sentence.",
        )
        .unwrap();
        s.persist(&d, &mut room.lock().unwrap()).unwrap();
        assert!(!s.active_attachment_allowed(&d, &untrusted));
        assert!(!s.attachment_allowed(&d, &untrusted));
        fs::write(
            s.root.join("trust.md"),
            format!(
                "{}\nAnother sentence.",
                fs::read_to_string(s.root.join("trust.md")).unwrap()
            ),
        )
        .unwrap();
        s.persist(&d, &mut room.lock().unwrap()).unwrap();
        assert!(!s.active_attachment_allowed(&d, &untrusted));
        fs::write(s.root.join("intentional.png"), b"public").unwrap();
        fs::write(
            s.root.join("trust.md"),
            format!(
                "{}\n![added locally](intentional.png)",
                fs::read_to_string(s.root.join("trust.md")).unwrap()
            ),
        )
        .unwrap();
        s.persist(&d, &mut room.lock().unwrap()).unwrap();
        assert!(s.active_attachment_allowed(&d, &s.media_path(&d, "intentional.png").unwrap()));
    }
    #[test]
    fn guest_media_uses_committed_room_source_without_breaking_its_projection_lease() {
        let (_dir, s) = store();
        fs::write(s.root.join("media.md"), "Hello").unwrap();
        let d = s.index_document("media.md").unwrap();
        s.db.lock()
            .unwrap()
            .execute(
                "UPDATE docs SET permission='edit',token='media-share' WHERE id=?",
                [&d.id],
            )
            .unwrap();
        let d = s.doc(&d.id).unwrap();
        let room = s.room(&d).unwrap();
        let image = BASE64.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFlsAAAAASUVORK5CYII=").unwrap();
        s.write_upload(&d, ".assets/media.png", &image).unwrap();
        process_frame(
            &s,
            &d,
            &room,
            &peer_update(&room, "\n![new](.assets/media.png)"),
            true,
            false,
            &mut Peer::default(),
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(s.root.join("media.md")).unwrap(),
            "Hello"
        );
        let lease = DiskFile::open(&s.root.join("media.md")).unwrap().unwrap();
        let (send, receive) = std::sync::mpsc::channel();
        let worker = s.clone();
        let id = d.id.clone();
        let request = std::thread::spawn(move || {
            let result = media_file(
                &worker,
                &id,
                &Media {
                    path: ".assets/media.png".into(),
                    token: Some("media-share".into()),
                },
                &HeaderMap::new(),
            );
            send.send(result.map(|(_, size, mime)| (size, mime)))
                .unwrap();
        });
        let response = receive.recv_timeout(std::time::Duration::from_secs(1));
        let intact = lease.intact();
        drop(lease);
        request.join().unwrap();
        assert!(
            intact,
            "Image requests must not interrupt the note's write lease"
        );
        assert_eq!(response.unwrap().unwrap(), (image.len(), "image/png"));
    }
    #[test]
    fn concurrent_unicode_edits_merge_against_the_disk_baseline() {
        let (_dir, s) = store();
        fs::write(s.root.join("unicode.md"), "a👋bc").unwrap();
        let d = s.index_document("unicode.md").unwrap();
        let room = s.room(&d).unwrap();
        {
            let mut r = room.lock().unwrap();
            r.awareness.doc().get_or_insert_text("content").insert(
                &mut r.awareness.doc().transact_mut(),
                0,
                "🌍",
            );
            fs::write(s.root.join("unicode.md"), "a👋c").unwrap();
            s.persist(&d, &mut r).unwrap();
            assert_eq!(r.engine.source(), "🌍a👋c");
        }
        s.rooms.lock().unwrap().remove(&d.id);
        assert_eq!(
            s.room(&d).unwrap().lock().unwrap().engine.source(),
            "🌍a👋c"
        );
    }
    fn store() -> (tempfile::TempDir, App) {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(
            dir.path().join("docs"),
            dir.path().join("state"),
            "http://localhost:3477".into(),
        )
        .unwrap();
        (dir, s)
    }
    #[tokio::test]
    async fn public_owner_ticket_sets_a_secure_cookie() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(
            dir.path().join("docs"),
            dir.path().join("state"),
            "https://notes.example.com".into(),
        )
        .unwrap();
        let t = token();
        s.db.lock()
            .unwrap()
            .execute(
                "INSERT INTO tickets(hash,expires) VALUES(?,?)",
                params![hash(&t), now() + 60],
            )
            .unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, "notes.example.com".parse().unwrap());
        let response = redeem(State(s), headers, Json(Redeem { ticket: t }))
            .await
            .unwrap();
        assert!(
            response
                .headers()
                .get(header::SET_COOKIE)
                .unwrap()
                .to_str()
                .unwrap()
                .contains("; Secure")
        );
    }
    #[test]
    fn utf16_desktop_diff_keeps_emoji_and_text() {
        let doc = Doc::with_options(Options {
            offset_kind: OffsetKind::Utf16,
            ..Options::default()
        });
        apply_text(&doc, "", "Hello 👋 world\n");
        apply_text(&doc, "Hello 👋 world\n", "Hello 👋 local world!\n");
        assert_eq!(
            doc.get_or_insert_text("content")
                .get_string(&doc.transact()),
            "Hello 👋 local world!\n"
        );
    }
    #[test]
    fn paths_cannot_escape_or_follow_symlinks() {
        let (_dir, s) = store();
        assert!(s.safe("../secret.md", false).is_err());
        assert!(s.safe("/etc/passwd", false).is_err());
        assert!(s.safe(".assets/x.md", false).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/tmp", s.root.join("escape")).unwrap();
            assert!(s.safe("escape/private.md", false).is_err());
        }
        assert!(s.safe("Projects/notes.md", false).is_ok());
    }
    #[test]
    fn viewers_cannot_inject_crdt_changes() {
        let (_dir, s) = store();
        fs::write(s.root.join("test.md"), "Original").unwrap();
        let d = s.index_document("test.md").unwrap();
        let room = s.room(&d).unwrap();
        let attacker = Doc::with_options(Options {
            offset_kind: OffsetKind::Utf16,
            ..Options::default()
        });
        let state = room
            .lock()
            .unwrap()
            .awareness
            .doc()
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        attacker
            .transact_mut()
            .apply_update(Update::decode_v1(&state).unwrap())
            .unwrap();
        attacker
            .get_or_insert_text("content")
            .insert(&mut attacker.transact_mut(), 0, "INJECTED ");
        let frame = Message::Sync(SyncMessage::Update(
            attacker
                .transact()
                .encode_state_as_update_v1(&StateVector::default()),
        ))
        .encode_v1();
        process_frame(&s, &d, &room, &frame, false, false, &mut Peer::default()).unwrap();
        assert_eq!(
            fs::read_to_string(s.root.join("test.md")).unwrap(),
            "Original"
        );
    }
    #[test]
    fn disk_changes_reconcile_and_survive_reopen() {
        let (_dir, s) = store();
        fs::write(s.root.join("test.md"), "Start\n").unwrap();
        let d = s.index_document("test.md").unwrap();
        let room = s.room(&d).unwrap();
        {
            let mut r = room.lock().unwrap();
            s.persist(&d, &mut r).unwrap();
            fs::write(s.root.join("test.md"), "Start\nDesktop change 👋\n").unwrap();
            s.persist(&d, &mut r).unwrap();
            assert_eq!(r.engine.source(), "Start\nDesktop change 👋\n");
        }
        s.rooms.lock().unwrap().remove(&d.id);
        let room = s.room(&d).unwrap();
        assert_eq!(
            room.lock().unwrap().engine.source(),
            "Start\nDesktop change 👋\n"
        );
    }
    #[test]
    fn owner_access_overrides_public_permissions() {
        let (_dir, s) = store();
        fs::write(s.root.join("a.md"), "A").unwrap();
        let d = s.index_document("a.md").unwrap();
        let mut h = HeaderMap::new();
        h.insert(
            header::AUTHORIZATION,
            format!("Bearer {}", s.key).parse().unwrap(),
        );
        assert_eq!(s.access(&h, &d, &Access::default()).unwrap(), (true, true));
        assert!(s.access(&HeaderMap::new(), &d, &Access::default()).is_err());
    }
    #[test]
    fn quota_counts_local_references_once() {
        let (_dir, s) = store();
        fs::write(s.root.join("a.md"), "").unwrap();
        fs::write(s.root.join("image.png"), vec![0; 1_000_000]).unwrap();
        let d = s.index_document("a.md").unwrap();
        assert_eq!(
            s.usage(&d, "![a](image.png)\n![again](image.png)"),
            1_000_000
        );
    }
    #[test]
    fn simultaneous_desktop_and_browser_edits_do_not_delete_the_wrong_character() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(
            dir.path().join("docs"),
            dir.path().join("state"),
            "http://localhost:3478".into(),
        )
        .unwrap();
        fs::write(s.root.join("race.md"), "abc").unwrap();
        let d = s.index_document("race.md").unwrap();
        let room = s.room(&d).unwrap();
        let mut r = room.lock().unwrap();
        let text = r.awareness.doc().get_or_insert_text("content");
        // The browser mutation has just been applied; persist() now sees a concurrent desktop save.
        text.insert(&mut r.awareness.doc().transact_mut(), 0, "X");
        fs::write(s.root.join("race.md"), "ac").unwrap();
        s.persist(&d, &mut r).unwrap();
        let actual = fs::read_to_string(s.root.join("race.md")).unwrap();
        assert_eq!(
            actual, "Xac",
            "The browser prepended X while the desktop deleted b; both edits should survive"
        );
    }
    #[tokio::test]
    async fn reopening_a_room_does_not_grant_an_untrusted_future_attachment() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(
            dir.path().join("docs"),
            dir.path().join("state"),
            "http://localhost:3478".into(),
        )
        .unwrap();
        fs::write(s.root.join("shared.md"), "hello\n").unwrap();
        let registered = s.index_document("shared.md").unwrap();
        s.db.lock()
            .unwrap()
            .execute(
                "UPDATE docs SET permission='edit',token='review-share' WHERE id=?",
                [&registered.id],
            )
            .unwrap();
        let d = s.doc(&registered.id).unwrap();
        let room = s.room(&d).unwrap();
        let peer = Doc::with_options(Options {
            offset_kind: OffsetKind::Utf16,
            ..Options::default()
        });
        let state = room
            .lock()
            .unwrap()
            .awareness
            .doc()
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        peer.transact_mut()
            .apply_update(Update::decode_v1(&state).unwrap())
            .unwrap();
        let before = peer.transact().state_vector();
        let text = peer.get_or_insert_text("content");
        let len = text.len(&peer.transact());
        text.insert(
            &mut peer.transact_mut(),
            len,
            "\n![private](future-private.png",
        );
        let update = peer.transact().encode_state_as_update_v1(&before);
        process_frame(
            &s,
            &d,
            &room,
            &Message::Sync(SyncMessage::Update(update)).encode_v1(),
            true,
            false,
            &mut Peer::default(),
        )
        .unwrap();
        // A later local owner action creates a private file with the guessed name.
        fs::write(s.root.join("future-private.png"),BASE64.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFlsAAAAASUVORK5CYII=").unwrap()).unwrap();
        let path = s.media_path(&d, "future-private.png").unwrap();
        assert!(!s.attachment_allowed(&d, &path));
        s.rooms.lock().unwrap().remove(&d.id);
        drop(room);
        let _reopened = s.room(&d).unwrap();
        let status = match media(
            State(s.clone()),
            AxPath(d.id.clone()),
            Query(Media {
                path: "future-private.png".into(),
                token: Some("review-share".into()),
            }),
            HeaderMap::new(),
        )
        .await
        {
            Ok(response) => response.status(),
            Err(error) => error.0,
        };
        assert_eq!(
            status,
            StatusCode::FORBIDDEN,
            "A cold room must not publish a formerly private attachment"
        );
    }
}
