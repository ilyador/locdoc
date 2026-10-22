//! File identity, discovery, journaled renames and retirement.
use super::*;
use crate::documents::tests::{append_frame, share, store};

type WalkStep = Box<dyn FnMut(&Path) -> std::io::Result<()>>;

thread_local! {
    /// Runs before the walk lists a folder or inspects an entry, so a test
    /// can change the tree at that exact moment or fail the operation.
    pub(super) static WALK_STEP: std::cell::RefCell<Option<WalkStep>> =
        const { std::cell::RefCell::new(None) };
    /// Nanoseconds added to the passes' clock on this thread.
    pub(super) static CLOCK: std::cell::Cell<i64> = const { std::cell::Cell::new(0) };
}

/// Run `body` with this thread's passes reading the clock `seconds` from now.
fn clock_offset<T>(seconds: i64, body: impl FnOnce() -> T) -> T {
    CLOCK.set(seconds * 1_000_000_000);
    let result = body();
    CLOCK.set(0);
    result
}

/// Run `body` with a walk hook installed on this thread.
fn walking<T>(
    step: impl FnMut(&Path) -> std::io::Result<()> + 'static,
    body: impl FnOnce() -> T,
) -> T {
    WALK_STEP.with_borrow_mut(|hook| *hook = Some(Box::new(step)));
    let result = body();
    WALK_STEP.with_borrow_mut(|hook| *hook = None);
    result
}

/// Stop the server, change the folder, and start it again.
fn stopped(s: App, change: impl FnOnce(&Path)) -> App {
    let root = s.root.clone();
    let data = s.data.clone();
    drop(s);
    change(&root);
    Store::open(root, data, "http://localhost".into()).unwrap()
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
    // A busy room defers only its own document. The pass no longer fails;
    // it asks the maintenance loop for a prompt retry instead.
    let (_dir, s) = store();
    let d = s.create_document("Drafts/page.md").unwrap();
    s.create_folder("Archive").unwrap();
    let room = s.room(&d).unwrap();
    let busy = room.lock().unwrap();
    fs::rename(s.root.join(&d.path), s.root.join("Archive/page.md")).unwrap();
    s.reconciliation.take();
    s.retire_missing_documents().unwrap();
    assert_eq!(s.doc(&d.id).unwrap().path, "Drafts/page.md");
    assert!(s.reconciliation.take().is_some());
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
    // A second name for d's file is neither d nor a separate document whose
    // edits would land in d's file.
    fs::hard_link(s.root.join(&d.path), s.root.join("alias.md")).unwrap();
    assert_eq!(
        s.index_document("alias.md").unwrap_err().0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(s.index_document(&d.path).unwrap().id, d.id);
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
fn a_rejected_external_move_replays_from_evidence_without_allocating_a_second_id() {
    // A followed move has no filesystem step of its own, so it no longer
    // writes a journal entry that could block the document.
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
    assert_eq!(pending_moves(&s), 0);
    s.db.lock()
        .unwrap()
        .execute_batch("DROP TRIGGER reject_move")
        .unwrap();
    let s = reopen(s);
    assert_eq!(s.index_document("Archive/page.md").unwrap().id, d.id);
    assert_eq!(s.doc(&d.id).unwrap().token.as_deref(), Some("old-link"));
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

/// Shared A at p.md and private B at r.md, each with durable accepted text.
fn swap_fixture() -> (tempfile::TempDir, App, Document, Document) {
    let (directory, s) = store();
    let a = s.create_document("p.md").unwrap();
    let b = s.create_document("r.md").unwrap();
    share(&s, &a.id);
    fs::write(s.root.join("p.md"), "Shared text of A\n").unwrap();
    fs::write(s.root.join("r.md"), "Private text of B\n").unwrap();
    for document in [&a, &b] {
        let room = s.room(document).unwrap();
        s.persist(document, &mut room.lock().unwrap()).unwrap();
    }
    (directory, s, a, b)
}

fn swap(root: &Path) {
    fs::rename(root.join("p.md"), root.join("q.md")).unwrap();
    fs::rename(root.join("r.md"), root.join("p.md")).unwrap();
}

#[test]
fn an_offline_swap_moves_each_document_with_its_own_file() {
    // Path-first discovery let A adopt B's file at p.md, so A's public link
    // served B's private text. A known file identity now outranks the path.
    let (_directory, s, a, b) = swap_fixture();
    let s = stopped(s, swap);
    let moved = s.doc(&a.id).unwrap();
    assert_eq!(moved.path, "q.md");
    assert_eq!(moved.token.as_deref(), Some("old-link"));
    let took = s.doc(&b.id).unwrap();
    assert_eq!(took.path, "p.md");
    assert_eq!(took.permission, "private");
    assert!(took.token.is_none());
    assert_eq!(
        shared_text(&s, "old-link").as_deref(),
        Some("Shared text of A\n")
    );
    assert_eq!(s.index_document("p.md").unwrap().id, b.id);
    assert_eq!(s.index_document("q.md").unwrap().id, a.id);
    assert_eq!(
        fs::read_to_string(s.root.join("q.md")).unwrap(),
        "Shared text of A\n"
    );
    assert_eq!(
        fs::read_to_string(s.root.join("p.md")).unwrap(),
        "Private text of B\n"
    );
}

#[test]
fn a_document_moved_out_of_the_root_retires_while_another_takes_its_path() {
    let (directory, s, a, b) = swap_fixture();
    let outside = directory.path().join("outside.md");
    let s = stopped(s, |root| {
        fs::rename(root.join("p.md"), &outside).unwrap();
        fs::rename(root.join("r.md"), root.join("p.md")).unwrap();
    });
    // Startup only discovers. A waits for a settled pass, B for A's path.
    assert_eq!(s.doc(&a.id).unwrap().path, "p.md");
    assert_eq!(s.doc(&b.id).unwrap().path, "r.md");
    // Meanwhile A's link keeps serving A's accepted text, never B's file.
    assert_eq!(
        shared_text(&s, "old-link").as_deref(),
        Some("Shared text of A\n")
    );
    assert_eq!(
        fs::read_to_string(s.root.join("p.md")).unwrap(),
        "Private text of B\n"
    );
    s.retire_missing_documents().unwrap();
    assert!(s.doc(&a.id).is_err());
    assert!(shared_text(&s, "old-link").is_none());
    let took = s.doc(&b.id).unwrap();
    assert_eq!(took.path, "p.md");
    assert_eq!(took.permission, "private");
    assert!(took.token.is_none());
    assert_eq!(
        fs::read_to_string(s.root.join("p.md")).unwrap(),
        "Private text of B\n"
    );
    assert_eq!(fs::read_to_string(outside).unwrap(), "Shared text of A\n");
}

#[test]
fn a_swap_while_running_moves_each_document_with_its_own_file() {
    let (_directory, s, a, b) = swap_fixture();
    swap(&s.root);
    s.discover_file_moves().unwrap();
    assert_eq!(s.doc(&a.id).unwrap().path, "q.md");
    let took = s.doc(&b.id).unwrap();
    assert_eq!(took.path, "p.md");
    assert!(took.token.is_none());
    assert_eq!(
        shared_text(&s, "old-link").as_deref(),
        Some("Shared text of A\n")
    );
    assert_eq!(
        fs::read_to_string(s.root.join("p.md")).unwrap(),
        "Private text of B\n"
    );
}

#[test]
fn a_rotation_of_three_files_keeps_every_document_with_its_file() {
    let (_directory, s) = store();
    let documents: Vec<_> = ["one.md", "two.md", "three.md"]
        .into_iter()
        .map(|name| {
            let document = s.create_document(name).unwrap();
            fs::write(s.root.join(name), format!("Text of {name}\n")).unwrap();
            (name, document)
        })
        .collect();
    fs::rename(s.root.join("one.md"), s.root.join("rotation.tmp")).unwrap();
    fs::rename(s.root.join("three.md"), s.root.join("one.md")).unwrap();
    fs::rename(s.root.join("two.md"), s.root.join("three.md")).unwrap();
    fs::rename(s.root.join("rotation.tmp"), s.root.join("two.md")).unwrap();
    s.discover_file_moves().unwrap();
    for ((name, document), expected) in documents.iter().zip(["two.md", "three.md", "one.md"]) {
        let current = s.doc(&document.id).unwrap();
        assert_eq!(current.path, expected);
        assert_eq!(
            fs::read_to_string(s.root.join(&current.path)).unwrap(),
            format!("Text of {name}\n")
        );
    }
}

#[test]
fn an_atomic_save_keeps_its_document_and_records_the_replacement() {
    let (_directory, s) = store();
    let document = s.create_document("page.md").unwrap();
    share(&s, &document.id);
    let generation = s.permissions.current();
    let temporary = s.root.join("page.md.tmp");
    fs::write(&temporary, "Saved by a desktop editor\n").unwrap();
    fs::rename(&temporary, s.root.join("page.md")).unwrap();
    s.retire_missing_documents().unwrap();
    let kept = s.doc(&document.id).unwrap();
    assert_eq!(kept.path, "page.md");
    assert_eq!(kept.token.as_deref(), Some("old-link"));
    let recorded: String =
        s.db.lock()
            .unwrap()
            .query_row(
                "SELECT identity FROM document_identities WHERE doc=?",
                [&document.id],
                |row| row.get(0),
            )
            .unwrap();
    assert_eq!(
        Some(Identity(recorded)),
        Identity::of(&fs::symlink_metadata(s.root.join("page.md")).unwrap())
    );
    assert_eq!(s.index_document("page.md").unwrap().id, document.id);
    assert_eq!(
        s.permissions.current(),
        generation,
        "Recording a replacement file must not reconnect every socket"
    );
}

#[test]
fn evidence_an_older_version_recorded_twice_stays_with_the_file_holding_it() {
    let (_directory, s) = store();
    let holder = s.create_document("holder.md").unwrap();
    let stale = s.create_document("stale.md").unwrap();
    fs::remove_file(s.root.join("stale.md")).unwrap();
    // Path-first discovery could record one file for two documents.
    s.db.lock()
        .unwrap()
        .execute(
            "UPDATE document_identities SET identity=
             (SELECT identity FROM document_identities WHERE doc=?) WHERE doc=?",
            [&holder.id, &stale.id],
        )
        .unwrap();
    s.retire_missing_documents().unwrap();
    assert_eq!(s.doc(&holder.id).unwrap().path, "holder.md");
    assert!(s.doc(&stale.id).is_err());
    assert_eq!(s.index_document("holder.md").unwrap().id, holder.id);
    fs::write(s.root.join("new.md"), "Unrelated\n").unwrap();
    let new = s.index_document("new.md").unwrap();
    assert_ne!(new.id, holder.id);
    assert_eq!(new.permission, "private");
}

#[test]
fn an_entry_vanishing_during_the_walk_cannot_stop_startup() {
    let (_directory, s) = store();
    let document = s.create_document("Drafts/page.md").unwrap();
    s.create_folder("Archive").unwrap();
    share(&s, &document.id);
    let temporary = s.root.join("Archive/page.md.swp");
    fs::write(&temporary, "Editor scratch file").unwrap();
    let s = walking(
        move |path| {
            // The editor removes its file between listing and inspecting it.
            if path == temporary {
                fs::remove_file(path)?;
            }
            Ok(())
        },
        || {
            stopped(s, |root| {
                fs::rename(root.join("Drafts/page.md"), root.join("Archive/page.md")).unwrap();
            })
        },
    );
    let moved = s.doc(&document.id).unwrap();
    assert_eq!(moved.path, "Archive/page.md");
    assert_eq!(moved.token.as_deref(), Some("old-link"));
}

#[test]
fn an_unreadable_folder_defers_retirement_until_it_can_be_read() {
    let (_directory, s) = store();
    let removed = s.create_document("removed.md").unwrap();
    let hidden = s.create_document("hidden.md").unwrap();
    share(&s, &removed.id);
    share_link(&s, &hidden.id, "hidden-link");
    s.create_folder("Locked").unwrap();
    fs::remove_file(s.root.join("removed.md")).unwrap();
    fs::rename(s.root.join("hidden.md"), s.root.join("Locked/hidden.md")).unwrap();
    let locked = s.root.join("Locked");
    s.reconciliation.take();
    walking(
        move |path| {
            if path == locked {
                return Err(std::io::ErrorKind::PermissionDenied.into());
            }
            Ok(())
        },
        || s.retire_missing_documents(),
    )
    .unwrap();
    // Either file could be in the unlisted folder, so neither retires.
    assert_eq!(
        s.doc(&removed.id).unwrap().token.as_deref(),
        Some("old-link")
    );
    assert_eq!(s.doc(&hidden.id).unwrap().path, "hidden.md");
    let retry = s.reconciliation.take().unwrap();
    assert!(
        retry > Instant::now() + Duration::from_secs(10),
        "An incomplete walk must not rescan the tree every second"
    );
    s.retire_missing_documents().unwrap();
    assert!(s.doc(&removed.id).is_err());
    let found = s.doc(&hidden.id).unwrap();
    assert_eq!(found.path, "Locked/hidden.md");
    assert_eq!(found.token.as_deref(), Some("hidden-link"));
}

#[test]
fn a_folder_nothing_can_move_into_holds_only_the_documents_recorded_inside_it() {
    use std::os::unix::fs::PermissionsExt;
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let (_directory, s) = store();
    let inside = s.create_document("Locked/inside.md").unwrap();
    let below = s.create_document("Names/below.md").unwrap();
    let removed = s.create_document("removed.md").unwrap();
    share_link(&s, &inside.id, "inside-link");
    share_link(&s, &below.id, "below-link");
    share(&s, &removed.id);
    for path in ["Locked/inside.md", "Names/below.md", "removed.md"] {
        fs::remove_file(s.root.join(path)).unwrap();
    }
    fs::write(s.root.join("Names/notes.txt"), "").unwrap();
    // Locked cannot be listed or entered, like a root-owned lost+found;
    // Names lists its entries but cannot be entered to inspect them.
    // Neither can take a moved file.
    let (locked, names) = (s.root.join("Locked"), s.root.join("Names"));
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
    fs::set_permissions(&names, fs::Permissions::from_mode(0o400)).unwrap();
    let passed = s.retire_missing_documents();
    let held = [&inside, &below].map(|document| s.doc(&document.id).map(|d| d.token));
    let retired = s.doc(&removed.id).is_err();
    for folder in [&locked, &names] {
        fs::set_permissions(folder, fs::Permissions::from_mode(0o700)).unwrap();
    }
    passed.unwrap();
    assert!(
        retired,
        "A file removed elsewhere cannot be in a folder no one could move it into"
    );
    let [inside_link, below_link] = held.map(|token| token.unwrap());
    assert_eq!(inside_link.as_deref(), Some("inside-link"));
    assert_eq!(below_link.as_deref(), Some("below-link"));
    s.retire_missing_documents().unwrap();
    assert!(s.doc(&inside.id).is_err());
    assert!(s.doc(&below.id).is_err());
}

#[test]
fn a_folder_locdoc_could_move_files_into_but_not_list_holds_every_missing_document() {
    use std::os::unix::fs::PermissionsExt;
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let (_directory, s) = store();
    let removed = s.create_document("removed.md").unwrap();
    let moved = s.create_document("moved.md").unwrap();
    share(&s, &removed.id);
    share_link(&s, &moved.id, "moved-link");
    s.create_folder("Drop").unwrap();
    fs::remove_file(s.root.join("removed.md")).unwrap();
    fs::rename(s.root.join("moved.md"), s.root.join("Drop/moved.md")).unwrap();
    let drop = s.root.join("Drop");
    s.reconciliation.take();
    // Writable and searchable but not readable: either file could be there.
    fs::set_permissions(&drop, fs::Permissions::from_mode(0o300)).unwrap();
    let passed = s.retire_missing_documents();
    let removed_link = s.doc(&removed.id).map(|d| d.token);
    let moved_path = s.doc(&moved.id).map(|d| d.path);
    let retry = s.reconciliation.take();
    fs::set_permissions(&drop, fs::Permissions::from_mode(0o700)).unwrap();
    passed.unwrap();
    assert_eq!(removed_link.unwrap().as_deref(), Some("old-link"));
    assert_eq!(moved_path.unwrap(), "moved.md");
    assert!(
        retry.unwrap() > Instant::now() + Duration::from_secs(10),
        "A held document must not rescan the tree every second"
    );
    s.retire_missing_documents().unwrap();
    assert!(s.doc(&removed.id).is_err());
    let found = s.doc(&moved.id).unwrap();
    assert_eq!(found.path, "Drop/moved.md");
    assert_eq!(found.token.as_deref(), Some("moved-link"));
}

#[test]
fn a_folder_locdoc_can_enter_but_not_list_holds_every_missing_document() {
    use std::os::unix::fs::PermissionsExt;
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let (_directory, s) = store();
    let moved = s.create_document("moved.md").unwrap();
    share_link(&s, &moved.id, "moved-link");
    s.create_folder("Search/Inbox").unwrap();
    fs::rename(
        s.root.join("moved.md"),
        s.root.join("Search/Inbox/moved.md"),
    )
    .unwrap();
    // Search cannot be listed or written, but a subfolder the walk cannot
    // see may still take files.
    let search = s.root.join("Search");
    fs::set_permissions(&search, fs::Permissions::from_mode(0o100)).unwrap();
    let passed = s.retire_missing_documents();
    let moved_link = s.doc(&moved.id).map(|d| d.token);
    fs::set_permissions(&search, fs::Permissions::from_mode(0o700)).unwrap();
    passed.unwrap();
    assert_eq!(moved_link.unwrap().as_deref(), Some("moved-link"));
    s.retire_missing_documents().unwrap();
    let found = s.doc(&moved.id).unwrap();
    assert_eq!(found.path, "Search/Inbox/moved.md");
    assert_eq!(found.token.as_deref(), Some("moved-link"));
}

#[test]
fn a_readable_lost_and_found_at_the_documents_root_is_still_searched() {
    let (_directory, s) = store();
    let moved = s.create_document("moved.md").unwrap();
    share_link(&s, &moved.id, "moved-link");
    fs::create_dir(s.root.join("lost+found")).unwrap();
    fs::rename(s.root.join("moved.md"), s.root.join("lost+found/moved.md")).unwrap();
    s.retire_missing_documents().unwrap();
    let found = s.doc(&moved.id).unwrap();
    assert_eq!(found.path, "lost+found/moved.md");
    assert_eq!(found.token.as_deref(), Some("moved-link"));
}

#[test]
fn lost_and_found_at_the_documents_root_never_holds_a_missing_document() {
    use std::os::unix::fs::PermissionsExt;
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let (_directory, s) = store();
    let removed = s.create_document("removed.md").unwrap();
    share(&s, &removed.id);
    fs::remove_file(s.root.join("removed.md")).unwrap();
    // fsck's folder at the top of a dedicated mount, here even one that
    // Locdoc could move files into.
    let found = s.root.join("lost+found");
    fs::create_dir(&found).unwrap();
    fs::set_permissions(&found, fs::Permissions::from_mode(0o300)).unwrap();
    let passed = s.retire_missing_documents();
    let retired = s.doc(&removed.id).is_err();
    fs::set_permissions(&found, fs::Permissions::from_mode(0o700)).unwrap();
    passed.unwrap();
    assert!(retired, "lost+found must not keep every walk incomplete");
}

fn share_link(s: &Store, id: &str, token: &str) {
    s.db.lock()
        .unwrap()
        .execute(
            "UPDATE docs SET permission='view',token=? WHERE id=?",
            [token, id],
        )
        .unwrap();
}

#[test]
fn startup_serves_documents_when_reconciliation_fails() {
    let (_directory, s) = store();
    let document = s.create_document("Drafts/page.md").unwrap();
    s.create_folder("Archive").unwrap();
    s.db.lock()
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER reject_reconciliation BEFORE UPDATE OF path ON docs
             BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END;",
        )
        .unwrap();
    let s = stopped(s, |root| {
        fs::rename(root.join("Drafts/page.md"), root.join("Archive/page.md")).unwrap();
    });
    assert_eq!(s.doc(&document.id).unwrap().path, "Drafts/page.md");
    s.db.lock()
        .unwrap()
        .execute_batch("DROP TRIGGER reject_reconciliation")
        .unwrap();
    s.discover_file_moves().unwrap();
    assert_eq!(s.doc(&document.id).unwrap().path, "Archive/page.md");
}

#[test]
fn a_file_still_being_matched_does_not_hide_the_workspace_listing() {
    let (directory, s, a, b) = swap_fixture();
    let other = s.create_document("other.md").unwrap();
    fs::rename(s.root.join("p.md"), directory.path().join("outside.md")).unwrap();
    fs::rename(s.root.join("r.md"), s.root.join("p.md")).unwrap();
    // Until a settled pass retires A, p.md belongs to neither document.
    let mut entries = Vec::new();
    scan(&s, &s.root, &mut entries).unwrap();
    let listed: Vec<_> = entries
        .iter()
        .filter_map(|entry| entry.id.clone())
        .collect();
    assert_eq!(listed, vec![other.id.clone()]);
    s.retire_missing_documents().unwrap();
    let mut entries = Vec::new();
    scan(&s, &s.root, &mut entries).unwrap();
    let listed: Vec<_> = entries
        .iter()
        .filter_map(|entry| entry.id.clone())
        .collect();
    assert!(listed.contains(&b.id) && listed.contains(&other.id));
    assert!(!listed.contains(&a.id));
}

#[test]
fn a_live_room_neither_imports_nor_overwrites_another_documents_file() {
    let (_directory, s, a, _b) = swap_fixture();
    let room = s.room(&a).unwrap();
    let frame = append_frame(&room, "Pending browser edit of A\n");
    process_frame(&s, &a, &room, &frame, true, true, &mut Peer::default()).unwrap();
    let accepted = room_text(&room.lock().unwrap());
    // The engine sees the swap before any pass has matched the files.
    swap(&s.root);
    s.reconciliation.take();
    assert!(!s.persist(&a, &mut room.lock().unwrap()).unwrap());
    assert_eq!(room_text(&room.lock().unwrap()), accepted);
    assert_eq!(
        fs::read_to_string(s.root.join("p.md")).unwrap(),
        "Private text of B\n"
    );
    assert!(
        s.reconciliation.take().is_some(),
        "The engine asks for a pass instead of waiting for document_files"
    );
    assert_eq!(
        shared_text(&s, "old-link").as_deref(),
        Some(accepted.as_str())
    );
    s.discover_file_moves().unwrap();
    let moved = s.doc(&a.id).unwrap();
    assert!(s.persist(&moved, &mut room.lock().unwrap()).unwrap());
    assert_eq!(fs::read_to_string(s.root.join("q.md")).unwrap(), accepted);
    assert_eq!(
        fs::read_to_string(s.root.join("p.md")).unwrap(),
        "Private text of B\n"
    );
}

#[test]
fn a_cold_document_never_loads_another_documents_file() {
    let (_directory, s) = store();
    let a = s.create_document("p.md").unwrap();
    let b = s.create_document("r.md").unwrap();
    share(&s, &a.id);
    fs::write(s.root.join("r.md"), "Private text of B\n").unwrap();
    swap(&s.root);
    assert!(matches!(
        s.room(&a),
        Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, _))
    ));
    assert!(shared_text(&s, "old-link").is_none());
    let state: Option<Vec<u8>> =
        s.db.lock()
            .unwrap()
            .query_row("SELECT state FROM docs WHERE id=?", [&a.id], |row| {
                row.get(0)
            })
            .unwrap();
    assert!(state.is_none(), "B's bytes must not seed A's first state");
    s.discover_file_moves().unwrap();
    assert_eq!(shared_text(&s, "old-link").as_deref(), Some("# p\n\n"));
    assert_eq!(s.doc(&b.id).unwrap().path, "p.md");
}

/// P's file now sits at C's old name and C's own file is gone. Until a settled
/// pass retires C, P keeps its row path, where nothing is.
fn moved_onto_a_removed_document() -> (tempfile::TempDir, App, Document, Document) {
    let (directory, s) = store();
    let moved = s.create_document("p.md").unwrap();
    let removed = s.create_document("q.md").unwrap();
    share(&s, &moved.id);
    fs::remove_file(s.root.join("q.md")).unwrap();
    fs::rename(s.root.join("p.md"), s.root.join("q.md")).unwrap();
    (directory, s, moved, removed)
}

#[test]
fn reusing_a_name_never_retires_a_document_whose_file_was_found_elsewhere() {
    let (_directory, s, moved, removed) = moved_onto_a_removed_document();
    let error = s.create_document("p.md").unwrap_err();
    assert_eq!(error.0, StatusCode::CONFLICT);
    assert_eq!(s.doc(&moved.id).unwrap().token.as_deref(), Some("old-link"));
    s.retire_missing_documents().unwrap();
    assert!(s.doc(&removed.id).is_err());
    assert_eq!(s.doc(&moved.id).unwrap().path, "q.md");
    let created = s.create_document("p.md").unwrap();
    assert_ne!(created.id, moved.id);
    assert_eq!(s.doc(&moved.id).unwrap().token.as_deref(), Some("old-link"));
}

#[test]
fn renaming_onto_a_name_never_retires_a_document_whose_file_was_found_elsewhere() {
    let (_directory, s, moved, _removed) = moved_onto_a_removed_document();
    let other = s.create_document("other.md").unwrap();
    let error = s.rename_document(&other.id, "p.md").unwrap_err();
    assert_eq!(error.0, StatusCode::CONFLICT);
    assert_eq!(s.doc(&other.id).unwrap().path, "other.md");
    assert_eq!(s.doc(&moved.id).unwrap().token.as_deref(), Some("old-link"));
    s.retire_missing_documents().unwrap();
    s.rename_document(&other.id, "p.md").unwrap();
    let kept = s.doc(&moved.id).unwrap();
    assert_eq!(kept.path, "q.md");
    assert_eq!(kept.token.as_deref(), Some("old-link"));
}

#[test]
fn no_path_reuse_retires_a_document_a_folder_it_cannot_list_may_hide() {
    use std::os::unix::fs::PermissionsExt;
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let (_directory, s) = store();
    let held = s.create_document("held.md").unwrap();
    share_link(&s, &held.id, "held-link");
    s.create_document("Notes/old.md").unwrap();
    let item = s.trash_folder("Notes").unwrap();
    let inside = s.create_document("Notes/inside.md").unwrap();
    share_link(&s, &inside.id, "inside-link");
    let other = s.create_document("other.md").unwrap();
    s.create_folder("Drafts").unwrap();
    s.create_folder("Drop").unwrap();
    // Both files move into a folder Locdoc can enter but not list, and the
    // folder one of them was in goes, so either path looks free.
    fs::rename(s.root.join("held.md"), s.root.join("Drop/held.md")).unwrap();
    fs::rename(
        s.root.join("Notes/inside.md"),
        s.root.join("Drop/inside.md"),
    )
    .unwrap();
    fs::remove_dir(s.root.join("Notes")).unwrap();
    let drop = s.root.join("Drop");
    fs::set_permissions(&drop, fs::Permissions::from_mode(0o300)).unwrap();
    let passed = s.retire_missing_documents();
    let reused = [
        ("create", s.create_document("held.md").map(|_| ())),
        (
            "duplicate",
            s.duplicate_document(&other, "held.md", "Copy\n", "lf")
                .map(|_| ()),
        ),
        ("rename", s.rename_document(&other.id, "held.md")),
        (
            "move a folder",
            s.rename_folder("Drafts", "Notes").map(|_| ()),
        ),
        ("restore", s.restore_trash(&item).map(|_| ())),
    ];
    fs::set_permissions(&drop, fs::Permissions::from_mode(0o700)).unwrap();
    passed.unwrap();
    for (what, result) in reused {
        let error = result.unwrap_err();
        assert_eq!(error.0, StatusCode::CONFLICT, "{what}: {}", error.1);
        assert!(error.1.contains("may be in Drop"), "{what}: {}", error.1);
    }
    assert!(!s.root.join("held.md").exists() && !s.root.join("Notes").exists());
    // Once the folder can be listed, both documents are found there with
    // their links, and their old paths are free.
    s.retire_missing_documents().unwrap();
    for (document, path, token) in [
        (&held, "Drop/held.md", "held-link"),
        (&inside, "Drop/inside.md", "inside-link"),
    ] {
        let found = s.doc(&document.id).unwrap();
        assert_eq!(found.path, path);
        assert_eq!(found.token.as_deref(), Some(token));
    }
    assert_ne!(s.create_document("held.md").unwrap().id, held.id);
    assert_eq!(s.rename_folder("Drafts", "Notes").unwrap(), "Notes");
}

#[test]
fn a_file_moved_between_folders_during_the_walk_is_not_retired() {
    let (directory, s) = store();
    let document = s.create_document("page.md").unwrap();
    share(&s, &document.id);
    s.create_folder("Left").unwrap();
    s.create_folder("Right").unwrap();
    let outside = directory.path().join("page.md");
    fs::rename(s.root.join("page.md"), &outside).unwrap();
    let folders = [s.root.join("Left"), s.root.join("Right")];
    let mut visits: HashMap<PathBuf, u32> = HashMap::new();
    let mut listed: Option<PathBuf> = None;
    walking(
        move |path| {
            // A folder is visited as an entry of its parent, then again just
            // before it is listed. Once one folder is listed and the other is
            // about to be, the file arrives in the one already listed.
            if folders.iter().any(|folder| folder == path) {
                let count = visits.entry(path.to_owned()).or_default();
                *count += 1;
                if *count == 2 {
                    match &listed {
                        None => listed = Some(path.to_owned()),
                        Some(first) if outside.exists() => {
                            fs::rename(&outside, first.join("page.md"))?;
                        }
                        Some(_) => {}
                    }
                }
            }
            Ok(())
        },
        || s.retire_missing_documents(),
    )
    .unwrap();
    assert_eq!(
        s.doc(&document.id).unwrap().token.as_deref(),
        Some("old-link")
    );
    s.retire_missing_documents().unwrap();
    let found = s.doc(&document.id).unwrap();
    assert!(found.path == "Left/page.md" || found.path == "Right/page.md");
    assert_eq!(found.token.as_deref(), Some("old-link"));
}

#[test]
fn an_interrupted_rename_settles_after_its_old_folder_became_a_link() {
    let (directory, s) = store();
    let document = s.create_document("Old/page.md").unwrap();
    s.create_folder("New").unwrap();
    share(&s, &document.id);
    interrupted_move(&s, &document, "New/page.md");
    disk::rename_new(&s.root.join("Old/page.md"), &s.root.join("New/page.md")).unwrap();
    // While Locdoc is stopped, the emptied folder is replaced by a link.
    fs::remove_dir(s.root.join("Old")).unwrap();
    std::os::unix::fs::symlink(directory.path(), s.root.join("Old")).unwrap();
    let s = reopen(s);
    assert_eq!(pending_moves(&s), 0);
    let moved = s.doc(&document.id).unwrap();
    assert_eq!(moved.path, "New/page.md");
    assert_eq!(moved.token.as_deref(), Some("old-link"));
}

#[test]
fn a_room_never_adopts_a_new_file_at_its_name_while_its_own_file_is_elsewhere() {
    let (_directory, s) = store();
    let a = s.create_document("p.md").unwrap();
    share(&s, &a.id);
    fs::write(s.root.join("p.md"), "Shared text of A\n").unwrap();
    let room = s.room(&a).unwrap();
    s.persist(&a, &mut room.lock().unwrap()).unwrap();
    let frame = append_frame(&room, "Browser edit of A\n");
    process_frame(&s, &a, &room, &frame, true, true, &mut Peer::default()).unwrap();
    let accepted = room_text(&room.lock().unwrap());
    // A desktop app moves A away and writes a new private file at its name.
    fs::rename(s.root.join("p.md"), s.root.join("q.md")).unwrap();
    fs::write(s.root.join("p.md"), "New private notes\n").unwrap();
    // The engine sees the new file before any pass decides whose it is. It
    // must not serve it through A's link or save A's edit into it.
    assert!(!s.persist(&a, &mut room.lock().unwrap()).unwrap());
    assert_eq!(room_text(&room.lock().unwrap()), accepted);
    assert_eq!(
        shared_text(&s, "old-link").as_deref(),
        Some(accepted.as_str())
    );
    assert_eq!(
        fs::read_to_string(s.root.join("p.md")).unwrap(),
        "New private notes\n"
    );
    s.discover_file_moves().unwrap();
    let moved = s.doc(&a.id).unwrap();
    assert_eq!(moved.path, "q.md");
    assert!(s.persist(&moved, &mut room.lock().unwrap()).unwrap());
    assert_eq!(fs::read_to_string(s.root.join("q.md")).unwrap(), accepted);
    let notes = s.index_document("p.md").unwrap();
    assert_ne!(notes.id, a.id);
    assert_eq!(notes.permission, "private");
}

#[test]
fn the_document_holding_evidence_recorded_twice_keeps_saving() {
    use std::os::unix::fs::PermissionsExt;
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let (_directory, s) = store();
    let holder = s.create_document("holder.md").unwrap();
    let stale = s.create_document("Locked/stale.md").unwrap();
    // Path-first discovery could record one file for two documents.
    s.db.lock()
        .unwrap()
        .execute(
            "UPDATE document_identities SET identity=
             (SELECT identity FROM document_identities WHERE doc=?) WHERE doc=?",
            [&holder.id, &stale.id],
        )
        .unwrap();
    // The other document is unreadable, so no pass can settle the evidence.
    let locked = s.root.join("Locked");
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
    let saved = (|| -> Result<(bool, String)> {
        s.discover_file_moves()?;
        let room = s.room(&holder)?;
        let frame = append_frame(&room, "Edit of the holder\n");
        process_frame(&s, &holder, &room, &frame, true, true, &mut Peer::default())?;
        let saved = s.persist(&holder, &mut room.lock().unwrap())?;
        Ok((saved, fs::read_to_string(s.root.join("holder.md"))?))
    })();
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).unwrap();
    let (saved, text) = saved.unwrap();
    assert!(saved);
    assert!(text.contains("Edit of the holder"));
}

#[test]
fn a_waiting_room_cannot_make_an_unreadable_tree_rescan_every_second() {
    let (directory, s, a, b) = swap_fixture();
    let room = s.room(&a).unwrap();
    let frame = append_frame(&room, "Pending edit of A\n");
    process_frame(&s, &a, &room, &frame, true, true, &mut Peer::default()).unwrap();
    s.create_folder("Locked").unwrap();
    fs::rename(s.root.join("p.md"), directory.path().join("outside.md")).unwrap();
    fs::rename(s.root.join("r.md"), s.root.join("p.md")).unwrap();
    let locked = s.root.join("Locked");
    s.reconciliation.take();
    walking(
        move |path| {
            if path == locked {
                return Err(std::io::ErrorKind::PermissionDenied.into());
            }
            Ok(())
        },
        || s.retire_missing_documents(),
    )
    .unwrap();
    // A's file may be in the unlisted folder, so A waits for a full listing.
    assert!(s.doc(&a.id).is_ok());
    let held = s.reconciliation.take().unwrap();
    assert!(held > Instant::now() + Duration::from_secs(10));
    // A's room polls while B's file sits at A's name; asking again cannot
    // complete the listing sooner.
    assert!(!s.persist(&a, &mut room.lock().unwrap()).unwrap());
    let next = s.reconciliation.take();
    assert!(
        next.is_none_or(|next| next >= held),
        "A waiting room must not bring the next full walk forward"
    );
    // Once the folder can be listed, A retires and B takes its name.
    s.retire_missing_documents().unwrap();
    assert!(s.doc(&a.id).is_err());
    assert_eq!(s.doc(&b.id).unwrap().path, "p.md");
}

#[test]
fn a_swap_with_a_busy_room_waits_for_both_documents() {
    let (_directory, s, a, b) = swap_fixture();
    let room = s.room(&a).unwrap();
    swap(&s.root);
    let busy = room.lock().unwrap();
    s.discover_file_moves().unwrap();
    // A cannot move yet, so B cannot take A's name either.
    assert_eq!(s.doc(&a.id).unwrap().path, "p.md");
    assert_eq!(s.doc(&b.id).unwrap().path, "r.md");
    drop(busy);
    assert_eq!(
        shared_text(&s, "old-link").as_deref(),
        Some("Shared text of A\n")
    );
    s.discover_file_moves().unwrap();
    assert_eq!(s.doc(&a.id).unwrap().path, "q.md");
    assert_eq!(s.doc(&b.id).unwrap().path, "p.md");
    assert_eq!(
        shared_text(&s, "old-link").as_deref(),
        Some("Shared text of A\n")
    );
}

#[test]
fn a_root_replaced_during_the_walk_retires_nothing() {
    let (directory, s) = store();
    let kept = s.create_document("kept.md").unwrap();
    let removed = s.create_document("removed.md").unwrap();
    share(&s, &kept.id);
    fs::remove_file(s.root.join("removed.md")).unwrap();
    let root = s.root.clone();
    let unmounted = directory.path().join("unmounted");
    let replaced = unmounted.clone();
    walking(
        move |path| {
            if path == root && !replaced.exists() {
                fs::rename(&root, &replaced)?;
                fs::create_dir(&root)?;
            }
            Ok(())
        },
        || s.retire_missing_documents(),
    )
    .unwrap();
    assert!(s.doc(&removed.id).is_ok());
    assert_eq!(s.doc(&kept.id).unwrap().token.as_deref(), Some("old-link"));
    fs::remove_dir(&s.root).unwrap();
    fs::rename(unmounted, &s.root).unwrap();
    s.retire_missing_documents().unwrap();
    assert!(s.doc(&removed.id).is_err());
    assert_eq!(s.doc(&kept.id).unwrap().token.as_deref(), Some("old-link"));
}

#[test]
fn a_file_moved_over_another_document_keeps_its_own_document() {
    let (_directory, s, a, b) = swap_fixture();
    // A's file replaces B's file under B's name.
    fs::rename(s.root.join("p.md"), s.root.join("r.md")).unwrap();
    s.discover_file_moves().unwrap();
    // Until a settled pass B keeps its name, so A waits too.
    assert_eq!(s.doc(&a.id).unwrap().path, "p.md");
    assert_eq!(s.doc(&b.id).unwrap().path, "r.md");
    assert_eq!(
        shared_text(&s, "old-link").as_deref(),
        Some("Shared text of A\n")
    );
    s.retire_missing_documents().unwrap();
    assert!(s.doc(&b.id).is_err());
    let moved = s.doc(&a.id).unwrap();
    assert_eq!(moved.path, "r.md");
    assert_eq!(moved.token.as_deref(), Some("old-link"));
    assert_eq!(
        shared_text(&s, "old-link").as_deref(),
        Some("Shared text of A\n")
    );
}

#[test]
fn a_hard_link_over_a_shared_name_never_serves_another_documents_file() {
    let (_directory, s, a, b) = swap_fixture();
    // `ln -f r.md p.md`, or a deduplicator merging two files: A's own file
    // is gone and its name now links to B's private file.
    fs::remove_file(s.root.join("p.md")).unwrap();
    fs::hard_link(s.root.join("r.md"), s.root.join("p.md")).unwrap();
    s.discover_file_moves().unwrap();
    assert_eq!(
        shared_text(&s, "old-link").as_deref(),
        Some("Shared text of A\n")
    );
    s.retire_missing_documents().unwrap();
    assert!(s.doc(&a.id).is_err());
    assert!(shared_text(&s, "old-link").is_none());
    // B keeps saving into its own file while the second name exists.
    let room = s.room(&b).unwrap();
    let frame = append_frame(&room, "Private edit of B\n");
    process_frame(&s, &b, &room, &frame, true, true, &mut Peer::default()).unwrap();
    assert!(s.persist(&b, &mut room.lock().unwrap()).unwrap());
    assert!(
        fs::read_to_string(s.root.join("r.md"))
            .unwrap()
            .contains("Private edit of B")
    );
    assert_eq!(s.doc(&b.id).unwrap().path, "r.md");
}

#[test]
fn a_private_name_linked_to_a_shared_file_never_writes_into_it() {
    let (_directory, s, a, b) = swap_fixture();
    // B's name now links to A's shared file. Edits accepted in B must not
    // reach that file, where A's link would publish them.
    fs::remove_file(s.root.join("r.md")).unwrap();
    fs::hard_link(s.root.join("p.md"), s.root.join("r.md")).unwrap();
    let room = s.room(&b).unwrap();
    let frame = append_frame(&room, "Private edit of B\n");
    process_frame(&s, &b, &room, &frame, true, true, &mut Peer::default()).unwrap();
    for _ in 0..2 {
        s.discover_file_moves().unwrap();
        let _ = s.persist(&b, &mut room.lock().unwrap());
        assert_eq!(
            fs::read_to_string(s.root.join("p.md")).unwrap(),
            "Shared text of A\n"
        );
        assert_eq!(
            shared_text(&s, "old-link").as_deref(),
            Some("Shared text of A\n")
        );
    }
    s.retire_missing_documents().unwrap();
    assert!(s.doc(&b.id).is_err());
    assert_eq!(s.doc(&a.id).unwrap().path, "p.md");
    assert_eq!(
        fs::read_to_string(s.root.join("p.md")).unwrap(),
        "Shared text of A\n"
    );
    // B's accepted edit stays recoverable by the owner.
    let recovery: String = s.db.lock().unwrap().query_row(
        "SELECT content FROM revisions WHERE doc=? AND kind='recovery' ORDER BY rowid DESC LIMIT 1",
        [&b.id], |row| row.get(0),
    ).unwrap();
    assert!(recovery.contains("Private edit of B"));
}

#[test]
fn two_names_linked_to_one_new_file_belong_to_neither_document() {
    let (_directory, s, a, b) = swap_fixture();
    // Both files are replaced by names for one new file. Neither document
    // can tell whose it is, and sharing it would publish B's edits on A's link.
    let new = s.root.join("new.tmp");
    fs::write(&new, "Notes in a new file\n").unwrap();
    for name in ["p.md", "r.md"] {
        fs::remove_file(s.root.join(name)).unwrap();
        fs::hard_link(&new, s.root.join(name)).unwrap();
    }
    fs::remove_file(&new).unwrap();
    s.discover_file_moves().unwrap();
    assert_eq!(
        shared_text(&s, "old-link").as_deref(),
        Some("Shared text of A\n")
    );
    s.retire_missing_documents().unwrap();
    assert!(s.doc(&a.id).is_err());
    assert!(s.doc(&b.id).is_err());
    assert!(shared_text(&s, "old-link").is_none());
    assert_eq!(
        fs::read_to_string(s.root.join("r.md")).unwrap(),
        "Notes in a new file\n"
    );
}

#[test]
fn a_link_never_opens_a_document_as_it_was_when_the_request_resolved_it() {
    let (_directory, s) = store();
    let document = s.create_document("Shared/page.md").unwrap();
    s.create_folder("Private").unwrap();
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
        .unwrap();
    let folder = Access {
        token: Some(token.into()),
        ..Access::default()
    };
    // open_shared resolves a document, then waits for that document's queue.
    // Meanwhile the owner moves it out of the shared folder.
    let grant = folders::grant(&s, token).unwrap();
    let resolved = folders::document(&s, &grant, Some(&document.id))
        .unwrap()
        .unwrap();
    s.rename_document(&document.id, "Private/page.md").unwrap();
    assert!(document_payload(&s, &HeaderMap::new(), &resolved, &folder).is_err());
    // Or turns its own link off.
    share(&s, &document.id);
    let resolved = shared_document(&s, "old-link").unwrap();
    share_document(
        &s,
        document.id.clone(),
        Share {
            permission: "private".into(),
            rotate: false,
        },
    )
    .unwrap();
    let link = Access {
        token: Some("old-link".into()),
        ..Access::default()
    };
    assert!(document_payload(&s, &HeaderMap::new(), &resolved, &link).is_err());
}

#[test]
fn an_unreadable_folder_keeps_no_link_alive_for_a_file_no_walk_can_find() {
    let (_directory, s) = store();
    let removed = s.create_document("removed.md").unwrap();
    share(&s, &removed.id);
    // As on a filesystem without birth times: nothing identifies the file.
    s.db.lock()
        .unwrap()
        .execute("DELETE FROM document_identities WHERE doc=?", [&removed.id])
        .unwrap();
    s.create_folder("Locked").unwrap();
    fs::remove_file(s.root.join("removed.md")).unwrap();
    let locked = s.root.join("Locked");
    let unreadable = move |path: &Path| {
        if path == locked {
            return Err(std::io::ErrorKind::PermissionDenied.into());
        }
        Ok(())
    };
    walking(unreadable.clone(), || s.retire_missing_documents()).unwrap();
    // Otherwise a new private file at its name would reopen the old link.
    fs::write(s.root.join("removed.md"), "New private notes\n").unwrap();
    walking(unreadable, || s.discover_file_moves()).unwrap();
    assert!(s.doc(&removed.id).is_err());
    assert!(shared_text(&s, "old-link").is_none());
    let notes = s.index_document("removed.md").unwrap();
    assert_ne!(notes.id, removed.id);
    assert_eq!(notes.permission, "private");
}

#[test]
fn a_second_name_in_a_shared_folder_never_opens_a_private_document() {
    let (_directory, s) = store();
    let private = s.create_document("Private/page.md").unwrap();
    fs::write(s.root.join("Private/page.md"), "Private text\n").unwrap();
    s.create_folder("Shared").unwrap();
    let shared = folders::share_folder(
        &s,
        serde_json::from_value(json!({"path": "Shared", "permission": "edit"})).unwrap(),
    )
    .unwrap();
    let token = shared["shareUrl"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap();
    fs::hard_link(
        s.root.join("Private/page.md"),
        s.root.join("Shared/page.md"),
    )
    .unwrap();
    let grant = folders::grant(&s, token).unwrap();
    // The second name is not listed as a document a visitor could open or edit.
    assert!(folders::entries(&s, &grant).unwrap().is_empty());
    assert!(folders::document(&s, &grant, Some(&private.id)).is_err());
    assert_eq!(s.doc(&private.id).unwrap().path, "Private/page.md");
}

#[test]
fn a_folder_link_stops_covering_a_document_moved_out_before_its_row_can_follow() {
    let (_directory, s) = store();
    let page = s.create_document("Shared/page.md").unwrap();
    let removed = s.create_document("Private/removed.md").unwrap();
    s.create_folder("Locked").unwrap();
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
    assert!(mcp_access::document_access(&s, &page).unwrap().mcp_allowed);
    // The owner removes one private file and moves the shared page into its
    // name. The removed document keeps that name while a folder is unreadable.
    fs::remove_file(s.root.join("Private/removed.md")).unwrap();
    fs::rename(
        s.root.join("Shared/page.md"),
        s.root.join("Private/removed.md"),
    )
    .unwrap();
    let locked = s.root.join("Locked");
    let generation = s.permissions.current();
    walking(
        move |path| {
            if path == locked {
                return Err(std::io::ErrorKind::PermissionDenied.into());
            }
            Ok(())
        },
        || s.retire_missing_documents(),
    )
    .unwrap();
    assert!(s.doc(&removed.id).is_ok());
    assert_ne!(
        s.permissions.current(),
        generation,
        "Open sockets recheck the folder grant before their next heartbeat"
    );
    let grant = folders::grant(&s, &token).unwrap();
    let visitor = Access {
        token: Some(token.clone()),
        ..Access::default()
    };
    let current = s.doc(&page.id).unwrap();
    assert!(s.access(&HeaderMap::new(), &current, &visitor).is_err());
    assert!(folders::document(&s, &grant, Some(&page.id)).is_err());
    assert!(
        !mcp_access::document_access(&s, &current)
            .unwrap()
            .mcp_allowed
    );
    // Once the folder can be read, the row follows the file.
    s.retire_missing_documents().unwrap();
    assert!(s.doc(&removed.id).is_err());
    let moved = s.doc(&page.id).unwrap();
    assert_eq!(moved.path, "Private/removed.md");
    assert!(s.access(&HeaderMap::new(), &moved, &visitor).is_err());
}

#[test]
fn a_symlink_at_a_shared_name_never_reaches_the_file_it_points_to() {
    let (_directory, s, a, _b) = swap_fixture();
    fs::remove_file(s.root.join("p.md")).unwrap();
    std::os::unix::fs::symlink(s.root.join("r.md"), s.root.join("p.md")).unwrap();
    s.discover_file_moves().unwrap();
    s.retire_missing_documents().unwrap();
    let room = s.room(&s.doc(&a.id).unwrap()).unwrap();
    assert!(!s.persist(&a, &mut room.lock().unwrap()).unwrap_or(false));
    assert_eq!(
        shared_text(&s, "old-link").as_deref(),
        Some("Shared text of A\n")
    );
    assert_eq!(
        fs::read_to_string(s.root.join("r.md")).unwrap(),
        "Private text of B\n"
    );
}

#[test]
fn a_followed_move_to_another_folder_never_approves_its_private_image() {
    let (_directory, s) = store();
    let page = s.create_document("Drafts/page.md").unwrap();
    s.create_folder("Private").unwrap();
    share(&s, &page.id);
    let png = BASE64.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFlsAAAAASUVORK5CYII=").unwrap();
    fs::write(s.root.join("Drafts/image.png"), &png).unwrap();
    fs::write(s.root.join("Private/image.png"), &png).unwrap();
    fs::write(s.root.join("Drafts/page.md"), "![image](image.png)\n").unwrap();
    s.room(&page).unwrap();
    let guest = Media {
        path: "image.png".into(),
        token: Some("old-link".into()),
    };
    assert!(media_file(&s, &page.id, &guest, &HeaderMap::new()).is_ok());
    // A desktop move, followed from file evidence rather than renamed here.
    fs::rename(
        s.root.join("Drafts/page.md"),
        s.root.join("Private/page.md"),
    )
    .unwrap();
    s.discover_file_moves().unwrap();
    assert_eq!(s.doc(&page.id).unwrap().path, "Private/page.md");
    assert!(media_file(&s, &page.id, &guest, &HeaderMap::new()).is_err());
}

#[test]
fn a_file_moved_into_a_hidden_folder_leaves_with_its_link() {
    let (_directory, s) = store();
    let page = s.create_document("Shared/page.md").unwrap();
    share(&s, &page.id);
    fs::create_dir(s.root.join("Shared/.archive")).unwrap();
    fs::rename(
        s.root.join("Shared/page.md"),
        s.root.join("Shared/.archive/page.md"),
    )
    .unwrap();
    s.discover_file_moves().unwrap();
    assert!(s.index_document("Shared/.archive/page.md").is_err());
    s.retire_missing_documents().unwrap();
    assert!(s.doc(&page.id).is_err());
    assert!(shared_text(&s, "old-link").is_none());
}

#[test]
fn a_busy_move_within_a_shared_folder_keeps_its_visitors() {
    let (_directory, s) = store();
    let page = s.create_document("Shared/page.md").unwrap();
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
        .unwrap();
    let visitor = Access {
        token: Some(token.into()),
        ..Access::default()
    };
    let room = s.room(&page).unwrap();
    let busy = room.lock().unwrap();
    fs::rename(
        s.root.join("Shared/page.md"),
        s.root.join("Shared/renamed.md"),
    )
    .unwrap();
    s.discover_file_moves().unwrap();
    let current = s.doc(&page.id).unwrap();
    assert_eq!(current.path, "Shared/page.md");
    assert_eq!(
        s.found_elsewhere(&page.id).as_deref(),
        Some("Shared/renamed.md")
    );
    assert!(s.access(&HeaderMap::new(), &current, &visitor).is_ok());
    drop(busy);
    s.discover_file_moves().unwrap();
    let moved = s.doc(&page.id).unwrap();
    assert_eq!(moved.path, "Shared/renamed.md");
    assert!(s.found_elsewhere(&page.id).is_none());
    assert!(s.access(&HeaderMap::new(), &moved, &visitor).is_ok());
}

const PNG: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFlsAAAAASUVORK5CYII=";

/// A shared page showing an image beside it, approved by the desktop file,
/// and an upload its editor embedded. Returns the upload's reference.
fn album() -> (tempfile::TempDir, App, Document, String) {
    let (directory, s) = store();
    let page = s.create_document("Album/page.md").unwrap();
    share(&s, &page.id);
    let png = BASE64.decode(PNG).unwrap();
    fs::write(s.root.join("Album/photo.png"), &png).unwrap();
    fs::write(s.root.join("Album/page.md"), "![photo](photo.png)\n").unwrap();
    let room = s.room(&page).unwrap();
    let upload = format!(".assets/{}/upload.png", page.id);
    s.write_upload(&page, &upload, &png).unwrap();
    let embed = append_frame(&room, &format!("![upload](../{upload})\n"));
    process_frame(&s, &page, &room, &embed, true, true, &mut Peer::default()).unwrap();
    assert!(s.persist(&page, &mut room.lock().unwrap()).unwrap());
    (directory, s, page, format!("../{upload}"))
}

/// What a visitor with the page's link gets for one of its media references.
fn guest_media(s: &Store, page: &Document, path: &str) -> StatusCode {
    let request = Media {
        path: path.into(),
        token: Some("old-link".into()),
    };
    match media_file(s, &page.id, &request, &HeaderMap::new()) {
        Ok(_) => StatusCode::OK,
        Err(error) => error.0,
    }
}

#[test]
fn approved_images_and_uploads_follow_a_folder_moved_with_its_document() {
    let (_directory, s, page, upload) = album();
    assert_eq!(guest_media(&s, &page, "photo.png"), StatusCode::OK);
    assert_eq!(guest_media(&s, &page, &upload), StatusCode::OK);
    // The approval used to be pinned to Album/photo.png, which no longer
    // exists, so the moved page showed every approved image as forbidden.
    fs::rename(s.root.join("Album"), s.root.join("Trip")).unwrap();
    s.discover_file_moves().unwrap();
    assert_eq!(s.doc(&page.id).unwrap().path, "Trip/page.md");
    assert_eq!(guest_media(&s, &page, "photo.png"), StatusCode::OK);
    assert_eq!(guest_media(&s, &page, &upload), StatusCode::OK);
}

#[test]
fn approved_images_follow_a_folder_moved_while_locdoc_was_stopped() {
    let (_directory, s, page, upload) = album();
    // The old folder is gone before any pass can resolve approvals there.
    let s = stopped(s, |root| {
        fs::rename(root.join("Album"), root.join("Trip")).unwrap();
    });
    assert_eq!(s.doc(&page.id).unwrap().path, "Trip/page.md");
    assert_eq!(guest_media(&s, &page, "photo.png"), StatusCode::OK);
    assert_eq!(guest_media(&s, &page, &upload), StatusCode::OK);
}

#[test]
fn a_locdoc_move_keeps_an_approved_image_that_moved_ahead_of_it() {
    let (_directory, s, page, _upload) = album();
    s.create_folder("Trip").unwrap();
    fs::rename(
        s.root.join("Album/photo.png"),
        s.root.join("Trip/photo.png"),
    )
    .unwrap();
    s.rename_document(&page.id, "Trip/page.md").unwrap();
    assert_eq!(guest_media(&s, &page, "photo.png"), StatusCode::OK);
}

#[test]
fn approvals_recorded_before_file_identities_are_identified_before_a_move() {
    let (_directory, s, page, _upload) = album();
    // As in a database written before approvals recorded their files.
    s.db.lock()
        .unwrap()
        .execute_batch("ALTER TABLE trusted_references DROP COLUMN identity")
        .unwrap();
    let s = reopen(s);
    fs::rename(s.root.join("Album"), s.root.join("Trip")).unwrap();
    s.discover_file_moves().unwrap();
    assert_eq!(s.doc(&page.id).unwrap().path, "Trip/page.md");
    assert_eq!(guest_media(&s, &page, "photo.png"), StatusCode::OK);
}

#[test]
fn a_move_never_approves_another_image_that_has_the_approved_spelling() {
    let (_directory, s) = store();
    let png = BASE64.decode(PNG).unwrap();
    // A folder moved with its page, but its cover lives in the parent.
    let page = s.create_document("Projects/Album/page.md").unwrap();
    share(&s, &page.id);
    fs::write(s.root.join("Projects/cover.png"), &png).unwrap();
    fs::write(
        s.root.join("Projects/Album/page.md"),
        "![cover](../cover.png)\n",
    )
    .unwrap();
    s.room(&page).unwrap();
    assert_eq!(guest_media(&s, &page, "../cover.png"), StatusCode::OK);
    // The destination already has a private image with identical bytes.
    s.create_folder("Private").unwrap();
    fs::write(s.root.join("Private/cover.png"), &png).unwrap();
    fs::rename(s.root.join("Projects/Album"), s.root.join("Private/Album")).unwrap();
    s.discover_file_moves().unwrap();
    let moved = s.doc(&page.id).unwrap();
    assert_eq!(moved.path, "Private/Album/page.md");
    assert_eq!(
        guest_media(&s, &page, "../cover.png"),
        StatusCode::FORBIDDEN
    );
    // The approved cover itself stays approved where it is.
    assert!(s.attachment_allowed(&moved, &s.root.join("Projects/cover.png")));
    // A page moved alone next to such an image is no different.
    let alone = s.create_document("Drafts/page.md").unwrap();
    share_link(&s, &alone.id, "alone-link");
    fs::write(s.root.join("Drafts/photo.png"), &png).unwrap();
    fs::write(s.root.join("Drafts/page.md"), "![photo](photo.png)\n").unwrap();
    s.room(&alone).unwrap();
    fs::write(s.root.join("Private/photo.png"), &png).unwrap();
    s.rename_document(&alone.id, "Private/page.md").unwrap();
    let request = Media {
        path: "photo.png".into(),
        token: Some("alone-link".into()),
    };
    assert_eq!(
        media_file(&s, &alone.id, &request, &HeaderMap::new())
            .unwrap_err()
            .0,
        StatusCode::FORBIDDEN
    );
    assert!(s.attachment_allowed(&s.doc(&alone.id).unwrap(), &s.root.join("Drafts/photo.png")));
}

#[test]
fn an_image_edited_in_place_stays_approved_before_and_after_moves() {
    let (_directory, s, page, _upload) = album();
    let png = BASE64.decode(PNG).unwrap();
    // An image editor saves by renaming a new file over the old one.
    let save = |folder: &str| {
        let temporary = s.root.join(folder).join("photo.png.tmp");
        fs::write(&temporary, &png).unwrap();
        fs::rename(&temporary, s.root.join(folder).join("photo.png")).unwrap();
    };
    save("Album");
    assert_eq!(guest_media(&s, &page, "photo.png"), StatusCode::OK);
    // The watcher runs a pass after that rename, which sees the new file.
    s.discover_file_moves().unwrap();
    fs::rename(s.root.join("Album"), s.root.join("Trip")).unwrap();
    s.discover_file_moves().unwrap();
    assert_eq!(guest_media(&s, &page, "photo.png"), StatusCode::OK);
    save("Trip");
    assert_eq!(guest_media(&s, &page, "photo.png"), StatusCode::OK);
    // Without a pass, the owner's editor loading the image records it.
    let mut owner = HeaderMap::new();
    owner.insert(
        header::AUTHORIZATION,
        format!("Bearer {}", s.key).parse().unwrap(),
    );
    let request = Media {
        path: "photo.png".into(),
        token: None,
    };
    media_file(&s, &page.id, &request, &owner).unwrap();
    fs::rename(s.root.join("Trip"), s.root.join("Final")).unwrap();
    s.discover_file_moves().unwrap();
    assert_eq!(s.doc(&page.id).unwrap().path, "Final/page.md");
    assert_eq!(guest_media(&s, &page, "photo.png"), StatusCode::OK);
}

#[test]
fn a_hard_link_at_the_destination_never_carries_an_image_approval_along() {
    let (_directory, s, page, _upload) = album();
    let png = BASE64.decode(PNG).unwrap();
    // A second name for the approved image waits in a private folder.
    s.create_folder("Private").unwrap();
    fs::hard_link(
        s.root.join("Album/photo.png"),
        s.root.join("Private/photo.png"),
    )
    .unwrap();
    s.rename_document(&page.id, "Private/page.md").unwrap();
    // The image stayed behind, so a later private image at that name was
    // served as approved.
    let temporary = s.root.join("Private/photo.png.tmp");
    fs::write(&temporary, &png).unwrap();
    fs::rename(&temporary, s.root.join("Private/photo.png")).unwrap();
    assert_eq!(guest_media(&s, &page, "photo.png"), StatusCode::FORBIDDEN);
    let moved = s.doc(&page.id).unwrap();
    assert!(s.attachment_allowed(&moved, &s.root.join("Album/photo.png")));
}

#[test]
fn a_symlink_at_the_destination_never_carries_an_image_approval_along() {
    let (_directory, s, page, _upload) = album();
    let png = BASE64.decode(PNG).unwrap();
    s.create_folder("Private").unwrap();
    fs::write(s.root.join("Private/secret.png"), &png).unwrap();
    let link = s.root.join("Private/photo.png");
    std::os::unix::fs::symlink("../Album/photo.png", &link).unwrap();
    fs::rename(s.root.join("Album/page.md"), s.root.join("Private/page.md")).unwrap();
    s.discover_file_moves().unwrap();
    assert_eq!(s.doc(&page.id).unwrap().path, "Private/page.md");
    // Through the link the reference still names the approved image.
    assert_eq!(guest_media(&s, &page, "photo.png"), StatusCode::OK);
    // Pointing the link at a private image never approves that image.
    fs::remove_file(&link).unwrap();
    std::os::unix::fs::symlink("secret.png", &link).unwrap();
    assert_eq!(guest_media(&s, &page, "photo.png"), StatusCode::FORBIDDEN);
}

/// The page's (grants, trusted references) rows.
fn approval_rows(s: &Store, page: &Document) -> (i64, i64) {
    let db = s.db.lock().unwrap();
    let count = |table: &str| {
        db.query_row(
            &format!("SELECT count(*) FROM {table} WHERE doc=?"),
            [&page.id],
            |row| row.get(0),
        )
        .unwrap()
    };
    (count("grants"), count("trusted_references"))
}

#[test]
fn a_pinned_grant_follows_its_image_when_the_image_later_moves_after_its_page() {
    let (_directory, s, page, upload) = album();
    s.create_folder("Trip").unwrap();
    // A Locdoc move leaves the image behind and pins its approval there.
    s.rename_document(&page.id, "Trip/page.md").unwrap();
    assert_eq!(approval_rows(&s, &page), (1, 0));
    assert_eq!(guest_media(&s, &page, "photo.png"), StatusCode::NOT_FOUND);
    // Later the image follows its page. The grant stayed pinned to the
    // old path, so the owner saw the image and link visitors got 403.
    fs::rename(
        s.root.join("Album/photo.png"),
        s.root.join("Trip/photo.png"),
    )
    .unwrap();
    assert_eq!(guest_media(&s, &page, "photo.png"), StatusCode::OK);
    // A pass makes the approval relative again, so it moves with the page.
    s.discover_file_moves().unwrap();
    assert_eq!(approval_rows(&s, &page), (0, 1));
    assert_eq!(guest_media(&s, &page, "photo.png"), StatusCode::OK);
    fs::rename(s.root.join("Trip"), s.root.join("Final")).unwrap();
    s.discover_file_moves().unwrap();
    assert_eq!(s.doc(&page.id).unwrap().path, "Final/page.md");
    assert_eq!(guest_media(&s, &page, "photo.png"), StatusCode::OK);
    assert_eq!(guest_media(&s, &page, &upload), StatusCode::OK);
    // A file that later takes the old pinned name stays private.
    let png = BASE64.decode(PNG).unwrap();
    fs::write(s.root.join("Album/photo.png"), &png).unwrap();
    let moved = s.doc(&page.id).unwrap();
    assert!(!s.attachment_allowed(&moved, &s.root.join("Album/photo.png")));
}

#[test]
fn a_pinned_grant_keeps_following_its_image_after_locdoc_moves_the_image_folder() {
    let (_directory, s, page, _upload) = album();
    s.create_folder("Trip").unwrap();
    s.rename_document(&page.id, "Trip/page.md").unwrap();
    assert_eq!(approval_rows(&s, &page), (1, 0));
    // The folder the image stayed in moves through Locdoc. Its pinned
    // grant moves along and must still know which file it approved.
    s.rename_folder("Album", "Pictures").unwrap();
    assert_eq!(approval_rows(&s, &page), (1, 0));
    let identity: Option<String> =
        s.db.lock()
            .unwrap()
            .query_row(
                "SELECT identity FROM grants WHERE doc=?",
                [&page.id],
                |row| row.get(0),
            )
            .unwrap();
    assert!(
        identity.is_some(),
        "a rebased grant keeps its file identity"
    );
    // The image later follows its page: link visitors keep seeing it.
    fs::rename(
        s.root.join("Pictures/photo.png"),
        s.root.join("Trip/photo.png"),
    )
    .unwrap();
    assert_eq!(guest_media(&s, &page, "photo.png"), StatusCode::OK);
    s.discover_file_moves().unwrap();
    assert_eq!(approval_rows(&s, &page), (0, 1));
    assert_eq!(guest_media(&s, &page, "photo.png"), StatusCode::OK);
}

#[test]
fn a_pinned_grant_never_follows_a_second_name_of_an_image_still_in_place() {
    let (_directory, s, page, _upload) = album();
    s.create_folder("Trip").unwrap();
    s.rename_document(&page.id, "Trip/page.md").unwrap();
    fs::hard_link(
        s.root.join("Album/photo.png"),
        s.root.join("Trip/photo.png"),
    )
    .unwrap();
    assert_eq!(guest_media(&s, &page, "photo.png"), StatusCode::FORBIDDEN);
    s.discover_file_moves().unwrap();
    assert_eq!(approval_rows(&s, &page), (1, 0));
    assert_eq!(guest_media(&s, &page, "photo.png"), StatusCode::FORBIDDEN);
    // A symlink left at the old name is not the image staying there.
    fs::remove_file(s.root.join("Album/photo.png")).unwrap();
    std::os::unix::fs::symlink("../Trip/photo.png", s.root.join("Album/photo.png")).unwrap();
    assert_eq!(guest_media(&s, &page, "photo.png"), StatusCode::OK);
    s.discover_file_moves().unwrap();
    assert_eq!(approval_rows(&s, &page), (0, 1));
}

#[test]
fn a_grant_pinned_by_an_older_version_follows_once_a_pass_has_seen_its_image() {
    let (_directory, s, page, _upload) = album();
    s.create_folder("Trip").unwrap();
    s.rename_document(&page.id, "Trip/page.md").unwrap();
    // As in a database written before grants recorded their files.
    s.db.lock()
        .unwrap()
        .execute_batch("ALTER TABLE grants DROP COLUMN identity")
        .unwrap();
    let s = reopen(s);
    assert_eq!(approval_rows(&s, &page), (1, 0));
    fs::rename(
        s.root.join("Album/photo.png"),
        s.root.join("Trip/photo.png"),
    )
    .unwrap();
    s.discover_file_moves().unwrap();
    assert_eq!(guest_media(&s, &page, "photo.png"), StatusCode::OK);
    assert_eq!(approval_rows(&s, &page), (0, 1));
}

/// A walk hook under which the root's Locked folder cannot be listed.
fn locked(s: &Store) -> impl Fn(&Path) -> std::io::Result<()> + Clone + 'static {
    let locked = s.root.join("Locked");
    move |path| {
        if path == locked {
            return Err(std::io::ErrorKind::PermissionDenied.into());
        }
        Ok(())
    }
}

#[test]
fn a_document_held_by_an_unreadable_folder_never_adopts_a_later_file_at_its_name() {
    let (_directory, s) = store();
    let removed = s.create_document("removed.md").unwrap();
    share(&s, &removed.id);
    let room = s.room(&removed).unwrap();
    s.persist(&removed, &mut room.lock().unwrap()).unwrap();
    drop(room);
    s.create_folder("Locked").unwrap();
    fs::remove_file(s.root.join("removed.md")).unwrap();
    // A pass sees its name empty; the unlisted folder keeps the document.
    clock_offset(-10, || walking(locked(&s), || s.retire_missing_documents())).unwrap();
    assert!(s.doc(&removed.id).is_ok());
    // Long after the settle window, an unrelated private file takes the
    // name. Path continuity used to hand it the old link.
    fs::write(s.root.join("removed.md"), "New private notes\n").unwrap();
    walking(locked(&s), || {
        s.discover_file_moves().unwrap();
        s.retire_missing_documents().unwrap();
        assert_eq!(
            s.index_document("removed.md").unwrap_err().0,
            StatusCode::SERVICE_UNAVAILABLE
        );
    });
    assert_eq!(
        shared_text(&s, "old-link").as_deref(),
        Some("# removed\n\n")
    );
    // The first complete walk retires it; the file is a new document.
    s.retire_missing_documents().unwrap();
    assert!(s.doc(&removed.id).is_err());
    assert!(shared_text(&s, "old-link").is_none());
    let notes = s.index_document("removed.md").unwrap();
    assert_ne!(notes.id, removed.id);
    assert_eq!(notes.permission, "private");
    assert_eq!(
        fs::read_to_string(s.root.join("removed.md")).unwrap(),
        "New private notes\n"
    );
}

#[test]
fn a_non_atomic_save_keeps_its_document_when_a_pass_saw_its_name_empty() {
    let (_directory, s) = store();
    let page = s.create_document("page.md").unwrap();
    share(&s, &page.id);
    s.create_folder("Locked").unwrap();
    // The editor removes the file and writes a new one; a pass runs between.
    fs::remove_file(s.root.join("page.md")).unwrap();
    walking(locked(&s), || s.retire_missing_documents()).unwrap();
    fs::write(s.root.join("page.md"), "Saved without a rename\n").unwrap();
    // The next pass may come well after the settle window.
    clock_offset(10, || walking(locked(&s), || s.retire_missing_documents())).unwrap();
    s.retire_missing_documents().unwrap();
    let kept = s.doc(&page.id).unwrap();
    assert_eq!(kept.path, "page.md");
    assert_eq!(
        shared_text(&s, "old-link").as_deref(),
        Some("Saved without a rename\n")
    );
    assert_eq!(s.index_document("page.md").unwrap().id, page.id);
}

#[test]
fn an_atomic_save_keeps_its_document_after_its_file_came_back() {
    let (_directory, s) = store();
    let page = s.create_document("page.md").unwrap();
    share(&s, &page.id);
    s.create_folder("Locked").unwrap();
    // Its file is away while a pass looks, then returns unchanged.
    fs::rename(s.root.join("page.md"), s.root.join("page.away")).unwrap();
    clock_offset(-10, || walking(locked(&s), || s.retire_missing_documents())).unwrap();
    fs::rename(s.root.join("page.away"), s.root.join("page.md")).unwrap();
    walking(locked(&s), || s.discover_file_moves()).unwrap();
    // A later atomic save replaces the inode with no gap in between.
    let temporary = s.root.join("page.md.tmp");
    fs::write(&temporary, "Saved by a rename\n").unwrap();
    fs::rename(&temporary, s.root.join("page.md")).unwrap();
    walking(locked(&s), || s.retire_missing_documents()).unwrap();
    s.retire_missing_documents().unwrap();
    assert_eq!(s.doc(&page.id).unwrap().path, "page.md");
    assert_eq!(
        shared_text(&s, "old-link").as_deref(),
        Some("Saved by a rename\n")
    );
}

/// Log lines written while a test runs on this thread.
#[derive(Clone, Default)]
struct Logs(Arc<Mutex<Vec<u8>>>);
impl std::io::Write for Logs {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
impl Logs {
    fn capture<T>(&self, body: impl FnOnce() -> T) -> T {
        let logs = self.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(move || logs.clone())
            .with_ansi(false)
            .finish();
        tracing::subscriber::with_default(subscriber, body)
    }
    fn count(&self, text: &str) -> usize {
        String::from_utf8_lossy(&self.0.lock().unwrap())
            .matches(text)
            .count()
    }
}

#[test]
fn an_unreadable_subfolder_never_hides_the_rest_of_the_listing() {
    use std::os::unix::fs::PermissionsExt;
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let (_directory, s) = store();
    s.create_document("page.md").unwrap();
    s.create_document("Locked/hidden.md").unwrap();
    let locked = s.root.join("Locked");
    let list = || -> Result<Vec<String>> {
        let mut entries = Vec::new();
        scan(&s, &s.root, &mut entries)?;
        Ok(entries.into_iter().map(|entry| entry.path).collect())
    };
    let logs = Logs::default();
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
    let polls = logs.capture(|| (0..3).map(|_| list()).collect::<Vec<_>>());
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).unwrap();
    for listed in polls {
        assert_eq!(listed.unwrap(), ["Locked", "page.md"]);
    }
    assert_eq!(
        logs.count("listing leaves out"),
        1,
        "One unreadable folder is logged once, not on every poll"
    );
    assert_eq!(list().unwrap(), ["Locked", "Locked/hidden.md", "page.md"]);
    // Once read again, a later failure is reported again.
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
    let listed = logs.capture(list);
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(listed.unwrap(), ["Locked", "page.md"]);
    assert_eq!(logs.count("listing leaves out"), 2);
}

#[test]
fn a_rename_into_an_unreadable_folder_ends_and_blocks_nothing() {
    use std::os::unix::fs::PermissionsExt;
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let (_directory, s) = store();
    let page = s.create_document("page.md").unwrap();
    s.create_folder("Locked").unwrap();
    let locked = s.root.join("Locked");
    // The sidebar lists the folder, but its entries cannot be reached.
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
    let renamed = s.rename_document(&page.id, "Locked/page.md");
    let pending = pending_moves(&s);
    let mut entries = Vec::new();
    let listed = scan(&s, &s.root, &mut entries);
    let opened = s.room(&page).map(|_| ());
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(renamed.is_err());
    // The file never left its name, yet its intent stayed pending, which
    // failed every listing and kept the document from opening.
    assert_eq!(pending, 0);
    listed.unwrap();
    assert!(
        entries
            .iter()
            .any(|entry| entry.id.as_deref() == Some(page.id.as_str()))
    );
    opened.unwrap();
    assert_eq!(s.doc(&page.id).unwrap().path, "page.md");
}

#[test]
fn listings_never_walk_the_tree_while_an_unreadable_folder_holds_a_document() {
    let (directory, s, a, b) = swap_fixture();
    s.create_folder("Locked").unwrap();
    // A's file leaves the root and B's file takes A's name. B cannot take
    // that name until a complete walk retires A.
    fs::rename(s.root.join("p.md"), directory.path().join("outside.md")).unwrap();
    fs::rename(s.root.join("r.md"), s.root.join("p.md")).unwrap();
    let walks = std::rc::Rc::new(std::cell::Cell::new(0));
    let (root, counted, unreadable) = (s.root.clone(), walks.clone(), locked(&s));
    s.reconciliation.take();
    walking(
        move |path| {
            if path == root {
                counted.set(counted.get() + 1);
            }
            unreadable(path)
        },
        || {
            s.retire_missing_documents().unwrap();
            let held = s.reconciliation.take().unwrap();
            let before = walks.get();
            // Tabs, including folder-link visitors, poll every few seconds.
            for _ in 0..5 {
                let mut entries = Vec::new();
                scan(&s, &s.root, &mut entries).unwrap();
                assert!(entries.iter().all(|entry| entry.id.is_none()));
            }
            assert_eq!(walks.get(), before, "A listing must never walk the tree");
            assert!(
                s.reconciliation.take().is_none_or(|next| next >= held),
                "Listings must not bring the next walk forward"
            );
        },
    );
    assert_eq!(s.doc(&a.id).unwrap().path, "p.md");
    assert_eq!(s.doc(&b.id).unwrap().path, "r.md");
    s.retire_missing_documents().unwrap();
    assert!(s.doc(&a.id).is_err());
    assert_eq!(s.doc(&b.id).unwrap().path, "p.md");
}

#[test]
fn saves_of_a_new_file_at_a_held_documents_name_never_walk_the_tree_or_hasten_its_retry() {
    let (_directory, s) = store();
    let removed = s.create_document("removed.md").unwrap();
    let page = s.create_document("page.md").unwrap();
    share(&s, &removed.id);
    let room = s.room(&removed).unwrap();
    s.persist(&removed, &mut room.lock().unwrap()).unwrap();
    drop(room);
    s.create_folder("Locked").unwrap();
    fs::remove_file(s.root.join("removed.md")).unwrap();
    clock_offset(-10, || walking(locked(&s), || s.retire_missing_documents())).unwrap();
    // A desktop editor keeps saving a new file at the held document's name.
    fs::write(s.root.join("removed.md"), "New private notes\n").unwrap();
    let walks = std::rc::Rc::new(std::cell::Cell::new(0));
    let (root, counted, unreadable) = (s.root.clone(), walks.clone(), locked(&s));
    s.reconciliation.take();
    walking(
        move |path| {
            if path == root {
                counted.set(counted.get() + 1);
            }
            unreadable(path)
        },
        || {
            s.retire_missing_documents().unwrap();
            let held = s.reconciliation.take().unwrap();
            let before = walks.get();
            // The watcher indexes the file after each of its saves.
            for _ in 0..5 {
                assert_eq!(
                    s.index_document("removed.md").unwrap_err().0,
                    StatusCode::SERVICE_UNAVAILABLE
                );
            }
            assert_eq!(walks.get(), before, "A save there must never walk the tree");
            assert!(
                s.reconciliation.take().is_none_or(|next| next >= held),
                "Saves there must not bring the next walk forward"
            );
            // An atomic save of another document is still recorded at once.
            let temporary = s.root.join("page.md.tmp");
            fs::write(&temporary, "Saved by a rename\n").unwrap();
            fs::rename(&temporary, s.root.join("page.md")).unwrap();
            assert_eq!(s.index_document("page.md").unwrap().id, page.id);
        },
    );
    assert_eq!(
        shared_text(&s, "old-link").as_deref(),
        Some("# removed\n\n")
    );
    s.retire_missing_documents().unwrap();
    assert!(s.doc(&removed.id).is_err());
    assert_ne!(s.index_document("removed.md").unwrap().id, removed.id);
}

#[test]
fn another_documents_file_moved_onto_a_held_name_is_found_at_once_without_hastening_the_retry() {
    let (directory, s, a, b) = swap_fixture();
    s.create_folder("Locked").unwrap();
    // A's file leaves the root, and long after a pass held A, B's file
    // takes A's name.
    fs::rename(s.root.join("p.md"), directory.path().join("outside.md")).unwrap();
    s.reconciliation.take();
    clock_offset(-10, || walking(locked(&s), || s.retire_missing_documents())).unwrap();
    let held = s.reconciliation.take().unwrap();
    fs::rename(s.root.join("r.md"), s.root.join("p.md")).unwrap();
    walking(locked(&s), || {
        // The watcher's pass for the move finds B where A keeps its name,
        // so B's folder grants are checked against it now.
        assert_eq!(
            s.index_document("p.md").unwrap_err().0,
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(s.found_elsewhere(&b.id).as_deref(), Some("p.md"));
        assert!(
            s.reconciliation.take().is_none_or(|next| next >= held),
            "A save must not bring the next walk forward"
        );
    });
    assert_eq!(s.doc(&a.id).unwrap().path, "p.md");
    s.retire_missing_documents().unwrap();
    assert!(s.doc(&a.id).is_err());
    assert_eq!(s.doc(&b.id).unwrap().path, "p.md");
}

#[test]
fn a_document_whose_folder_became_a_file_retires() {
    let (_dir, s) = store();
    let doc = s.create_document("Notes/note.md").unwrap();
    share(&s, &doc.id);
    fs::remove_dir_all(s.root.join("Notes")).unwrap();
    fs::write(s.root.join("Notes"), "Not a folder\n").unwrap();
    s.retire_missing_documents().unwrap();
    assert!(s.doc(&doc.id).is_err(), "no file can be at its path");
}
