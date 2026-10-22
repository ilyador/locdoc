//! Owner-selected MCP visibility is independent of public sharing. Documents
//! follow their stable identity; folder grants follow a real directory identity
//! so reusing a deleted folder's name never revives its grant.
use super::*;

pub(super) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS mcp_documents(doc TEXT PRIMARY KEY);
         CREATE TABLE IF NOT EXISTS mcp_folders(path TEXT PRIMARY KEY,identity TEXT NOT NULL);",
    )?;
    Ok(())
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Access {
    pub mcp_allowed: bool,
    pub mcp_direct: bool,
    pub mcp_inherited: bool,
}

impl Access {
    fn new(direct: bool, inherited: bool) -> Self {
        Self {
            mcp_allowed: direct || inherited,
            mcp_direct: direct,
            mcp_inherited: inherited,
        }
    }
}

fn denied_access() -> ApiError {
    ApiError(
        StatusCode::FORBIDDEN,
        "MCP access is not enabled for this document or folder.".into(),
    )
}

fn ancestors(path: &str) -> Vec<String> {
    Path::new(path)
        .ancestors()
        .skip(1)
        .filter(|path| !path.as_os_str().is_empty())
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

fn inherited(s: &Store, path: &str) -> Result<bool> {
    // A handful of indexed lookups per path keeps unrelated grants out of the
    // check and avoids SQL prefix matching where '_' and '%' are wildcards.
    let grants = {
        let db = s.db.lock().unwrap();
        let mut query = db.prepare("SELECT identity FROM mcp_folders WHERE path=?")?;
        ancestors(path)
            .into_iter()
            .map(|path| {
                let identity = query
                    .query_row([&path], |row| row.get::<_, String>(0))
                    .optional()?;
                Ok(identity.map(|identity| (path, identity)))
            })
            .collect::<Result<Vec<_>>>()?
    };
    Ok(grants.into_iter().flatten().any(|(path, identity)| {
        folders::directory_identity(s, &path).is_ok_and(|current| current == identity)
    }))
}

pub(super) fn document_access(s: &Store, document: &Document) -> Result<Access> {
    let current = s.doc(&document.id)?;
    if current.path != document.path {
        return Err(denied_access());
    }
    // Active identities alone cannot make hidden or symlink aliases visible.
    s.safe(&current.path, false)?;
    let direct =
        s.db.lock()
            .unwrap()
            .query_row(
                "SELECT 1 FROM mcp_documents WHERE doc=?",
                [&current.id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
    // A file found outside its row's folder leaves that folder's grant.
    let mut covered = inherited(s, &current.path)?;
    if let Some(path) = s.found_elsewhere(&current.id) {
        covered &= inherited(s, &path)?;
    }
    Ok(Access::new(direct, covered))
}

pub(super) fn folder_access(s: &Store, input: &str) -> Result<Access> {
    let path = documents::relative_path(input, false)?;
    let identity = folders::directory_identity(s, &path)?;
    let direct =
        s.db.lock()
            .unwrap()
            .query_row(
                "SELECT identity FROM mcp_folders WHERE path=?",
                [&path],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .is_some_and(|stored| stored == identity);
    Ok(Access::new(direct, inherited(s, &path)?))
}

pub(super) fn require_document(s: &Store, document: &Document) -> Result<()> {
    if document_access(s, document)?.mcp_allowed {
        Ok(())
    } else {
        Err(denied_access())
    }
}

pub(super) fn require_folder(s: &Store, path: &str) -> Result<()> {
    if folder_access(s, path).is_ok_and(|access| access.mcp_allowed) {
        Ok(())
    } else {
        Err(denied_access())
    }
}

fn set_document(s: &Store, id: &str, allowed: bool) -> Result<Access> {
    let document = s.doc(id)?;
    s.safe(&document.path, false)?;
    let db = s.db.lock().unwrap();
    if allowed {
        db.execute("INSERT OR IGNORE INTO mcp_documents(doc) VALUES(?)", [id])?;
    } else {
        db.execute("DELETE FROM mcp_documents WHERE doc=?", [id])?;
    }
    drop(db);
    document_access(s, &document)
}

/// Folders whose MCP grant no longer matches them, as after a restore copied
/// every folder. The owner allows them again. Grants of folders in the trash
/// wait for their restore.
pub(super) fn unmatched_folders(s: &Store) -> Result<Vec<String>> {
    let grants =
        s.db.lock()
            .unwrap()
            .prepare("SELECT path,identity FROM mcp_folders ORDER BY path")?
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(grants
        .into_iter()
        .filter(|(path, identity)| {
            !path.starts_with(namespace::TRASH)
                && folders::directory_identity(s, path).ok().as_ref() != Some(identity)
        })
        .map(|(path, _)| path)
        .collect())
}

fn set_folder(s: &Store, input: &str, allowed: bool) -> Result<Access> {
    let path = documents::relative_path(input, false)?;
    let identity = folders::directory_identity(s, &path)?;
    let db = s.db.lock().unwrap();
    if allowed {
        db.execute(
            "INSERT INTO mcp_folders(path,identity) VALUES(?,?)
             ON CONFLICT(path) DO UPDATE SET identity=excluded.identity",
            params![path, identity],
        )?;
    } else {
        db.execute("DELETE FROM mcp_folders WHERE path=?", [&path])?;
    }
    drop(db);
    folder_access(s, &path)
}

#[derive(Deserialize)]
pub(super) struct Change {
    allowed: bool,
}

#[derive(Deserialize)]
pub(super) struct FolderQuery {
    path: String,
}

#[derive(Deserialize)]
pub(super) struct FolderChange {
    path: String,
    allowed: bool,
}

pub(super) async fn read_document(
    State(s): State<App>,
    _owner: security::Owner,
    AxPath(id): AxPath<String>,
) -> Result<Json<Access>> {
    doc_job(s, id.clone(), move |s| {
        Ok(Json(document_access(s, &s.doc(&id)?)?))
    })
    .await
}

pub(super) async fn change_document(
    State(s): State<App>,
    _owner: security::Owner,
    AxPath(id): AxPath<String>,
    Json(change): Json<Change>,
) -> Result<Json<Access>> {
    doc_job(s, id.clone(), move |s| {
        let _files = s.document_files.lock().unwrap();
        Ok(Json(set_document(s, &id, change.allowed)?))
    })
    .await
}

pub(super) async fn read_folder(
    State(s): State<App>,
    _owner: security::Owner,
    Query(query): Query<FolderQuery>,
) -> Result<Json<Access>> {
    job(s, move |s| Ok(Json(folder_access(s, &query.path)?))).await
}

pub(super) async fn change_folder(
    State(s): State<App>,
    _owner: security::Owner,
    Json(change): Json<FolderChange>,
) -> Result<Json<Access>> {
    job(s, move |s| {
        let _files = s.document_files.lock().unwrap();
        Ok(Json(set_folder(s, &change.path, change.allowed)?))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, App) {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(
            dir.path().join("docs"),
            dir.path().join("state"),
            "http://localhost".into(),
        )
        .unwrap();
        (dir, s)
    }

    #[test]
    fn migration_is_idempotent_and_all_documents_start_private_to_mcp() {
        let (_dir, s) = store();
        let doc = s.create_document("note.md").unwrap();
        let db = s.db.lock().unwrap();
        migrate(&db).unwrap();
        migrate(&db).unwrap();
        db.execute("UPDATE docs SET permission='edit',token='public-link'", [])
            .unwrap();
        drop(db);
        assert!(!document_access(&s, &doc).unwrap().mcp_allowed);
        assert!(require_document(&s, &doc).is_err());
        assert!(set_document(&s, &doc.id, true).unwrap().mcp_allowed);
        assert!(require_document(&s, &doc).is_ok());
        assert!(!set_document(&s, &doc.id, false).unwrap().mcp_allowed);
    }

    #[test]
    fn folder_inheritance_is_explicit_and_does_not_match_sibling_prefixes() {
        let (_dir, s) = store();
        let doc = s.create_document("Drafts/Nested/note.md").unwrap();
        let other = s.create_document("Drafts elsewhere/note.md").unwrap();
        let access = set_folder(&s, "./Drafts//", true).unwrap();
        assert!(access.mcp_direct && access.mcp_allowed && !access.mcp_inherited);
        let access = document_access(&s, &doc).unwrap();
        assert!(!access.mcp_direct && access.mcp_inherited && access.mcp_allowed);
        assert!(!document_access(&s, &other).unwrap().mcp_allowed);
        let access = set_document(&s, &doc.id, false).unwrap();
        assert!(access.mcp_allowed && access.mcp_inherited);
        let nested = folder_access(&s, "Drafts/Nested").unwrap();
        assert!(nested.mcp_allowed && nested.mcp_inherited && !nested.mcp_direct);
        set_document(&s, &doc.id, true).unwrap();
        set_folder(&s, "Drafts", false).unwrap();
        let access = document_access(&s, &doc).unwrap();
        assert!(access.mcp_direct && !access.mcp_inherited);
    }

    #[test]
    fn a_replaced_directory_does_not_revive_its_grant() {
        let (_dir, s) = store();
        s.create_folder("Drafts").unwrap();
        set_folder(&s, "Drafts", true).unwrap();
        fs::rename(s.root.join("Drafts"), s.root.join("Archived")).unwrap();
        fs::create_dir(s.root.join("Drafts")).unwrap();
        assert!(!folder_access(&s, "Drafts").unwrap().mcp_allowed);
        assert!(!folder_access(&s, "Archived").unwrap().mcp_allowed);
        let doc = s.create_document("Drafts/new.md").unwrap();
        assert!(!document_access(&s, &doc).unwrap().mcp_allowed);
    }

    #[test]
    fn retired_ids_cannot_retain_access_and_a_reused_path_starts_off() {
        let (_dir, s) = store();
        let old = s.create_document("note.md").unwrap();
        set_document(&s, &old.id, true).unwrap();
        fs::rename(s.root.join("note.md"), s.root.join("old.md")).unwrap();
        let new = s.create_document("note.md").unwrap();
        assert!(document_access(&s, &old).is_err());
        assert!(!document_access(&s, &new).unwrap().mcp_allowed);
    }

    #[test]
    fn grants_survive_restart_and_follow_explicit_document_rename() {
        let (dir, s) = store();
        let doc = s.create_document("note.md").unwrap();
        set_document(&s, &doc.id, true).unwrap();
        s.rename_document(&doc.id, "renamed.md").unwrap();
        assert!(document_access(&s, &doc).is_err());
        assert!(
            document_access(&s, &s.doc(&doc.id).unwrap())
                .unwrap()
                .mcp_allowed
        );
        drop(s);
        let s = Store::open(
            dir.path().join("docs"),
            dir.path().join("state"),
            "http://localhost".into(),
        )
        .unwrap();
        assert!(
            document_access(&s, &s.doc(&doc.id).unwrap())
                .unwrap()
                .mcp_allowed
        );
    }

    #[test]
    fn hidden_invalid_root_and_symlink_paths_are_never_granted() {
        let (_dir, s) = store();
        assert_eq!(
            require_folder(&s, "Missing").unwrap_err().0,
            StatusCode::FORBIDDEN
        );
        for path in ["", ".", "../outside", ".hidden", "/tmp", "a\\b"] {
            assert!(set_folder(&s, path, true).is_err());
            assert!(require_folder(&s, path).is_err());
        }
        std::os::unix::fs::symlink(&s.data, s.root.join("alias")).unwrap();
        assert!(set_folder(&s, "alias", true).is_err());
        assert!(folder_access(&s, "alias").is_err());
    }
}
