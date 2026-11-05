//! Device outboxes use the same namespace and engine boundaries as the UI.
//! The operation UUID makes lost responses retryable. Uncertain filesystem
//! outcomes stop for review; a retry never adopts a different file by name.
use super::*;

pub(super) fn migrate(db: &Connection) -> Result<String> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS offline_operations(
        id TEXT PRIMARY KEY, request TEXT NOT NULL, result TEXT, created INTEGER NOT NULL);",
    )?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS offline_workspace(id INTEGER PRIMARY KEY CHECK(id=1),scope TEXT NOT NULL);")?;
    db.execute(
        "INSERT OR IGNORE INTO offline_workspace(id,scope) VALUES(1,?)",
        [uuid::Uuid::new_v4().to_string()],
    )?;
    Ok(db.query_row(
        "SELECT scope FROM offline_workspace WHERE id=1",
        [],
        |row| row.get(0),
    )?)
}

#[derive(Clone, Deserialize, Serialize)]
pub(super) struct FileCommand {
    id: String,
    kind: String,
    #[serde(default)]
    document: String,
    #[serde(default)]
    from: String,
    path: String,
    #[serde(default)]
    identity: String,
    #[serde(default)]
    children: Vec<String>,
}
fn conflict(message: &str) -> ApiError {
    ApiError(StatusCode::CONFLICT, message.into())
}

// Refresh active replicas' media/permissions without serializing their full CRDT.
pub(super) async fn metadata(
    State(s): State<App>,
    AxPath(id): AxPath<String>,
    Query(access): Query<Access>,
    h: HeaderMap,
) -> Result<Json<Value>> {
    doc_job(s, id.clone(), move |s| {
        let doc = s.doc(&id)?;
        document_payload_mode(s, &h, &doc, &access, true).map(Json)
    })
    .await
}

pub(super) async fn file(
    State(s): State<App>,
    _owner: security::Owner,
    Json(command): Json<FileCommand>,
) -> Result<Json<Value>> {
    if uuid::Uuid::parse_str(&command.id).is_err() {
        return Err(bad("Invalid operation identity."));
    }
    let operation = s
        .document_jobs
        .acquire(format!("offline:{}", command.id))
        .await;
    let document = if !command.document.is_empty() {
        Some(s.document_jobs.acquire(command.document.clone()).await)
    } else {
        None
    };
    job(s, move |s| {
        let (_operation, _document) = (operation, document);
        execute(s, command).map(Json)
    })
    .await
}

fn execute(s: &Store, command: FileCommand) -> Result<Value> {
    if !matches!(
        command.kind.as_str(),
        "create-file"
            | "create-folder"
            | "move-file"
            | "move-folder"
            | "delete-file"
            | "delete-folder"
            | "restore"
    ) {
        return Err(bad("Unknown offline file operation."));
    }
    let request =
        serde_json::to_string(&command).map_err(|_| bad("Cannot encode the offline operation."))?;
    let previous: Option<(String, Option<String>)> =
        s.db.lock()
            .unwrap()
            .query_row(
                "SELECT request,result FROM offline_operations WHERE id=?",
                [&command.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
    if let Some((kept, result)) = previous {
        if kept != request {
            return Err(conflict(
                "This operation identity was already used. Your local changes are retained.",
            ));
        }
        if let Some(result) = result {
            return serde_json::from_str(&result)
                .map_err(|_| conflict("The saved operation receipt cannot be read."));
        }
    } else {
        if command.kind == "create-file"
            && s.db
                .lock()
                .unwrap()
                .query_row("SELECT 1 FROM docs WHERE id=?", [&command.document], |_| {
                    Ok(())
                })
                .optional()?
                .is_some()
        {
            return Err(conflict("This document identity already exists."));
        }
        // Commit the request before any filesystem work. Namespace operations
        // retain their own identity journal and fsync guarantees underneath it.
        s.db.lock().unwrap().execute(
            "INSERT INTO offline_operations(id,request,created) VALUES(?,?,?)",
            params![command.id, request, now()],
        )?;
    }
    let result = apply(s, &command)?;
    s.db.lock().unwrap().execute(
        "UPDATE offline_operations SET result=? WHERE id=?",
        params![
            serde_json::to_string(&result)
                .map_err(|_| bad("Cannot encode the offline receipt."))?,
            command.id
        ],
    )?;
    Ok(result)
}

fn identity(s: &Store, path: &str, hidden: bool) -> Result<String> {
    let metadata = fs::metadata(s.safe(path, hidden)?)?;
    metadata_identity(&metadata)
}
fn metadata_identity(metadata: &fs::Metadata) -> Result<String> {
    let born = metadata
        .created()?
        .duration_since(UNIX_EPOCH)
        .map_err(|_| bad("Cannot identify this folder."))?;
    Ok(format!(
        "{}:{}:{}",
        metadata.dev(),
        metadata.ino(),
        born.as_nanos()
    ))
}
fn expected_identity(s: &Store, command: &FileCommand) -> Result<String> {
    if let Some(created) = command.identity.strip_prefix("new.") {
        let result: Option<String> =
            s.db.lock()
                .unwrap()
                .query_row(
                    "SELECT result FROM offline_operations WHERE id=?",
                    [created],
                    |row| row.get(0),
                )
                .optional()?
                .flatten();
        let result: Value = serde_json::from_str(
            &result.ok_or_else(|| conflict("The new folder has not synchronized yet."))?,
        )
        .map_err(|_| conflict("The saved folder receipt cannot be read."))?;
        return result["identity"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| conflict("The folder identity is unavailable."));
    }
    if command.identity.is_empty() {
        return Err(conflict(
            "Reconnect once to identify this folder before changing it offline.",
        ));
    }
    Ok(command.identity.clone())
}
fn deleted(s: &Store, trash: &str) -> Result<Value> {
    let item = actions::items(s)?
        .into_iter()
        .find(|item| item.id == trash)
        .ok_or_else(|| conflict("This deleted item is no longer available."))?;
    Ok(json!({"ok":true,"trash":item}))
}
fn apply(s: &Store, command: &FileCommand) -> Result<Value> {
    match command.kind.as_str() {
        "create-file" => {
            let doc = match s.doc(&command.document) {
                Ok(doc) if doc.path == command.path => doc,
                Ok(_) => {
                    return Err(conflict(
                        "The new document moved before creation finished. Your local copy is retained.",
                    ));
                }
                Err(error) if error.0 == StatusCode::NOT_FOUND => {
                    s.create_offline_document(&command.path, &command.document)?
                }
                Err(error) => return Err(error),
            };
            Ok(json!(doc))
        }
        "create-folder" => {
            // If creation completed but its receipt did not, an existing
            // folder has no recorded identity proof. Never adopt it by name.
            s.create_folder(&command.path)?;
            Ok(json!({"ok":true,"path":command.path,"identity":identity(s, &command.path, false)?}))
        }
        "move-file" => {
            s.rename_document_checked(
                &command.document,
                &command.path,
                |current, to| {
                    if current.path != command.from && current.path != to {
                        return Err(conflict(
                            "This file moved on another device. Review the pending move.",
                        ));
                    }
                    Ok(())
                },
                &|_| true,
            )?;
            Ok(json!({"ok":true,"path":command.path}))
        }
        "move-folder" => {
            let expected = expected_identity(s, command)?;
            if identity(s, &command.path, false).ok().as_ref() != Some(&expected) {
                if identity(s, &command.from, false).ok().as_ref() != Some(&expected) {
                    return Err(conflict(
                        "This folder moved or was replaced. Review the pending move.",
                    ));
                }
                s.rename_folder_checked(&command.from, &command.path, |metadata| {
                    if metadata_identity(metadata)? != expected {
                        return Err(conflict("This folder was replaced during the move."));
                    }
                    Ok(())
                })?;
            }
            Ok(json!({"ok":true,"path":command.path,"identity":expected}))
        }
        "delete-file" => {
            if let Some((item, _)) = actions::holding(s, &command.document)? {
                return Ok(json!({"ok":true,"trash":item}));
            }
            let doc = s.doc(&command.document)?;
            if doc.path != command.from {
                return Err(conflict("This file moved. Review the pending deletion."));
            }
            deleted(s, &s.trash_document(&command.document)?)
        }
        "delete-folder" => {
            let expected = expected_identity(s, command)?;
            if identity(s, &command.from, false).ok().as_ref() != Some(&expected) {
                let items = actions::items(s)?;
                let locations: Vec<(String, String)> =
                    s.db.lock()
                        .unwrap()
                        .prepare("SELECT id,location FROM trash WHERE kind='folder'")?
                        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                        .collect::<std::result::Result<_, _>>()?;
                for (id, location) in locations {
                    if items
                        .iter()
                        .any(|item| item.id == id && item.path == command.from)
                        && identity(s, &location, true).ok().as_ref() == Some(&expected)
                    {
                        return deleted(s, &id);
                    }
                }
                return Err(conflict(
                    "This folder moved or was replaced. Review the pending deletion.",
                ));
            }
            let trash = s.trash_folder_checked(&command.from, |metadata, documents| {
                if metadata_identity(metadata)? != expected {
                    return Err(conflict("This folder was replaced during the deletion."));
                }
                let mut current: Vec<_> = documents
                    .iter()
                    .map(|document| document.id.clone())
                    .collect();
                current.sort();
                let mut expected = command.children.clone();
                expected.sort();
                if current != expected {
                    return Err(conflict(
                        "The folder's documents changed while offline. Review the pending deletion.",
                    ));
                }
                Ok(())
            })?;
            deleted(s, &trash)
        }
        "restore" => {
            let target: Option<String> =
                s.db.lock()
                    .unwrap()
                    .query_row(
                        "SELECT result FROM offline_operations WHERE id=?",
                        [&command.document],
                        |r| r.get(0),
                    )
                    .optional()?
                    .flatten();
            let target = target
                .and_then(|value| serde_json::from_str::<Value>(&value).ok())
                .and_then(|v| v["trash"]["id"].as_str().map(str::to_owned))
                .unwrap_or_else(|| command.document.clone());
            let (path, documents) = s.restore_trash(&target)?;
            s.recover_restored(&documents);
            Ok(json!({"ok":true,"path":path}))
        }
        _ => Err(bad("Unknown file operation.")),
    }
}

#[derive(Deserialize)]
pub(super) struct Sync {
    epoch: String,
    update: String,
}
pub(super) async fn sync(
    State(s): State<App>,
    AxPath(id): AxPath<String>,
    Query(access): Query<Access>,
    headers: HeaderMap,
    Json(input): Json<Sync>,
) -> Result<Json<Value>> {
    doc_job(s, id.clone(), move |s| {
        sync_document(s, &id, &access, &headers, input)
    })
    .await
    .map(Json)
}
fn sync_document(
    s: &Store,
    id: &str,
    access: &Access,
    headers: &HeaderMap,
    input: Sync,
) -> Result<Value> {
    let doc = s.doc(id)?;
    let (owner, edit) = s.access(headers, &doc, access)?;
    if !edit {
        return Err(denied());
    }
    if input.epoch != s.epoch(id)? {
        return Err(conflict(
            "This document was recovered or restored. Open it to review the offline draft.",
        ));
    }
    let update = BASE64
        .decode(input.update)
        .map_err(|_| bad("Invalid collaboration update."))?;
    if update.len() > 6 * MB {
        return Err(bad(
            "This draft is too large. Open the document to review it.",
        ));
    }
    let frame = Message::Sync(SyncMessage::SyncStep2(update)).encode_v1();
    let room = s.room(&doc)?;
    let mut peer = Peer::default();
    process_frame(s, &doc, &room, &frame, true, owner, &mut peer)?;
    if peer.awaiting_sync {
        return Err(conflict(
            "This draft needs its original collaboration state. Open the document to recover it.",
        ));
    }
    {
        let mut room = room.lock().unwrap();
        room.ensure_committed(s, &doc)?;
        room.flush_to_disk(s, &doc)?;
    }
    document_payload(s, headers, &doc, access)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::store;
    fn command(kind: &str, path: &str) -> FileCommand {
        let id = uuid::Uuid::new_v4().to_string();
        FileCommand {
            document: id.clone(),
            id,
            kind: kind.into(),
            path: path.into(),
            from: String::new(),
            identity: String::new(),
            children: vec![],
        }
    }
    #[test]
    fn creation_receipts_replay_one_private_identity_without_replacing_files() {
        let (_directory, s) = store();
        let create = command("create-file", "Offline.md");
        let first = execute(&s, create.clone()).unwrap();
        let inode = fs::metadata(s.root.join("Offline.md")).unwrap().ino();
        assert_eq!(execute(&s, create.clone()).unwrap()["id"], first["id"]);
        assert_eq!(
            fs::metadata(s.root.join("Offline.md")).unwrap().ino(),
            inode
        );
        assert_eq!(fs::read_to_string(s.root.join("Offline.md")).unwrap(), "");
        assert_eq!(s.doc(&create.document).unwrap().permission, "private");
        s.db.lock()
            .unwrap()
            .execute(
                "UPDATE offline_operations SET result=NULL WHERE id=?",
                [&create.id],
            )
            .unwrap();
        assert_eq!(execute(&s, create.clone()).unwrap()["id"], first["id"]);
        let mut forged = create.clone();
        forged.path = "Different.md".into();
        assert_eq!(execute(&s, forged).unwrap_err().0, StatusCode::CONFLICT);
        let mut reused = command("create-file", "Copy.md");
        reused.document = create.document;
        assert_eq!(execute(&s, reused).unwrap_err().0, StatusCode::CONFLICT);
        assert!(!s.root.join("Copy.md").exists());
    }
    #[test]
    fn queued_moves_use_the_existing_identity_journal_and_never_overwrite() {
        let (_directory, s) = store();
        let create = command("create-file", "First.md");
        execute(&s, create.clone()).unwrap();
        fs::write(s.root.join("Occupied.md"), "Someone else's file").unwrap();
        let mut blocked = command("move-file", "Occupied.md");
        blocked.document = create.document.clone();
        blocked.from = "First.md".into();
        assert!(execute(&s, blocked).is_err());
        assert_eq!(
            fs::read_to_string(s.root.join("Occupied.md")).unwrap(),
            "Someone else's file"
        );
        let mut move_file = command("move-file", "Moved.md");
        move_file.document = create.document.clone();
        move_file.from = "First.md".into();
        execute(&s, move_file.clone()).unwrap();
        s.db.lock()
            .unwrap()
            .execute(
                "UPDATE offline_operations SET result=NULL WHERE id=?",
                [&move_file.id],
            )
            .unwrap();
        execute(&s, move_file).unwrap();
        assert_eq!(s.doc(&create.document).unwrap().path, "Moved.md");
    }
    #[test]
    fn deletion_is_retryable_and_undo_preserves_text_and_identity() {
        let (_directory, s) = store();
        fs::write(s.root.join("Note.md"), "Keep this source").unwrap();
        let doc = s.index_document("Note.md").unwrap();
        let mut delete = command("delete-file", "Note.md");
        delete.document = doc.id.clone();
        delete.from = doc.path;
        let first = execute(&s, delete.clone()).unwrap();
        s.db.lock()
            .unwrap()
            .execute(
                "UPDATE offline_operations SET result=NULL WHERE id=?",
                [&delete.id],
            )
            .unwrap();
        assert_eq!(
            execute(&s, delete.clone()).unwrap()["trash"]["id"],
            first["trash"]["id"]
        );
        let mut restore = command("restore", "Note.md");
        restore.document = delete.id;
        execute(&s, restore).unwrap();
        assert_eq!(s.doc(&doc.id).unwrap().path, "Note.md");
        assert_eq!(
            fs::read_to_string(s.root.join("Note.md")).unwrap(),
            "Keep this source"
        );
    }
    #[test]
    fn offline_folder_deletion_refuses_unseen_documents() {
        let (_directory, s) = store();
        s.create_folder("Folder").unwrap();
        let mut remove = command("delete-folder", "Folder");
        remove.document.clear();
        remove.from = "Folder".into();
        remove.identity = identity(&s, "Folder", false).unwrap();
        let new_doc = s.create_document("Folder/New.md").unwrap();
        assert_eq!(
            execute(&s, remove.clone()).unwrap_err().0,
            StatusCode::CONFLICT
        );
        assert!(s.root.join("Folder/New.md").is_file());
        let mut reviewed = command("delete-folder", "Folder");
        reviewed.document.clear();
        reviewed.from = "Folder".into();
        reviewed.identity = remove.identity;
        reviewed.children = vec![new_doc.id];
        let deleted = execute(&s, reviewed.clone()).unwrap();
        s.db.lock()
            .unwrap()
            .execute(
                "UPDATE offline_operations SET result=NULL WHERE id=?",
                [&reviewed.id],
            )
            .unwrap();
        assert_eq!(
            execute(&s, reviewed).unwrap()["trash"]["id"],
            deleted["trash"]["id"]
        );
    }
}
