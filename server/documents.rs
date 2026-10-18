//! The only boundary that assigns document identities or changes filenames.
//! Paths are normalized before storage. Discovery preserves an identity;
//! explicit creation always gets a fresh, private identity.
use super::*;
use std::os::unix::fs::MetadataExt;

#[derive(Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct RootIdentity {
    device: u64,
    inode: u64,
}
impl RootIdentity {
    fn read(path: &Path) -> std::io::Result<Self> {
        let metadata = fs::metadata(path)?;
        if !metadata.is_dir() {
            return Err(std::io::Error::other("Documents path is not a folder."));
        }
        Ok(Self {
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }
    pub(super) fn matches(&self, path: &Path) -> bool {
        Self::read(path).is_ok_and(|identity| identity == *self)
    }
}

fn root_unavailable() -> ApiError {
    ApiError(StatusCode::SERVICE_UNAVAILABLE,
        "The documents folder is unavailable or was replaced. Restore the configured folder before continuing.".into())
}

/// First installation may create a folder; reopening an existing workspace
/// must never turn a missing mount into an empty replacement workspace.
pub(super) fn prepare_root(root: &Path, data: &Path) -> Result<(PathBuf, RootIdentity)> {
    match fs::metadata(root) {
        Ok(metadata) if metadata.is_dir() => {}
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound
                && !data.join("locdoc.sqlite").exists()
                && !data.join("root.identity").exists() =>
        {
            fs::create_dir_all(root)?
        }
        _ => return Err(root_unavailable()),
    }
    let root = fs::canonicalize(root)?;
    let identity = RootIdentity::read(&root)?;
    let identity_path = data.join("root.identity");
    match fs::read(&identity_path) {
        Ok(bytes) => {
            let previous: RootIdentity =
                serde_json::from_slice(&bytes).map_err(|_| root_unavailable())?;
            if previous != identity {
                return Err(root_unavailable());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            use std::io::Write;
            use std::os::unix::fs::OpenOptionsExt;
            let temporary = data.join(format!(".root-identity-{}.tmp", uuid::Uuid::new_v4()));
            let result: Result<()> = (|| {
                let mut file = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(&temporary)?;
                file.write_all(&serde_json::to_vec(&identity).map_err(|_| root_unavailable())?)?;
                file.sync_all()?;
                fs::rename(&temporary, &identity_path)?;
                fs::File::open(data)?.sync_all()?;
                Ok(())
            })();
            if result.is_err() {
                let _ = fs::remove_file(temporary);
            }
            result?;
        }
        Err(error) => return Err(error.into()),
    }
    Ok((root, identity))
}

#[derive(PartialEq)]
pub(super) enum Format {
    Markdown,
    Fountain,
}

pub(super) fn format(path: &str) -> Option<Format> {
    match Path::new(path)
        .extension()?
        .to_str()?
        .to_ascii_lowercase()
        .as_str()
    {
        "md" => Some(Format::Markdown),
        "fountain" => Some(Format::Fountain),
        _ => None,
    }
}

pub(super) fn relative_path(input: &str, hidden: bool) -> Result<String> {
    let path = Path::new(input);
    if path.is_absolute() || input.contains('\\') {
        return Err(bad("Use a relative path within the documents folder."));
    }
    let mut parts = Vec::new();
    for part in path.components() {
        match part {
            Component::Normal(name) if hidden || !name.to_string_lossy().starts_with('.') => {
                parts.push(name.to_string_lossy().into_owned());
            }
            Component::CurDir => {}
            _ => return Err(bad("Use a relative path within the documents folder.")),
        }
    }
    if parts.is_empty() {
        return Err(bad("Enter a file or folder name."));
    }
    Ok(parts.join("/"))
}

fn retire(db: &Connection, id: &str) -> Result<()> {
    const RETIRE: &str = "UPDATE docs SET active=0,
        retired_path=COALESCE(retired_path,path),retired_at=?,path=?,
        permission='private',token=NULL WHERE id=? AND active=1";
    db.execute(RETIRE, params![now(), format!(".retired/{id}"), id])?;
    Ok(())
}

pub(super) fn migrate(connection: &Connection) -> Result<()> {
    let db = connection.unchecked_transaction()?;
    let has_active = db
        .prepare("PRAGMA table_info(docs)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(std::result::Result::ok)
        .any(|name| name == "active");
    if !has_active {
        db.execute(
            "ALTER TABLE docs ADD COLUMN active INTEGER NOT NULL DEFAULT 1",
            [],
        )?;
    }
    for (name, definition) in [
        ("disk_state", "BLOB"),
        ("write_intent", "INTEGER NOT NULL DEFAULT 0"),
        ("write_target", "BLOB"),
        ("write_before_hash", "TEXT"),
        ("write_before", "BLOB"),
        ("line_ending", "TEXT NOT NULL DEFAULT 'lf'"),
        ("line_ending_migrated", "INTEGER NOT NULL DEFAULT 0"),
        ("browser_generation", "INTEGER NOT NULL DEFAULT 0"),
        ("collaboration_epoch", "TEXT NOT NULL DEFAULT ''"),
        ("media_initialized", "INTEGER NOT NULL DEFAULT 0"),
        ("protected_generation", "INTEGER NOT NULL DEFAULT -1"),
        ("retired_path", "TEXT"),
        ("retired_at", "INTEGER"),
    ] {
        let exists = db
            .prepare("PRAGMA table_info(docs)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(std::result::Result::ok)
            .any(|column| column == name);
        if !exists {
            db.execute(
                &format!("ALTER TABLE docs ADD COLUMN {name} {definition}"),
                [],
            )?;
        }
    }
    db.execute_batch("CREATE TABLE IF NOT EXISTS active_media(doc TEXT NOT NULL,reference TEXT NOT NULL,PRIMARY KEY(doc,reference));")?;
    let has_kind = db
        .prepare("PRAGMA table_info(revisions)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(std::result::Result::ok)
        .any(|column| column == "kind");
    if !has_kind {
        db.execute(
            "ALTER TABLE revisions ADD COLUMN kind TEXT NOT NULL DEFAULT 'autosave'",
            [],
        )?;
    }
    let has_pending = db
        .prepare("PRAGMA table_info(assets)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(std::result::Result::ok)
        .any(|column| column == "pending_until");
    if !has_pending {
        db.execute(
            "ALTER TABLE assets ADD COLUMN pending_until INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    let rows = db
        .prepare("SELECT id,path FROM docs WHERE active=1 ORDER BY path")?
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for (id, path) in rows {
        let Ok(normalized) = relative_path(&path, false) else {
            retire(&db, &id)?;
            continue;
        };
        if normalized == path {
            continue;
        }
        let existing = db
            .query_row(
                "SELECT id FROM docs WHERE path=? AND active=1",
                [&normalized],
                |r| r.get::<_, String>(0),
            )
            .optional()?;
        if existing.is_some() {
            retire(&db, &id)?;
        } else {
            db.execute("UPDATE docs SET path=? WHERE id=?", params![normalized, id])?;
        }
    }
    db.commit()?;
    Ok(())
}

impl Store {
    pub(super) fn safe(&self, rel: &str, hidden: bool) -> Result<PathBuf> {
        if !self.root_identity.matches(&self.root) {
            return Err(root_unavailable());
        }
        let normalized = relative_path(rel, hidden)?;
        let mut path = self.root.clone();
        for part in Path::new(&normalized).components() {
            path.push(part);
            // Symlink aliases would otherwise produce two IDs for one file.
            if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
                return Err(denied());
            }
        }
        Ok(path)
    }

    pub(super) fn doc(&self, id: &str) -> Result<Document> {
        self.db
            .lock()
            .unwrap()
            .query_row(
                "SELECT id,path,permission,token FROM docs WHERE id=? AND active=1",
                [id],
                |r| {
                    Ok(Document {
                        id: r.get(0)?,
                        path: r.get(1)?,
                        permission: r.get(2)?,
                        token: r.get(3)?,
                    })
                },
            )
            .optional()?
            .ok_or(ApiError(
                StatusCode::NOT_FOUND,
                "Document not found.".into(),
            ))
    }

    pub(super) fn index_document(&self, input: &str) -> Result<Document> {
        let _files = self.document_files.lock().unwrap();
        let path = relative_path(input, false)?;
        if format(&path).is_none() || !self.safe(&path, false)?.is_file() {
            return Err(ApiError(
                StatusCode::NOT_FOUND,
                "Document not found.".into(),
            ));
        }
        let id = {
            let db = self.db.lock().unwrap();
            db.execute(
                "INSERT OR IGNORE INTO docs(id,path) VALUES(?,?)",
                params![uuid::Uuid::new_v4().to_string(), path],
            )?;
            db.query_row(
                "SELECT id FROM docs WHERE path=? AND active=1",
                [&path],
                |r| r.get::<_, String>(0),
            )?
        };
        self.doc(&id)
    }

    fn close_document(&self, id: &str) {
        let room = self.rooms.lock().unwrap().remove(id);
        if let Some(room) = room {
            let _ = room.lock().unwrap().tx.send(vec![126]);
        }
    }

    pub(super) fn create_document(&self, input: &str) -> Result<Document> {
        use std::io::Write;
        let _files = self.document_files.lock().unwrap();
        let path = relative_path(input, false)?;
        if format(&path).is_none() {
            return Err(bad("Document names must end with .md or .fountain."));
        }
        let full = self.safe(&path, false)?;
        fs::create_dir_all(full.parent().ok_or_else(|| bad("Invalid path."))?)?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&full)
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::AlreadyExists {
                    bad("A file or folder with this name already exists.")
                } else {
                    e.into()
                }
            })?;
        let result = (|| {
            let title = full
                .file_stem()
                .ok_or_else(|| bad("Invalid filename."))?
                .to_string_lossy();
            let initial = if format(&path) == Some(Format::Fountain) {
                format!("Title: {title}\n\n")
            } else {
                format!("# {title}\n\n")
            };
            file.write_all(initial.as_bytes())?;
            file.sync_all()?;
            let id = uuid::Uuid::new_v4().to_string();
            let mut db = self.db.lock().unwrap();
            let tx = db.transaction()?;
            let previous = tx
                .query_row("SELECT id FROM docs WHERE path=?", [&path], |r| {
                    r.get::<_, String>(0)
                })
                .optional()?;
            if let Some(ref previous) = previous {
                retire(&tx, previous)?;
            }
            tx.execute("INSERT INTO docs(id,path) VALUES(?,?)", params![id, path])?;
            tx.commit()?;
            drop(db);
            self.permissions.invalidate();
            if let Some(previous) = previous {
                self.close_document(&previous);
            }
            Ok(Document {
                id,
                path: path.clone(),
                permission: "private".into(),
                token: None,
            })
        })();
        if result.is_err() {
            let _ = fs::remove_file(full);
        }
        result
    }

    pub(super) fn rename_document(&self, id: &str, input: &str) -> Result<()> {
        let _files = self.document_files.lock().unwrap();
        let d = self.doc(id)?;
        let path = relative_path(input, false)?;
        if path == d.path {
            return Ok(());
        }
        if format(&path).is_none() {
            return Err(bad("Document names must end with .md or .fountain."));
        }
        if Path::new(&path).parent() != Path::new(&d.path).parent() {
            return Err(bad(
                "Rename within the same folder to preserve relative attachments.",
            ));
        }
        let dest = self.safe(&path, false)?;
        if dest.exists() {
            return Err(bad("That path already exists."));
        }
        let source = self.safe(&d.path, false)?;
        let room = self.room(&d)?;
        let mut r = room.lock().unwrap();
        if !self.persist(&d, &mut r)? {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "A desktop application has this file open. Finish its save before renaming.".into(),
            ));
        }
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;
        let previous = tx
            .query_row("SELECT id FROM docs WHERE path=?", [&path], |r| {
                r.get::<_, String>(0)
            })
            .optional()?;
        if let Some(ref previous) = previous {
            retire(&tx, previous)?;
        }
        // All SQL constraints are checked before touching the filesystem.
        tx.execute("UPDATE docs SET path=? WHERE id=?", params![path, id])?;
        // A same-folder hard link fails atomically if an external app creates
        // the destination; it never overwrites that app's file.
        fs::hard_link(&source, &dest)?;
        if let Err(error) = fs::remove_file(&source) {
            let _ = fs::remove_file(&dest);
            return Err(error.into());
        }
        if let Err(error) = tx.commit() {
            if !source.exists() {
                let _ = fs::rename(&dest, &source);
            }
            return Err(error.into());
        }
        drop(db);
        drop(r);
        self.permissions.invalidate();
        if let Some(previous) = previous {
            self.close_document(&previous);
        }
        Ok(())
    }

    pub(super) fn retire_missing_documents(&self) -> Result<()> {
        let _files = self.document_files.lock().unwrap();
        if !self.root_identity.matches(&self.root) {
            return Ok(());
        }
        let rows = self
            .db
            .lock()
            .unwrap()
            .prepare("SELECT id,path FROM docs WHERE active=1")?
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut missing = rows
            .into_iter()
            .filter_map(|(id, path)| {
                let full = self.safe(&path, false).ok()?;
                match fs::metadata(&full) {
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some((id, full)),
                    _ => None,
                }
            })
            .collect::<Vec<_>>();
        // Do not hold the database while taking a room lock: persistence takes
        // them in the reverse order. Preserve accepted edits before retirement.
        for (id, _) in &missing {
            let room = self.rooms.lock().unwrap().get(id).cloned();
            if let Some(room) = room {
                let room = room.lock().unwrap();
                let source = room_text(&room);
                if room.save.needs_projection()
                    || room.save.interrupted()
                    || source != room.save.source()
                {
                    self.snapshot(&self.doc(id)?, &source, true)?;
                }
            }
        }
        if !self.root_identity.matches(&self.root) {
            return Ok(());
        }
        missing.retain(|(_, full)| {
            fs::metadata(full).is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
        });
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;
        for (id, _) in &missing {
            retire(&tx, id)?;
        }
        tx.commit()?;
        drop(db);
        if !missing.is_empty() {
            self.permissions.invalidate();
        }
        for (id, _) in missing {
            self.close_document(&id);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn store() -> (tempfile::TempDir, App) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(
            dir.path().join("docs"),
            dir.path().join("state"),
            "http://localhost".into(),
        )
        .unwrap();
        (dir, store)
    }
    fn share(s: &Store, id: &str) {
        s.db.lock()
            .unwrap()
            .execute(
                "UPDATE docs SET permission='edit',token='old-link' WHERE id=?",
                [id],
            )
            .unwrap();
    }
    #[test]
    fn a_missing_or_replaced_root_never_retires_documents_or_recreates_the_folder() {
        let (dir, s) = store();
        let doc = s.create_document("root.md").unwrap();
        share(&s, &doc.id);
        let root = s.root.clone();
        let data = s.data.clone();
        let moved = dir.path().join("temporarily-unmounted");
        fs::rename(&root, &moved).unwrap();
        s.retire_missing_documents().unwrap();
        assert_eq!(s.doc(&doc.id).unwrap().token.as_deref(), Some("old-link"));
        drop(s);
        assert!(Store::open(root.clone(), data.clone(), "http://localhost".into()).is_err());
        assert!(
            !root.exists(),
            "Startup must not recreate a missing configured root"
        );
        fs::create_dir(&root).unwrap();
        assert!(Store::open(root.clone(), data.clone(), "http://localhost".into()).is_err());
        fs::remove_dir(&root).unwrap();
        fs::rename(moved, &root).unwrap();
        let reopened = Store::open(root, data, "http://localhost".into()).unwrap();
        assert_eq!(
            reopened.doc(&doc.id).unwrap().token.as_deref(),
            Some("old-link")
        );
    }
    #[test]
    fn permission_errors_do_not_retire_files() {
        use std::os::unix::fs::PermissionsExt;
        let (_dir, s) = store();
        let doc = s.create_document("Restricted/note.md").unwrap();
        share(&s, &doc.id);
        let folder = s.root.join("Restricted");
        fs::set_permissions(&folder, fs::Permissions::from_mode(0o000)).unwrap();
        let result = s.retire_missing_documents();
        fs::set_permissions(&folder, fs::Permissions::from_mode(0o700)).unwrap();
        result.unwrap();
        assert_eq!(s.doc(&doc.id).unwrap().token.as_deref(), Some("old-link"));
    }
    fn append_frame(room: &Arc<Mutex<Room>>, value: &str) -> Vec<u8> {
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
        text.insert(&mut peer.transact_mut(), len, value);
        Message::Sync(SyncMessage::Update(
            peer.transact().encode_state_as_update_v1(&before),
        ))
        .encode_v1()
    }
    #[test]
    fn a_temporary_replacement_gap_defers_projection_without_rejecting_accepted_edits() {
        let (_dir, s) = store();
        let doc = s.create_document("replacement.md").unwrap();
        let room = s.room(&doc).unwrap();
        s.persist(&doc, &mut room.lock().unwrap()).unwrap();
        let frame = append_frame(&room, "Browser edit");
        let path = s.root.join("replacement.md");
        let held = s.root.join("replacement.old");
        fs::rename(&path, &held).unwrap();
        process_frame(&s, &doc, &room, &frame, true, true, &mut Peer::default()).unwrap();
        assert!(room_text(&room.lock().unwrap()).contains("Browser edit"));
        assert!(!s.persist(&doc, &mut room.lock().unwrap()).unwrap());
        fs::rename(held, &path).unwrap();
        assert!(s.persist(&doc, &mut room.lock().unwrap()).unwrap());
        assert!(fs::read_to_string(path).unwrap().contains("Browser edit"));
    }
    #[test]
    fn a_read_only_file_defers_browser_projection_until_it_is_writable() {
        use std::os::unix::fs::PermissionsExt;
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let (_dir, s) = store();
        let doc = s.create_document("readonly.md").unwrap();
        let room = s.room(&doc).unwrap();
        s.persist(&doc, &mut room.lock().unwrap()).unwrap();
        let frame = append_frame(&room, "Browser edit");
        let path = s.root.join("readonly.md");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o444)).unwrap();
        let accepted = process_frame(&s, &doc, &room, &frame, true, true, &mut Peer::default());
        let saved = s.persist(&doc, &mut room.lock().unwrap());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        accepted.unwrap();
        assert!(!saved.unwrap());
        assert!(s.persist(&doc, &mut room.lock().unwrap()).unwrap());
        assert!(fs::read_to_string(path).unwrap().contains("Browser edit"));
    }
    #[test]
    fn paths_have_one_identity() {
        let (_dir, s) = store();
        let d = s.create_document("Folder//./note.md").unwrap();
        assert_eq!(d.path, "Folder/note.md");
        for path in ["Folder/note.md", "Folder//note.md", "./Folder/./note.md"] {
            assert_eq!(s.index_document(path).unwrap().id, d.id);
            assert_eq!(s.safe(path, false).unwrap(), s.root.join("Folder/note.md"));
        }
        assert!(s.safe("Folder/../escape.md", false).is_err());
        assert!(s.safe("", false).is_err());
        assert!(s.safe(".secret/note.md", false).is_err());
    }
    #[test]
    fn explicit_creation_never_reuses_a_share() {
        let (_dir, s) = store();
        let old = s.create_document("note.md").unwrap();
        share(&s, &old.id);
        fs::rename(s.root.join("note.md"), s.root.join("archive.md")).unwrap();
        let new = s.create_document("note.md").unwrap();
        assert_ne!(old.id, new.id);
        assert_eq!(new.permission, "private");
        assert!(new.token.is_none());
        assert_eq!(s.doc(&old.id).unwrap_err().0, StatusCode::NOT_FOUND);
    }
    #[test]
    fn rename_retires_a_missing_destination_but_preserves_the_source_identity() {
        let (_dir, s) = store();
        let a = s.create_document("a.md").unwrap();
        let b = s.create_document("b.md").unwrap();
        share(&s, &a.id);
        fs::remove_file(s.root.join("b.md")).unwrap();
        s.rename_document(&a.id, "./b.md").unwrap();
        let renamed = s.doc(&a.id).unwrap();
        assert_eq!(renamed.path, "b.md");
        assert_eq!(renamed.token.as_deref(), Some("old-link"));
        assert_eq!(fs::read_to_string(s.root.join("b.md")).unwrap(), "# a\n\n");
        assert!(s.doc(&b.id).is_err());
    }
    #[test]
    fn a_database_rejection_never_moves_the_file() {
        let (_dir, s) = store();
        let a = s.create_document("a.md").unwrap();
        s.db.lock().unwrap().execute_batch("CREATE TRIGGER reject_rename BEFORE UPDATE OF path ON docs BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
        assert!(s.rename_document(&a.id, "b.md").is_err());
        assert!(s.root.join("a.md").is_file());
        assert!(!s.root.join("b.md").exists());
        assert_eq!(s.doc(&a.id).unwrap().path, "a.md");
    }
    #[test]
    fn creating_or_renaming_never_overwrites_a_file() {
        let (_dir, s) = store();
        let a = s.create_document("a.md").unwrap();
        fs::write(s.root.join("b.md"), "Keep this text").unwrap();
        assert!(s.create_document("b.md").is_err());
        assert!(s.rename_document(&a.id, "b.md").is_err());
        assert_eq!(
            fs::read_to_string(s.root.join("b.md")).unwrap(),
            "Keep this text"
        );
    }
    #[test]
    fn missing_files_lose_their_old_identity() {
        let (_dir, s) = store();
        let old = s.create_document("a.md").unwrap();
        share(&s, &old.id);
        fs::remove_file(s.root.join("a.md")).unwrap();
        s.retire_missing_documents().unwrap();
        fs::write(s.root.join("a.md"), "Unrelated file").unwrap();
        let new = s.index_document("a.md").unwrap();
        assert_ne!(new.id, old.id);
        assert_eq!(new.permission, "private");
    }
    #[test]
    fn migration_deduplicates_legacy_path_aliases_without_reusing_their_tokens() {
        let (_dir, s) = store();
        let d = s.create_document("Folder/note.md").unwrap();
        let db = s.db.lock().unwrap();
        db.execute("INSERT INTO docs(id,path,permission,token) VALUES('alias','Folder//note.md','edit','alias-link')", []).unwrap();
        migrate(&db).unwrap();
        let ids = db
            .prepare("SELECT id FROM docs WHERE active=1")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(ids, vec![d.id]);
        let active: i64 = db
            .query_row("SELECT active FROM docs WHERE id='alias'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(active, 0);
    }
    #[test]
    fn repeated_file_lifecycles_keep_identity_and_sharing_separate() {
        let (_dir, s) = store();
        let mut previous: Option<String> = None;
        for n in 0..30 {
            let doc = s.create_document("folder//note.md").unwrap();
            assert_eq!(doc.permission, "private");
            if let Some(ref old) = previous {
                assert!(s.doc(old).is_err());
            }
            share(&s, &doc.id);
            s.rename_document(&doc.id, "folder/renamed.md").unwrap();
            assert_eq!(s.index_document("folder//renamed.md").unwrap().id, doc.id);
            fs::rename(
                s.root.join("folder/renamed.md"),
                s.root.join(format!("folder/archive-{n}.md")),
            )
            .unwrap();
            s.retire_missing_documents().unwrap();
            previous = Some(doc.id);
        }
    }
}
