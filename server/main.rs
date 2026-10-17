mod comments;
mod disk;
mod documents;
mod folders;
mod links;
mod social;
mod web;
use disk::DiskFile;

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
use notify::Watcher;
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
    Doc, GetString, OffsetKind, Options, ReadTxn, StateVector, Text, Transact, Update,
    sync::{Awareness, DefaultProtocol, Message, Protocol, SyncMessage},
    updates::{decoder::Decode, encoder::Encode},
};

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
    last_disk: String,
    disk_state: Arc<[u8]>,
    persisted: Arc<[u8]>,
    persisted_disk: Arc<[u8]>,
    persisted_intent: bool,
    snapshot_at: i64,
    disk_dirty: bool,
    disk_waiting: bool,
    recovering: bool,
    receipts: HashMap<uuid::Uuid, String>,
    usage: Option<usize>,
}
struct Store {
    root: PathBuf,
    data: PathBuf,
    db: Mutex<Connection>,
    rooms: Mutex<HashMap<String, Arc<Mutex<Room>>>>,
    key: String,
    public_url: String,
    owner_name: String,
    http: reqwest::Client,
    rates: Mutex<HashMap<String, (i64, u32)>>,
    document_files: Mutex<()>,
}
#[derive(Default, Deserialize)]
struct Access {
    token: Option<String>,
    client: Option<String>,
}
impl Store {
    fn open(root: PathBuf, data: PathBuf, public_url: String) -> Result<App> {
        fs::create_dir_all(&root)?;
        fs::create_dir_all(&data)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&data, fs::Permissions::from_mode(0o700))?;
        }
        let key_path = data.join("owner.key");
        let key = if key_path.exists() {
            fs::read_to_string(&key_path)?.trim().to_string()
        } else {
            let k = token();
            fs::write(&key_path, &k)?;
            k
        };
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
        documents::migrate(&db)?;
        folders::migrate(&db)?;
        Ok(Arc::new(Self {
            root: fs::canonicalize(root)?,
            data,
            db: Mutex::new(db),
            rooms: Mutex::new(HashMap::new()),
            key,
            public_url: public_url.trim_end_matches('/').into(),
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
        }))
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
        cookie(h, "locdoc_owner").is_some_and(|s| {
            self.db
                .lock()
                .unwrap()
                .query_row(
                    "SELECT 1 FROM sessions WHERE hash=? AND expires>?",
                    params![hash(&s), now()],
                    |r| r.get::<_, i64>(0),
                )
                .is_ok()
        })
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
        let db = self.db.lock().unwrap();
        for reference in current.difference(&previous) {
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
    fn validate_references(&self, d: &Document, content: &str) -> Result<()> {
        for reference in Self::references(content) {
            if let Ok(path) = self.media_path(d, &reference)
                && !self.attachment_allowed(d, &path)
            {
                return Err(denied());
            }
        }
        Ok(())
    }
    fn usage(&self, d: &Document, content: &str) -> usize {
        let mut files: HashSet<PathBuf> = Self::references(content)
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
    fn room(&self, d: &Document) -> Result<Arc<Mutex<Room>>> {
        let mut rooms = self.rooms.lock().unwrap();
        if let Some(r) = rooms.get(&d.id) {
            return Ok(r.clone());
        }
        if rooms.len() >= 64 {
            rooms.retain(|_, r| Arc::strong_count(r) > 1 || r.lock().unwrap().disk_dirty);
        }
        if rooms.len() >= 128 {
            return Err(ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                "Too many active documents. Try again shortly.".into(),
            ));
        }
        let (saved, baseline, recovering): (Option<Vec<u8>>, Option<Vec<u8>>, bool) =
            self.db.lock().unwrap().query_row(
                "SELECT state,disk_state,write_intent FROM docs WHERE id=?",
                [&d.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?;
        let doc = Doc::with_options(Options {
            offset_kind: OffsetKind::Utf16,
            ..Options::default()
        });
        if let Some(bytes) = &saved {
            doc.transact_mut()
                .apply_update(Update::decode_v1(bytes).map_err(|_| bad("Invalid saved state."))?)
                .map_err(|_| bad("Invalid saved state."))?;
        } else {
            let mut file = DiskFile::open_read(&self.safe(&d.path, false)?)?
                .ok_or_else(|| ApiError(StatusCode::CONFLICT, "A desktop application is saving this file. Try opening it again when finished.".into()))?;
            let disk = file.read()?;
            apply_text(&doc, "", &disk);
            self.grant_new_references(d, "", &disk)?;
        }
        let disk_state: Arc<[u8]> = baseline
            .or_else(|| saved.clone())
            .unwrap_or_else(|| {
                doc.transact()
                    .encode_state_as_update_v1(&StateVector::default())
            })
            .into();
        let disk_doc = Doc::new();
        disk_doc
            .transact_mut()
            .apply_update(
                Update::decode_v1(&disk_state).map_err(|_| bad("Invalid disk baseline."))?,
            )
            .map_err(|_| bad("Invalid disk baseline."))?;
        let disk = disk_doc
            .get_or_insert_text("content")
            .get_string(&disk_doc.transact());
        let (tx, _) = broadcast::channel(256);
        let r = Arc::new(Mutex::new(Room {
            awareness: Awareness::new(doc),
            tx,
            last_disk: disk.clone(),
            persisted_disk: disk_state.clone(),
            persisted_intent: recovering,
            disk_state,
            persisted: saved.unwrap_or_default().into(),
            snapshot_at: 0,
            disk_dirty: true,
            disk_waiting: false,
            recovering,
            receipts: HashMap::new(),
            usage: None,
        }));
        rooms.insert(d.id.clone(), r.clone());
        Ok(r)
    }
    fn snapshot(&self, d: &Document, content: &str, force: bool) -> Result<()> {
        let db = self.db.lock().unwrap();
        let latest: Option<(i64, String)> = db
            .query_row(
                "SELECT created,content FROM revisions WHERE doc=? ORDER BY rowid DESC LIMIT 1",
                [&d.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if latest
            .as_ref()
            .is_some_and(|(time, body)| body == content || (!force && now() - time < 30))
        {
            return Ok(());
        }
        db.execute(
            "INSERT INTO revisions(id,doc,content,created) VALUES(?,?,?,?)",
            params![uuid::Uuid::new_v4().to_string(), d.id, content, now()],
        )?;
        db.execute("DELETE FROM revisions WHERE doc=? AND id NOT IN(SELECT id FROM revisions WHERE doc=? ORDER BY rowid DESC LIMIT 50)",params![d.id,d.id])?;
        Ok(())
    }
    fn persist(&self, d: &Document, r: &mut Room) -> Result<bool> {
        // A client may have queued an update just before an owner rename.
        let current = self.doc(&d.id)?;
        let d = &current;
        let path = self.safe(&d.path, false)?;
        if now() - r.snapshot_at >= 30 {
            self.snapshot(d, &r.last_disk, false)?;
            r.snapshot_at = now();
        }
        r.disk_dirty = true;
        // The database is a durable outbox, not an assumption that Markdown was
        // already written. Its separate baseline survives an open desktop writer
        // and a server restart without replaying desktop changes at wrong offsets.
        self.store_room(d, r, r.recovering)?;
        let writer = if r.recovering || room_text(r) != r.last_disk {
            DiskFile::open(&path)?
        } else {
            None
        };
        let Some(mut file) = (match writer {
            Some(file) => Some(file),
            // Open readers must not block importing a completed desktop save.
            // A read lease still excludes every existing or arriving writer.
            None => DiskFile::open_read(&path)?,
        }) else {
            r.waiting(true);
            return Ok(false);
        };
        let disk = file.read()?;
        if r.recovering {
            let intended = room_text(r);
            if disk != intended {
                // An interrupted in-place commit is ambiguous. Keep the observed
                // file as an owner-restorable version before completing the WAL.
                self.snapshot(d, &disk, true)?;
                tracing::warn!(
                    "Recovered interrupted save for {}; observed file kept in version history",
                    d.path
                );
            }
        }
        if !r.recovering && disk != r.last_disk {
            // An external editor supplies no causal version for a whole-file
            // replacement. Keep accepted browser edits before importing its diff,
            // even when this save falls inside the normal snapshot interval.
            self.snapshot(d, &room_text(r), true)?;
            self.grant_new_references(d, &r.last_disk, &disk)?;
            let before = r.awareness.doc().transact().state_vector();
            // Apply the desktop diff to the exact CRDT baseline it was based on,
            // then merge that update with any browser changes already in memory.
            let baseline = Doc::with_options(Options {
                offset_kind: OffsetKind::Utf16,
                ..Options::default()
            });
            baseline
                .transact_mut()
                .apply_update(
                    Update::decode_v1(&r.disk_state).map_err(|_| bad("Invalid disk baseline."))?,
                )
                .map_err(|_| bad("Invalid disk baseline."))?;
            let baseline_vector = baseline.transact().state_vector();
            apply_text(&baseline, &r.last_disk, &disk);
            let desktop_update = baseline
                .transact()
                .encode_state_as_update_v1(&baseline_vector);
            r.awareness
                .doc()
                .transact_mut()
                .apply_update(
                    Update::decode_v1(&desktop_update)
                        .map_err(|_| bad("Invalid desktop update."))?,
                )
                .map_err(|_| bad("Invalid desktop update."))?;
            let update = r
                .awareness
                .doc()
                .transact()
                .encode_state_as_update_v1(&before);
            let _ =
                r.tx.send(Message::Sync(SyncMessage::Update(update)).encode_v1());
            r.last_disk = disk.clone();
            r.disk_state = baseline
                .transact()
                .encode_state_as_update_v1(&StateVector::default())
                .into();
        }
        let text = room_text(r);
        self.settle_uploads(d, &text)?;
        if text != disk && !file.writable() {
            // Import and broadcast desktop changes now, but retain queued
            // browser writes durably until exclusive projection is possible.
            self.store_room(d, r, r.recovering)?;
            r.waiting(true);
            return Ok(false);
        }
        // Persist the intended full text BEFORE touching the file. A crash in
        // write/truncate/fsync is repaired from this intent on the next open.
        if !file.is_current(&path) || !file.intact() {
            r.waiting(true);
            return Ok(false);
        }
        self.store_room(d, r, text != disk)?;
        if !file.intact() {
            self.store_room(d, r, r.recovering)?;
            r.waiting(true);
            return Ok(false);
        }
        if text != disk {
            r.recovering = true;
            file.write(&text)?;
        }
        if !file.is_current(&path) {
            r.recovering = false;
            self.store_room(d, r, false)?;
            r.waiting(true);
            return Ok(false);
        }
        let state = r
            .awareness
            .doc()
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        r.last_disk = text;
        r.disk_state = state.into();
        r.recovering = false;
        self.store_room(d, r, false)?;
        r.disk_dirty = false;
        let usage = self.usage(d, &r.last_disk);
        if r.usage != Some(usage) {
            r.usage = Some(usage);
            let _ =
                r.tx.send(Message::Custom(123, usage.to_string().into_bytes()).encode_v1());
        }
        for (_, receipt) in r.receipts.drain() {
            let _ =
                r.tx.send(Message::Custom(127, receipt.into_bytes()).encode_v1());
        }
        r.waiting(false);
        Ok(true)
    }
    fn store_room(&self, d: &Document, r: &mut Room, intent: bool) -> Result<()> {
        let state = r
            .awareness
            .doc()
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        if state.as_slice() == r.persisted.as_ref()
            && r.disk_state == r.persisted_disk
            && intent == r.persisted_intent
        {
            return Ok(());
        }
        self.db.lock().unwrap().execute(
            "UPDATE docs SET state=?,disk_state=?,write_intent=? WHERE id=?",
            params![&state, r.disk_state.as_ref(), intent, d.id],
        )?;
        r.persisted = state.into();
        r.persisted_disk = r.disk_state.clone();
        r.persisted_intent = intent;
        Ok(())
    }
    fn settle_uploads(&self, d: &Document, content: &str) -> Result<()> {
        let paths: HashSet<_> = Self::references(content)
            .iter()
            .filter_map(|reference| self.media_path(d, reference).ok())
            .filter_map(|path| {
                path.strip_prefix(&self.root)
                    .ok()
                    .map(|p| p.to_string_lossy().into_owned())
            })
            .collect();
        let db = self.db.lock().unwrap();
        for path in paths {
            db.execute(
                "UPDATE assets SET pending_until=0 WHERE doc=? AND path=? AND pending_until!=0",
                params![d.id, path],
            )?;
        }
        Ok(())
    }
}
impl Room {
    fn waiting(&mut self, waiting: bool) {
        if self.disk_waiting != waiting {
            self.disk_waiting = waiting;
            let _ = self
                .tx
                .send(Message::Custom(121, if waiting { b"1" } else { b"0" }.to_vec()).encode_v1());
        }
    }
}
fn room_text(r: &Room) -> String {
    r.awareness
        .doc()
        .get_or_insert_text("content")
        .get_string(&r.awareness.doc().transact())
}

fn apply_text(doc: &Doc, old: &str, new: &str) {
    let text = doc.get_or_insert_text("content");
    let mut txn = doc.transact_mut();
    let mut pos = 0u32;
    let diff = similar::TextDiff::from_chars(old, new);
    // Apply contiguous diff runs in one CRDT operation. Inserting each character
    // separately made even a modest desktop paste take seconds under the lock.
    for op in diff.ops() {
        let len = diff.old_slices()[op.old_range()]
            .iter()
            .map(|s| s.encode_utf16().count() as u32)
            .sum::<u32>();
        match op.tag() {
            similar::DiffTag::Equal => pos += len,
            similar::DiffTag::Delete | similar::DiffTag::Replace => {
                if pos + len <= text.len(&txn) {
                    text.remove_range(&mut txn, pos, len);
                }
            }
            similar::DiffTag::Insert => {}
        }
        if matches!(
            op.tag(),
            similar::DiffTag::Insert | similar::DiffTag::Replace
        ) {
            let inserted = diff.new_slices()[op.new_range()].concat();
            text.insert(&mut txn, pos, &inserted);
            pos += inserted.encode_utf16().count() as u32;
        }
    }
}
fn origin_check(s: &Store, h: &HeaderMap) -> Result<()> {
    if let Some(origin) = h.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
        let host = h
            .get(header::HOST)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let parsed = url::Url::parse(origin).map_err(|_| denied())?;
        if origin != s.public_url
            && parsed[url::Position::BeforeHost..url::Position::AfterPort] != *host
        {
            return Err(denied());
        }
    }
    Ok(())
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
    let mut value = json!({"owner":s.owner(h),"root":if s.owner(h){s.root.to_string_lossy().to_string()}else{String::new()},"guest":hash(&guest),"publicUrl":s.public_url,"limits":{"image":5*MB,"video":20*MB,"document":DOC_LIMIT}});
    if s.owner(h) {
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
            if s.public_url.starts_with("https")
                && h.get(header::HOST)
                    .and_then(|v| v.to_str().ok())
                    .is_some_and(|x| !x.starts_with("localhost") && !x.starts_with("127.0.0.1"))
            {
                "; Secure"
            } else {
                ""
            }
        )
        .parse()
        .unwrap(),
    );
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
    origin_check(&s, &h)?;
    if !secure_eq(b.key.trim(), &s.key) {
        tokio::time::sleep(std::time::Duration::from_millis(700)).await;
        return Err(denied());
    }
    let t = token();
    s.db.lock().unwrap().execute(
        "INSERT INTO sessions(hash,expires) VALUES(?,?)",
        params![hash(&t), now() + 365 * 86400],
    )?;
    let mut res = Json(json!({"ok":true})).into_response();
    let secure = if h
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|x| x.starts_with("localhost") || x.starts_with("127.0.0.1"))
    {
        ""
    } else {
        "; Secure"
    };
    res.headers_mut().insert(
        header::SET_COOKIE,
        format!("locdoc_owner={t}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000{secure}")
            .parse()
            .unwrap(),
    );
    Ok(res)
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
    origin_check(&s, &h)?;
    let db = s.db.lock().unwrap();
    let valid = db.execute(
        "DELETE FROM tickets WHERE hash=? AND expires>?",
        params![hash(&b.ticket), now()],
    )?;
    if valid != 1 {
        return Err(denied());
    }
    let t = token();
    db.execute(
        "INSERT INTO sessions(hash,expires) VALUES(?,?)",
        params![hash(&t), now() + 365 * 86400],
    )?;
    let secure = if h
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .is_some_and(|h| h.starts_with("127.0.0.1:") || h.starts_with("localhost:"))
    {
        ""
    } else {
        "; Secure"
    };
    let mut res = Json(json!({"ok":true})).into_response();
    res.headers_mut().insert(
        header::SET_COOKIE,
        format!("locdoc_owner={t}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000{secure}")
            .parse()
            .unwrap(),
    );
    Ok(res)
}
async fn logout(State(s): State<App>, h: HeaderMap) -> Result<Response> {
    origin_check(&s, &h)?;
    if let Some(t) = cookie(&h, "locdoc_owner") {
        s.db.lock()
            .unwrap()
            .execute("DELETE FROM sessions WHERE hash=?", [hash(&t)])?;
    }
    let mut res = Json(json!({"ok":true})).into_response();
    res.headers_mut().insert(
        header::SET_COOKIE,
        "locdoc_owner=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict"
            .parse()
            .unwrap(),
    );
    Ok(res)
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
async fn create(State(s): State<App>, h: HeaderMap, Json(b): Json<Create>) -> Result<Json<Value>> {
    origin_check(&s, &h)?;
    if !s.owner(&h) {
        return Err(denied());
    }
    if b.kind == "folder" {
        let path = s.safe(&b.path, false)?;
        if path.exists() {
            return Err(bad("A file or folder with this name already exists."));
        }
        fs::create_dir_all(path)?;
        Ok(Json(json!({"ok":true})))
    } else if b.kind == "file" {
        Ok(Json(json!(s.create_document(&b.path)?)))
    } else {
        Err(bad("Choose file or folder."))
    }
}
fn document_payload(s: &Store, h: &HeaderMap, d: &Document, access: &Access) -> Result<Value> {
    let (owner, edit) = s.access(h, d, access)?;
    let room = s.room(d)?;
    let mut room = room.lock().unwrap();
    s.persist(d, &mut room)?;
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
    Ok(
        json!({"id":d.id,"path":if owner{d.path.clone()}else{Path::new(&d.path).file_name().unwrap().to_string_lossy().to_string()},"owner":owner,"edit":edit,"permission":if owner{d.permission.as_str()}else if edit{"edit"}else{"view"},"shareUrl":link,"usage":usage,"modified":fs::metadata(s.safe(&d.path,false)?)?.modified().ok().and_then(|t|t.duration_since(UNIX_EPOCH).ok()).map(|d|d.as_secs()),"content":content,"state":BASE64.encode(state),"diskPending":room.disk_waiting}),
    )
}
async fn document(
    State(s): State<App>,
    AxPath(id): AxPath<String>,
    Query(a): Query<Access>,
    h: HeaderMap,
) -> Result<Json<Value>> {
    Ok(Json(document_payload(&s, &h, &s.doc(&id)?, &a)?))
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
    if let Ok(folder) = folders::grant(&s, &token) {
        let entries = folders::entries(&s, &folder)?;
        let selected = selection
            .doc
            .as_deref()
            .or_else(|| entries.iter().find_map(|entry| entry.id.as_deref()));
        let document = folders::document(&s, &folder, selected)?
            .map(|doc| {
                document_payload(
                    &s,
                    &h,
                    &doc,
                    &Access {
                        token: Some(token.clone()),
                        ..Access::default()
                    },
                )
            })
            .transpose()?;
        return Ok(configuration_extra(
            &s,
            &h,
            json!({"folder":folder.value(&s),"entries":entries,"document":document}),
        ));
    }
    let document = shared_document(&s, &token)?;
    let value = document_payload(
        &s,
        &h,
        &document,
        &Access {
            token: Some(token),
            client: None,
        },
    )?;
    Ok(configuration(&s, &h, Some(value)))
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
    h: HeaderMap,
    Json(b): Json<Share>,
) -> Result<Json<Value>> {
    origin_check(&s, &h)?;
    if !s.owner(&h) {
        return Err(denied());
    }
    if !["private", "view", "edit"].contains(&b.permission.as_str()) {
        return Err(bad("Choose private, view, or edit."));
    }
    let d = s.doc(&id)?;
    let t = match (b.rotate, d.token) {
        (false, Some(existing)) => existing,
        _ => token(),
    };
    s.db.lock().unwrap().execute(
        "UPDATE docs SET permission=?,token=? WHERE id=?",
        params![b.permission, t, id],
    )?;
    // Permissions are rechecked on every frame and existing visitors reconnect with the new mode.
    if let Some(room) = s.rooms.lock().unwrap().get(&id) {
        let _ = room.lock().unwrap().tx.send(vec![126]);
    }
    Ok(Json(
        json!({"permission":b.permission,"shareUrl":if b.permission=="private"{None}else{Some(format!("{}/s/{t}",s.public_url))}}),
    ))
}
#[derive(Deserialize)]
struct Rename {
    path: String,
}
async fn rename(
    State(s): State<App>,
    AxPath(id): AxPath<String>,
    h: HeaderMap,
    Json(b): Json<Rename>,
) -> Result<Json<Value>> {
    origin_check(&s, &h)?;
    if !s.owner(&h) {
        return Err(denied());
    }
    s.rename_document(&id, &b.path)?;
    Ok(Json(json!({"ok":true})))
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
    origin_check(&s, &h)?;
    let d = s.doc(&id)?;
    if !s.access(&h, &d, &a)?.1 {
        return Err(denied());
    }
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
    let kind = infer::get(&bytes).ok_or_else(|| {
        bad("Unsupported file. Use PNG, JPEG, GIF, WebP, AVIF, MP4, WebM, or MOV.")
    })?;
    let mime = kind.mime_type();
    let video = mime.starts_with("video/");
    if ![
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
    {
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
    let r = room.lock().unwrap();
    if s.usage(&d, &room_text(&r)) + bytes.len() > DOC_LIMIT {
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
    let path = s.safe(&rel, true)?;
    fs::create_dir_all(path.parent().unwrap())?;
    fs::write(&path, &bytes)?;
    s.db.lock().unwrap().execute(
        "INSERT INTO assets(doc,path,bytes,pending_until) VALUES(?,?,?,?)",
        params![id, rel, bytes.len() as i64, now() + 600],
    )?;
    let depth = Path::new(&d.path).parent().unwrap().components().count();
    let reference = format!("{}{rel}", "../".repeat(depth));
    Ok(Json(
        json!({"path":reference,"name":name,"bytes":bytes.len(),"video":video,"usage":s.usage(&d,&room_text(&r))}),
    ))
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
    let d = s.doc(&id)?;
    let (owner, _) = s.access(
        &h,
        &d,
        &Access {
            token: q.token,
            ..Access::default()
        },
    )?;
    let path = s.media_path(&d, &q.path)?;
    if !owner {
        let text = fs::read_to_string(s.safe(&d.path, false)?)?;
        let allowed = Store::references(&text)
            .iter()
            .filter_map(|p| s.media_path(&d, p).ok())
            .any(|p| p == path);
        if !allowed || !s.attachment_allowed(&d, &path) {
            return Err(denied());
        }
    }
    use std::io::Read;
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
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
        .insert(header::CONTENT_TYPE, kind.mime_type().parse().unwrap());
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
    h: HeaderMap,
    Json(b): Json<FontRequest>,
) -> Result<Json<Value>> {
    origin_check(&s, &h)?;
    if !s.owner(&h) {
        return Err(denied());
    }
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
    h: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response> {
    origin_check(&s, &h)?;
    let d = s.doc(&id)?;
    s.access(&h, &d, &a)?;
    let r = s.room(&d)?;
    Ok(ws
        .max_message_size(6 * MB)
        .on_upgrade(move |socket| socket_loop(socket, s, d.id, r, h, a)))
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
    if h.contains_key(header::ORIGIN) && a.client.as_deref() != Some("file-comments-v1") {
        // Old editors cannot safely interpret the new source records. Their
        // existing error handler stops reconnecting and preserves local drafts.
        let _ = sender.send(WsMessage::Binary(Message::Custom(125,
            b"Locdoc was updated. Reload to use file comments. Your unsaved browser draft is kept here.".to_vec()
        ).encode_v1().into())).await;
        return;
    }
    let mut rx = room.lock().unwrap().tx.subscribe();
    let mut peer = Peer::default();
    if s.doc(&id).and_then(|d| s.access(&h, &d, &a)).is_err() {
        return;
    }
    let initial = {
        let r = room.lock().unwrap();
        let mut v = vec![
            Message::Custom(121, if r.disk_waiting { b"1" } else { b"0" }.to_vec()).encode_v1(),
            Message::Sync(SyncMessage::SyncStep1(
                r.awareness.doc().transact().state_vector(),
            ))
            .encode_v1(),
        ];
        if let Ok(u) = r.awareness.update() {
            v.push(Message::Awareness(u).encode_v1());
        }
        v
    };
    for data in initial {
        if sender.send(WsMessage::Binary(data.into())).await.is_err() {
            return;
        }
    }
    let mut pulse = tokio::time::interval(std::time::Duration::from_secs(20));
    let mut frames = 0u32;
    loop {
        tokio::select! {
            incoming = receiver.next() => match incoming {
                Some(Ok(WsMessage::Binary(bytes))) => {
                    frames += 1;
                    if frames > 1500 { break; }
                    let Ok(d) = s.doc(&id) else { break; };
                    let Ok((owner, edit)) = s.access(&h, &d, &a) else { break; };
                    match process_frame(&s, &d, &room, &bytes, edit, owner, &mut peer) {
                        Ok(responses) => {
                            for frame in responses {
                                if sender.send(WsMessage::Binary(frame.into())).await.is_err() { break; }
                            }
                        }
                        Err(e) => {
                            tracing::warn!("sync rejected: {}", e.1);
                            let _ = sender.send(WsMessage::Binary(Message::Custom(125, e.1.into_bytes()).encode_v1().into())).await;
                            break;
                        }
                    }
                }
                Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            },
            outgoing = rx.recv() => match outgoing {
                Ok(data) => {
                    if data == [126] { break; }
                    // Directory replacement can invalidate a folder capability
                    // without a settings request. Passive visitors must not
                    // receive another user's edits until the next heartbeat.
                    if s.doc(&id).and_then(|d| s.access(&h, &d, &a)).is_err() { break; }
                    if sender.send(WsMessage::Binary(data.into())).await.is_err() { break; }
                }
                Err(_) => break,
            },
            _ = pulse.tick() => {
                frames = 0;
                if s.doc(&id).and_then(|d| s.access(&h, &d, &a)).is_err() { break; }
                if sender.send(WsMessage::Ping(vec![].into())).await.is_err() { break; }
            }
        }
    }
    let mut r = room.lock().unwrap();
    r.receipts.remove(&peer.id);
    for client in &peer.clients {
        r.awareness.remove_state(*client);
    }
    if let Ok(update) = r.awareness.update_with_clients(peer.clients) {
        let _ = r.tx.send(Message::Awareness(update).encode_v1());
    }
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
    clients: HashSet<yrs::ClientID>,
}
impl Default for Peer {
    fn default() -> Self {
        Self {
            id: uuid::Uuid::new_v4(),
            clients: HashSet::new(),
        }
    }
}
fn process_frame(
    s: &Store,
    d: &Document,
    room: &Arc<Mutex<Room>>,
    bytes: &[u8],
    edit: bool,
    owner: bool,
    peer: &mut Peer,
) -> Result<Vec<Vec<u8>>> {
    let message = Message::decode_v1(bytes).map_err(|_| bad("Invalid synchronization frame."))?;
    let mutation = matches!(
        &message,
        Message::Sync(SyncMessage::SyncStep2(_) | SyncMessage::Update(_))
    );
    if mutation && !edit {
        return Ok(vec![]);
    }
    let clients = &mut peer.clients;
    if let Message::Awareness(ref update) = message {
        if update.clients.len() > 16
            || clients
                .iter()
                .copied()
                .chain(update.clients.keys().copied())
                .collect::<HashSet<_>>()
                .len()
                > 16
            || update
                .clients
                .values()
                .any(|u| u.json.len() > 2048 || !valid_presence(&u.json))
        {
            return Err(bad("Too many or invalid presence updates."));
        }
        for client in update.clients.keys() {
            clients.insert(*client);
        }
    }
    let mut r = room.lock().unwrap();
    if mutation {
        s.persist(d, &mut r)?;
    }
    if let Message::Custom(124, ref payload) = message {
        if !edit || payload.len() != 36 || uuid::Uuid::try_parse_ascii(payload).is_err() {
            return Err(denied());
        }
        let receipt =
            String::from_utf8(payload.clone()).map_err(|_| bad("Invalid save checkpoint."))?;
        if !r.disk_dirty || s.persist(d, &mut r)? {
            return Ok(vec![Message::Custom(127, payload.clone()).encode_v1()]);
        }
        if !r.receipts.contains_key(&peer.id) && r.receipts.len() >= 128 {
            return Err(bad("Too many pending save checkpoints."));
        }
        r.receipts.insert(peer.id, receipt);
        return Ok(vec![Message::Custom(122, payload.clone()).encode_v1()]);
    }
    // Cursor traffic must stay independent of document size. Only an owner's
    // text mutation needs the old text for granting newly embedded references.
    let previous_content = (mutation && owner).then(|| room_text(&r));
    if mutation {
        let preview = Doc::with_options(Options {
            offset_kind: OffsetKind::Utf16,
            ..Options::default()
        });
        let current = r
            .awareness
            .doc()
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        preview
            .transact_mut()
            .apply_update(Update::decode_v1(&current).map_err(|_| bad("Invalid state"))?)
            .map_err(|_| bad("Invalid state"))?;
        if let Message::Sync(SyncMessage::SyncStep2(ref update) | SyncMessage::Update(ref update)) =
            message
        {
            preview
                .transact_mut()
                .apply_update(Update::decode_v1(update).map_err(|_| bad("Invalid update"))?)
                .map_err(|_| bad("Invalid update"))?;
        }
        let content = preview
            .get_or_insert_text("content")
            .get_string(&preview.transact());
        if preview
            .transact()
            .encode_state_as_update_v1(&StateVector::default())
            .len()
            > 20 * MB
        {
            return Err(bad("Document collaboration history is too large."));
        }
        if !owner {
            s.validate_references(d, &content)?;
        }
        if content.len() > 5 * MB {
            return Err(bad("Document exceeds 5 MB."));
        }
        if s.usage(d, &content) > DOC_LIMIT && s.usage(d, &content) > s.usage(d, &room_text(&r)) {
            return Err(bad("Document exceeds its 50 MB attachment limit."));
        }
    }
    // A peer's reply finishes only its own handshake. Broadcast its data as an
    // update so another new client cannot mistake it for the server's reply.
    let broadcast = match &message {
        Message::Sync(SyncMessage::SyncStep2(update)) => {
            Message::Sync(SyncMessage::Update(update.clone())).encode_v1()
        }
        _ => bytes.to_vec(),
    };
    let response = DefaultProtocol
        .handle_message(&mut r.awareness, message)
        .map_err(|_| bad("Invalid sync update."))?;
    if mutation {
        if let Some(previous_content) = previous_content {
            let text = r
                .awareness
                .doc()
                .get_or_insert_text("content")
                .get_string(&r.awareness.doc().transact());
            s.grant_new_references(d, &previous_content, &text)?;
        }
        s.persist(d, &mut r)?;
    }
    if mutation || bytes.first() == Some(&1) {
        let _ = r.tx.send(broadcast);
    }
    let responses = response.map(|r| vec![r.encode_v1()]).unwrap_or_default();
    Ok(responses)
}
fn watch(s: App) -> notify::Result<notify::RecommendedWatcher> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let mut watcher = notify::recommended_watcher(move |e| {
        let _ = tx.send(e);
    })?;
    watcher.watch(&s.root, notify::RecursiveMode::Recursive)?;
    tokio::spawn(async move {
        let settle = std::time::Duration::from_millis(500);
        let mut sweep = tokio::time::interval(std::time::Duration::from_millis(250));
        let mut missing_after = Some(tokio::time::Instant::now() + settle);
        loop {
            let result = tokio::select! {
                result = rx.recv() => { let Some(result) = result else { break; }; result },
                _ = sweep.tick() => {
                    let rooms: Vec<_> = s.rooms.lock().unwrap().iter().map(|(id, room)| (id.clone(), room.clone())).collect();
                    for (id, room) in rooms {
                        let mut r = room.lock().unwrap();
                        if r.disk_dirty && let Ok(d) = s.doc(&id) && let Err(error) = s.persist(&d, &mut r) {
                            tracing::warn!("pending disk save failed: {error}");
                        }
                    }
                    if missing_after.is_some_and(|deadline| tokio::time::Instant::now() >= deadline) {
                        if let Err(error) = s.retire_missing_documents() { tracing::warn!("document scan failed: {error}"); }
                        missing_after = None;
                    }
                    continue;
                }
            };
            let Ok(event): notify::Result<notify::Event> = result else {
                continue;
            };
            if matches!(
                event.kind,
                notify::EventKind::Remove(_)
                    | notify::EventKind::Modify(notify::event::ModifyKind::Name(_))
            ) {
                // Desktop editors may briefly remove and replace a file. Wait
                // for their rename sequence to settle before retiring an ID.
                missing_after = Some(tokio::time::Instant::now() + settle);
            }
            if !matches!(
                event.kind,
                notify::EventKind::Access(notify::event::AccessKind::Close(
                    notify::event::AccessMode::Write
                )) | notify::EventKind::Modify(notify::event::ModifyKind::Name(_))
            ) {
                continue;
            }
            for p in event.paths {
                if documents::format(&p.to_string_lossy()).is_some()
                    && let Ok(rel) = p.strip_prefix(&s.root)
                {
                    let rel = rel.to_string_lossy().to_string();
                    let d = s.index_document(&rel);
                    if let Ok(d) = d {
                        let room = s.rooms.lock().unwrap().get(&d.id).cloned();
                        if let Some(room) = room {
                            let mut r = room.lock().unwrap();
                            // Our own lease descriptors also emit close-write.
                            // The watcher invalidates; only the coordinator commits.
                            if !r.disk_dirty
                                && fs::read_to_string(&p).is_ok_and(|text| text != r.last_disk)
                            {
                                r.disk_dirty = true;
                            }
                        }
                    }
                }
            }
        }
    });
    Ok(watcher)
}
async fn versions(
    State(s): State<App>,
    AxPath(id): AxPath<String>,
    h: HeaderMap,
) -> Result<Json<Value>> {
    if !s.owner(&h) {
        return Err(denied());
    }
    s.doc(&id)?;
    let db = s.db.lock().unwrap();
    let mut q =
        db.prepare("SELECT id,substr(content,1,120),length(content),created FROM revisions WHERE doc=? ORDER BY rowid DESC")?;
    let rows=q.query_map([id],|r|Ok(json!({"id":r.get::<_,String>(0)?,"preview":r.get::<_,String>(1)?,"bytes":r.get::<_,i64>(2)?,"created":r.get::<_,i64>(3)?})))?.filter_map(|v|v.ok()).collect::<Vec<_>>();
    Ok(Json(json!({"versions":rows})))
}
async fn version(
    State(s): State<App>,
    AxPath((id, revision)): AxPath<(String, String)>,
    h: HeaderMap,
) -> Result<Json<Value>> {
    if !s.owner(&h) {
        return Err(denied());
    }
    let content: Option<String> =
        s.db.lock()
            .unwrap()
            .query_row(
                "SELECT content FROM revisions WHERE id=? AND doc=?",
                params![revision, id],
                |r| r.get(0),
            )
            .optional()?;
    Ok(Json(
        json!({"content":content.ok_or_else(||bad("Version not found."))?}),
    ))
}
async fn restore(
    State(s): State<App>,
    AxPath((id, revision)): AxPath<(String, String)>,
    h: HeaderMap,
) -> Result<Json<Value>> {
    origin_check(&s, &h)?;
    if !s.owner(&h) {
        return Err(denied());
    }
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
    if !s.persist(&d, &mut r)? {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Finish the desktop save before restoring a version.".into(),
        ));
    }
    s.snapshot(&d, &r.last_disk, true)?;
    let before = r.awareness.doc().transact().state_vector();
    apply_text(r.awareness.doc(), &r.last_disk, &content);
    s.grant_new_references(&d, &r.last_disk, &content)?;
    s.persist(&d, &mut r)?;
    let update = r
        .awareness
        .doc()
        .transact()
        .encode_state_as_update_v1(&before);
    let _ =
        r.tx.send(Message::Sync(SyncMessage::Update(update)).encode_v1());
    Ok(Json(json!({"ok":true})))
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
    if path.starts_with("/api/") || path.starts_with("/ws/") || path.starts_with("/s/") {
        let peer = req
            .extensions()
            .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
            .map(|p| p.0.ip());
        let forwarded = if peer.is_some_and(|p| p.is_loopback()) {
            req.headers()
                .get("x-forwarded-for")
                .and_then(|x| x.to_str().ok())
                .and_then(|s| s.rsplit(',').next())
                .and_then(|s| s.trim().parse::<std::net::IpAddr>().ok())
        } else {
            None
        };
        let ip = forwarded
            .or(peer)
            .map(|p| p.to_string())
            .unwrap_or_else(|| "local".into());
        let (method, limit) = if path == "/api/login" || path == "/api/redeem" {
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
        let mut rates = s.rates.lock().unwrap();
        let time = now();
        if rates.len() > 10_000 {
            rates.retain(|_, v| time - v.0 < 60);
        }
        if rates.len() > 20_000 {
            return ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                "Server is busy. Try again shortly.".into(),
            )
            .into_response();
        }
        let entry = rates.entry(format!("{ip}:{method}")).or_insert((time, 0));
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
    next.run(req).await
}
fn router(s: App) -> Router {
    Router::new().route("/api/open/{token}",get(open_shared)).route("/api/docs/{id}/versions",get(versions)).route("/api/docs/{id}/versions/{revision}",get(version)).route("/api/docs/{id}/versions/{revision}/restore",post(restore)).route("/api/ticket",post(issue_ticket)).route("/api/redeem",post(redeem)).route("/api/config",get(config)).route("/api/login",post(login)).route("/api/logout",post(logout)).route("/api/folders/share",get(folders::read).post(folders::share)).route("/api/tree",get(tree)).route("/api/files",post(create)).route("/api/shared/{token}",get(shared)).route("/api/docs/{id}",get(document).patch(rename)).route("/api/docs/{id}/share",post(share)).route("/api/docs/{id}/link-preview",get(links::preview)).route("/api/docs/{id}/comments",get(comments::list).post(comments::add)).route("/api/docs/{id}/comments/{cid}",patch(comments::edit)).route("/api/docs/{id}/upload",post(upload).layer(DefaultBodyLimit::max(21*MB))).route("/api/docs/{id}/media",get(media)).route("/api/fonts",get(font_list).post(install_font)).route("/api/fonts.css",get(font_css)).route("/ws/{id}",get(websocket))
 .nest_service("/fonts",ServeDir::new(s.data.join("fonts")))
 .route("/",get(web::shell))
 .route("/index.html",get(web::shell))
 .route("/d/{id}",get(web::shell))
 .route("/d/{id}/",get(web::shell))
 .route("/s/{token}",get(web::shell))
 .route("/s/{token}/",get(web::shell))
 .route("/s/{token}/preview.png",get(web::preview_image))
 .fallback_service(ServeDir::new("dist"))
 .layer(DefaultBodyLimit::max(64*1024))
 .layer(axum::middleware::from_fn(|req:axum::extract::Request,next:axum::middleware::Next|async move{let cacheable=req.uri().path().starts_with("/assets/");let mut response=next.run(req).await;let ok=response.status().is_success();let h=response.headers_mut();let html=h.get(header::CONTENT_TYPE).is_some_and(|v|v.as_bytes().starts_with(b"text/html"));h.insert("cache-control",if cacheable&&ok{"public, max-age=31536000, immutable"}else if html{"no-store, no-transform"}else{"no-store"}.parse().unwrap());h.insert("x-content-type-options","nosniff".parse().unwrap());h.insert("referrer-policy","no-referrer".parse().unwrap());h.insert("x-frame-options","SAMEORIGIN".parse().unwrap());h.insert("content-security-policy","default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; object-src 'none'".parse().unwrap());response}))
 .layer(axum::middleware::from_fn_with_state(s.clone(),guard))
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
    let _watcher = watch(s.clone())?;
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
        process_frame(&s, &d, &room, &update, true, true, &mut Peer::default()).unwrap();
        let receipt = uuid::Uuid::new_v4().to_string();
        let frame = Message::Custom(124, receipt.as_bytes().to_vec()).encode_v1();
        let replies =
            process_frame(&s, &d, &room, &frame, true, true, &mut Peer::default()).unwrap();
        let Message::Custom(127, payload) = Message::decode_v1(replies.last().unwrap()).unwrap()
        else {
            panic!("Missing saved acknowledgement");
        };
        assert_eq!(payload, receipt.as_bytes());
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
        assert!(events.try_recv().is_err());
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
        assert!(room.lock().unwrap().receipts.is_empty());
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
            s.store_room(&d, &mut r, true).unwrap();
        }
        fs::write(&path, "Interrupted partial").unwrap();
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
                    "SELECT count(*) FROM revisions WHERE doc=? AND content='Interrupted partial'",
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
        assert!(s.attachment_allowed(&d, &s.media_path(&d, "intentional.png").unwrap()));
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
            assert_eq!(r.last_disk, "🌍a👋c");
        }
        s.rooms.lock().unwrap().remove(&d.id);
        assert_eq!(s.room(&d).unwrap().lock().unwrap().last_disk, "🌍a👋c");
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
        let (_dir, s) = store();
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
            assert_eq!(r.last_disk, "Start\nDesktop change 👋\n");
        }
        s.rooms.lock().unwrap().remove(&d.id);
        let room = s.room(&d).unwrap();
        assert_eq!(room.lock().unwrap().last_disk, "Start\nDesktop change 👋\n");
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
            "\n![private](future-private.png)\n",
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
