//! The only boundary that assigns document identities or changes filenames.
//! Paths are normalized before storage. Discovery preserves an identity;
//! explicit creation always gets a fresh, private identity.
use super::*;

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
    db.execute(
        "UPDATE docs SET active=0,path=?,permission='private',token=NULL WHERE id=?",
        params![format!(".retired/{id}"), id],
    )?;
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
        if let Some(previous) = previous {
            self.close_document(&previous);
        }
        Ok(())
    }

    pub(super) fn retire_missing_documents(&self) -> Result<()> {
        let _files = self.document_files.lock().unwrap();
        let mut db = self.db.lock().unwrap();
        let missing = db
            .prepare("SELECT id,path FROM docs WHERE active=1")?
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .filter_map(std::result::Result::ok)
            .filter(|(_, path)| self.safe(path, false).is_ok_and(|p| !p.exists()))
            .map(|(id, _)| id)
            .collect::<Vec<_>>();
        let tx = db.transaction()?;
        for id in &missing {
            retire(&tx, id)?;
        }
        tx.commit()?;
        drop(db);
        for id in missing {
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
