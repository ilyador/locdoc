//! Restores from backups whose files all have new identities.
use super::*;
use crate::documents::tests::{append_frame, share, store};
use std::os::unix::fs::MetadataExt;

/// Copy a folder as a backup does: every file gets a new inode.
fn copy_tree(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}

/// Back up as the hourly service does: a consistent copy of the database
/// with owner.key and root.identity first, then the documents folder.
/// `between` changes the live folder between the two steps.
fn back_up(s: &Store, backup: &Path, between: impl FnOnce(&Path)) {
    let state = backup.join("state");
    fs::create_dir_all(&state).unwrap();
    {
        let db = s.db.lock().unwrap();
        db.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
            .unwrap();
        fs::copy(s.data.join("locdoc.sqlite"), state.join("locdoc.sqlite")).unwrap();
    }
    for name in ["owner.key", "root.identity"] {
        fs::copy(s.data.join(name), state.join(name)).unwrap();
    }
    between(&s.root);
    copy_tree(&s.root, &backup.join("docs"));
}

/// Stop the live instance and copy the backup in place of its folders, as
/// `deploy.sh restore` does. The live folders stay aside.
fn put_in_place(s: App, backup: &Path) -> (PathBuf, PathBuf) {
    let (root, data) = (s.root.clone(), s.data.clone());
    drop(s);
    fs::rename(&root, root.with_extension("before-restore")).unwrap();
    fs::rename(&data, data.with_extension("before-restore")).unwrap();
    copy_tree(&backup.join("docs"), &root);
    copy_tree(&backup.join("state"), &data);
    (root, data)
}

fn restored(s: App, backup: &Path) -> (App, Value) {
    let (root, data) = put_in_place(s, backup);
    let s = Store::open_restored(root, data, "http://localhost".into()).unwrap();
    let report = restore(&s).unwrap();
    (s, report)
}

fn placement<'a>(report: &'a Value, document: &Document) -> &'a Value {
    report["documents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|placed| placed["id"] == document.id.as_str())
        .unwrap()
}

/// What a visitor with this link reads, or None once it no longer opens.
fn shared_text(s: &Store, token: &str) -> Option<String> {
    let document = shared_document(s, token).ok()?;
    let access = Access {
        token: Some(token.into()),
        ..Access::default()
    };
    let payload = document_payload(s, &HeaderMap::new(), &document, &access).ok()?;
    Some(payload["content"].as_str()?.to_owned())
}

/// A document with durable accepted text whose file holds it too.
fn written(s: &Store, path: &str, text: &str) -> Document {
    let document = s.create_document(path).unwrap();
    fs::write(s.root.join(path), text).unwrap();
    let room = s.room(&document).unwrap();
    assert!(s.persist(&document, &mut room.lock().unwrap()).unwrap());
    document
}

#[test]
fn a_document_moved_between_the_backup_steps_follows_its_content() {
    let (directory, s) = store();
    let a = written(&s, "p.md", "Shared text of A\n");
    share(&s, &a.id);
    let backup = directory.path().join("backup");
    back_up(&s, &backup, |root| {
        fs::rename(root.join("p.md"), root.join("q.md")).unwrap();
    });
    let (root, data) = put_in_place(s, &backup);
    // The copy is a new folder: normal startup still refuses it.
    assert!(Store::open(root.clone(), data.clone(), "http://localhost".into()).is_err());
    let s = Store::open_restored(root.clone(), data.clone(), "http://localhost".into()).unwrap();
    let report = restore(&s).unwrap();
    assert_eq!(report["completed"], true);
    let placed = placement(&report, &a);
    assert_eq!(placed["recordedPath"], "p.md");
    assert_eq!(placed["restoredPath"], "q.md");
    assert_eq!(placed["evidence"], "content");
    let saved: Value = serde_json::from_slice(&fs::read(data.join(REPORT)).unwrap()).unwrap();
    assert_eq!(saved, report);
    assert_eq!(s.doc(&a.id).unwrap().path, "q.md");
    assert_eq!(
        shared_text(&s, "old-link").as_deref(),
        Some("Shared text of A\n")
    );
    drop(s);
    // A completed pass recorded the copy, so the server starts on it.
    let s = Store::open(root, data, "http://localhost".into()).unwrap();
    assert_eq!(s.index_document("q.md").unwrap().id, a.id);
    assert_eq!(
        shared_text(&s, "old-link").as_deref(),
        Some("Shared text of A\n")
    );
}

#[test]
fn a_content_match_outranks_the_path_of_a_document_whose_file_is_gone() {
    let (directory, s) = store();
    let a = written(&s, "p.md", "Shared text of A\n");
    let c = written(&s, "q.md", "Private text of C\n");
    share(&s, &a.id);
    let backup = directory.path().join("backup");
    // A's file replaces C's file under C's name.
    back_up(&s, &backup, |root| {
        fs::remove_file(root.join("q.md")).unwrap();
        fs::rename(root.join("p.md"), root.join("q.md")).unwrap();
    });
    let (s, report) = restored(s, &backup);
    assert_eq!(report["completed"], true);
    assert_eq!(placement(&report, &a)["evidence"], "content");
    assert_eq!(placement(&report, &a)["restoredPath"], "q.md");
    assert_eq!(placement(&report, &c)["evidence"], "retired");
    assert!(placement(&report, &c)["restoredPath"].is_null());
    assert!(s.doc(&c.id).is_err());
    assert_eq!(
        shared_text(&s, "old-link").as_deref(),
        Some("Shared text of A\n")
    );
}

#[test]
fn documents_with_identical_content_fall_back_to_their_paths() {
    let (directory, s) = store();
    let a = written(&s, "a.md", "Same notes\n");
    let b = written(&s, "b.md", "Same notes\n");
    share(&s, &a.id);
    let backup = directory.path().join("backup");
    back_up(&s, &backup, |root| {
        fs::rename(root.join("a.md"), root.join("moved.md")).unwrap();
    });
    let (s, report) = restored(s, &backup);
    assert_eq!(report["completed"], true);
    // Two files hold B's text and two documents had it: neither content
    // decides. B keeps its path; A's path is empty, so A retires.
    assert_eq!(placement(&report, &b)["evidence"], "path");
    assert_eq!(s.doc(&b.id).unwrap().path, "b.md");
    assert_eq!(placement(&report, &a)["evidence"], "retired");
    assert!(shared_text(&s, "old-link").is_none());
    assert_eq!(report["unclaimedFiles"], json!(["moved.md"]));
    let new = s.index_document("moved.md").unwrap();
    assert!(new.id != a.id && new.id != b.id);
    assert_eq!(new.permission, "private");
}

#[test]
fn a_file_changed_between_the_backup_steps_keeps_its_document_and_history() {
    let (directory, s) = store();
    let a = written(&s, "p.md", "First text\n");
    share(&s, &a.id);
    let room = s.room(&a).unwrap();
    let frame = append_frame(&room, "Accepted browser edit\n");
    process_frame(&s, &a, &room, &frame, true, true, &mut Peer::default()).unwrap();
    assert!(s.persist(&a, &mut room.lock().unwrap()).unwrap());
    let accepted = room_text(&room.lock().unwrap());
    drop(room);
    let backup = directory.path().join("backup");
    back_up(&s, &backup, |root| {
        fs::write(root.join("p.md"), "Newer desktop text\n").unwrap();
    });
    let (s, report) = restored(s, &backup);
    assert_eq!(report["completed"], true);
    assert_eq!(placement(&report, &a)["evidence"], "path");
    assert_eq!(placement(&report, &a)["restoredPath"], "p.md");
    // The newer file wins; the accepted text it replaced stays restorable.
    assert_eq!(
        shared_text(&s, "old-link").as_deref(),
        Some("Newer desktop text\n")
    );
    let kept: i64 =
        s.db.lock()
            .unwrap()
            .query_row(
                "SELECT count(*) FROM revisions WHERE doc=? AND content=?",
                params![a.id, accepted],
                |row| row.get(0),
            )
            .unwrap();
    assert!(kept > 0, "The older accepted text is in version history");
}

#[test]
fn a_document_missing_from_the_backup_retires_with_its_text_recoverable() {
    let (directory, s) = store();
    let a = written(&s, "gone.md", "Text only the database still has\n");
    share(&s, &a.id);
    let backup = directory.path().join("backup");
    back_up(&s, &backup, |root| {
        fs::remove_file(root.join("gone.md")).unwrap()
    });
    let (s, report) = restored(s, &backup);
    assert_eq!(report["completed"], true);
    assert_eq!(placement(&report, &a)["evidence"], "retired");
    assert!(s.doc(&a.id).is_err());
    assert!(shared_text(&s, "old-link").is_none());
    let state: Vec<u8> =
        s.db.lock()
            .unwrap()
            .query_row("SELECT disk_state FROM docs WHERE id=?", [&a.id], |row| {
                row.get(0)
            })
            .unwrap();
    let recovered = Doc::with_options(Options {
        offset_kind: OffsetKind::Utf16,
        ..Options::default()
    });
    recovered
        .transact_mut()
        .apply_update(security::decode_update(&state).unwrap())
        .unwrap();
    assert_eq!(
        recovered
            .get_or_insert_text("content")
            .get_string(&recovered.transact()),
        "Text only the database still has\n"
    );
}

#[test]
fn a_restored_file_no_document_claims_opens_as_a_new_private_document() {
    let (directory, s) = store();
    let a = written(&s, "kept.md", "Kept text\n");
    share(&s, &a.id);
    let backup = directory.path().join("backup");
    back_up(&s, &backup, |root| {
        fs::write(root.join("new.md"), "Written after the database backup\n").unwrap();
    });
    let (s, report) = restored(s, &backup);
    assert_eq!(report["completed"], true);
    assert_eq!(placement(&report, &a)["evidence"], "content");
    assert_eq!(report["unclaimedFiles"], json!(["new.md"]));
    let new = s.index_document("new.md").unwrap();
    assert_ne!(new.id, a.id);
    assert_eq!(new.permission, "private");
    assert!(new.token.is_none());
}

#[test]
fn a_rename_the_database_backup_caught_half_done_settles_and_follows_its_file() {
    let (directory, s) = store();
    let a = written(&s, "p.md", "Shared text of A\n");
    share(&s, &a.id);
    // The backup reads the database between journaling and committing a
    // rename; the documents copy sees the renamed file.
    let metadata = fs::metadata(s.root.join("p.md")).unwrap();
    s.db.lock()
        .unwrap()
        .execute(
            "INSERT INTO document_moves(doc,source,destination,device,inode) VALUES(?,?,?,?,?)",
            params![
                a.id,
                "p.md",
                "q.md",
                metadata.dev().to_string(),
                metadata.ino().to_string()
            ],
        )
        .unwrap();
    let backup = directory.path().join("backup");
    back_up(&s, &backup, |root| {
        disk::rename_new(&root.join("p.md"), &root.join("q.md")).unwrap();
    });
    let (s, report) = restored(s, &backup);
    assert_eq!(report["completed"], true);
    let pending: i64 =
        s.db.lock()
            .unwrap()
            .query_row("SELECT count(*) FROM document_moves", [], |row| row.get(0))
            .unwrap();
    assert_eq!(pending, 0);
    assert_eq!(placement(&report, &a)["restoredPath"], "q.md");
    assert_eq!(
        shared_text(&s, "old-link").as_deref(),
        Some("Shared text of A\n")
    );
}

#[test]
fn an_unreadable_folder_keeps_the_restore_unaccepted_until_a_complete_pass() {
    use std::os::unix::fs::PermissionsExt;
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let (directory, s) = store();
    let a = written(&s, "p.md", "Shared text of A\n");
    share(&s, &a.id);
    s.create_folder("Locked").unwrap();
    let backup = directory.path().join("backup");
    back_up(&s, &backup, |root| {
        fs::rename(root.join("p.md"), root.join("q.md")).unwrap();
    });
    let (root, data) = put_in_place(s, &backup);
    let locked = root.join("Locked");
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
    let s = Store::open_restored(root.clone(), data.clone(), "http://localhost".into()).unwrap();
    let report = restore(&s);
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).unwrap();
    let report = report.unwrap();
    // The unread folder could hold a copy of A's text: nothing changes.
    assert_eq!(report["completed"], false);
    assert!(
        report["problem"]
            .as_str()
            .unwrap()
            .contains("could not be read")
    );
    assert_eq!(placement(&report, &a)["evidence"], "undecided");
    assert_eq!(s.doc(&a.id).unwrap().path, "p.md");
    drop(s);
    assert!(Store::open(root.clone(), data.clone(), "http://localhost".into()).is_err());
    let s = Store::open_restored(root, data, "http://localhost".into()).unwrap();
    let report = restore(&s).unwrap();
    assert_eq!(report["completed"], true);
    assert_eq!(s.doc(&a.id).unwrap().path, "q.md");
}

#[test]
fn a_second_instance_on_the_same_state_fails_fast_in_either_mode() {
    let (_directory, s) = store();
    let (root, data) = (s.root.clone(), s.data.clone());
    let busy = |result: Result<App>| match result {
        Err(error) => {
            assert_eq!(error.0, StatusCode::SERVICE_UNAVAILABLE);
            assert!(error.1.contains("Another Locdoc process"), "{}", error.1);
        }
        Ok(_) => panic!("A second instance opened a state folder in use"),
    };
    busy(Store::open_restored(
        root.clone(),
        data.clone(),
        "http://localhost".into(),
    ));
    busy(Store::open(
        root.clone(),
        data.clone(),
        "http://localhost".into(),
    ));
    drop(s);
    let restoring =
        Store::open_restored(root.clone(), data.clone(), "http://localhost".into()).unwrap();
    busy(Store::open(
        root.clone(),
        data.clone(),
        "http://localhost".into(),
    ));
    busy(Store::open_restored(
        root.clone(),
        data.clone(),
        "http://localhost".into(),
    ));
    drop(restoring);
    Store::open(root, data, "http://localhost".into()).unwrap();
}

#[test]
fn normal_passes_never_follow_a_copy_by_its_content() {
    // The copy-then-delete a restore matches by content is a new file in
    // normal operation: the document retires instead of following it.
    let (_directory, s) = store();
    let a = written(&s, "p.md", "Shared text of A\n");
    share(&s, &a.id);
    fs::copy(s.root.join("p.md"), s.root.join("q.md")).unwrap();
    fs::remove_file(s.root.join("p.md")).unwrap();
    s.retire_missing_documents().unwrap();
    assert!(s.doc(&a.id).is_err());
    assert!(shared_text(&s, "old-link").is_none());
    let copy = s.index_document("q.md").unwrap();
    assert_ne!(copy.id, a.id);
    assert_eq!(copy.permission, "private");
}

#[test]
fn a_restore_never_revives_folder_links_or_grants_and_names_them() {
    let (directory, s) = store();
    let page = written(&s, "Shared/page.md", "Shared page\n");
    let shared = folders::share_folder(
        &s,
        serde_json::from_value(json!({"path": "Shared", "permission": "view"})).unwrap(),
    )
    .unwrap();
    let token = shared["shareUrl"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap()
        .to_owned();
    let identity = folders::directory_identity(&s, "Shared").unwrap();
    s.db.lock()
        .unwrap()
        .execute(
            "INSERT INTO mcp_folders(path,identity) VALUES('Shared',?)",
            [identity],
        )
        .unwrap();
    let backup = directory.path().join("backup");
    back_up(&s, &backup, |_| {});
    let (s, report) = restored(s, &backup);
    assert_eq!(report["completed"], true);
    assert_eq!(placement(&report, &page)["evidence"], "content");
    // The restored folder is a copy: its pathname alone never revives the
    // link or the MCP grant, and the report names both to grant again.
    assert_eq!(report["folderLinks"], json!(["Shared"]));
    assert_eq!(report["mcpFolders"], json!(["Shared"]));
    assert!(folders::grant(&s, &token).is_err());
    assert!(
        !mcp_access::document_access(&s, &s.doc(&page.id).unwrap())
            .unwrap()
            .mcp_allowed
    );
}
