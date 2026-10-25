//! The owner's sidebar file actions over HTTP: duplicate a document, move a
//! folder, delete into Locdoc's trash, list the trash and restore from it.
//! Every route is owner-only. The filesystem steps belong to namespace.rs.
use super::namespace::EntryKind;
use super::*;

/// One deleted document or folder, as the trash lists it.
#[derive(Clone, Debug, Serialize)]
pub(super) struct TrashItem {
    pub(super) id: String,
    pub(super) kind: &'static str,
    /// Where it was, and where a restore puts it back.
    pub(super) path: String,
    /// When it was deleted, in seconds.
    pub(super) deleted: i64,
    /// How many documents it holds.
    pub(super) documents: i64,
}

const ITEMS: &str = "SELECT t.id,t.kind,t.path,t.deleted,
    (SELECT count(*) FROM trashed_documents d JOIN docs r ON r.id=d.doc
     WHERE d.trash=t.id AND r.active=2)
    FROM trash t";

fn item(row: &rusqlite::Row<'_>) -> rusqlite::Result<TrashItem> {
    let kind: String = row.get(1)?;
    Ok(TrashItem {
        id: row.get(0)?,
        kind: EntryKind::parse(&kind)
            .unwrap_or(EntryKind::Document)
            .as_str(),
        path: row.get(2)?,
        deleted: row.get(3)?,
        documents: row.get(4)?,
    })
}

/// The trash, newest first.
pub(super) fn items(s: &Store) -> Result<Vec<TrashItem>> {
    Ok(s.db
        .lock()
        .unwrap()
        .prepare(&format!("{ITEMS} ORDER BY t.deleted DESC,t.rowid DESC"))?
        .query_map([], item)?
        .collect::<std::result::Result<Vec<_>, _>>()?)
}

fn find(s: &Store, id: &str) -> Result<TrashItem> {
    s.db.lock()
        .unwrap()
        .query_row(&format!("{ITEMS} WHERE t.id=?"), [id], item)
        .optional()?
        .ok_or_else(|| {
            ApiError(
                StatusCode::NOT_FOUND,
                "This item is no longer in the trash.".into(),
            )
        })
}

/// The trash item holding a trashed document, and the path the document
/// had: a folder item names only the folder.
pub(super) fn holding(s: &Store, document: &str) -> Result<Option<(TrashItem, String)>> {
    let trashed =
        s.db.lock()
            .unwrap()
            .query_row(
                "SELECT t.trash,t.path FROM trashed_documents t JOIN docs d ON d.id=t.doc
             WHERE t.doc=? AND d.active=2",
                [document],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
    trashed
        .map(|(trash, path)| Ok((find(s, &trash)?, path)))
        .transpose()
}

fn deleted(s: &Store, trash: &str) -> Result<Json<Value>> {
    Ok(Json(json!({"ok": true, "trash": find(s, trash)?})))
}

#[derive(Deserialize)]
pub(super) struct Target {
    path: String,
}

#[derive(Deserialize)]
pub(super) struct FolderMove {
    from: String,
    to: String,
}

/// A new private document holding a document's current accepted text,
/// from its collaboration state rather than its file, without comment
/// records.
pub(super) async fn duplicate(
    State(s): State<App>,
    AxPath(id): AxPath<String>,
    _owner: security::Owner,
    Json(target): Json<Target>,
) -> Result<Json<Value>> {
    doc_job(s, id.clone(), move |s| {
        let original = s.doc(&id)?;
        let room = s.room(&original)?;
        let (source, ending) = {
            let mut room = room.lock().unwrap();
            // Only what passed the durable commit barrier is accepted text.
            room.ensure_committed(s, &original)?;
            (room_text(&room), room.engine.ending().to_owned())
        };
        let copy = s.duplicate_document(
            &original,
            &target.path,
            &comments::without_records(&source, comments::plain(&original.path)),
            &ending,
        )?;
        Ok(Json(json!(copy)))
    })
    .await
}

pub(super) async fn delete_document(
    State(s): State<App>,
    AxPath(id): AxPath<String>,
    _owner: security::Owner,
) -> Result<Json<Value>> {
    doc_job(s, id.clone(), move |s| deleted(s, &s.trash_document(&id)?)).await
}

pub(super) async fn move_folder(
    State(s): State<App>,
    _owner: security::Owner,
    Json(change): Json<FolderMove>,
) -> Result<Json<Value>> {
    job(s, move |s| {
        let path = s.rename_folder(&change.from, &change.to)?;
        Ok(Json(json!({"ok": true, "path": path})))
    })
    .await
}

pub(super) async fn delete_folder(
    State(s): State<App>,
    _owner: security::Owner,
    Json(target): Json<Target>,
) -> Result<Json<Value>> {
    job(s, move |s| deleted(s, &s.trash_folder(&target.path)?)).await
}

pub(super) async fn trash(State(s): State<App>, _owner: security::Owner) -> Result<Json<Value>> {
    job(s, |s| Ok(Json(json!({"items": items(s)?})))).await
}

/// Daily retention is fixed here; callers cannot shorten the grace period.
pub(super) async fn cleanup(State(s): State<App>, _owner: security::Owner) -> Result<Json<Value>> {
    job(s, |s| {
        let (items, folders) = s.cleanup_trash(now() - 30 * 24 * 60 * 60)?;
        Ok(Json(
            json!({"ok": true, "items": items, "folders": folders}),
        ))
    })
    .await
}

pub(super) async fn restore(
    State(s): State<App>,
    AxPath(id): AxPath<String>,
    _owner: security::Owner,
) -> Result<Json<Value>> {
    job(s, move |s| {
        let (path, documents) = s.restore_trash(&id)?;
        s.recover_restored(&documents);
        Ok(Json(json!({"ok": true, "path": path})))
    })
    .await
}

#[cfg(test)]
#[path = "actions_tests.rs"]
mod tests;
