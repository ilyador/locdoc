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

/// What root.identity holds from the start of a restore pass until one
/// completes. No folder has inode 0, so normal startup refuses the restored
/// folder even when the backup had no root.identity.
const RESTORING: RootIdentity = RootIdentity {
    device: 0,
    inode: 0,
};

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
    match fs::read(data.join("root.identity")) {
        Ok(bytes) => {
            let previous: RootIdentity =
                serde_json::from_slice(&bytes).map_err(|_| root_unavailable())?;
            if previous == RESTORING {
                return Err(ApiError(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "A restore pass has not completed. Run locdoc --restored again.".into(),
                ));
            }
            if previous != identity {
                return Err(root_unavailable());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            record_root(data, &identity)?;
        }
        Err(error) => return Err(error.into()),
    }
    Ok((root, identity))
}

/// A documents folder copied back from a backup is a new folder. Only the
/// owner's restore pass opens it, and records it once every document is
/// placed; until then normal startup keeps refusing it.
pub(super) fn restored_root(root: &Path) -> Result<(PathBuf, RootIdentity)> {
    let missing = |_| {
        bad(
            "The restored documents folder is missing. Copy it into place before running locdoc --restored.",
        )
    };
    let root = fs::canonicalize(root).map_err(missing)?;
    let identity = RootIdentity::read(&root).map_err(missing)?;
    Ok((root, identity))
}

/// Keep normal startup refusing the documents folder until a restore pass
/// completes and records it.
pub(super) fn hold_root(data: &Path) -> Result<()> {
    record_root(data, &RESTORING)
}

pub(super) fn record_root(data: &Path, identity: &RootIdentity) -> Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let temporary = data.join(format!(".root-identity-{}.tmp", uuid::Uuid::new_v4()));
    let result: Result<()> = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(&serde_json::to_vec(identity).map_err(|_| root_unavailable())?)?;
        file.sync_all()?;
        fs::rename(&temporary, data.join("root.identity"))?;
        fs::File::open(data)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Format {
    Markdown,
    Fountain,
    /// Plain text: its source has no Markdown, so no media references.
    Text,
}
impl Format {
    /// The name listings and document payloads give this format.
    pub(super) fn name(self) -> &'static str {
        match self {
            Self::Markdown => "markdown",
            Self::Fountain => "fountain",
            Self::Text => "text",
        }
    }
}

pub(super) const FORMATS: &str = "Document names must end with .md, .fountain or .txt.";

pub(super) fn format(path: &str) -> Option<Format> {
    match Path::new(path)
        .extension()?
        .to_str()?
        .to_ascii_lowercase()
        .as_str()
    {
        "md" => Some(Format::Markdown),
        "fountain" => Some(Format::Fountain),
        "txt" => Some(Format::Text),
        _ => None,
    }
}

/// Whether a document's `![...](...)` syntax names media. In a plain text
/// document it is text: never approved, served or charged as an embed.
pub(super) fn has_media(path: &str) -> bool {
    format(path) != Some(Format::Text)
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
    db.execute("DELETE FROM document_identities WHERE doc=?", [id])?;
    db.execute("DELETE FROM document_gaps WHERE doc=?", [id])?;
    Ok(())
}

/// A trashed document whose file left the trash retires like any missing
/// document. Removed document recovery lists it under its original path.
pub(super) fn retire_trashed(db: &Connection, id: &str, original: &str) -> Result<()> {
    const RETIRE: &str = "UPDATE docs SET active=0,
        retired_path=COALESCE(retired_path,?),retired_at=?,path=?,
        permission='private',token=NULL WHERE id=? AND active=2";
    db.execute(
        RETIRE,
        params![original, now(), format!(".retired/{id}"), id],
    )?;
    db.execute("DELETE FROM document_identities WHERE doc=?", [id])?;
    db.execute("DELETE FROM document_gaps WHERE doc=?", [id])?;
    db.execute("DELETE FROM trashed_documents WHERE doc=?", [id])?;
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
        // Starts again with each delete into the trash; see DocumentEngine.
        ("incarnation", "INTEGER NOT NULL DEFAULT 0"),
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
    // The file each owner approval resolved to. Existing rows have none
    // until the first pass observes their document in its folder.
    let has_media_identity = db
        .prepare("PRAGMA table_info(trusted_references)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(std::result::Result::ok)
        .any(|column| column == "identity");
    if !has_media_identity {
        db.execute(
            "ALTER TABLE trusted_references ADD COLUMN identity TEXT",
            [],
        )?;
    }
    // The file a grant pinned at its exact path, so the grant follows that
    // file once it moves where the document names it. Rows from earlier
    // versions have none until a pass sees their file still in place.
    let has_grant_identity = db
        .prepare("PRAGMA table_info(grants)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(std::result::Result::ok)
        .any(|column| column == "identity");
    if !has_grant_identity {
        db.execute("ALTER TABLE grants ADD COLUMN identity TEXT", [])?;
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
        self.not_into_state(&path)?;
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

    /// Whether `path` is the state folder or inside it, for a state folder
    /// kept inside the documents folder. Like Locdoc's trash it is no part
    /// of the namespace: walks, listings, folder links, MCP and media never
    /// enter it. A documents folder kept inside the state folder holds none
    /// of the state's own files.
    pub(super) fn in_state(&self, path: &Path) -> bool {
        self.data != self.root && self.data.starts_with(&self.root) && path.starts_with(&self.data)
    }

    /// No document or folder is created, renamed, moved, restored or
    /// duplicated at `path` inside the state folder.
    pub(super) fn not_into_state(&self, path: &Path) -> Result<()> {
        if self.in_state(path) {
            return Err(bad(
                "Locdoc keeps its own state in that folder. Choose another destination.",
            ));
        }
        Ok(())
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
        let Some(kind) = format(&path) else {
            return Err(bad(FORMATS));
        };
        let full = self.safe(&path, false)?;
        self.not_into_state(&full)?;
        fs::create_dir_all(full.parent().ok_or_else(|| bad("Invalid path."))?)?;
        match fs::symlink_metadata(&full) {
            Ok(_) => return Err(bad("A file or folder with this name already exists.")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        self.free_document_path(&path, &full)?;
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
            // A plain text file starts empty, as a new file in a text editor.
            let initial = match kind {
                Format::Fountain => format!("Title: {title}\n\n"),
                Format::Markdown => format!("# {title}\n\n"),
                Format::Text => String::new(),
            };
            file.write_all(initial.as_bytes())?;
            file.sync_all()?;
            disk::sync_directories(full.parent().unwrap(), &self.root)?;
            let id = uuid::Uuid::new_v4().to_string();
            let mut db = self.db.lock().unwrap();
            let tx = db.transaction()?;
            tx.execute("INSERT INTO docs(id,path) VALUES(?,?)", params![id, path])?;
            namespace::record_identity(
                &tx,
                &id,
                namespace::Identity::of(&file.metadata()?).as_ref(),
            )?;
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

    /// Explicit creation reuses a path still recorded for a document only
    /// once that document's file is known to be gone. One whose file was
    /// found elsewhere follows it once a pass can place it; its name is not
    /// free yet.
    fn free_document_path(&self, path: &str, full: &Path) -> Result<()> {
        let previous = self
            .db
            .lock()
            .unwrap()
            .query_row(
                "SELECT id FROM docs WHERE path=? AND active=1",
                [path],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if let Some(previous) = previous {
            let unplaced = self.discover_file_moves_locked()?;
            if self.doc(&previous)?.path == path
                && (unplaced.contains(&previous)
                    || !self.retire_missing_identity(&previous, full)?)
            {
                return Err(ApiError(
                    StatusCode::CONFLICT,
                    "The previous document is busy or its file changed. Retry after its save finishes."
                        .into(),
                ));
            }
        }
        Ok(())
    }

    /// A new document at `input` holding `source`: another document's
    /// accepted text without its comment records, written with that
    /// document's line ending. It gets a fresh private identity and no
    /// links. Its collaboration state starts from that text, so loading it
    /// never approves media the way a desktop file's first read does; it
    /// carries over only the original's approvals of files the same
    /// spellings reach from its folder.
    pub(super) fn duplicate_document(
        &self,
        original: &Document,
        input: &str,
        source: &str,
        ending: &str,
    ) -> Result<Document> {
        use std::io::Write;
        let _files = self.document_files.lock().unwrap();
        let path = relative_path(input, false)?;
        self.finish_pending_path(&path)?;
        if format(&path).is_none() {
            return Err(bad(FORMATS));
        }
        let full = self.safe(&path, false)?;
        self.not_into_state(&full)?;
        let taken = || ApiError(StatusCode::CONFLICT, "That path already exists.".into());
        match fs::symlink_metadata(&full) {
            Ok(_) => return Err(taken()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotADirectory => {
                return Err(bad("A file is in the way of that path."));
            }
            Err(error) => return Err(error.into()),
        }
        fs::create_dir_all(full.parent().ok_or_else(|| bad("Invalid path."))?)?;
        self.free_document_path(&path, &full)?;
        let ending = text::uniform(ending);
        let doc = Doc::with_options(Options {
            offset_kind: OffsetKind::Utf16,
            ..Options::default()
        });
        doc.get_or_insert_text("content")
            .insert(&mut doc.transact_mut(), 0, source);
        security::validate_document(&doc)?;
        let state = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let copy = Document {
            id: uuid::Uuid::new_v4().to_string(),
            path,
            permission: "private".into(),
            token: None,
        };
        let approvals = if format(&copy.path) == format(&original.path) {
            self.carried_approvals(original, &copy, source)
        } else {
            Vec::new()
        };
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&full)
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    taken()
                } else {
                    error.into()
                }
            })?;
        file.write_all(text::render(source, ending).as_bytes())?;
        file.sync_all()?;
        disk::sync_directories(full.parent().unwrap(), &self.root)?;
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;
        tx.execute(
            "INSERT INTO docs(id,path,state,disk_state,line_ending,media_initialized)
             VALUES(?,?,?,?,?,1)",
            params![copy.id, copy.path, state, state, ending],
        )?;
        namespace::record_identity(
            &tx,
            &copy.id,
            namespace::Identity::of(&file.metadata()?).as_ref(),
        )?;
        for (reference, identity) in &approvals {
            tx.execute(
                "INSERT OR IGNORE INTO active_media(doc,reference) VALUES(?,?)",
                params![copy.id, reference],
            )?;
            tx.execute(
                "INSERT OR IGNORE INTO trusted_references(doc,reference,identity) VALUES(?,?,?)",
                params![copy.id, reference, identity],
            )?;
        }
        tx.commit()?;
        drop(db);
        self.permissions.invalidate();
        // As with creation, a refused commit leaves the written file for
        // private discovery once storage recovers.
        Ok(copy)
    }

    /// References in `source` whose files the original may serve and which
    /// the copy's same spelling reaches from its own folder, with the
    /// identity of each file.
    fn carried_approvals(
        &self,
        original: &Document,
        copy: &Document,
        source: &str,
    ) -> Vec<(String, Option<String>)> {
        let mut approvals: Vec<(String, Option<String>)> = Self::media_references(copy, source)
            .into_iter()
            .filter_map(|reference| {
                let path = self.media_path(original, &reference).ok()?;
                if !self.attachment_allowed(original, &path)
                    || self.media_path(copy, &reference).ok()? != path
                {
                    return None;
                }
                let identity = fs::metadata(&path)
                    .ok()
                    .and_then(|metadata| namespace::Identity::of(&metadata))
                    .map(|identity| identity.as_str().to_owned());
                Some((reference, identity))
            })
            .collect();
        approvals.sort();
        approvals
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
    fn plain_text_is_a_document_format_that_renames_keep_across_formats() {
        let (_dir, s) = store();
        let notes = s.create_document("Notes/list.txt").unwrap();
        // A new plain text file starts empty, without a Markdown heading.
        assert_eq!(
            fs::read_to_string(s.root.join("Notes/list.txt")).unwrap(),
            ""
        );
        assert_eq!(format(&notes.path), Some(Format::Text));
        assert!(!has_media(&notes.path));
        // A desktop file of any letter case is discovered as plain text.
        fs::write(s.root.join("Notes/README.TXT"), "Desktop notes\n").unwrap();
        let found = s.index_document("Notes/README.TXT").unwrap();
        assert_eq!(format(&found.path).map(Format::name), Some("text"));
        share(&s, &notes.id);
        // Renames change formats and keep the document, its file and links.
        for (path, name) in [
            ("Notes/list.md", "markdown"),
            ("Notes/list.fountain", "fountain"),
            ("Notes/list.txt", "text"),
        ] {
            s.rename_document(&notes.id, path).unwrap();
            let renamed = s.doc(&notes.id).unwrap();
            assert_eq!(renamed.path, path);
            assert_eq!(renamed.token.as_deref(), Some("old-link"));
            assert_eq!(format(path).map(Format::name), Some(name));
            assert!(s.root.join(path).is_file());
        }
        for path in ["list.pdf", "list", "list.txt.bak"] {
            assert_eq!(s.create_document(path).unwrap_err().1, FORMATS);
            assert_eq!(s.rename_document(&notes.id, path).unwrap_err().1, FORMATS);
        }
        assert_eq!(s.doc(&notes.id).unwrap().path, "Notes/list.txt");
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
