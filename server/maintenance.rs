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
    line_ending: String,
    updates: Vec<RecoveryUpdate>,
    comments: Vec<RecoveryComment>,
    filesystem_bytes: Option<String>,
    filesystem_source: Option<String>,
    filesystem_error: Option<String>,
    live_state: Option<String>,
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

fn capture(
    store: &Store,
    document: &Document,
    filesystem: std::result::Result<Vec<u8>, String>,
    live: Option<&Room>,
) -> Result<RecoveryBundle> {
    let db = store.db.lock().unwrap();
    let (state, disk_state, intent, ending, epoch): (
        Option<Vec<u8>>, Option<Vec<u8>>, bool, String, String,
    ) = db.query_row(
        "SELECT state,disk_state,write_intent,line_ending,collaboration_epoch FROM docs WHERE id=? AND active=1",
        [&document.id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
    )?;
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
        write_intent: intent,
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
    })
}

fn read_file(store: &Store, document: &Document) -> Result<(PathBuf, DiskFile, Vec<u8>)> {
    let path = store.safe(&document.path, false)?;
    let mut file = DiskFile::open_read(&path)?.ok_or_else(|| conflict(
        "The desktop file is unavailable or still being saved. Finish that save before rebuilding.",
    ))?;
    let source = file.read_bytes()?;
    if !file.intact() || !file.is_current(&path) {
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
) -> Result<Json<RecoveryBundle>> {
    Ok(Json(
        job(store, move |store| {
            let document = store.doc(&id)?;
            let room = store.rooms.lock().unwrap().get(&id).cloned();
            let live = room.as_ref().map(|room| room.lock().unwrap());
            let filesystem = read_file(store, &document)
                .map(|(_, _, source)| source)
                .map_err(|error| error.1);
            capture(store, &document, filesystem, live.as_deref())
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
    let mut rooms = store.rooms.lock().unwrap();
    let mut live = loaded.as_ref().map(|room| room.lock().unwrap());
    if let Some(room) = loaded.as_ref()
        && (live.as_ref().unwrap().tx.receiver_count() != 0 || Arc::strong_count(room) > 2)
    {
        return Err(conflict(
            "Close all document tabs before rebuilding collaboration history.",
        ));
    }
    if matches!(choice, RebuildSource::Durable) {
        let room = live.as_mut().unwrap();
        security::validate_document(room.awareness.doc()).map_err(|_| conflict(
            "Stored collaboration data is not plain text. Export recovery data, then explicitly choose the desktop file to rebuild.",
        ))?;
        if !store.persist(&document, room)? {
            return Err(conflict(
                "The current edits are waiting for the desktop file. Finish its save before rebuilding.",
            ));
        }
    }
    let (path, file, bytes) = read_file(store, &document)?;
    let raw = String::from_utf8(bytes.clone()).map_err(|_| conflict(
        "The desktop file is not complete UTF-8. Export its recovery bytes and repair the file before rebuilding.",
    ))?;
    let chosen = if matches!(choice, RebuildSource::Durable) {
        let current = security::validate_document(live.as_ref().unwrap().awareness.doc())?;
        if current != text::canonical(&raw) {
            return Err(conflict(
                "The desktop file changed during recovery. Retry to reconcile it first.",
            ));
        }
        current
    } else {
        text::canonical(&raw)
    };
    let bundle = capture(store, &document, Ok(bytes), live.as_deref())?;
    let saved_archive = archive(store, &bundle)?;
    if !file.intact() || !file.is_current(&path) {
        return Err(conflict(
            "The desktop file changed. Recovery was archived; retry after the save finishes.",
        ));
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
        .map(|old| comments::rebuild_metadata(old, &fresh, &chosen, &metadata))
        .unwrap_or_default();
    let mut db = store.db.lock().unwrap();
    let tx = db.transaction()?;
    tx.execute("UPDATE docs SET state=?,disk_state=?,write_intent=0,line_ending=?,line_ending_migrated=0,browser_generation=0,protected_generation=0,collaboration_epoch=? WHERE id=? AND active=1",
        params![state, state, text::ending(&raw, &bundle.line_ending), epoch, id])?;
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
        job(store, move |store| {
            rebuild_document(store, &id, request.source)
        })
        .await?,
    ))
}
