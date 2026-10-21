//! File identity, discovery, journaled renames and retirement.
use super::*;
use crate::documents::tests::{append_frame, share, store};

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

fn interrupted_move(s: &Store, document: &Document, destination: &str) {
    let metadata = fs::metadata(s.root.join(&document.path)).unwrap();
    s.db.lock()
        .unwrap()
        .execute(
            "INSERT INTO document_moves(doc,source,destination,device,inode,born) VALUES(?,?,?,?,?,?)",
            params![
                document.id,
                document.path,
                destination,
                metadata.dev().to_string(),
                metadata.ino().to_string(),
                FileMove::birth(&metadata)
            ],
        )
        .unwrap();
}

fn reopen(s: App) -> App {
    let root = s.root.clone();
    let data = s.data.clone();
    drop(s);
    let s = Store::open(root, data, "http://localhost".into()).unwrap();
    s.recover_file_operations().unwrap();
    s
}

#[test]
fn rename_recovery_preserves_identity_content_and_history_at_every_commit_boundary() {
    for stage in 0..3 {
        let (_dir, s) = store();
        let document = s.create_document("Nested/original.md").unwrap();
        share(&s, &document.id);
        let room = s.room(&document).unwrap();
        let frame = append_frame(&room, "Accepted browser text");
        process_frame(
            &s,
            &document,
            &room,
            &frame,
            true,
            true,
            &mut Peer::default(),
        )
        .unwrap();
        s.persist(&document, &mut room.lock().unwrap()).unwrap();
        let source = fs::read_to_string(s.root.join(&document.path)).unwrap();
        s.snapshot(&document, &source, true).unwrap();
        drop(room);
        interrupted_move(&s, &document, "Nested/renamed.md");
        if stage >= 1 {
            disk::rename_new(
                &s.root.join(&document.path),
                &s.root.join("Nested/renamed.md"),
            )
            .unwrap();
        }
        if stage >= 2 {
            disk::sync_directories(&s.root.join("Nested"), &s.root).unwrap();
        }
        let s = reopen(s);
        let recovered = s.doc(&document.id).unwrap();
        assert_eq!(recovered.path, "Nested/renamed.md");
        assert_eq!(recovered.token.as_deref(), Some("old-link"));
        assert_eq!(
            fs::read_to_string(s.root.join(&recovered.path)).unwrap(),
            source
        );
        assert!(!s.root.join("Nested/original.md").exists());
        assert_eq!(
            s.index_document("Nested/renamed.md").unwrap().id,
            document.id
        );
        let db = s.db.lock().unwrap();
        let recovery: String = db
            .query_row(
                "SELECT content FROM revisions WHERE doc=? AND kind='recovery'",
                [&document.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(recovery, source);
        let pending: i64 = db
            .query_row("SELECT count(*) FROM document_moves", [], |row| row.get(0))
            .unwrap();
        assert_eq!(pending, 0);
    }
}

#[test]
fn interrupted_rename_never_overwrites_a_later_destination() {
    let (_dir, s) = store();
    let document = s.create_document("original.md").unwrap();
    share(&s, &document.id);
    interrupted_move(&s, &document, "other.md");
    fs::write(s.root.join("other.md"), "Unrelated desktop file").unwrap();
    let s = reopen(s);
    assert_eq!(s.doc(&document.id).unwrap().path, "original.md");
    assert_eq!(
        s.doc(&document.id).unwrap().token.as_deref(),
        Some("old-link")
    );
    assert_eq!(
        fs::read_to_string(s.root.join("original.md")).unwrap(),
        "# original\n\n"
    );
    assert_eq!(
        fs::read_to_string(s.root.join("other.md")).unwrap(),
        "Unrelated desktop file"
    );
    let pending: i64 =
        s.db.lock()
            .unwrap()
            .query_row("SELECT count(*) FROM document_moves", [], |row| row.get(0))
            .unwrap();
    assert_eq!(pending, 0);
}

#[test]
fn rename_recovery_rejects_an_unrelated_file_with_a_reused_inode() {
    let (_directory, s) = store();
    let document = s.create_document("original.md").unwrap();
    interrupted_move(&s, &document, "renamed.md");
    // Model inode reuse: device/inode still match, creation identity does not.
    s.db.lock()
        .unwrap()
        .execute(
            "UPDATE document_moves SET born='another-file-creation' WHERE doc=?",
            [&document.id],
        )
        .unwrap();
    let s = reopen(s);
    assert!(s.root.join("original.md").is_file());
    assert!(!s.root.join("renamed.md").exists());
    assert_eq!(s.doc(&document.id).unwrap().path, "original.md");
    s.create_document("unrelated.md").unwrap();
}

#[test]
fn completed_filesystem_rename_does_not_delete_a_new_file_at_the_old_path() {
    let (_dir, s) = store();
    let document = s.create_document("original.md").unwrap();
    share(&s, &document.id);
    interrupted_move(&s, &document, "renamed.md");
    disk::rename_new(&s.root.join("original.md"), &s.root.join("renamed.md")).unwrap();
    fs::write(s.root.join("original.md"), "New desktop document").unwrap();
    let s = reopen(s);
    let recovered = s.doc(&document.id).unwrap();
    assert_eq!(recovered.path, "renamed.md");
    assert_eq!(recovered.token.as_deref(), Some("old-link"));
    assert_eq!(
        fs::read_to_string(s.root.join("original.md")).unwrap(),
        "New desktop document"
    );
    let replacement = s.index_document("original.md").unwrap();
    assert_ne!(replacement.id, document.id);
    assert_eq!(replacement.permission, "private");
}

#[test]
fn unfinished_rename_cannot_import_an_unrelated_recreation_of_its_old_path() {
    let (_directory, s) = store();
    let document = s.create_document("original.md").unwrap();
    let room = s.room(&document).unwrap();
    room.lock().unwrap().flush_to_disk(&s, &document).unwrap();
    interrupted_move(&s, &document, "renamed.md");
    disk::rename_new(&s.root.join("original.md"), &s.root.join("renamed.md")).unwrap();
    fs::write(s.root.join("original.md"), "An unrelated new document").unwrap();
    {
        let mut room = room.lock().unwrap();
        let result = room.reconcile(&s, &document);
        assert!(!matches!(result, Ok(true)));
        assert_eq!(room_text(&room), "# original\n\n");
    }
    assert_eq!(
        fs::read_to_string(s.root.join("renamed.md")).unwrap(),
        "# original\n\n"
    );
    assert_eq!(
        fs::read_to_string(s.root.join("original.md")).unwrap(),
        "An unrelated new document"
    );
    s.recover_file_operations().unwrap();
    assert_eq!(s.doc(&document.id).unwrap().path, "renamed.md");
    let replacement = s.index_document("original.md").unwrap();
    assert_ne!(replacement.id, document.id);
    assert_eq!(replacement.permission, "private");
}

fn pending_moves(s: &Store) -> i64 {
    s.db.lock()
        .unwrap()
        .query_row("SELECT count(*) FROM document_moves", [], |row| row.get(0))
        .unwrap()
}

// Recovery covers every combination of where the journaled inode is: only at
// the source (redo, or drop when the destination is taken), only at the
// destination (complete), at both names, and at neither.
#[test]
fn an_interrupted_legacy_hard_link_rename_removes_the_old_alias() {
    let (_directory, s) = store();
    let document = s.create_document("original.md").unwrap();
    share(&s, &document.id);
    interrupted_move(&s, &document, "renamed.md");
    fs::hard_link(s.root.join("original.md"), s.root.join("renamed.md")).unwrap();
    let s = reopen(s);
    let recovered = s.doc(&document.id).unwrap();
    assert_eq!(recovered.path, "renamed.md");
    assert_eq!(recovered.token.as_deref(), Some("old-link"));
    assert!(!s.root.join("original.md").exists());
    assert_eq!(
        fs::read_to_string(s.root.join("renamed.md")).unwrap(),
        "# original\n\n"
    );
    assert_eq!(pending_moves(&s), 0);
}

#[test]
fn an_interrupted_rename_whose_file_moved_elsewhere_follows_the_file() {
    let (_directory, s) = store();
    let document = s.create_document("original.md").unwrap();
    share(&s, &document.id);
    interrupted_move(&s, &document, "renamed.md");
    fs::create_dir(s.root.join("Elsewhere")).unwrap();
    fs::rename(
        s.root.join("original.md"),
        s.root.join("Elsewhere/moved.md"),
    )
    .unwrap();
    let s = reopen(s);
    assert_eq!(pending_moves(&s), 0);
    let found = s.doc(&document.id).unwrap();
    assert_eq!(found.path, "Elsewhere/moved.md");
    assert_eq!(found.token.as_deref(), Some("old-link"));
    assert!(!s.root.join("renamed.md").exists());
    // Without its intent the document saves again.
    let room = s.room(&found).unwrap();
    let frame = append_frame(&room, "Saved after recovery\n");
    process_frame(&s, &found, &room, &frame, true, true, &mut Peer::default()).unwrap();
    assert!(s.persist(&found, &mut room.lock().unwrap()).unwrap());
    assert!(
        fs::read_to_string(s.root.join("Elsewhere/moved.md"))
            .unwrap()
            .contains("Saved after recovery")
    );
}

#[test]
fn a_source_replaced_during_a_rename_is_restored_and_keeps_saving() {
    use rusqlite::functions::FunctionFlags;
    let (_directory, s) = store();
    let document = s.create_document("original.md").unwrap();
    share(&s, &document.id);
    let room = s.room(&document).unwrap();
    let path = s.root.join("original.md");
    let temporary = s.root.join("original.md.tmp");
    {
        // An editor's atomic save lands between journaling and the rename.
        let db = s.db.lock().unwrap();
        db.create_scalar_function("replace_source", 0, FunctionFlags::SQLITE_UTF8, move |_| {
            fs::write(&temporary, "Desktop save during the rename\n")
                .and_then(|()| fs::rename(&temporary, &path))
                .map(|()| 1)
                .map_err(|error| rusqlite::Error::UserFunctionError(Box::new(error)))
        })
        .unwrap();
        db.execute_batch(
            "CREATE TRIGGER replace_during_rename AFTER INSERT ON document_moves
             BEGIN SELECT replace_source(); END;",
        )
        .unwrap();
    }
    let error = s.rename_document(&document.id, "renamed.md").unwrap_err();
    s.db.lock()
        .unwrap()
        .execute_batch("DROP TRIGGER replace_during_rename")
        .unwrap();
    assert_eq!(error.0, StatusCode::CONFLICT);
    assert_eq!(error.1, "The file changed during the rename. Try again.");
    assert_eq!(pending_moves(&s), 0);
    let kept = s.doc(&document.id).unwrap();
    assert_eq!(kept.path, "original.md");
    assert_eq!(kept.token.as_deref(), Some("old-link"));
    assert!(!s.root.join("renamed.md").exists());
    assert_eq!(
        fs::read_to_string(s.root.join("original.md")).unwrap(),
        "Desktop save during the rename\n"
    );
    // No intent outlives the conflict: edits commit and project.
    let frame = append_frame(&room, "Browser edit after the conflict\n");
    process_frame(&s, &kept, &room, &frame, true, true, &mut Peer::default()).unwrap();
    assert!(s.persist(&kept, &mut room.lock().unwrap()).unwrap());
    let saved = fs::read_to_string(s.root.join("original.md")).unwrap();
    assert!(saved.contains("Desktop save during the rename"));
    assert!(saved.contains("Browser edit after the conflict"));
    s.rename_document(&document.id, "renamed.md").unwrap();
    assert_eq!(s.doc(&document.id).unwrap().path, "renamed.md");
    assert_eq!(
        fs::read_to_string(s.root.join("renamed.md")).unwrap(),
        saved
    );
}

#[test]
fn pending_renames_retry_without_restart_or_waiting_for_a_busy_file_operation() {
    let (_directory, s) = store();
    let document = s.create_document("original.md").unwrap();
    interrupted_move(&s, &document, "renamed.md");
    let busy = s.document_files.lock().unwrap();
    s.retry_file_operations().unwrap();
    assert!(s.root.join("original.md").is_file());
    assert!(!s.root.join("renamed.md").exists());
    drop(busy);
    s.retry_file_operations().unwrap();
    assert_eq!(s.doc(&document.id).unwrap().path, "renamed.md");
    assert_eq!(
        fs::read_to_string(s.root.join("renamed.md")).unwrap(),
        "# original\n\n"
    );
}

#[test]
fn an_interrupted_rename_whose_file_left_the_root_retires_with_its_accepted_text() {
    // Its inode is under neither journaled name. The intent used to remain
    // forever and reject every save with 503; now it settles, and the
    // document retires like any other file moved out of the root.
    let (directory, s) = store();
    let document = s.create_document("original.md").unwrap();
    share(&s, &document.id);
    let room = s.room(&document).unwrap();
    let frame = append_frame(&room, "Accepted text remains recoverable");
    process_frame(
        &s,
        &document,
        &room,
        &frame,
        true,
        true,
        &mut Peer::default(),
    )
    .unwrap();
    s.persist(&document, &mut room.lock().unwrap()).unwrap();
    drop(room);
    interrupted_move(&s, &document, "renamed.md");
    fs::rename(
        s.root.join("original.md"),
        directory.path().join("moved-outside.md"),
    )
    .unwrap();
    let s = reopen(s);
    assert_eq!(s.pending_file_moves(None).unwrap().len(), 0);
    s.retire_missing_documents().unwrap();
    assert!(s.doc(&document.id).is_err());
    assert!(shared_document(&s, "old-link").is_err());
    assert!(s.room(&document).is_err());
    let state: Vec<u8> =
        s.db.lock()
            .unwrap()
            .query_row(
                "SELECT disk_state FROM docs WHERE id=?",
                [&document.id],
                |row| row.get(0),
            )
            .unwrap();
    let recovered = Doc::with_options(Options {
        offset_kind: OffsetKind::Utf16,
        ..Options::default()
    });
    recovered
        .transact_mut()
        .apply_update(security::decode_update(&state).unwrap())
        .unwrap();
    assert!(
        recovered
            .get_or_insert_text("content")
            .get_string(&recovered.transact())
            .contains("Accepted text remains recoverable")
    );
    s.create_document("unaffected.md").unwrap();
    assert!(s.index_document("unaffected.md").is_ok());
    assert!(!s.root.join("original.md").exists());
    assert!(!s.root.join("renamed.md").exists());
}

#[test]
fn retirement_skips_busy_rooms_then_snapshots_their_final_accepted_edits() {
    let (_directory, s) = store();
    let document = s.create_document("removed.md").unwrap();
    let room = s.room(&document).unwrap();
    let frame = append_frame(&room, "The pending browser edit");
    process_frame(
        &s,
        &document,
        &room,
        &frame,
        true,
        true,
        &mut Peer::default(),
    )
    .unwrap();
    fs::remove_file(s.root.join("removed.md")).unwrap();
    let live = room.lock().unwrap();
    s.retire_missing_documents().unwrap();
    assert!(s.doc(&document.id).is_ok());
    let expected = room_text(&live);
    drop(live);
    s.retire_missing_documents().unwrap();
    assert!(s.doc(&document.id).is_err());
    let recovery: String = s.db.lock().unwrap().query_row(
        "SELECT content FROM revisions WHERE doc=? AND kind='recovery' ORDER BY rowid DESC LIMIT 1",
        [&document.id], |row| row.get(0),
    ).unwrap();
    assert_eq!(recovery, expected);
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
fn repeated_file_lifecycles_keep_identity_and_sharing_separate() {
    let (_dir, s) = store();
    let mut previous: Option<String> = None;
    for n in 0..30 {
        let doc = s.create_document("folder//note.md").unwrap();
        assert_eq!(doc.permission, "private");
        if let Some(ref old) = previous {
            assert_ne!(&doc.id, old);
            assert_eq!(s.doc(old).unwrap().token.as_deref(), Some("old-link"));
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

#[test]
fn moves_keep_identity_history_and_bytes_across_folders_and_restart() {
    let (_dir, s) = store();
    let d = s.create_document("Drafts/page.md").unwrap();
    s.create_folder("Published").unwrap();
    share(&s, &d.id);
    let source = fs::read(s.root.join(&d.path)).unwrap();
    s.snapshot(&d, "Earlier text", true).unwrap();
    s.rename_document(&d.id, "Published/page.md").unwrap();
    let moved = s.doc(&d.id).unwrap();
    assert_eq!(moved.path, "Published/page.md");
    assert_eq!(moved.token.as_deref(), Some("old-link"));
    assert_eq!(fs::read(s.root.join(&moved.path)).unwrap(), source);
    assert!(!s.root.join(&d.path).exists());
    // Also follow a directory move made while the process is stopped.
    fs::rename(s.root.join("Published"), s.root.join("Archived")).unwrap();
    let s = reopen(s);
    let recovered = s.doc(&d.id).unwrap();
    assert_eq!(recovered.path, "Archived/page.md");
    assert_eq!(recovered.token.as_deref(), Some("old-link"));
    assert_eq!(s.index_document(&recovered.path).unwrap().id, d.id);
    let history: i64 =
        s.db.lock()
            .unwrap()
            .query_row(
                "SELECT count(*) FROM revisions WHERE doc=? AND content='Earlier text'",
                [&d.id],
                |r| r.get(0),
            )
            .unwrap();
    assert_eq!(history, 1);
}

#[test]
fn desktop_moves_keep_pending_accepted_text_and_never_require_a_text_replacement() {
    let (_dir, s) = store();
    let d = s.create_document("Drafts/page.fountain").unwrap();
    s.create_folder("Archive").unwrap();
    share(&s, &d.id);
    let room = s.room(&d).unwrap();
    let frame = append_frame(&room, "Browser text still waiting for projection");
    process_frame(&s, &d, &room, &frame, true, true, &mut Peer::default()).unwrap();
    let expected = room_text(&room.lock().unwrap());
    fs::rename(s.root.join(&d.path), s.root.join("Archive/page.fountain")).unwrap();
    let moved = s.index_document("Archive/page.fountain").unwrap();
    assert_eq!(moved.id, d.id);
    assert_eq!(moved.token.as_deref(), Some("old-link"));
    s.persist(&moved, &mut room.lock().unwrap()).unwrap();
    assert_eq!(
        fs::read_to_string(s.root.join(&moved.path)).unwrap(),
        expected
    );
    assert!(!s.root.join(&d.path).exists());
}

#[test]
fn a_busy_external_move_retries_before_retiring_its_identity() {
    let (_dir, s) = store();
    let d = s.create_document("Drafts/page.md").unwrap();
    s.create_folder("Archive").unwrap();
    let room = s.room(&d).unwrap();
    let busy = room.lock().unwrap();
    fs::rename(s.root.join(&d.path), s.root.join("Archive/page.md")).unwrap();
    assert!(s.retire_missing_documents().is_err());
    assert!(s.doc(&d.id).is_ok());
    drop(busy);
    s.retire_missing_documents().unwrap();
    assert_eq!(s.doc(&d.id).unwrap().path, "Archive/page.md");
}

#[test]
fn copies_aliases_and_reused_inodes_never_steal_document_links() {
    let (_dir, s) = store();
    let d = s.create_document("original.md").unwrap();
    share(&s, &d.id);
    fs::copy(s.root.join(&d.path), s.root.join("copy.md")).unwrap();
    let copy = s.index_document("copy.md").unwrap();
    assert_ne!(copy.id, d.id);
    assert_eq!(copy.permission, "private");
    fs::hard_link(s.root.join(&d.path), s.root.join("alias.md")).unwrap();
    let alias = s.index_document("alias.md").unwrap();
    assert_ne!(alias.id, d.id);
    assert_eq!(alias.permission, "private");
    fs::remove_file(s.root.join("alias.md")).unwrap();
    s.index_document(&d.path).unwrap();
    s.db.lock()
        .unwrap()
        .execute(
            "UPDATE document_identities SET identity=identity||'-wrong-birth' WHERE doc=?",
            [&d.id],
        )
        .unwrap();
    fs::rename(s.root.join(&d.path), s.root.join("unconfirmed.md")).unwrap();
    let unrelated = s.index_document("unconfirmed.md").unwrap();
    assert_ne!(unrelated.id, d.id);
    assert_eq!(unrelated.permission, "private");
}

#[test]
fn moving_does_not_turn_relative_media_approval_into_access_to_another_private_image() {
    let (_dir, s) = store();
    let d = s.create_document("Drafts/page.md").unwrap();
    s.create_folder("Private").unwrap();
    fs::write(s.root.join("Drafts/image.png"), "Original image").unwrap();
    fs::write(s.root.join("Private/image.png"), "Unshared private image").unwrap();
    fs::write(s.root.join(&d.path), "![image](image.png)").unwrap();
    let room = s.room(&d).unwrap();
    let original = s.root.join("Drafts/image.png");
    assert!(s.active_attachment_allowed(&d, &original));
    s.rename_document(&d.id, "Private/page.md").unwrap();
    let moved = s.doc(&d.id).unwrap();
    assert!(!s.active_attachment_allowed(&moved, &s.root.join("Private/image.png")));
    assert_eq!(room_text(&room.lock().unwrap()), "![image](image.png)");
    assert!(s.attachment_allowed(&moved, &original));
}

#[test]
fn a_rejected_external_move_stays_journaled_and_replays_without_allocating_a_second_id() {
    let (_dir, s) = store();
    let d = s.create_document("Drafts/page.md").unwrap();
    s.create_folder("Archive").unwrap();
    share(&s, &d.id);
    fs::rename(s.root.join(&d.path), s.root.join("Archive/page.md")).unwrap();
    s.db.lock()
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER reject_move BEFORE UPDATE OF path ON docs
         BEGIN SELECT RAISE(ABORT,'fixture rejection'); END;",
        )
        .unwrap();
    assert!(s.index_document("Archive/page.md").is_err());
    assert_eq!(s.pending_file_moves(None).unwrap().len(), 1);
    s.db.lock()
        .unwrap()
        .execute_batch("DROP TRIGGER reject_move")
        .unwrap();
    let s = reopen(s);
    assert_eq!(s.index_document("Archive/page.md").unwrap().id, d.id);
    assert_eq!(s.doc(&d.id).unwrap().token.as_deref(), Some("old-link"));
}
