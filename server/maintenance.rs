//! Explicit owner recovery. Collaboration rebases never run automatically:
//! archive every original byte before replacing identities, and require all
//! connected editors to leave before starting a new collaboration generation.
use super::*;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

#[cfg(test)]
#[path = "maintenance_tests.rs"]
mod tests;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RecoveryUpdate {
    sequence: i64,
    state: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RecoveryComment {
    id: String,
    guest: String,
    data: String,
}

#[derive(Serialize)]
pub(super) struct RecoveryVersion {
    id: String,
    created: i64,
    kind: String,
    content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RecoveryBundle {
    format: &'static str,
    document: String,
    path: String,
    created: i64,
    collaboration_epoch: String,
    state: Option<String>,
    disk_state: Option<String>,
    write_intent: bool,
    write_conflict: bool,
    write_target: Option<String>,
    write_state: Option<String>,
    write_before_hash: Option<String>,
    write_before: Option<String>,
    line_ending: String,
    updates: Vec<RecoveryUpdate>,
    comments: Vec<RecoveryComment>,
    filesystem_bytes: Option<String>,
    filesystem_source: Option<String>,
    filesystem_error: Option<String>,
    live_state: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pending_comments: Vec<Value>,
    versions: Vec<RecoveryVersion>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemovedDocument {
    id: String,
    path: String,
    removed: Option<i64>,
}

pub(super) async fn removed(
    State(store): State<App>,
    _owner: security::Owner,
) -> Result<Json<Vec<RemovedDocument>>> {
    const REMOVED: &str = "SELECT id,COALESCE(retired_path,id),retired_at
        FROM docs WHERE active=0 ORDER BY retired_at DESC,id";
    let records = job(store, |store| {
        let db = store.db.lock().unwrap();
        let mut statement = db.prepare(REMOVED)?;
        let records = statement.query_map([], |row| {
            Ok(RemovedDocument {
                id: row.get(0)?,
                path: row.get(1)?,
                removed: row.get(2)?,
            })
        })?;
        Ok(records.collect::<std::result::Result<Vec<_>, _>>()?)
    })
    .await?;
    Ok(Json(records))
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum RebuildSource {
    Durable,
    Disk,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RebuildRequest {
    source: RebuildSource,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RebuildResult {
    id: String,
    collaboration_epoch: String,
    archive: String,
    preserved_comments: usize,
    archived_comments: usize,
}

fn conflict(message: &str) -> ApiError {
    ApiError(StatusCode::CONFLICT, message.into())
}

struct RecoveryState {
    state: Option<Vec<u8>>,
    disk_state: Option<Vec<u8>>,
    intent: i64,
    ending: String,
    epoch: String,
    target: Option<Vec<u8>>,
    target_state: Option<Vec<u8>>,
    before_hash: Option<String>,
    before: Option<Vec<u8>>,
}

#[derive(Deserialize)]
pub(super) struct ExportOptions {
    history: Option<bool>,
}

fn capture(
    store: &Store,
    document: &Document,
    filesystem: std::result::Result<Vec<u8>, String>,
    live: Option<&Room>,
    history: bool,
) -> Result<RecoveryBundle> {
    const STORED: &str = "SELECT state,disk_state,write_intent,line_ending,
        collaboration_epoch,write_target,write_state,write_before_hash,write_before
        FROM docs WHERE id=?";
    let db = store.db.lock().unwrap();
    let RecoveryState {
        state,
        disk_state,
        intent,
        ending,
        epoch,
        target,
        target_state,
        before_hash,
        before,
    } = db.query_row(STORED, [&document.id], |row| {
        Ok(RecoveryState {
            state: row.get(0)?,
            disk_state: row.get(1)?,
            intent: row.get(2)?,
            ending: row.get(3)?,
            epoch: row.get(4)?,
            target: row.get(5)?,
            target_state: row.get(6)?,
            before_hash: row.get(7)?,
            before: row.get(8)?,
        })
    })?;
    let updates = db
        .prepare("SELECT seq,content FROM doc_updates WHERE doc=? ORDER BY seq")?
        .query_map([&document.id], |row| {
            Ok(RecoveryUpdate {
                sequence: row.get(0)?,
                state: BASE64.encode(row.get::<_, Vec<u8>>(1)?),
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let comments = db
        .prepare("SELECT id,guest,data FROM comments WHERE doc=? ORDER BY rowid")?
        .query_map([&document.id], |row| {
            Ok(RecoveryComment {
                id: row.get(0)?,
                guest: row.get(1)?,
                data: row.get(2)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let versions = if history {
        db.prepare("SELECT id,created,kind,content FROM revisions WHERE doc=? ORDER BY rowid DESC")?
            .query_map([&document.id], |row| {
                Ok(RecoveryVersion {
                    id: row.get(0)?,
                    created: row.get(1)?,
                    kind: row.get(2)?,
                    content: row.get(3)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?
    } else {
        Vec::new()
    };
    let (filesystem_bytes, filesystem_source, filesystem_error) = match filesystem {
        Ok(bytes) => {
            let source = String::from_utf8(bytes.clone()).ok();
            let error = source.is_none().then(|| {
                "The file is not UTF-8; its exact bytes are included in filesystemBytes.".into()
            });
            (Some(BASE64.encode(bytes)), source, error)
        }
        Err(error) => (None, None, Some(error)),
    };
    Ok(RecoveryBundle {
        format: "locdoc-recovery-v1",
        document: document.id.clone(),
        path: document.path.clone(),
        created: now(),
        collaboration_epoch: epoch,
        state: state.map(|bytes| BASE64.encode(bytes)),
        disk_state: disk_state.map(|bytes| BASE64.encode(bytes)),
        write_intent: intent != 0,
        write_conflict: intent == 2 || live.is_some_and(Room::conflicted),
        write_target: target.map(|bytes| BASE64.encode(bytes)),
        write_state: target_state.map(|bytes| BASE64.encode(bytes)),
        write_before_hash: before_hash,
        write_before: before.map(|bytes| BASE64.encode(bytes)),
        line_ending: ending,
        updates,
        comments,
        filesystem_bytes,
        filesystem_source,
        filesystem_error,
        live_state: live.map(|room| {
            BASE64.encode(
                room.awareness
                    .doc()
                    .transact()
                    .encode_state_as_update_v1(&StateVector::default()),
            )
        }),
        pending_comments: live.map(Room::pending_comment_metadata).unwrap_or_default(),
        versions,
    })
}

fn read_file(store: &Store, document: &Document) -> Result<(PathBuf, DiskFile, Vec<u8>)> {
    read_guarded_file(store, document, false)
}

fn read_guarded_file(
    store: &Store,
    document: &Document,
    writable: bool,
) -> Result<(PathBuf, DiskFile, Vec<u8>)> {
    let path = store.safe(&document.path, false)?;
    let opened = if writable {
        DiskFile::open(&path)?
    } else {
        DiskFile::open_read(&path)?
    };
    let mut file = opened.ok_or_else(|| conflict(
        "The desktop file is unavailable or still being saved. Finish that save before rebuilding.",
    ))?;
    if store.unmatched_file(&document.id, &file.metadata()?)? {
        return Err(conflict(
            "This file is still being matched to its document. Retry shortly.",
        ));
    }
    let source = file.read_bytes()?;
    if !file.excludes_writers() || !file.is_current(&path) {
        return Err(conflict(
            "The desktop file changed. Retry after its save finishes.",
        ));
    }
    Ok((path, file, source))
}

fn archive(store: &Store, bundle: &RecoveryBundle) -> Result<String> {
    let directory = store.data.join("recovery");
    fs::create_dir_all(&directory)?;
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
    let name = format!("{}.json", uuid::Uuid::new_v4());
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(directory.join(&name))?;
    serde_json::to_writer(&mut file, bundle)
        .map_err(|_| bad("Could not serialize the recovery archive."))?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    fs::File::open(&directory)?.sync_all()?;
    fs::File::open(&store.data)?.sync_all()?;
    Ok(format!("recovery/{name}"))
}

pub(super) async fn export(
    State(store): State<App>,
    AxPath(id): AxPath<String>,
    _owner: security::Owner,
    Query(options): Query<ExportOptions>,
) -> Result<Json<RecoveryBundle>> {
    Ok(Json(
        doc_job(store, id.clone(), move |store| {
            // Retired identities remain private recovery records. Never open
            // their former path: it may now belong to an unrelated document.
            // A trashed one is listed under the path a restore returns it to.
            let (document, active) = store
                .db
                .lock()
                .unwrap()
                .query_row(
                    "SELECT COALESCE(t.path,d.retired_path,d.path),d.active FROM docs d
                     LEFT JOIN trashed_documents t ON t.doc=d.id WHERE d.id=?",
                    [&id],
                    |row| {
                        Ok((
                            Document {
                                id: id.clone(),
                                path: row.get(0)?,
                                permission: "private".into(),
                                token: None,
                            },
                            row.get::<_, i64>(1)?,
                        ))
                    },
                )
                .optional()?
                .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Document not found.".into()))?;
            let room = store.rooms.lock().unwrap().get(&id).cloned();
            let live = room.as_ref().map(|room| room.lock().unwrap());
            let filesystem = match active {
                1 => read_file(store, &document)
                    .map(|(_, _, source)| source)
                    .map_err(|error| error.1),
                2 => Err("This document is in the trash. Restore it to read its file.".into()),
                _ => Err(
                    "This document was removed. Its former path is not read or restored.".into(),
                ),
            };
            capture(
                store,
                &document,
                filesystem,
                live.as_deref(),
                options.history.unwrap_or(true),
            )
        })
        .await?,
    ))
}

fn rebuild_document(store: &Store, id: &str, choice: RebuildSource) -> Result<RebuildResult> {
    let _files = store.document_files.lock().unwrap();
    let document = store.doc(id)?;
    // Load before taking the cache gate. A corrupt row is intentionally allowed
    // only for the owner's explicit disk choice; its original bytes are archived.
    let loaded = match store.room(&document) {
        Ok(room) => Some(room),
        Err(_) if matches!(choice, RebuildSource::Disk) => None,
        Err(_) => {
            return Err(conflict(
                "Durable source cannot be decoded. Export recovery data, then explicitly choose the desktop file to rebuild.",
            ));
        }
    };
    let mut live = loaded.as_ref().map(|room| room.lock().unwrap());
    // Never wait for a document while holding the cache map. A rename may
    // hold that document while retiring another cached identity.
    let mut rooms = store.rooms.lock().unwrap();
    if let Some(room) = loaded.as_ref()
        && (live.as_ref().unwrap().tx.receiver_count() != 0 || Arc::strong_count(room) > 2)
    {
        return Err(conflict(
            "Close all document tabs before rebuilding collaboration history.",
        ));
    }
    let explicit_projection =
        matches!(choice, RebuildSource::Durable) && live.as_deref().is_some_and(Room::conflicted);
    if matches!(choice, RebuildSource::Durable) {
        let room = live.as_mut().unwrap();
        security::validate_document(room.awareness.doc()).map_err(|_| conflict(
            "Stored collaboration data is not plain text. Export recovery data, then explicitly choose the desktop file to rebuild.",
        ))?;
        if !explicit_projection && !room.flush_to_disk(store, &document)? {
            return Err(conflict(
                "The current edits are waiting for the desktop file. Finish its save before rebuilding.",
            ));
        }
    }
    let (path, mut file, bytes) = read_guarded_file(store, &document, explicit_projection)?;
    let raw = match String::from_utf8(bytes.clone()) {
        Ok(raw) => raw,
        // The owner chose durable text, not the incomplete external bytes.
        // They are still archived exactly before replacement; only the line
        // ending preference falls back to its last known value.
        Err(_) if explicit_projection => String::new(),
        Err(_) => {
            return Err(conflict(
                "The desktop file is not complete UTF-8. Export its recovery bytes and repair the file before rebuilding.",
            ));
        }
    };
    let chosen = if matches!(choice, RebuildSource::Durable) {
        let current = security::validate_document(live.as_ref().unwrap().awareness.doc())?;
        if !explicit_projection && current != text::canonical(&raw) {
            return Err(conflict(
                "The desktop file changed during recovery. Retry to reconcile it first.",
            ));
        }
        current
    } else {
        text::canonical(&raw)
    };
    let bundle = capture(store, &document, Ok(bytes), live.as_deref(), true)?;
    let saved_archive = archive(store, &bundle)?;
    if !file.excludes_writers() || !file.is_current(&path) {
        return Err(conflict(
            "The desktop file changed. Recovery was archived; retry after the save finishes.",
        ));
    }
    if explicit_projection {
        // The owner explicitly selected accepted edits over the conflicting
        // desktop save. Preserve both originals before touching the same inode.
        let ending = text::ending(&raw, &bundle.line_ending);
        file.write(&text::render(&chosen, &ending))?;
        if !file.excludes_writers() || !file.is_current(&path) {
            return Err(conflict(
                "The desktop file changed during recovery. Its originals were archived; retry after its save finishes.",
            ));
        }
    }
    let fresh = Doc::with_options(Options {
        offset_kind: OffsetKind::Utf16,
        ..Options::default()
    });
    fresh
        .get_or_insert_text("content")
        .insert(&mut fresh.transact_mut(), 0, &chosen);
    let state = fresh
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let epoch = uuid::Uuid::new_v4().to_string();
    let metadata: Vec<Value> = bundle
        .comments
        .iter()
        .filter_map(|row| {
            let mut value: Value = serde_json::from_str(&row.data).ok()?;
            let object = value.as_object_mut()?;
            // SQLite owns identity; malformed opaque JSON cannot change it
            // while a rebuild recovers an otherwise recognizable thread.
            object.insert("id".into(), json!(row.id));
            object.insert("guest".into(), json!(row.guest));
            Some(value)
        })
        .collect();
    let restored = live
        .as_deref()
        .filter(|old| security::validate_document(old.awareness.doc()).is_ok())
        .map(|old| {
            let plain = comments::plain(&document.path);
            comments::rebuild_metadata(old, &fresh, &chosen, &metadata, plain)
        })
        .unwrap_or_default();
    let mut db = store.db.lock().unwrap();
    let tx = db.transaction()?;
    const REBUILD_DOCUMENT: &str = "UPDATE docs SET state=?,disk_state=?,write_intent=0,
        write_target=NULL,write_state=NULL,write_before_hash=NULL,write_before=NULL,
        line_ending=?,line_ending_migrated=0,browser_generation=0,protected_generation=0,
        collaboration_epoch=? WHERE id=? AND active=1";
    tx.execute(
        REBUILD_DOCUMENT,
        params![
            state,
            state,
            text::ending(&raw, &bundle.line_ending),
            epoch,
            id
        ],
    )?;
    tx.execute("DELETE FROM doc_updates WHERE doc=?", [id])?;
    tx.execute("DELETE FROM comments WHERE doc=?", [id])?;
    for row in &restored {
        tx.execute(
            "INSERT INTO comments(id,doc,guest,data) VALUES(?,?,?,?)",
            params![
                row["id"].as_str(),
                id,
                row["guest"].as_str().unwrap_or(""),
                row.to_string()
            ],
        )?;
    }
    // Rebuilding identity must not silently widen attachment sharing. Preserve
    // current grants that remain referenced and revoke references removed by an
    // explicit disk choice; retained historical grants stay separately stored.
    store.commit_active_media(&tx, &document, &chosen, &HashSet::new())?;
    tx.commit()?;
    drop(db);
    drop(live);
    rooms.remove(id);
    Ok(RebuildResult {
        id: id.into(),
        collaboration_epoch: epoch,
        archive: saved_archive,
        preserved_comments: restored.len(),
        archived_comments: bundle.comments.len() - restored.len(),
    })
}

pub(super) async fn rebuild(
    State(store): State<App>,
    AxPath(id): AxPath<String>,
    _owner: security::Owner,
    Json(request): Json<RebuildRequest>,
) -> Result<Json<RebuildResult>> {
    Ok(Json(
        doc_job(store, id.clone(), move |store| {
            rebuild_document(store, &id, request.source)
        })
        .await?,
    ))
}
