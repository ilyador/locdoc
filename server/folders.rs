//! A folder link is one capability over a real directory, not a copy of each
//! document's permissions. Directory identity prevents links reviving when a
//! removed folder's pathname is reused.
use super::*;
use std::os::unix::fs::MetadataExt;

pub(super) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS folder_shares(
        path TEXT PRIMARY KEY, identity TEXT NOT NULL,
        permission TEXT NOT NULL, token TEXT UNIQUE NOT NULL);",
    )?;
    Ok(())
}

#[derive(Clone)]
pub(super) struct Grant {
    pub path: String,
    pub permission: String,
    pub token: String,
    identity: String,
}
impl Grant {
    pub fn contains(&self, path: &str) -> bool {
        path.strip_prefix(&self.path)
            .is_some_and(|tail| tail.starts_with('/'))
    }
    fn valid(&self, s: &Store) -> bool {
        directory_identity(s, &self.path).is_ok_and(|value| value == self.identity)
    }
    pub fn value(&self, s: &Store) -> Value {
        let name = Path::new(&self.path).file_name().unwrap().to_string_lossy();
        let share_url =
            (self.permission != "private").then(|| format!("{}/s/{}", s.public_url, self.token));
        json!({"name": name, "permission": self.permission, "shareUrl": share_url})
    }
}

pub(super) fn directory_identity(s: &Store, path: &str) -> Result<String> {
    let metadata = fs::metadata(s.safe(path, false)?)?;
    if !metadata.is_dir() {
        return Err(bad("Choose an existing folder."));
    }
    // Birth time is stable across edits to children, unlike ctime. Fail closed
    // on filesystems that cannot distinguish inode reuse after deletion.
    let born = metadata
        .created()
        .map_err(|_| {
            bad("Folder sharing requires a local filesystem with directory creation times.")
        })?
        .duration_since(UNIX_EPOCH)
        .map_err(|_| bad("Cannot identify this folder."))?;
    Ok(format!(
        "{}:{}:{}",
        metadata.dev(),
        metadata.ino(),
        born.as_nanos()
    ))
}

fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Grant> {
    Ok(Grant {
        path: row.get(0)?,
        identity: row.get(1)?,
        permission: row.get(2)?,
        token: row.get(3)?,
    })
}
pub(super) fn grant(s: &Store, token: &str) -> Result<Grant> {
    const GRANT: &str = "SELECT path,identity,permission,token FROM folder_shares
        WHERE token=? AND permission!='private'";
    let value =
        s.db.lock()
            .unwrap()
            .query_row(GRANT, [token], row)
            .optional()?;
    let value = value.ok_or_else(unavailable)?;
    if !value.valid(s) {
        return Err(unavailable());
    }
    Ok(value)
}
fn unavailable() -> ApiError {
    ApiError(
        StatusCode::NOT_FOUND,
        "This folder link has been turned off or the folder was moved or removed.".into(),
    )
}
pub(super) fn active(s: &Store) -> Result<Vec<Grant>> {
    let values = s
        .db
        .lock()
        .unwrap()
        .prepare(
            "SELECT path,identity,permission,token FROM folder_shares WHERE permission!='private'",
        )?
        .query_map([], row)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(values.into_iter().filter(|value| value.valid(s)).collect())
}
pub(super) fn entries(s: &Store, folder: &Grant) -> Result<Vec<Entry>> {
    let mut values = vec![];
    scan(s, &s.safe(&folder.path, false)?, &mut values)?;
    for entry in &mut values {
        entry.path = entry
            .path
            .strip_prefix(&format!("{}/", folder.path))
            .ok_or_else(denied)?
            .to_string();
        entry.shared = true;
        entry.url = entry
            .id
            .as_ref()
            .map(|id| format!("{}/s/{}?doc={id}", s.public_url, folder.token));
    }
    if !folder.valid(s) {
        return Err(unavailable());
    }
    Ok(values)
}
pub(super) fn document(
    s: &Store,
    folder: &Grant,
    selected: Option<&str>,
) -> Result<Option<Document>> {
    let selected = if let Some(id) = selected {
        Some(id.to_string())
    } else {
        entries(s, folder)?.into_iter().find_map(|entry| entry.id)
    };
    selected
        .map(|id| {
            let doc = s.doc(&id)?;
            if !folder.contains(&doc.path) {
                return Err(denied());
            }
            Ok(doc)
        })
        .transpose()
}

#[derive(Deserialize)]
pub(super) struct Selection {
    pub doc: Option<String>,
}
#[derive(Deserialize)]
pub(super) struct PathQuery {
    path: String,
}
pub(super) async fn read(
    State(s): State<App>,
    _owner: security::Owner,
    Query(q): Query<PathQuery>,
) -> Result<Json<Value>> {
    let path = documents::relative_path(&q.path, false)?;
    let identity = directory_identity(&s, &path)?;
    let value =
        s.db.lock()
            .unwrap()
            .query_row(
                "SELECT path,identity,permission,token FROM folder_shares WHERE path=?",
                [&path],
                row,
            )
            .optional()?;
    let mut value = value
        .filter(|value| value.identity == identity)
        .map(|value| value.value(&s))
        .unwrap_or_else(|| json!({"permission":"private","shareUrl":null}));
    let access = mcp_access::folder_access(&s, &path)?;
    value["mcpAllowed"] = json!(access.mcp_allowed);
    value["mcpDirect"] = json!(access.mcp_direct);
    value["mcpInherited"] = json!(access.mcp_inherited);
    Ok(Json(value))
}
#[derive(Deserialize)]
pub(super) struct Change {
    path: String,
    permission: String,
    #[serde(default)]
    rotate: bool,
}
pub(super) async fn share(
    State(s): State<App>,
    _owner: security::Owner,
    Json(b): Json<Change>,
) -> Result<Json<Value>> {
    job(s, move |s| share_folder(s, b)).await.map(Json)
}
pub(super) fn share_folder(s: &Store, b: Change) -> Result<Value> {
    if !["private", "view", "edit"].contains(&b.permission.as_str()) {
        return Err(bad("Choose private, view, or edit."));
    }
    let path = documents::relative_path(&b.path, false)?;
    let identity = directory_identity(s, &path)?;
    let previous =
        s.db.lock()
            .unwrap()
            .query_row(
                "SELECT path,identity,permission,token FROM folder_shares WHERE path=?",
                [&path],
                row,
            )
            .optional()?;
    let token = previous
        .filter(|value| {
            !b.rotate
                && b.permission != "private"
                && value.permission != "private"
                && value.identity == identity
        })
        .map(|value| value.token)
        .unwrap_or_else(token);
    let value = Grant {
        path,
        identity,
        permission: b.permission,
        token,
    };
    const UPSERT: &str = "INSERT INTO folder_shares(path,identity,permission,token)
            VALUES(?,?,?,?) ON CONFLICT(path) DO UPDATE SET
            identity=excluded.identity,permission=excluded.permission,token=excluded.token";
    s.db.lock().unwrap().execute(
        UPSERT,
        params![value.path, value.identity, value.permission, value.token],
    )?;
    s.permissions.invalidate();
    // Reconnect descendants immediately. Cached passive checks also see
    // this mutation even if a busy room cannot be notified immediately.
    let rooms: Vec<_> = s
        .rooms
        .lock()
        .unwrap()
        .iter()
        .map(|(id, room)| (id.clone(), room.clone()))
        .collect();
    for (id, room) in rooms {
        if s.doc(&id).is_ok_and(|doc| value.contains(&doc.path))
            && let Ok(room) = room.try_lock()
        {
            let _ = room.tx.send(vec![126]);
        }
    }
    Ok(value.value(s))
}
