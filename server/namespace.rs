//! The only boundary that changes filenames or follows a file to its
//! document. Discovery and renames preserve an identity; a file missing from
//! the documents folder retires its identity.
use super::documents::{format, relative_path, retire};
use super::*;
use std::os::unix::fs::MetadataExt;

/// SQLite and a directory cannot commit atomically. Keep the rename intent
/// durable until both the directory entry and document identity have committed.
/// File identity binds recovery to our file; birth time, where supported,
/// additionally distinguishes an unrelated file that reuses the same inode.
struct FileMove {
    document: String,
    source: String,
    destination: String,
    device: String,
    inode: String,
    born: Option<String>,
}
impl FileMove {
    fn birth(metadata: &fs::Metadata) -> Option<String> {
        metadata
            .created()
            .ok()?
            .duration_since(UNIX_EPOCH)
            .ok()
            .map(|time| time.as_nanos().to_string())
    }
    fn contains(&self, path: &Path) -> std::io::Result<bool> {
        match fs::symlink_metadata(path) {
            Ok(metadata) => Ok(metadata.is_file()
                && metadata.dev().to_string() == self.device
                && metadata.ino().to_string() == self.inode
                && self
                    .born
                    .as_ref()
                    .is_none_or(|born| Self::birth(&metadata).as_ref() == Some(born))),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error),
        }
    }
}

// An inode alone can be reused after deletion. Only a regular, unaliased file
// with a birth time is evidence for following an unannounced desktop move.
fn file_identity(metadata: &fs::Metadata) -> Option<String> {
    (metadata.is_file() && metadata.nlink() == 1).then_some(())?;
    Some(format!(
        "{}:{}:{}",
        metadata.dev(),
        metadata.ino(),
        FileMove::birth(metadata)?
    ))
}

pub(super) fn migrate(connection: &Connection) -> Result<()> {
    let db = connection.unchecked_transaction()?;
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS document_moves(
            doc TEXT PRIMARY KEY,source TEXT NOT NULL,destination TEXT NOT NULL UNIQUE,
            device TEXT NOT NULL,inode TEXT NOT NULL,born TEXT);",
    )?;
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS document_identities(
            doc TEXT PRIMARY KEY,identity TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS document_physical_identity
            ON document_identities(identity);",
    )?;
    let has_move_birth = db
        .prepare("PRAGMA table_info(document_moves)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(std::result::Result::ok)
        .any(|column| column == "born");
    if !has_move_birth {
        db.execute("ALTER TABLE document_moves ADD COLUMN born TEXT", [])?;
    }
    db.commit()?;
    Ok(())
}

impl Store {
    pub(super) fn index_document(&self, input: &str) -> Result<Document> {
        let _files = self.document_files.lock().unwrap();
        let path = relative_path(input, false)?;
        self.finish_pending_path(&path)?;
        let full = self.safe(&path, false)?;
        if format(&path).is_none() || !full.is_file() {
            return Err(ApiError(
                StatusCode::NOT_FOUND,
                "Document not found.".into(),
            ));
        }
        let metadata = fs::metadata(&full)?;
        let indexed = self
            .db
            .lock()
            .unwrap()
            .query_row(
                "SELECT id FROM docs WHERE path=? AND active=1",
                [&path],
                |r| r.get::<_, String>(0),
            )
            .optional()?;
        if indexed.is_none() {
            self.follow_file_move(&path, &metadata)?;
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
        self.remember_file_identity(&id, &metadata)?;
        self.doc(&id)
    }

    fn remember_file_identity(&self, id: &str, metadata: &fs::Metadata) -> Result<()> {
        let db = self.db.lock().unwrap();
        Self::remember_file_identity_in(&db, id, metadata)
    }

    pub(super) fn remember_file_identity_in(
        db: &Connection,
        id: &str,
        metadata: &fs::Metadata,
    ) -> Result<()> {
        if let Some(identity) = file_identity(metadata) {
            db.execute(
                "INSERT INTO document_identities(doc,identity) VALUES(?,?)
                 ON CONFLICT(doc) DO UPDATE SET identity=excluded.identity
                 WHERE identity!=excluded.identity",
                params![id, identity],
            )?;
        } else {
            db.execute("DELETE FROM document_identities WHERE doc=?", [id])?;
        }
        Ok(())
    }

    /// Called under document_files, before discovery allocates a new identity.
    /// Copies, hard links, inaccessible sources and ambiguous matches never
    /// acquire another document's links or history.
    fn follow_file_move(&self, path: &str, metadata: &fs::Metadata) -> Result<()> {
        let Some(identity) = file_identity(metadata) else {
            return Ok(());
        };
        let candidates = self
            .db
            .lock()
            .unwrap()
            .prepare(
                "SELECT d.id,d.path FROM docs d JOIN document_identities f ON f.doc=d.id
             WHERE d.active=1 AND f.identity=? AND d.path!=?
             AND NOT EXISTS(SELECT 1 FROM document_moves WHERE doc=d.id)",
            )?
            .query_map(params![identity, path], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let missing = candidates
            .into_iter()
            .filter(|(_, source)| {
                self.safe(source, false).is_ok_and(|source| {
                    fs::symlink_metadata(source)
                        .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
                })
            })
            .collect::<Vec<_>>();
        if missing.len() != 1 {
            return Ok(());
        }
        let (id, source) = &missing[0];
        let room = self.rooms.lock().unwrap().get(id).cloned();
        let mut live = if let Some(room) = &room {
            Some(room.try_lock().map_err(|_| {
                ApiError(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "The moved document is busy. Retry shortly.".into(),
                )
            })?)
        } else {
            None
        };
        if let Some(room) = live.as_mut() {
            room.ensure_committed(self, &self.doc(id)?)?;
        }
        let movement = FileMove {
            document: id.clone(),
            source: source.clone(),
            destination: path.into(),
            device: metadata.dev().to_string(),
            inode: metadata.ino().to_string(),
            born: FileMove::birth(metadata),
        };
        // Recheck after admission: an editor may have recreated the old name.
        if !fs::symlink_metadata(self.safe(source, false)?)
            .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
            || !movement.contains(&self.safe(path, false)?)?
        {
            return Err(bad(
                "The moved file changed during discovery. Retry shortly.",
            ));
        }
        self.journal_file_move(&movement)?;
        self.finish_file_move(&movement)?;
        Ok(())
    }

    /// Refresh atomic-save identities and find moves missed while offline or
    /// during watcher overflow. Only missing tracked files require a tree walk.
    pub(super) fn discover_file_moves(&self) -> Result<()> {
        let _files = self.document_files.lock().unwrap();
        self.discover_file_moves_locked()
    }

    pub(super) fn discover_file_moves_locked(&self) -> Result<()> {
        let rows = self
            .db
            .lock()
            .unwrap()
            .prepare(
                "SELECT d.id,d.path,f.identity FROM docs d
             LEFT JOIN document_identities f ON f.doc=d.id WHERE d.active=1
             AND NOT EXISTS(SELECT 1 FROM document_moves WHERE doc=d.id)",
            )?
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut missing = HashSet::new();
        let mut present = Vec::new();
        for (id, path, identity) in rows {
            let Ok(full) = self.safe(&path, false) else {
                continue;
            };
            match fs::metadata(full) {
                Ok(metadata) => present.push((id, metadata)),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    if let Some(identity) = identity {
                        missing.insert(identity);
                    }
                }
                // Inaccessibility is never evidence for an external move.
                Err(_) => {}
            }
        }
        {
            let mut db = self.db.lock().unwrap();
            let tx = db.transaction()?;
            for (id, metadata) in present {
                Self::remember_file_identity_in(&tx, &id, &metadata)?;
            }
            tx.commit()?;
        }
        if missing.is_empty() {
            return Ok(());
        }
        let mut folders = vec![self.root.clone()];
        while let Some(folder) = folders.pop() {
            let children = match fs::read_dir(folder) {
                Ok(children) => children,
                Err(_) => continue,
            };
            for child in children {
                let child = child?;
                if child.file_name().to_string_lossy().starts_with('.') {
                    continue;
                }
                let metadata = fs::symlink_metadata(child.path())?;
                if metadata.is_dir() {
                    folders.push(child.path());
                } else if file_identity(&metadata)
                    .is_some_and(|identity| missing.contains(&identity))
                {
                    let path = child.path();
                    let relative = path.strip_prefix(&self.root).unwrap().to_string_lossy();
                    if format(&relative).is_some() {
                        // Never reinterpret an existing destination document as
                        // a move: ordinary atomic replacement preserves its ID.
                        let exists = self
                            .db
                            .lock()
                            .unwrap()
                            .query_row(
                                "SELECT 1 FROM docs WHERE path=? AND active=1",
                                [&*relative],
                                |_| Ok(()),
                            )
                            .optional()?
                            .is_some();
                        if !exists {
                            self.follow_file_move(&relative, &metadata)?;
                        }
                    }
                }
            }
        }
        Ok(())
    }

    fn close_document(&self, id: &str) {
        let room = self.rooms.lock().unwrap().remove(id);
        if let Some(room) = room
            && let Ok(room) = room.try_lock()
        {
            let _ = room.tx.send(vec![126]);
        }
        // Busy peers observe the invalidated permission generation before
        // their next frame or heartbeat. Closing must never wait on their room.
    }

    pub(super) fn rename_document(&self, id: &str, input: &str) -> Result<()> {
        self.rename_document_checked(id, input, |_, _| Ok(()))
    }

    /// Recheck scoped callers after filesystem discovery and under the same
    /// namespace lock as folder opt-ins and the move itself.
    pub(super) fn rename_document_checked(
        &self,
        id: &str,
        input: &str,
        authorize: impl FnOnce(&Document, &str) -> Result<()>,
    ) -> Result<()> {
        let _files = self.document_files.lock().unwrap();
        self.finish_pending_path(&self.doc(id)?.path)?;
        self.discover_file_moves_locked()?;
        let d = self.doc(id)?;
        let path = relative_path(input, false)?;
        self.finish_pending_path(&path)?;
        authorize(&d, &path)?;
        if path == d.path {
            return Ok(());
        }
        if format(&path).is_none() {
            return Err(bad("Document names must end with .md or .fountain."));
        }
        let dest = self.safe(&path, false)?;
        if !dest.parent().is_some_and(Path::is_dir) {
            return Err(bad("Choose an existing destination folder."));
        }
        if dest.exists() {
            return Err(bad("That path already exists."));
        }
        let source = self.safe(&d.path, false)?;
        let room = self.room(&d)?;
        let mut r = room.lock().unwrap();
        if !r.flush_to_disk(self, &d)? {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "A desktop application has this file open. Finish its save before renaming.".into(),
            ));
        }
        let metadata = fs::symlink_metadata(&source)?;
        let movement = FileMove {
            document: id.into(),
            source: d.path,
            destination: path,
            device: metadata.dev().to_string(),
            inode: metadata.ino().to_string(),
            born: FileMove::birth(&metadata),
        };
        let previous = {
            let mut db = self.db.lock().unwrap();
            // Exercise path constraints before committing a filesystem intent.
            // The transaction rolls back; only finish_file_move publishes it.
            let tx = db.transaction()?;
            let previous = Self::move_identity(&tx, &movement)?;
            tx.rollback()?;
            previous
        };
        if let Some(previous) = previous
            && !self.retire_missing_identity(&previous, &dest)?
        {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "The previous destination is busy or changed. Retry after its save finishes."
                    .into(),
            ));
        }
        self.journal_file_move(&movement)?;
        let completed = self.finish_file_move(&movement)?;
        drop(r);
        if !completed {
            return Err(bad("That path already exists."));
        }
        Ok(())
    }

    fn journal_file_move(&self, movement: &FileMove) -> Result<()> {
        self.db.lock().unwrap().execute(
            "INSERT INTO document_moves(doc,source,destination,device,inode,born)
                    VALUES(?,?,?,?,?,?)",
            params![
                movement.document,
                movement.source,
                movement.destination,
                movement.device,
                movement.inode,
                movement.born
            ],
        )?;
        Ok(())
    }

    fn move_identity(db: &Connection, movement: &FileMove) -> Result<Option<String>> {
        let previous = db
            .query_row(
                "SELECT id FROM docs WHERE path=? AND id!=?",
                params![movement.destination, movement.document],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if let Some(ref previous) = previous {
            retire(db, previous)?;
        }
        let updated = db.execute(
            "UPDATE docs SET path=? WHERE id=? AND active=1 AND path IN (?,?)",
            params![
                movement.destination,
                movement.document,
                movement.source,
                movement.destination
            ],
        )?;
        if updated != 1 {
            return Err(bad("The document identity changed during its rename."));
        }
        Ok(previous)
    }

    fn finish_file_move(&self, movement: &FileMove) -> Result<bool> {
        let source = self.safe(&movement.source, false)?;
        let destination = self.safe(&movement.destination, false)?;
        let original_source = movement.contains(&source)?;
        if !movement.contains(&destination)? {
            if !original_source {
                return Err(ApiError(StatusCode::CONFLICT,
                    "An interrupted rename cannot find its original file. Restore the original file before continuing; its saved edits remain in recovery.".into()));
            }
            match disk::rename_new(&source, &destination) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    // The original remains safely in place. An external app's
                    // destination wins; abort our intent without touching it.
                    self.db.lock().unwrap().execute(
                        "DELETE FROM document_moves WHERE doc=?",
                        [&movement.document],
                    )?;
                    return Ok(false);
                }
                Err(error) => return Err(error.into()),
            }
        } else if original_source {
            // Also tolerate an interrupted legacy hard-link move. Both names
            // refer to exactly our inode, so removing the old alias is safe.
            fs::remove_file(&source)?;
        }
        disk::sync_directories(destination.parent().unwrap(), &self.root)?;
        if source.parent().unwrap().is_dir() {
            disk::sync_directories(source.parent().unwrap(), &self.root)?;
        }
        let mut old = self.doc(&movement.document)?;
        old.path = movement.source.clone();
        let metadata = fs::metadata(&destination)?;
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;
        if Path::new(&movement.source).parent() != Path::new(&movement.destination).parent() {
            self.freeze_moved_media(&tx, &old)?;
        }
        let previous = Self::move_identity(&tx, movement)?;
        Self::remember_file_identity_in(&tx, &movement.document, &metadata)?;
        tx.execute(
            "DELETE FROM document_moves WHERE doc=?",
            [&movement.document],
        )?;
        tx.commit()?;
        drop(db);
        self.permissions.invalidate();
        if let Some(previous) = previous {
            self.close_document(&previous);
        }
        Ok(true)
    }

    fn pending_file_moves(&self, path: Option<&str>) -> Result<Vec<FileMove>> {
        let movements = self
            .db
            .lock()
            .unwrap()
            .prepare(
                "SELECT doc,source,destination,device,inode,born FROM document_moves
                WHERE ?1 IS NULL OR source=?1 OR destination=?1 ORDER BY doc",
            )?
            .query_map([path], |row| {
                Ok(FileMove {
                    document: row.get(0)?,
                    source: row.get(1)?,
                    destination: row.get(2)?,
                    device: row.get(3)?,
                    inode: row.get(4)?,
                    born: row.get(5)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(movements)
    }

    pub(super) fn finish_pending_path(&self, path: &str) -> Result<()> {
        for movement in self.pending_file_moves(Some(path))? {
            self.finish_file_move(&movement)?;
        }
        Ok(())
    }

    pub(super) fn recover_file_operations(&self) -> Result<()> {
        let _files = self.document_files.lock().unwrap();
        for movement in self.pending_file_moves(None)? {
            if let Err(error) = self.finish_file_move(&movement) {
                // A missing external file cannot justify deleting saved state
                // or stopping recovery of every other document in the folder.
                tracing::error!(
                    document = movement.document,
                    "Interrupted rename needs owner recovery: {error}"
                );
            }
        }
        Ok(())
    }

    pub(super) fn retry_file_operations(&self) -> Result<()> {
        let Ok(_files) = self.document_files.try_lock() else {
            return Ok(());
        };
        for movement in self.pending_file_moves(None)? {
            if let Err(error) = self.finish_file_move(&movement) {
                // Startup reports unresolved operations at error level. A
                // persistent external conflict must not flood logs each pass.
                tracing::debug!(
                    document = movement.document,
                    "Rename still pending: {error}"
                );
            }
        }
        Ok(())
    }

    pub(super) fn retire_missing_documents(&self) -> Result<()> {
        let _files = self.document_files.lock().unwrap();
        if !self.root_identity.matches(&self.root) {
            return Ok(());
        }
        self.discover_file_moves_locked()?;
        let rows = self
            .db
            .lock()
            .unwrap()
            .prepare(
                "SELECT id,path FROM docs WHERE active=1
                AND NOT EXISTS(SELECT 1 FROM document_moves WHERE doc=docs.id)",
            )?
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let missing = rows
            .into_iter()
            .filter_map(|(id, path)| {
                let full = self.safe(&path, false).ok()?;
                match fs::metadata(&full) {
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some((id, full)),
                    _ => None,
                }
            })
            .collect::<Vec<_>>();
        for (id, full) in missing {
            self.retire_missing_identity(&id, &full)?;
        }
        Ok(())
    }

    /// Shared by intentional path reuse and external-file retirement. Preserve
    /// the final accepted room before revoking identity, with one lock order.
    pub(super) fn retire_missing_identity(&self, id: &str, path: &Path) -> Result<bool> {
        let room = self.rooms.lock().unwrap().get(id).cloned();
        let mut live = if let Some(room) = &room {
            // A busy missing file must not delay unrelated documents' saves.
            let Ok(live) = room.try_lock() else {
                return Ok(false);
            };
            Some(live)
        } else {
            None
        };
        let missing = || {
            self.root_identity.matches(&self.root)
                && fs::metadata(path)
                    .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
        };
        if !missing() {
            return Ok(false);
        }
        if let Some(room) = live.as_mut() {
            // A failed comment/restore transaction may still be waiting in the
            // engine. Never evict that buffer merely because its file moved.
            let document = self.doc(id)?;
            room.ensure_committed(self, &document)?;
            let source = room_text(room);
            if room.engine.needs_projection()
                || room.engine.interrupted()
                || source != room.engine.source()
            {
                self.snapshot(&document, &source, true)?;
            }
        }
        if !missing() {
            return Ok(false);
        }
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;
        retire(&tx, id)?;
        tx.commit()?;
        drop(db);
        self.permissions.invalidate();
        // Cache operations acquire map -> room. Drop the guard before removing
        // it from that map; stale commands reject the now-inactive identity.
        drop(live);
        self.close_document(id);
        Ok(true)
    }
}

#[cfg(test)]
#[path = "namespace_tests.rs"]
mod tests;
