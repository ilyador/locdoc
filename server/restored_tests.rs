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
    let kept = written(&s, "kept.md", "Kept text\n");
    share(&s, &a.id);
    let backup = directory.path().join("backup");
    back_up(&s, &backup, |root| {
        fs::remove_file(root.join("gone.md")).unwrap()
    });
    let (s, report) = restored(s, &backup);
    assert_eq!(report["completed"], true);
    assert_eq!(placement(&report, &a)["evidence"], "retired");
    assert_eq!(placement(&report, &kept)["evidence"], "content");
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
fn a_copied_lost_and_found_never_keeps_the_restore_unaccepted() {
    use std::os::unix::fs::PermissionsExt;
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let (directory, s) = store();
    let a = written(&s, "p.md", "Shared text of A\n");
    share(&s, &a.id);
    let backup = directory.path().join("backup");
    back_up(&s, &backup, |_| {});
    let (root, data) = put_in_place(s, &backup);
    // A backup of a dedicated mount's root also copies fsck's folder,
    // which only root can read.
    let found = root.join("lost+found");
    fs::create_dir(&found).unwrap();
    fs::set_permissions(&found, fs::Permissions::from_mode(0o000)).unwrap();
    let s = Store::open_restored(root, data, "http://localhost".into()).unwrap();
    let report = restore(&s);
    fs::set_permissions(&found, fs::Permissions::from_mode(0o700)).unwrap();
    let report = report.unwrap();
    assert_eq!(report["completed"], true);
    assert_eq!(placement(&report, &a)["restoredPath"], "p.md");
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
    // Nor does a text in the trash, or a trashed one outside it.
    let b = written(&s, "b.md", "Text of B\n");
    let t = written(&s, "t.md", "Text of T\n");
    let item = s.trash_document(&t.id).unwrap();
    let trash = s.root.join(crate::namespace::TRASH);
    fs::create_dir(trash.join("copy")).unwrap();
    fs::copy(s.root.join("b.md"), trash.join("copy/b.md")).unwrap();
    fs::remove_file(s.root.join("b.md")).unwrap();
    fs::copy(trash.join(&item).join("t.md"), s.root.join("t.md")).unwrap();
    fs::remove_file(trash.join(&item).join("t.md")).unwrap();
    s.retire_missing_documents().unwrap();
    for document in [&b, &t] {
        assert!(s.doc(&document.id).is_err());
        assert!(crate::actions::holding(&s, &document.id).unwrap().is_none());
    }
    assert_ne!(s.index_document("t.md").unwrap().id, t.id);
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

#[test]
fn a_blank_text_never_matches_a_restored_file() {
    let (directory, s) = store();
    let kept = written(&s, "kept.md", "Kept text\n");
    let empty = written(&s, "empty.md", "");
    let blank = written(&s, "blank.md", "\n\n");
    for (document, token) in [(&empty, "empty-link"), (&blank, "blank-link")] {
        s.db.lock()
            .unwrap()
            .execute(
                "UPDATE docs SET permission='edit',token=? WHERE id=?",
                params![token, document.id],
            )
            .unwrap();
    }
    let backup = directory.path().join("backup");
    // Both files go, and unrelated empty and blank files appear.
    back_up(&s, &backup, |root| {
        fs::remove_file(root.join("empty.md")).unwrap();
        fs::remove_file(root.join("blank.md")).unwrap();
        fs::write(root.join("new.md"), "").unwrap();
        fs::write(root.join("other.md"), "\r\n\r\n").unwrap();
    });
    let (s, report) = restored(s, &backup);
    assert_eq!(report["completed"], true);
    assert_eq!(placement(&report, &kept)["evidence"], "content");
    assert_eq!(placement(&report, &empty)["evidence"], "retired");
    assert_eq!(placement(&report, &blank)["evidence"], "retired");
    assert!(shared_text(&s, "empty-link").is_none());
    assert!(shared_text(&s, "blank-link").is_none());
    assert_eq!(report["unclaimedFiles"], json!(["new.md", "other.md"]));
    assert_eq!(s.index_document("new.md").unwrap().permission, "private");
}

#[test]
fn a_document_whose_file_has_other_names_never_follows_a_copy() {
    // A pass over a folder whose files kept their identities, as when the
    // owner restores only the state files and runs the pass.
    let (_directory, s) = store();
    let a = written(&s, "a.md", "Text of A\n");
    let b = written(&s, "b.md", "Text of B\n");
    share(&s, &a.id);
    // A's file gets a second name; B's file moves under two other names.
    fs::hard_link(s.root.join("a.md"), s.root.join("alias.md")).unwrap();
    fs::hard_link(s.root.join("b.md"), s.root.join("b2.md")).unwrap();
    fs::rename(s.root.join("b.md"), s.root.join("b3.md")).unwrap();
    fs::copy(s.root.join("a.md"), s.root.join("copy of a.md")).unwrap();
    fs::copy(s.root.join("b3.md"), s.root.join("copy of b.md")).unwrap();
    let (root, data) = (s.root.clone(), s.data.clone());
    drop(s);
    let s = Store::open_restored(root, data, "http://localhost".into()).unwrap();
    let report = restore(&s).unwrap();
    assert_eq!(report["completed"], true);
    // A keeps its own file; B's file is found, so B never takes a copy,
    // and a link cannot show which name it moved to.
    assert_eq!(placement(&report, &a)["evidence"], "identity");
    assert_eq!(s.doc(&a.id).unwrap().path, "a.md");
    assert_eq!(shared_text(&s, "old-link").as_deref(), Some("Text of A\n"));
    assert_eq!(placement(&report, &b)["evidence"], "retired");
    assert_eq!(
        report["unclaimedFiles"],
        json!(["b2.md", "b3.md", "copy of a.md", "copy of b.md"])
    );
}

#[test]
fn a_backup_holding_none_of_the_documents_retires_nothing() {
    let (directory, s) = store();
    let a = written(&s, "p.md", "Shared text of A\n");
    let b = written(&s, "Folder/q.md", "Text of B\n");
    share(&s, &a.id);
    let backup = directory.path().join("backup");
    // The documents copy came out empty, apart from an unrelated file.
    back_up(&s, &backup, |root| {
        fs::remove_file(root.join("p.md")).unwrap();
        fs::remove_file(root.join("Folder/q.md")).unwrap();
        fs::write(root.join("other.md"), "Unrelated\n").unwrap();
    });
    let (root, data) = put_in_place(s, &backup);
    let s = Store::open_restored(root.clone(), data.clone(), "http://localhost".into()).unwrap();
    let report = restore(&s).unwrap();
    assert_eq!(report["completed"], false);
    assert!(
        report["problem"]
            .as_str()
            .unwrap()
            .contains("holds none of the 2 documents")
    );
    assert_eq!(placement(&report, &a)["evidence"], "undecided");
    assert_eq!(s.doc(&a.id).unwrap().path, "p.md");
    assert_eq!(s.doc(&b.id).unwrap().path, "Folder/q.md");
    assert_eq!(
        token(&s, &a).as_deref(),
        Some("old-link"),
        "A keeps its link"
    );
    drop(s);
    assert!(Store::open(root, data, "http://localhost".into()).is_err());
}

/// The link token a document's row still holds.
fn token(s: &Store, document: &Document) -> Option<String> {
    s.db.lock()
        .unwrap()
        .query_row("SELECT token FROM docs WHERE id=?", [&document.id], |row| {
            row.get(0)
        })
        .unwrap()
}

#[test]
fn normal_startup_refuses_an_unfinished_restore_of_a_backup_without_root_identity() {
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
    // Older backups hold no root.identity, which normal startup would
    // otherwise record for whatever folder it finds.
    fs::remove_file(backup.join("state/root.identity")).unwrap();
    let (root, data) = put_in_place(s, &backup);
    let locked = root.join("Locked");
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
    let s = Store::open_restored(root.clone(), data.clone(), "http://localhost".into()).unwrap();
    let report = restore(&s);
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(report.unwrap()["completed"], false);
    drop(s);
    match Store::open(root.clone(), data.clone(), "http://localhost".into()) {
        Err(error) => assert!(error.1.contains("locdoc --restored"), "{}", error.1),
        Ok(_) => panic!("Normal startup accepted an unfinished restore"),
    }
    let s = Store::open_restored(root.clone(), data.clone(), "http://localhost".into()).unwrap();
    assert_eq!(restore(&s).unwrap()["completed"], true);
    drop(s);
    let s = Store::open(root, data, "http://localhost".into()).unwrap();
    assert_eq!(s.doc(&a.id).unwrap().path, "q.md");
    assert_eq!(
        shared_text(&s, "old-link").as_deref(),
        Some("Shared text of A\n")
    );
}

#[test]
fn a_document_whose_folder_became_a_file_never_blocks_the_restore() {
    let (directory, s) = store();
    let kept = written(&s, "kept.md", "Kept text\n");
    let a = written(&s, "Notes/a.md", "Text of A\n");
    share(&s, &a.id);
    let backup = directory.path().join("backup");
    // A file now has the folder's name: no file can be at A's path.
    back_up(&s, &backup, |root| {
        fs::remove_dir_all(root.join("Notes")).unwrap();
        fs::write(root.join("Notes"), "Not a folder\n").unwrap();
    });
    let (s, report) = restored(s, &backup);
    assert_eq!(report["completed"], true);
    assert_eq!(placement(&report, &a)["evidence"], "retired");
    assert_eq!(placement(&report, &kept)["evidence"], "content");
    assert!(shared_text(&s, "old-link").is_none());
}

#[test]
fn an_approved_image_stays_approved_for_a_document_moved_between_the_backup_steps() {
    let (directory, s) = store();
    let png = BASE64.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFlsAAAAASUVORK5CYII=").unwrap();
    fs::write(s.root.join("cover.png"), &png).unwrap();
    s.create_folder("Album").unwrap();
    let page = written(&s, "Album/page.md", "![cover](../cover.png)\n");
    share(&s, &page.id);
    let backup = directory.path().join("backup");
    back_up(&s, &backup, |root| {
        fs::create_dir(root.join("Trip")).unwrap();
        fs::rename(root.join("Album/page.md"), root.join("Trip/page.md")).unwrap();
    });
    let (s, report) = restored(s, &backup);
    assert_eq!(placement(&report, &page)["evidence"], "content");
    let moved = s.doc(&page.id).unwrap();
    assert_eq!(moved.path, "Trip/page.md");
    // The backup recorded the live image's identity, which no restored file
    // has; the approval stays pinned to the restored cover where it was.
    assert!(s.attachment_allowed(&moved, &s.root.join("cover.png")));
    let request = Media {
        path: "../cover.png".into(),
        token: Some("old-link".into()),
    };
    assert!(media_file(&s, &page.id, &request, &HeaderMap::new()).is_ok());
}

/// The text a document opens with, after any import of its file.
fn opened_text(s: &Store, document: &Document) -> String {
    let document = s.doc(&document.id).unwrap();
    let room = s.room(&document).unwrap();
    let mut room = room.lock().unwrap();
    room.reconcile(s, &document).unwrap();
    room_text(&room)
}

#[test]
fn edits_waiting_for_projection_in_the_database_backup_are_applied_once() {
    let (directory, s) = store();
    let projected = written(&s, "p.md", "First text\n");
    let continued = written(&s, "q.md", "Second text\n");
    let waiting = written(&s, "r.md", "Third text\n");
    let mut accepted = Vec::new();
    let mut rooms = Vec::new();
    for document in [&projected, &continued, &waiting] {
        let room = s.room(document).unwrap();
        let frame = append_frame(&room, "Accepted browser edit\n");
        process_frame(
            &s,
            document,
            &room,
            &frame,
            true,
            true,
            &mut Peer::default(),
        )
        .unwrap();
        accepted.push(room_text(&room.lock().unwrap()));
        rooms.push(room);
    }
    let backup = directory.path().join("backup");
    // The database backup holds each edit still waiting for its projection.
    // Two projections reach their files before the documents folder is
    // copied, one of them followed by another edit; the third never does.
    back_up(&s, &backup, |root| {
        for (document, room) in [(&projected, &rooms[0]), (&continued, &rooms[1])] {
            assert!(s.persist(document, &mut room.lock().unwrap()).unwrap());
        }
        let frame = append_frame(&rooms[1], "Later browser edit\n");
        process_frame(
            &s,
            &continued,
            &rooms[1],
            &frame,
            true,
            true,
            &mut Peer::default(),
        )
        .unwrap();
        assert!(
            s.persist(&continued, &mut rooms[1].lock().unwrap())
                .unwrap()
        );
        assert_eq!(fs::read_to_string(root.join("p.md")).unwrap(), accepted[0]);
        assert_eq!(
            fs::read_to_string(root.join("r.md")).unwrap(),
            "Third text\n"
        );
    });
    drop(rooms);
    let later = format!("{}Later browser edit\n", accepted[1]);
    let (s, report) = restored(s, &backup);
    assert_eq!(report["completed"], true);
    assert_eq!(placement(&report, &projected)["evidence"], "content");
    assert_eq!(placement(&report, &continued)["evidence"], "path");
    assert_eq!(placement(&report, &waiting)["evidence"], "content");
    drop(s);
    let root = directory.path().join("docs");
    let s = Store::open(
        root.clone(),
        directory.path().join("state"),
        "http://localhost".into(),
    )
    .unwrap();
    for (document, path, text) in [
        (&projected, "p.md", &accepted[0]),
        (&continued, "q.md", &later),
        (&waiting, "r.md", &accepted[2]),
    ] {
        assert_eq!(
            &opened_text(&s, document),
            text,
            "{path} opens with each edit once"
        );
        let room = s.room(&s.doc(&document.id).unwrap()).unwrap();
        assert!(s.persist(document, &mut room.lock().unwrap()).unwrap());
        assert_eq!(&fs::read_to_string(root.join(path)).unwrap(), text);
    }
    // The newer file replaced the accepted text, which stays restorable.
    let kept: i64 =
        s.db.lock()
            .unwrap()
            .query_row(
                "SELECT count(*) FROM revisions WHERE doc=? AND content=?",
                params![continued.id, accepted[1]],
                |row| row.get(0),
            )
            .unwrap();
    assert!(kept > 0, "The accepted text is in version history");
}

#[test]
fn a_file_replaced_after_the_pass_placed_it_is_never_compared() {
    let (_directory, s) = store();
    let kept = written(&s, "kept.md", "Kept text\n");
    let replaced = written(&s, "replaced.md", "Replaced text\n");
    for document in [&kept, &replaced] {
        let room = s.room(document).unwrap();
        let frame = append_frame(&room, "Accepted browser edit\n");
        process_frame(
            &s,
            document,
            &room,
            &frame,
            true,
            true,
            &mut Peer::default(),
        )
        .unwrap();
    }
    // Both files now hold their accepted text: one written in place, the
    // other a new file renamed over the placed one.
    fs::write(s.root.join("kept.md"), "Kept text\nAccepted browser edit\n").unwrap();
    let incoming = s.root.join(".replaced.md.new");
    fs::write(&incoming, "Replaced text\nAccepted browser edit\n").unwrap();
    fs::rename(&incoming, s.root.join("replaced.md")).unwrap();
    let baseline = |document: &Document| -> Option<Vec<u8>> {
        s.db.lock()
            .unwrap()
            .query_row(
                "SELECT disk_state FROM docs WHERE id=?",
                [&document.id],
                |row| row.get(0),
            )
            .unwrap()
    };
    let before = [baseline(&kept), baseline(&replaced)];
    for document in [&kept, &replaced] {
        s.rebase_restored(&s.doc(&document.id).unwrap()).unwrap();
    }
    assert!(baseline(&kept) != before[0], "the placed file is compared");
    assert!(
        baseline(&replaced) == before[1],
        "a file the pass never placed is not"
    );
}

/// The trash items Recently deleted lists: id, kind, path and documents.
fn trash_items(s: &Store) -> Vec<(String, &'static str, String, i64)> {
    crate::actions::items(s)
        .unwrap()
        .into_iter()
        .map(|item| (item.id, item.kind, item.path, item.documents))
        .collect()
}

#[test]
fn a_restored_backup_keeps_deleted_documents_in_the_trash_ready_to_put_back() {
    let (directory, s) = store();
    let kept = written(&s, "kept.md", "Kept text\n");
    let deleted = written(&s, "Notes/deleted.md", "Deleted text\n");
    let inside = written(&s, "Old/inside.md", "Inside text\n");
    share(&s, &deleted.id);
    let trash = s.trash_document(&deleted.id).unwrap();
    let folder = s.trash_folder("Old").unwrap();
    let items = trash_items(&s);
    let backup = directory.path().join("backup");
    // Nothing moves between the backup steps.
    back_up(&s, &backup, |_| {});
    let (s, report) = restored(s, &backup);
    assert_eq!(report["completed"], true);
    assert_eq!(placement(&report, &kept)["restoredPath"], "kept.md");
    // The copy holds each trashed file where the database names it, so
    // both items stay as they were.
    for document in [&deleted, &inside] {
        assert_eq!(placement(&report, document)["evidence"], "trashed");
        assert!(placement(&report, document)["restoredPath"].is_null());
    }
    assert_eq!(trash_items(&s), items);
    assert_eq!(report["unclaimedFiles"], json!([]));
    let (root, data) = (s.root.clone(), s.data.clone());
    drop(s);
    let s = Store::open(root, data, "http://localhost".into()).unwrap();
    s.retire_missing_documents().unwrap();
    assert!(shared_text(&s, "old-link").is_none());
    // Its copy in the trash has a new inode; the restore needs none of its
    // old evidence.
    assert_eq!(s.restore_trash(&trash).unwrap().0, "Notes/deleted.md");
    assert_eq!(
        shared_text(&s, "old-link").as_deref(),
        Some("Deleted text\n")
    );
    assert_eq!(s.index_document("Notes/deleted.md").unwrap().id, deleted.id);
    assert_eq!(s.restore_trash(&folder).unwrap().0, "Old");
    assert_eq!(s.index_document("Old/inside.md").unwrap().id, inside.id);
}

#[test]
fn a_document_deleted_between_the_backup_steps_goes_back_to_the_trash() {
    let (directory, s) = store();
    let kept = written(&s, "kept.md", "Kept text\n");
    let deleted = written(
        &s,
        "Notes/deleted.md",
        "Deleted after the database backup\n",
    );
    share(&s, &deleted.id);
    let backup = directory.path().join("backup");
    let mut item = String::new();
    back_up(&s, &backup, |_| {
        item = s.trash_document(&deleted.id).unwrap();
    });
    let (s, report) = restored(s, &backup);
    assert_eq!(report["completed"], true);
    assert_eq!(placement(&report, &kept)["evidence"], "content");
    // The database had it active; the copy holds its text only in the
    // trash, so it is in the trash again, under the item that holds it.
    let placed = placement(&report, &deleted);
    assert_eq!(placed["evidence"], "trashed");
    assert_eq!(placed["recordedPath"], "Notes/deleted.md");
    assert!(placed["restoredPath"].is_null());
    assert_eq!(
        trash_items(&s),
        [(item.clone(), "document", "Notes/deleted.md".into(), 1)]
    );
    assert_eq!(report["unclaimedFiles"], json!([]));
    assert!(shared_text(&s, "old-link").is_none());
    let (root, data) = (s.root.clone(), s.data.clone());
    drop(s);
    let s = Store::open(root, data, "http://localhost".into()).unwrap();
    s.retire_missing_documents().unwrap();
    // Recently deleted puts it back with its link.
    assert_eq!(s.restore_trash(&item).unwrap().0, "Notes/deleted.md");
    assert_eq!(
        shared_text(&s, "old-link").as_deref(),
        Some("Deleted after the database backup\n")
    );
    assert_eq!(s.index_document("Notes/deleted.md").unwrap().id, deleted.id);
}

#[test]
fn a_document_restored_between_the_backup_steps_comes_back_from_the_trash() {
    let (directory, s) = store();
    let kept = written(&s, "kept.md", "Kept text\n");
    let page = written(&s, "page.md", "Restored after the database backup\n");
    share(&s, &page.id);
    let item = s.trash_document(&page.id).unwrap();
    let backup = directory.path().join("backup");
    back_up(&s, &backup, |_| {
        s.restore_trash(&item).unwrap();
    });
    let (s, report) = restored(s, &backup);
    assert_eq!(report["completed"], true);
    assert_eq!(placement(&report, &kept)["evidence"], "content");
    // The database had it in the trash; the copy holds its text back at its
    // path, so it is back there and its emptied item is gone.
    let placed = placement(&report, &page);
    assert_eq!(placed["evidence"], "content");
    assert_eq!(
        placed["recordedPath"],
        format!(".locdoc-trash/{item}/page.md")
    );
    assert_eq!(placed["restoredPath"], "page.md");
    assert!(trash_items(&s).is_empty());
    assert_eq!(report["unclaimedFiles"], json!([]));
    assert_eq!(
        shared_text(&s, "old-link").as_deref(),
        Some("Restored after the database backup\n")
    );
    let (root, data) = (s.root.clone(), s.data.clone());
    drop(s);
    let s = Store::open(root, data, "http://localhost".into()).unwrap();
    s.retire_missing_documents().unwrap();
    assert_eq!(s.index_document("page.md").unwrap().id, page.id);
    assert_eq!(
        shared_text(&s, "old-link").as_deref(),
        Some("Restored after the database backup\n")
    );
}

/// Share a document by a link with this token.
fn link(s: &Store, document: &Document, token: &str) {
    s.db.lock()
        .unwrap()
        .execute(
            "UPDATE docs SET permission='view',token=? WHERE id=?",
            params![token, document.id],
        )
        .unwrap();
}

#[test]
fn documents_trading_a_path_through_the_trash_between_the_backup_steps_keep_their_links() {
    let (directory, s) = store();
    let returned = written(&s, "p.md", "Text of the returning page\n");
    link(&s, &returned, "returned-link");
    let item = s.trash_document(&returned.id).unwrap();
    let deleted = written(&s, "p.md", "Text of the deleted page\n");
    link(&s, &deleted, "deleted-link");
    let moving = written(&s, "q.md", "Text of the moving page\n");
    link(&s, &moving, "moving-link");
    let other = s.trash_document(&moving.id).unwrap();
    let away = written(&s, "q.md", "Text of the page moving away\n");
    link(&s, &away, "away-link");
    let backup = directory.path().join("backup");
    let mut trash = String::new();
    // One page goes to the trash for the other to come back at its path,
    // and one moves away for another to come back at its path.
    back_up(&s, &backup, |_| {
        trash = s.trash_document(&deleted.id).unwrap();
        s.restore_trash(&item).unwrap();
        s.rename_document(&away.id, "r.md").unwrap();
        s.restore_trash(&other).unwrap();
    });
    let (s, report) = restored(s, &backup);
    assert_eq!(report["completed"], true);
    for (document, path, token, text) in [
        (
            &returned,
            "p.md",
            "returned-link",
            "Text of the returning page\n",
        ),
        (&moving, "q.md", "moving-link", "Text of the moving page\n"),
        (&away, "r.md", "away-link", "Text of the page moving away\n"),
    ] {
        assert_eq!(placement(&report, document)["evidence"], "content");
        assert_eq!(placement(&report, document)["restoredPath"], path);
        assert_eq!(shared_text(&s, token).as_deref(), Some(text));
    }
    assert_eq!(placement(&report, &deleted)["evidence"], "trashed");
    assert!(shared_text(&s, "deleted-link").is_none());
    assert_eq!(trash_items(&s), [(trash, "document", "p.md".into(), 1)]);
    assert_eq!(report["unclaimedFiles"], json!([]));
}

#[test]
fn folders_deleted_or_restored_between_the_backup_steps_keep_their_documents_together() {
    let (directory, s) = store();
    let a = written(&s, "Drafts/a.md", "Text of A\n");
    let b = written(&s, "Drafts/Sub/b.md", "Text of B\n");
    let c = written(&s, "Archive/c.md", "Text of C\n");
    let d = written(&s, "Archive/Old/d.md", "Text of D\n");
    share(&s, &a.id);
    let archive = s.trash_folder("Archive").unwrap();
    let backup = directory.path().join("backup");
    let mut drafts = String::new();
    back_up(&s, &backup, |_| {
        drafts = s.trash_folder("Drafts").unwrap();
        s.restore_trash(&archive).unwrap();
    });
    let (s, report) = restored(s, &backup);
    assert_eq!(report["completed"], true);
    // Drafts went to the trash after the database backup: both of its
    // documents are back under its item, which keeps the folder's path.
    for document in [&a, &b] {
        assert_eq!(placement(&report, document)["evidence"], "trashed");
    }
    assert_eq!(
        trash_items(&s),
        [(drafts.clone(), "folder", "Drafts".into(), 2)]
    );
    // Archive came back after it: its documents are where the copy holds
    // them and its item is gone.
    for (document, path) in [(&c, "Archive/c.md"), (&d, "Archive/Old/d.md")] {
        assert_eq!(placement(&report, document)["evidence"], "content");
        assert_eq!(placement(&report, document)["restoredPath"], path);
    }
    assert_eq!(report["unclaimedFiles"], json!([]));
    let (root, data) = (s.root.clone(), s.data.clone());
    drop(s);
    let s = Store::open(root, data, "http://localhost".into()).unwrap();
    s.retire_missing_documents().unwrap();
    assert_eq!(s.restore_trash(&drafts).unwrap().0, "Drafts");
    assert_eq!(s.index_document("Drafts/a.md").unwrap().id, a.id);
    assert_eq!(s.index_document("Drafts/Sub/b.md").unwrap().id, b.id);
    assert_eq!(shared_text(&s, "old-link").as_deref(), Some("Text of A\n"));
}

/// Journal a folder move, delete or restore as it starts, with the identity
/// of its file or folder.
fn journal(s: &Store, id: &str, action: &str, document: Option<&str>, paths: (&str, &str)) {
    let metadata = fs::symlink_metadata(s.root.join(paths.0)).unwrap();
    s.db.lock()
        .unwrap()
        .execute(
            "INSERT INTO entry_moves(id,action,kind,document,source,destination,device,inode)
             VALUES(?,?,?,?,?,?,?,?)",
            params![
                id,
                action,
                if metadata.is_dir() {
                    "folder"
                } else {
                    "document"
                },
                document,
                paths.0,
                paths.1,
                metadata.dev().to_string(),
                metadata.ino().to_string()
            ],
        )
        .unwrap();
}

fn journaled(s: &Store) -> i64 {
    s.db.lock()
        .unwrap()
        .query_row("SELECT count(*) FROM entry_moves", [], |row| row.get(0))
        .unwrap()
}

#[test]
fn moves_the_database_backup_caught_half_done_settle_without_moving_a_file() {
    let (directory, s) = store();
    // Documents never opened in Locdoc have no text to follow.
    for path in ["deleted.md", "returned.md", "From/moved.md"] {
        fs::create_dir_all(s.root.join(path).parent().unwrap()).unwrap();
        fs::write(s.root.join(path), format!("Text at {path}\n")).unwrap();
    }
    let [deleted, returned, moved] =
        ["deleted.md", "returned.md", "From/moved.md"].map(|path| s.index_document(path).unwrap());
    let returning = s.trash_document(&returned.id).unwrap();
    let deleting = uuid::Uuid::new_v4().to_string();
    let trashed = format!("{}/{deleting}/deleted.md", crate::namespace::TRASH);
    let location = format!("{}/{returning}/returned.md", crate::namespace::TRASH);
    journal(
        &s,
        &deleting,
        "trash",
        Some(&deleted.id),
        ("deleted.md", &trashed),
    );
    journal(
        &s,
        &returning,
        "restore",
        Some(&returned.id),
        (&location, "returned.md"),
    );
    journal(
        &s,
        &uuid::Uuid::new_v4().to_string(),
        "rename",
        None,
        ("From", "To"),
    );
    let backup = directory.path().join("backup");
    // The database backup holds the three intents; each rename then happens
    // before the documents folder is copied.
    back_up(&s, &backup, |root| {
        fs::create_dir_all(root.join(&trashed).parent().unwrap()).unwrap();
        disk::rename_new(&root.join("deleted.md"), &root.join(&trashed)).unwrap();
        disk::rename_new(&root.join(&location), &root.join("returned.md")).unwrap();
        disk::rename_new(&root.join("From"), &root.join("To")).unwrap();
    });
    let (s, report) = restored(s, &backup);
    assert_eq!(report["completed"], true);
    assert_eq!(journaled(&s), 0);
    // Each settles where the copy holds its entry; no file moved back.
    assert_eq!(placement(&report, &deleted)["evidence"], "trashed");
    assert!(s.root.join(&trashed).is_file() && !s.root.join("deleted.md").exists());
    assert_eq!(placement(&report, &returned)["restoredPath"], "returned.md");
    assert_eq!(placement(&report, &moved)["restoredPath"], "To/moved.md");
    assert_eq!(
        trash_items(&s),
        [(deleting.clone(), "document", "deleted.md".into(), 1)]
    );
    assert_eq!(report["unclaimedFiles"], json!([]));
    drop(s);
    let s = Store::open(
        directory.path().join("docs"),
        directory.path().join("state"),
        "http://localhost".into(),
    )
    .unwrap();
    assert_eq!(s.restore_trash(&deleting).unwrap().0, "deleted.md");
    assert_eq!(s.index_document("deleted.md").unwrap().id, deleted.id);
}

#[test]
fn a_move_the_restored_database_journaled_never_runs_again() {
    // A pass over a folder whose files kept their identities, as when the
    // owner restores only the state files and runs the pass.
    let (_directory, s) = store();
    let page = written(&s, "page.md", "Text of the page\n");
    share(&s, &page.id);
    s.create_folder("Kept").unwrap();
    // A delete and a folder move journaled before their renames, which
    // never happened.
    let item = uuid::Uuid::new_v4().to_string();
    let trashed = format!("{}/{item}/page.md", crate::namespace::TRASH);
    fs::create_dir_all(s.root.join(&trashed).parent().unwrap()).unwrap();
    journal(&s, &item, "trash", Some(&page.id), ("page.md", &trashed));
    journal(
        &s,
        &uuid::Uuid::new_v4().to_string(),
        "rename",
        None,
        ("Kept", "Moved"),
    );
    let (root, data) = (s.root.clone(), s.data.clone());
    drop(s);
    let s = Store::open_restored(root, data, "http://localhost".into()).unwrap();
    let report = restore(&s).unwrap();
    assert_eq!(report["completed"], true);
    assert_eq!(journaled(&s), 0);
    assert_eq!(placement(&report, &page)["restoredPath"], "page.md");
    assert!(s.root.join("page.md").is_file() && s.root.join("Kept").is_dir());
    assert!(!s.root.join(&trashed).exists() && !s.root.join("Moved").exists());
    assert!(trash_items(&s).is_empty());
    assert_eq!(
        shared_text(&s, "old-link").as_deref(),
        Some("Text of the page\n")
    );
}

#[test]
fn a_backup_without_the_trash_folder_retires_what_it_held_with_its_text() {
    let (directory, s) = store();
    let deleted = written(&s, "deleted.md", "Deleted text\n");
    share(&s, &deleted.id);
    s.trash_document(&deleted.id).unwrap();
    let backup = directory.path().join("backup");
    back_up(&s, &backup, |root| {
        fs::rename(
            root.join(crate::namespace::TRASH),
            root.with_extension("trash-aside"),
        )
        .unwrap();
    });
    let (s, report) = restored(s, &backup);
    assert_eq!(report["completed"], true);
    let (root, data) = (s.root.clone(), s.data.clone());
    drop(s);
    let s = Store::open(root, data, "http://localhost".into()).unwrap();
    s.retire_missing_documents().unwrap();
    let (active, path): (i64, String) =
        s.db.lock()
            .unwrap()
            .query_row(
                "SELECT active,retired_path FROM docs WHERE id=?",
                [&deleted.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
    assert_eq!((active, path.as_str()), (0, "deleted.md"));
    assert!(crate::actions::items(&s).unwrap().is_empty());
}
