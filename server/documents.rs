//! Document records, path normalization and explicit creation. Paths are
//! normalized before storage; explicit creation always gets a fresh, private
//! identity. Deciding which file is which document belongs to namespace.rs.
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
            fs::create_dir_all(root)?;
            // Persist every newly created ancestor as well as the root itself.
            // Otherwise a durable root.identity could outlive its directory.
            disk::sync_directories(&fs::canonicalize(root)?, Path::new("/"))?;
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

pub(super) fn retire(db: &Connection, id: &str) -> Result<()> {
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
        ("write_state", "BLOB"),
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
    pub(super) fn create_folder(&self, input: &str) -> Result<()> {
        let _files = self.document_files.lock().unwrap();
        let path = self.safe(input, false)?;
        if path.exists() {
            return Err(bad("A file or folder with this name already exists."));
        }
        fs::create_dir_all(&path)?;
        disk::sync_directories(&path, &self.root)
    }
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

    pub(super) fn create_document(&self, input: &str) -> Result<Document> {
        use std::io::Write;
        let _files = self.document_files.lock().unwrap();
        let path = relative_path(input, false)?;
        self.finish_pending_path(&path)?;
        if format(&path).is_none() {
            return Err(bad("Document names must end with .md or .fountain."));
        }
        let full = self.safe(&path, false)?;
        fs::create_dir_all(full.parent().ok_or_else(|| bad("Invalid path."))?)?;
        match fs::symlink_metadata(&full) {
            Ok(_) => return Err(bad("A file or folder with this name already exists.")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let previous = self
            .db
            .lock()
            .unwrap()
            .query_row(
                "SELECT id FROM docs WHERE path=? AND active=1",
                [&path],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if let Some(previous) = previous {
            self.discover_file_moves_locked()?;
            if self.doc(&previous)?.path == path
                && !self.retire_missing_identity(&previous, &full)?
            {
                return Err(ApiError(
                    StatusCode::CONFLICT,
                    "The previous document is busy or its file changed. Retry after its save finishes."
                        .into(),
                ));
            }
        }
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
            disk::sync_directories(full.parent().unwrap(), &self.root)?;
            let id = uuid::Uuid::new_v4().to_string();
            let mut db = self.db.lock().unwrap();
            let tx = db.transaction()?;
            tx.execute("INSERT INTO docs(id,path) VALUES(?,?)", params![id, path])?;
            Self::remember_file_identity_in(&tx, &id, &file.metadata()?)?;
            tx.commit()?;
            drop(db);
            self.permissions.invalidate();
            Ok(Document {
                id,
                path: path.clone(),
                permission: "private".into(),
                token: None,
            })
        })();
        // If SQLite refuses creation, retain the new file for normal private
        // discovery after storage recovers. A desktop app may already have
        // written to it; rollback must never delete those bytes.
        result
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    pub(crate) fn store() -> (tempfile::TempDir, App) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(
            dir.path().join("docs"),
            dir.path().join("state"),
            "http://localhost".into(),
        )
        .unwrap();
        (dir, store)
    }
    pub(crate) fn share(s: &Store, id: &str) {
        s.db.lock()
            .unwrap()
            .execute(
                "UPDATE docs SET permission='edit',token='old-link' WHERE id=?",
                [id],
            )
            .unwrap();
    }

    pub(crate) fn append_frame(room: &Arc<Mutex<Room>>, value: &str) -> Vec<u8> {
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
        let moved = s.doc(&old.id).unwrap();
        assert_eq!(moved.path, "archive.md");
        assert_eq!(moved.token.as_deref(), Some("old-link"));
    }
    #[test]
    fn failed_creation_retains_the_file_for_private_recovery_and_desktop_edits() {
        let (_directory, s) = store();
        s.db.lock()
            .unwrap()
            .execute_batch(
                "CREATE TRIGGER reject_create BEFORE INSERT ON docs
                BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END;",
            )
            .unwrap();
        assert!(s.create_document("recover.md").is_err());
        let path = s.root.join("recover.md");
        assert_eq!(fs::read_to_string(&path).unwrap(), "# recover\n\n");
        fs::write(&path, "Desktop text added after the failed create").unwrap();
        s.db.lock()
            .unwrap()
            .execute_batch("DROP TRIGGER reject_create")
            .unwrap();
        let discovered = s.index_document("recover.md").unwrap();
        assert_eq!(discovered.permission, "private");
        assert!(discovered.token.is_none());
        assert_eq!(
            fs::read_to_string(path).unwrap(),
            "Desktop text added after the failed create"
        );
    }
    #[test]
    fn failed_path_reuse_cannot_revive_the_previous_share_on_discovery() {
        let (directory, s) = store();
        let old = s.create_document("reused.md").unwrap();
        share(&s, &old.id);
        let moved = directory.path().join("intentional-move.md");
        fs::rename(s.root.join("reused.md"), &moved).unwrap();
        s.db.lock()
            .unwrap()
            .execute_batch(
                "CREATE TRIGGER reject_create BEFORE INSERT ON docs
                BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END;",
            )
            .unwrap();
        assert!(s.create_document("reused.md").is_err());
        assert!(s.doc(&old.id).is_err());
        s.db.lock()
            .unwrap()
            .execute_batch("DROP TRIGGER reject_create")
            .unwrap();
        let discovered = s.index_document("reused.md").unwrap();
        assert_ne!(discovered.id, old.id);
        assert_eq!(discovered.permission, "private");
        assert!(discovered.token.is_none());
        assert_eq!(fs::read_to_string(moved).unwrap(), "# reused\n\n");
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
}
