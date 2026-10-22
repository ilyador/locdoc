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
mod media;
mod namespace;
mod peers;
#[cfg(test)]
mod persistence_adversarial_tests;
#[cfg(test)]
mod persistence_tests;
mod projection;
mod restored;
mod routes;
mod save;
#[cfg(test)]
mod save_adversarial_tests;
mod security;
mod sharing;
mod social;
mod sockets;
mod text;
mod validation;
mod web;
mod work;
use disk::DiskFile;
use engine::process_frame;
#[cfg(test)]
use media::{Media, media_file};
use routes::router;
#[cfg(test)]
use sharing::share;
use sharing::{Share, share_document, shared_document};
#[cfg(test)]
use sockets::socket_access;
use sockets::{Peer, valid_presence};

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
    reconciliation: namespace::Requests,
    /// Folders the last listing could not read in full, already logged.
    unlisted: Mutex<HashSet<PathBuf>>,
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
        let store = Self::open_state(root, data, public_url, false)?;
        // Serve documents even when files cannot be matched yet; the
        // maintenance loop keeps reconciling them.
        if let Err(error) = store.recover_file_operations() {
            tracing::error!("file operation recovery failed: {error}");
        }
        if let Err(error) = store.discover_file_moves() {
            tracing::error!("file discovery failed: {error}");
        }
        Ok(store)
    }
    /// State files and a documents folder just copied back from a backup, for
    /// the owner's restore pass only. The folder may be new; nothing is
    /// reconciled until that pass runs.
    fn open_restored(root: PathBuf, data: PathBuf, public_url: String) -> Result<App> {
        if !data.join("locdoc.sqlite").is_file() {
            return Err(bad(
                "The state folder has no locdoc.sqlite. Copy the backup's state files into place before running locdoc --restored.",
            ));
        }
        Self::open_state(root, data, public_url, true)
    }
    fn open_state(root: PathBuf, data: PathBuf, public_url: String, restored: bool) -> Result<App> {
        let new_data = !data.exists();
        fs::create_dir_all(&data)?;
        let data = fs::canonicalize(data)?;
        if new_data {
            disk::sync_directories(&data, Path::new("/"))?;
        }
        let state_lock = disk::StateLock::acquire(&data)?;
        let (root, root_identity) = if restored {
            documents::restored_root(&root)?
        } else {
            documents::prepare_root(&root, &data)?
        };
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
        namespace::migrate(&db)?;
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
            reconciliation: namespace::Requests::default(),
            unlisted: Mutex::new(HashSet::new()),
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(25))
                .build()
                .unwrap(),
        });
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
                Some(grant) if grant.holds(self, d) => Ok((false, grant.permission == "edit")),
                _ => Err(denied()),
            }
        }
    }
    fn media_path(&self, d: &Document, rel: &str) -> Result<PathBuf> {
        self.resolve_media(Path::new(&d.path).parent().unwrap(), rel)
    }
    /// The file a media reference names from a folder, inside the root and
    /// outside `.trash`.
    fn resolve_media(&self, folder: &Path, rel: &str) -> Result<PathBuf> {
        if rel.contains("://") || rel.starts_with('/') || rel.contains('\\') {
            return Err(bad("Only local attachments are supported."));
        }
        let decoded = percent_encoding::percent_decode_str(rel)
            .decode_utf8()
            .map_err(|_| bad("Invalid attachment path."))?;
        if decoded.starts_with('/') || decoded.contains('\\') {
            return Err(denied());
        }
        let path = self.root.join(folder).join(decoded.as_ref());
        let canonical = fs::canonicalize(path)
            .map_err(|_| ApiError(StatusCode::NOT_FOUND, "Attachment not found.".into()))?;
        if !canonical.starts_with(&self.root)
            || canonical.components().any(|p| p.as_os_str() == ".trash")
        {
            return Err(denied());
        }
        Ok(canonical)
    }
    /// The identity of the file a media reference names from a document path.
    fn media_identity(&self, document: &str, rel: &str) -> Option<namespace::Identity> {
        let path = self
            .resolve_media(Path::new(document).parent()?, rel)
            .ok()?;
        namespace::Identity::of(&fs::metadata(path).ok()?)
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
    /// The media references `content` holds as `d`'s source. A plain text
    /// document has none: its `![...](...)` is text.
    fn media_references(d: &Document, content: &str) -> HashSet<String> {
        if documents::has_media(&d.path) {
            Self::references(content)
        } else {
            HashSet::new()
        }
    }
    fn grant_new_references(&self, d: &Document, before: &str, after: &str) -> Result<()> {
        let previous = Self::media_references(d, before);
        let current = Self::media_references(d, after);
        self.grant_references(d, current.difference(&previous))
    }
    fn grant_desktop_references(
        &self,
        d: &Document,
        baseline: &str,
        live: &str,
        after: &str,
    ) -> Result<()> {
        let previous = Self::media_references(d, baseline);
        let existing = Self::media_references(d, live);
        let current = Self::media_references(d, after);
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
        // A move later checks whether each approved file moved with it.
        let approved: Vec<_> = references
            .map(|reference| (reference, self.media_identity(&d.path, reference)))
            .collect();
        let db = self.db.lock().unwrap();
        for (reference, identity) in approved {
            db.execute(
                "INSERT OR IGNORE INTO active_media(doc,reference) VALUES(?,?)",
                params![d.id, reference],
            )?;
            // Remember explicit owner references even before their file exists.
            // Loading a cached room never upgrades anonymous references to trusted ones.
            db.execute(
                "INSERT INTO trusted_references(doc,reference,identity) VALUES(?,?,?)
                 ON CONFLICT(doc,reference) DO UPDATE SET identity=COALESCE(excluded.identity,identity)",
                params![d.id, reference, identity.as_ref().map(namespace::Identity::as_str)],
            )?;
        }
        Ok(())
    }
    /// References in `content` whose file this document may already serve.
    /// A restore uses this to re-activate approved media without turning an
    /// unapproved local file into a new grant, the way an edit cannot.
    fn authorized_references(&self, d: &Document, content: &str) -> Result<HashSet<String>> {
        Ok(Self::media_references(d, content)
            .into_iter()
            .filter(|reference| {
                self.media_path(d, reference)
                    .is_ok_and(|path| self.attachment_allowed(d, &path))
            })
            .collect())
    }
    fn attachment_allowed(&self, d: &Document, path: &Path) -> bool {
        self.approvals(d).approves(path)
    }
    /// The file still at the exact path a grant pinned, as long as that path
    /// is its own name rather than a link to where it went.
    fn pinned_identity(path: &str) -> Option<namespace::Identity> {
        let path = Path::new(path);
        if fs::canonicalize(path).ok()? != path {
            return None;
        }
        namespace::Identity::of(&fs::metadata(path).ok()?)
    }

    fn usage(&self, d: &Document, content: &str) -> usize {
        self.reference_usage(d, &Self::media_references(d, content))
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
    /// Whether a listing read a folder in full. One it could not is logged
    /// once, not on every poll, until a listing reads it again.
    fn listed(&self, folder: &Path, unreadable: Option<std::io::Error>) {
        let mut logged = self.unlisted.lock().unwrap();
        match unreadable {
            None => {
                logged.remove(folder);
            }
            Some(error) => {
                if logged.insert(folder.to_owned()) {
                    let relative = folder.strip_prefix(&self.root).unwrap_or(folder);
                    tracing::warn!(
                        folder = %relative.display(),
                        "listing leaves out what it cannot read: {error}"
                    );
                }
            }
        }
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
    /// A document's format; folders have none.
    #[serde(skip_serializing_if = "Option::is_none")]
    format: Option<&'static str>,
}
/// Folders of this name hold a document's images, like `.assets`. One with
/// no document at any depth is left out of listings; it is still walked.
const ATTACHMENTS: &str = "_attachments";
/// List a folder and its descendants. A subfolder or entry that cannot be
/// read is left out, logged once until it can be read again, rather than
/// failing every poll of the whole listing.
fn scan(s: &Store, dir: &Path, entries: &mut Vec<Entry>) -> Result<()> {
    let listing = fs::read_dir(dir)?;
    scan_folder(s, dir, listing, entries)
}
fn scan_folder(
    s: &Store,
    dir: &Path,
    listing: fs::ReadDir,
    entries: &mut Vec<Entry>,
) -> Result<()> {
    let mut unreadable = None;
    let mut children = Vec::new();
    for child in listing {
        match child {
            Ok(child) => children.push(child),
            Err(error) => {
                unreadable.get_or_insert(error);
            }
        }
    }
    children.sort_by_key(|e| e.file_name());
    for e in children {
        let name = e.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let p = e.path();
        // An entry removed since it was listed is simply gone.
        let metadata = match fs::symlink_metadata(&p) {
            Ok(metadata) => metadata,
            Err(error) => {
                if error.kind() != std::io::ErrorKind::NotFound {
                    unreadable.get_or_insert(error);
                }
                continue;
            }
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        let rel = p
            .strip_prefix(&s.root)
            .unwrap()
            .to_string_lossy()
            .to_string();
        if metadata.is_dir() {
            let at = entries.len();
            entries.push(Entry {
                path: rel,
                kind: "folder",
                id: None,
                shared: false,
                modified: 0,
                title: name.to_string_lossy().into_owned(),
                url: None,
                format: None,
            });
            match fs::read_dir(&p) {
                Ok(listing) => scan_folder(s, &p, listing, entries)?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => s.listed(&p, Some(error)),
            }
            if name == ATTACHMENTS && !entries[at..].iter().any(|entry| entry.id.is_some()) {
                entries.truncate(at);
            }
        } else if metadata.is_file()
            && let Some(format) = documents::format(&rel)
        {
            let d = match s.listed_document(&rel) {
                // A file still being matched to its document is listed once a
                // pass decides. One removed or replaced by a link meanwhile,
                // or with a name no document path can have, is left out.
                // None of them may hide the rest of the workspace.
                Err(error)
                    if (error.0 == StatusCode::SERVICE_UNAVAILABLE
                        && s.root_identity.matches(&s.root))
                        || matches!(
                            error.0,
                            StatusCode::NOT_FOUND | StatusCode::FORBIDDEN | StatusCode::BAD_REQUEST
                        ) =>
                {
                    continue;
                }
                result => result?,
            };
            entries.push(Entry {
                path: rel,
                kind: "file",
                id: Some(d.id.clone()),
                shared: d.permission != "private",
                modified: metadata
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
                format: Some(format.name()),
            });
        }
    }
    s.listed(dir, unreadable);
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
    // A caller may resolve the document before waiting for its queue, while
    // it moves or its link is turned off. Authorize it as it is now.
    let d = &s.doc(&d.id)?;
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
fn main() -> std::process::ExitCode {
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
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    match arguments.iter().map(String::as_str).collect::<Vec<_>>()[..] {
        [] => {}
        // The pass rewrites what it finds: never pair a state folder with
        // a documents folder by the working folder's defaults.
        ["--restored"]
            if std::env::var_os("LOCDOC_STATE").is_none()
                || std::env::var_os("LOCDOC_DOCS").is_none() =>
        {
            eprintln!(
                "locdoc --restored: set LOCDOC_STATE and LOCDOC_DOCS to the service's state and documents folders."
            );
            return std::process::ExitCode::from(2);
        }
        ["--restored"] => return restored::run(root.into(), data.into(), public),
        _ => {
            eprintln!(
                "Usage: locdoc [--restored]\n\nWithout arguments, serve LOCDOC_DOCS with the state in LOCDOC_STATE.\n--restored  After copying a backup's state files and documents folder\n            into place, match its files to documents once and exit.\n            LOCDOC_STATE and LOCDOC_DOCS must both be set."
            );
            return std::process::ExitCode::from(2);
        }
    }
    match serve(root.into(), data.into(), public) {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("locdoc: {error}");
            std::process::ExitCode::FAILURE
        }
    }
}

#[tokio::main]
async fn serve(
    root: PathBuf,
    data: PathBuf,
    public: String,
) -> std::result::Result<(), Box<dyn std::error::Error>> {
    let bind = std::env::var("LOCDOC_BIND").unwrap_or_else(|_| "127.0.0.1:3477".into());
    // systemd stops and restarts the unit with SIGTERM; handle it as ctrl-c.
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let s = Store::open(root, data, public)?;
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
    .with_graceful_shutdown(async move {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = terminate.recv() => {}
        }
    })
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    pub(super) fn peer_update(room: &Arc<Mutex<Room>>, append: &str) -> Vec<u8> {
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
    fn listed(s: &Store) -> Vec<Entry> {
        let mut entries = vec![];
        scan(s, &s.root, &mut entries).unwrap();
        entries
    }
    #[test]
    fn listings_name_formats_and_leave_out_attachment_folders_without_documents() {
        let (_dir, s) = store();
        let png = BASE64.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFlsAAAAASUVORK5CYII=").unwrap();
        for path in ["Trip/script.fountain", "Trip/list.txt"] {
            s.create_document(path).unwrap();
        }
        // Images only, at any depth: left out of listings like .assets.
        fs::create_dir_all(s.root.join("Trip/_attachments/2024")).unwrap();
        fs::write(s.root.join("Trip/_attachments/photo.png"), &png).unwrap();
        fs::write(s.root.join("Trip/_attachments/2024/old.png"), &png).unwrap();
        fs::write(
            s.root.join("Trip/page.md"),
            "![photo](_attachments/photo.png)\n",
        )
        .unwrap();
        let page = s.index_document("Trip/page.md").unwrap();
        // A document at any depth keeps its attachment folder listed, and a
        // folder with another name is listed even when empty.
        s.create_document("Work/_attachments/Notes/kept.md")
            .unwrap();
        s.create_folder("Trip/attachments").unwrap();
        s.create_folder("Empty/_attachments").unwrap();
        let entries = listed(&s);
        let entry = |path: &str| entries.iter().find(|entry| entry.path == path);
        for hidden in [
            "Trip/_attachments",
            "Trip/_attachments/2024",
            "Empty/_attachments",
        ] {
            assert!(entry(hidden).is_none(), "{hidden} is listed");
        }
        for shown in [
            "Trip/attachments",
            "Empty",
            "Work/_attachments",
            "Work/_attachments/Notes",
        ] {
            assert!(entry(shown).is_some(), "{shown} is not listed");
        }
        let formats = [
            "Trip/page.md",
            "Trip/script.fountain",
            "Trip/list.txt",
            "Work/_attachments/Notes/kept.md",
            "Trip",
        ]
        .map(|path| entry(path).unwrap().format);
        assert_eq!(
            formats,
            [
                Some("markdown"),
                Some("fountain"),
                Some("text"),
                Some("markdown"),
                None
            ]
        );
        // Folders keep their entry shape; documents gain only the format.
        let folder = serde_json::to_value(entry("Trip").unwrap()).unwrap();
        assert!(folder.get("format").is_none());
        let document = serde_json::to_value(entry("Trip/list.txt").unwrap()).unwrap();
        assert_eq!(document["format"], "text");
        // A folder link lists the same entries.
        let link = folders::share_folder(
            &s,
            serde_json::from_value(json!({"path": "Trip", "permission": "view"})).unwrap(),
        )
        .unwrap();
        let token = link["shareUrl"]
            .as_str()
            .unwrap()
            .rsplit('/')
            .next()
            .unwrap();
        let visible = folders::entries(&s, &folders::grant(&s, token).unwrap()).unwrap();
        assert!(visible.iter().any(|entry| entry.path == "attachments"));
        assert!(
            !visible
                .iter()
                .any(|entry| entry.path.starts_with("_attachments"))
        );
        // Hidden folders are still walked: their images keep working, and a
        // document moved into one is followed and lists the folder again.
        s.db.lock()
            .unwrap()
            .execute(
                "UPDATE docs SET permission='view',token='old-link' WHERE id=?",
                [&page.id],
            )
            .unwrap();
        let shared = s.doc(&page.id).unwrap();
        s.room(&shared).unwrap();
        let request = Media {
            path: "_attachments/photo.png".into(),
            token: Some("old-link".into()),
        };
        assert!(media_file(&s, &page.id, &request, &HeaderMap::new()).is_ok());
        fs::rename(
            s.root.join("Trip/list.txt"),
            s.root.join("Trip/_attachments/2024/list.txt"),
        )
        .unwrap();
        s.discover_file_moves().unwrap();
        let entries = listed(&s);
        for shown in [
            "Trip/_attachments",
            "Trip/_attachments/2024",
            "Trip/_attachments/2024/list.txt",
        ] {
            assert!(
                entries.iter().any(|entry| entry.path == shown),
                "{shown} is not listed"
            );
        }
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
    pub(super) fn store() -> (tempfile::TempDir, App) {
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
}
