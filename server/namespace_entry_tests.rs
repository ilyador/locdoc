//! Folder moves, deletes into Locdoc's trash and restores. Documents keep
//! their identity, links and history through each, also when Locdoc stops
//! at any step between the journal and the commit.
use super::*;
use crate::documents::tests::{append_frame, share, store};

fn reopen(s: App) -> App {
    let root = s.root.clone();
    let data = s.data.clone();
    drop(s);
    Store::open(root, data, "http://localhost".into()).unwrap()
}

/// Paths the owner's sidebar lists.
fn listed(s: &Store) -> Vec<String> {
    let mut entries = Vec::new();
    scan(s, &s.root, &mut entries).unwrap();
    entries.into_iter().map(|entry| entry.path).collect()
}

fn journaled(s: &Store) -> i64 {
    s.db.lock()
        .unwrap()
        .query_row("SELECT count(*) FROM entry_moves", [], |row| row.get(0))
        .unwrap()
}

fn trash_items(s: &Store) -> Vec<(String, String, String)> {
    s.db.lock()
        .unwrap()
        .prepare("SELECT id,kind,path FROM trash ORDER BY deleted,rowid")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<std::result::Result<_, _>>()
        .unwrap()
}

fn active(s: &Store, id: &str) -> i64 {
    s.db.lock()
        .unwrap()
        .query_row("SELECT active FROM docs WHERE id=?", [id], |row| row.get(0))
        .unwrap()
}

fn versions(s: &Store, id: &str, content: &str) -> i64 {
    s.db.lock()
        .unwrap()
        .query_row(
            "SELECT count(*) FROM revisions WHERE doc=? AND content=?",
            [id, content],
            |row| row.get(0),
        )
        .unwrap()
}

/// The accepted text durable state holds, as Removed document recovery
/// rebuilds it.
fn durable_text(s: &Store, id: &str) -> String {
    let doc = Doc::with_options(Options {
        offset_kind: OffsetKind::Utf16,
        ..Options::default()
    });
    let db = s.db.lock().unwrap();
    let state: Vec<u8> = db
        .query_row("SELECT state FROM docs WHERE id=?", [id], |row| row.get(0))
        .unwrap();
    let mut parts = vec![state];
    parts.extend(
        db.prepare("SELECT content FROM doc_updates WHERE doc=? ORDER BY seq")
            .unwrap()
            .query_map([id], |row| row.get::<_, Vec<u8>>(0))
            .unwrap()
            .map(std::result::Result::unwrap),
    );
    for part in parts {
        doc.transact_mut()
            .apply_update(security::decode_update(&part).unwrap())
            .unwrap();
    }
    doc.get_or_insert_text("content")
        .get_string(&doc.transact())
}

fn folder_link(s: &Store, path: &str) -> String {
    let shared = folders::share_folder(
        s,
        serde_json::from_value(json!({"path": path, "permission": "view"})).unwrap(),
    )
    .unwrap();
    shared["shareUrl"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap()
        .to_owned()
}

fn allow_mcp_folder(s: &Store, path: &str) {
    let identity = folders::directory_identity(s, path).unwrap();
    s.db.lock()
        .unwrap()
        .execute(
            "INSERT INTO mcp_folders(path,identity) VALUES(?,?)",
            params![path, identity],
        )
        .unwrap();
}

/// Accept an edit from a browser without projecting it.
fn accept(s: &Store, document: &Document, text: &str) -> Arc<Mutex<Room>> {
    let room = s.room(document).unwrap();
    let frame = append_frame(&room, text);
    process_frame(s, document, &room, &frame, true, true, &mut Peer::default()).unwrap();
    room
}

/// Journal a move as the operation does before its filesystem step.
fn journal(
    s: &Store,
    (id, action, entry, document): (&str, Action, EntryKind, Option<&str>),
    source: &str,
    destination: &str,
) {
    let metadata = fs::symlink_metadata(s.safe(source, true).unwrap()).unwrap();
    let movement = EntryMove::new(
        id.into(),
        action,
        entry,
        document.map(Into::into),
        (source.into(), destination.into()),
        &metadata,
    );
    s.journal_entry(&movement).unwrap();
}

/// Stop after `stage` steps of a journaled move: 0 journaled only, 1 also
/// renamed, 2 also synced.
fn interrupt(s: &Store, stage: usize, source: &str, destination: &str) {
    let (source, destination) = (s.root.join(source), s.root.join(destination));
    if stage >= 1 {
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        disk::rename_new(&source, &destination).unwrap();
    }
    if stage >= 2 {
        disk::sync_directories(destination.parent().unwrap(), &s.root).unwrap();
        disk::sync_directories(source.parent().unwrap(), &s.root).unwrap();
    }
}

#[test]
fn a_folder_move_keeps_its_documents_links_history_and_grants() {
    let (_directory, s) = store();
    let page = s.create_document("Drafts/page.md").unwrap();
    let note = s.create_document("Drafts/Nested/note.fountain").unwrap();
    s.create_folder("Archive").unwrap();
    share(&s, &page.id);
    s.snapshot(&page, "Earlier text", true).unwrap();
    let folder = folder_link(&s, "Drafts");
    let nested = folder_link(&s, "Drafts/Nested");
    allow_mcp_folder(&s, "Drafts/Nested");
    assert_eq!(
        s.rename_folder("./Drafts/", "Archive/Kept").unwrap(),
        "Archive/Kept"
    );
    assert!(!s.root.join("Drafts").exists());
    let moved = s.doc(&page.id).unwrap();
    assert_eq!(moved.path, "Archive/Kept/page.md");
    assert_eq!(moved.token.as_deref(), Some("old-link"));
    assert_eq!(
        s.doc(&note.id).unwrap().path,
        "Archive/Kept/Nested/note.fountain"
    );
    assert_eq!(
        fs::read_to_string(s.root.join("Archive/Kept/page.md")).unwrap(),
        "# page\n\n"
    );
    assert_eq!(versions(&s, &page.id, "Earlier text"), 1);
    assert_eq!(shared_document(&s, "old-link").unwrap().id, page.id);
    let grant = folders::grant(&s, &folder).unwrap();
    assert_eq!(grant.path, "Archive/Kept");
    assert!(grant.holds(&s, &s.doc(&note.id).unwrap()));
    assert_eq!(
        folders::grant(&s, &nested).unwrap().path,
        "Archive/Kept/Nested"
    );
    assert!(
        mcp_access::folder_access(&s, "Archive/Kept/Nested")
            .unwrap()
            .mcp_direct
    );
    assert!(
        mcp_access::document_access(&s, &s.doc(&note.id).unwrap())
            .unwrap()
            .mcp_inherited
    );
    assert_eq!(journaled(&s), 0);
    // Passes agree with the commit; nothing moves or retires again.
    s.retire_missing_documents().unwrap();
    assert_eq!(s.doc(&page.id).unwrap().path, "Archive/Kept/page.md");
    assert_eq!(
        s.index_document("Archive/Kept/page.md").unwrap().id,
        page.id
    );
    let s = reopen(s);
    assert_eq!(
        s.doc(&note.id).unwrap().path,
        "Archive/Kept/Nested/note.fountain"
    );
}

#[test]
fn a_folder_move_takes_open_documents_and_their_waiting_edits_along() {
    let (_directory, s) = store();
    let page = s.create_document("Drafts/page.md").unwrap();
    let room = s.room(&page).unwrap();
    assert!(s.persist(&page, &mut room.lock().unwrap()).unwrap());
    // A desktop application holds the file open, so the edit waits.
    let desktop = fs::OpenOptions::new()
        .append(true)
        .open(s.root.join("Drafts/page.md"))
        .unwrap();
    let frame = append_frame(&room, "Accepted while the desktop held the file\n");
    process_frame(&s, &page, &room, &frame, true, true, &mut Peer::default()).unwrap();
    assert!(!s.persist(&page, &mut room.lock().unwrap()).unwrap());
    let expected = room_text(&room.lock().unwrap());
    s.rename_folder("Drafts", "Published").unwrap();
    drop(desktop);
    let moved = s.doc(&page.id).unwrap();
    assert_eq!(moved.path, "Published/page.md");
    assert!(s.persist(&moved, &mut room.lock().unwrap()).unwrap());
    assert_eq!(
        fs::read_to_string(s.root.join("Published/page.md")).unwrap(),
        expected
    );
    assert!(!s.root.join("Drafts").exists());
}

#[test]
fn a_folder_move_refuses_a_taken_destination_itself_and_missing_folders() {
    let (_directory, s) = store();
    s.create_document("Drafts/page.md").unwrap();
    s.create_document("Other/note.md").unwrap();
    for (from, to, status) in [
        ("Drafts", "Other", StatusCode::CONFLICT),
        ("Drafts", "Drafts/Inner", StatusCode::BAD_REQUEST),
        ("Drafts", "Drafts/Inner/Deeper", StatusCode::BAD_REQUEST),
        ("Missing", "Elsewhere", StatusCode::NOT_FOUND),
        ("Drafts", "Nowhere/Drafts", StatusCode::BAD_REQUEST),
        ("Drafts/page.md", "Notes", StatusCode::BAD_REQUEST),
        ("Drafts", ".hidden", StatusCode::BAD_REQUEST),
        ("Drafts", "../outside", StatusCode::BAD_REQUEST),
    ] {
        assert_eq!(
            s.rename_folder(from, to).unwrap_err().0,
            status,
            "{from} -> {to}"
        );
    }
    assert_eq!(s.rename_folder("Drafts", "Drafts").unwrap(), "Drafts");
    assert!(s.root.join("Drafts/page.md").is_file());
    assert!(s.root.join("Other/note.md").is_file());
    assert_eq!(journaled(&s), 0);
}

#[test]
fn a_rejected_folder_move_commit_never_moves_the_folder() {
    let (_directory, s) = store();
    let page = s.create_document("Drafts/page.md").unwrap();
    s.db.lock()
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER reject_move BEFORE UPDATE OF path ON docs
             BEGIN SELECT RAISE(ABORT,'fixture failure'); END;",
        )
        .unwrap();
    assert!(s.rename_folder("Drafts", "Kept").is_err());
    assert!(s.root.join("Drafts/page.md").is_file());
    assert!(!s.root.join("Kept").exists());
    assert_eq!(s.doc(&page.id).unwrap().path, "Drafts/page.md");
    assert_eq!(journaled(&s), 0);
}

#[test]
fn a_folder_move_interrupted_at_any_step_finishes_with_every_identity() {
    for stage in 0..3 {
        let (_directory, s) = store();
        let page = s.create_document("Drafts/page.md").unwrap();
        share(&s, &page.id);
        let expected = room_text(
            &accept(&s, &page, "Accepted before Locdoc stopped\n")
                .lock()
                .unwrap(),
        );
        let link = folder_link(&s, "Drafts");
        allow_mcp_folder(&s, "Drafts");
        journal(
            &s,
            ("move", Action::Rename, EntryKind::Folder, None),
            "Drafts",
            "Kept",
        );
        interrupt(&s, stage, "Drafts", "Kept");
        let s = reopen(s);
        let recovered = s.doc(&page.id).unwrap();
        assert_eq!(recovered.path, "Kept/page.md", "stage {stage}");
        assert_eq!(recovered.token.as_deref(), Some("old-link"));
        assert_eq!(folders::grant(&s, &link).unwrap().path, "Kept");
        assert!(mcp_access::folder_access(&s, "Kept").unwrap().mcp_direct);
        assert_eq!(journaled(&s), 0);
        assert!(!s.root.join("Drafts").exists());
        assert_eq!(s.index_document("Kept/page.md").unwrap().id, page.id);
        // The edit accepted before the stop reaches the file where it is now.
        let room = s.room(&recovered).unwrap();
        assert!(s.persist(&recovered, &mut room.lock().unwrap()).unwrap());
        assert_eq!(
            fs::read_to_string(s.root.join("Kept/page.md")).unwrap(),
            expected
        );
    }
}

#[test]
fn an_interrupted_folder_move_never_replaces_a_later_destination() {
    let (_directory, s) = store();
    let page = s.create_document("Drafts/page.md").unwrap();
    let link = folder_link(&s, "Drafts");
    journal(
        &s,
        ("move", Action::Rename, EntryKind::Folder, None),
        "Drafts",
        "Kept",
    );
    fs::create_dir(s.root.join("Kept")).unwrap();
    fs::write(s.root.join("Kept/other.md"), "Unrelated desktop file").unwrap();
    let s = reopen(s);
    assert_eq!(journaled(&s), 0);
    assert_eq!(s.doc(&page.id).unwrap().path, "Drafts/page.md");
    assert_eq!(folders::grant(&s, &link).unwrap().path, "Drafts");
    assert_eq!(
        fs::read_to_string(s.root.join("Kept/other.md")).unwrap(),
        "Unrelated desktop file"
    );
}

#[test]
fn an_interrupted_folder_move_whose_folder_went_elsewhere_follows_its_files() {
    let (_directory, s) = store();
    let page = s.create_document("Drafts/page.md").unwrap();
    share(&s, &page.id);
    journal(
        &s,
        ("move", Action::Rename, EntryKind::Folder, None),
        "Drafts",
        "Kept",
    );
    fs::rename(s.root.join("Drafts"), s.root.join("Elsewhere")).unwrap();
    let s = reopen(s);
    assert_eq!(journaled(&s), 0);
    let found = s.doc(&page.id).unwrap();
    assert_eq!(found.path, "Elsewhere/page.md");
    assert_eq!(found.token.as_deref(), Some("old-link"));
    assert!(!s.root.join("Kept").exists());
}

#[test]
fn a_pending_move_holds_its_documents_until_it_settles() {
    use std::os::unix::fs::PermissionsExt;
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let (_directory, s) = store();
    let page = s.create_document("Drafts/page.md").unwrap();
    share(&s, &page.id);
    s.create_folder("Locked").unwrap();
    journal(
        &s,
        ("move", Action::Rename, EntryKind::Folder, None),
        "Drafts",
        "Locked/Kept",
    );
    interrupt(&s, 2, "Drafts", "Locked/Kept");
    // Settling cannot look at the destination, so the intent stays. Passes
    // neither retire the document nor list its file as a new one.
    let locked = s.root.join("Locked");
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
    let passed = s.retire_missing_documents();
    let listing = s
        .index_document("Drafts/page.md")
        .map(|document| document.id);
    let still = journaled(&s);
    let kept = s.doc(&page.id).map(|document| document.token);
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).unwrap();
    passed.unwrap();
    assert!(listing.is_err());
    assert_eq!(still, 1);
    assert_eq!(kept.unwrap().as_deref(), Some("old-link"));
    s.retire_missing_documents().unwrap();
    assert_eq!(journaled(&s), 0);
    assert_eq!(s.doc(&page.id).unwrap().path, "Locked/Kept/page.md");
    assert_eq!(s.doc(&page.id).unwrap().token.as_deref(), Some("old-link"));
}

#[test]
fn a_deleted_document_is_suspended_and_a_restore_revives_it() {
    let (_directory, s) = store();
    let page = s.create_document("Notes/page.md").unwrap();
    share(&s, &page.id);
    s.db.lock()
        .unwrap()
        .execute("INSERT INTO mcp_documents(doc) VALUES(?)", [&page.id])
        .unwrap();
    s.snapshot(&page, "Earlier text", true).unwrap();
    let room = s.room(&page).unwrap();
    let mut events = room.lock().unwrap().tx.subscribe();
    let trash = s.trash_document(&page.id).unwrap();
    // Its sockets close as a retired document's do.
    assert!(std::iter::from_fn(|| events.try_recv().ok()).any(|frame| frame == [126]));
    let location = format!("{TRASH}/{trash}/page.md");
    assert_eq!(
        fs::read_to_string(s.root.join(&location)).unwrap(),
        "# page\n\n"
    );
    assert!(!s.root.join("Notes/page.md").exists());
    assert_eq!(active(&s, &page.id), 2);
    assert!(s.doc(&page.id).is_err());
    assert!(s.room(&page).is_err());
    // A request still holding the room can no longer change it.
    let late = append_frame(&room, "Late edit");
    let mut peer = Peer::default();
    assert!(process_frame(&s, &page, &room, &late, true, true, &mut peer).is_err());
    assert!(!listed(&s).iter().any(|path| path.ends_with("page.md")));
    // Links, MCP and listings refuse it as they refuse a removed document.
    assert_eq!(
        shared_document(&s, "old-link").unwrap_err().1,
        "This link has been turned off or does not exist."
    );
    assert!(mcp_access::document_access(&s, &page).is_err());
    assert!(s.index_document(&location).is_err());
    assert_eq!(
        trash_items(&s),
        [(trash.clone(), "document".into(), "Notes/page.md".into())]
    );
    // Passes neither retire nor move it.
    s.discover_file_moves().unwrap();
    s.retire_missing_documents().unwrap();
    let s = reopen(s);
    s.retire_missing_documents().unwrap();
    assert_eq!(active(&s, &page.id), 2);
    let (path, documents) = s.restore_trash(&trash).unwrap();
    assert_eq!(path, "Notes/page.md");
    assert_eq!(documents, std::slice::from_ref(&page.id));
    let restored = s.doc(&page.id).unwrap();
    assert_eq!(restored.path, "Notes/page.md");
    assert_eq!(restored.token.as_deref(), Some("old-link"));
    assert_eq!(shared_document(&s, "old-link").unwrap().id, page.id);
    assert!(
        mcp_access::document_access(&s, &restored)
            .unwrap()
            .mcp_direct
    );
    assert_eq!(versions(&s, &page.id, "Earlier text"), 1);
    assert!(trash_items(&s).is_empty());
    assert!(!s.root.join(TRASH).join(&trash).exists());
    assert_eq!(s.index_document("Notes/page.md").unwrap().id, page.id);
    assert_eq!(journaled(&s), 0);
}

#[test]
fn a_restore_projects_the_edits_that_were_waiting_when_the_document_was_deleted() {
    let (_directory, s) = store();
    let page = s.create_document("Notes/page.md").unwrap();
    let room = s.room(&page).unwrap();
    assert!(s.persist(&page, &mut room.lock().unwrap()).unwrap());
    let desktop = fs::OpenOptions::new()
        .append(true)
        .open(s.root.join("Notes/page.md"))
        .unwrap();
    let frame = append_frame(&room, "Accepted, not yet on disk\n");
    process_frame(&s, &page, &room, &frame, true, true, &mut Peer::default()).unwrap();
    assert!(!s.persist(&page, &mut room.lock().unwrap()).unwrap());
    let expected = room_text(&room.lock().unwrap());
    let trash = s.trash_document(&page.id).unwrap();
    drop(desktop);
    assert_eq!(durable_text(&s, &page.id), expected);
    let (_, documents) = s.restore_trash(&trash).unwrap();
    s.recover_restored(&documents);
    assert_eq!(
        fs::read_to_string(s.root.join("Notes/page.md")).unwrap(),
        expected
    );
}

#[test]
fn a_restore_reports_a_conflict_while_its_path_is_taken() {
    let (_directory, s) = store();
    let page = s.create_document("page.md").unwrap();
    let trash = s.trash_document(&page.id).unwrap();
    let other = s.create_document("page.md").unwrap();
    let error = s.restore_trash(&trash).unwrap_err();
    assert_eq!(error.0, StatusCode::CONFLICT);
    assert!(error.1.contains("page.md already exists"), "{}", error.1);
    assert_eq!(active(&s, &page.id), 2);
    assert_eq!(trash_items(&s).len(), 1);
    assert_eq!(s.doc(&other.id).unwrap().path, "page.md");
    assert!(s.root.join(format!("{TRASH}/{trash}/page.md")).is_file());
    assert_eq!(journaled(&s), 0);
    s.rename_document(&other.id, "other.md").unwrap();
    s.restore_trash(&trash).unwrap();
    assert_eq!(s.doc(&page.id).unwrap().path, "page.md");
    assert_eq!(s.doc(&other.id).unwrap().path, "other.md");
    assert_eq!(
        s.restore_trash(&trash).unwrap_err().0,
        StatusCode::NOT_FOUND
    );
}

#[test]
fn a_restore_recreates_the_folders_its_path_needs() {
    let (_directory, s) = store();
    let page = s.create_document("Projects/Notes/page.md").unwrap();
    let trash = s.trash_document(&page.id).unwrap();
    fs::remove_dir(s.root.join("Projects/Notes")).unwrap();
    fs::remove_dir(s.root.join("Projects")).unwrap();
    s.restore_trash(&trash).unwrap();
    assert_eq!(s.doc(&page.id).unwrap().path, "Projects/Notes/page.md");
    assert!(s.root.join("Projects/Notes/page.md").is_file());
    // A file in the way of a folder it needs is a conflict.
    let trash = s.trash_document(&page.id).unwrap();
    fs::remove_dir(s.root.join("Projects/Notes")).unwrap();
    fs::write(s.root.join("Projects/Notes"), "In the way").unwrap();
    assert_eq!(s.restore_trash(&trash).unwrap_err().0, StatusCode::CONFLICT);
    assert_eq!(active(&s, &page.id), 2);
}

#[test]
fn a_file_removed_from_the_trash_retires_its_document_with_its_text() {
    let (_directory, s) = store();
    let page = s.create_document("page.md").unwrap();
    share(&s, &page.id);
    drop(accept(&s, &page, "Accepted text to recover\n"));
    let trash = s.trash_document(&page.id).unwrap();
    fs::remove_file(s.root.join(format!("{TRASH}/{trash}/page.md"))).unwrap();
    s.retire_missing_documents().unwrap();
    assert_eq!(active(&s, &page.id), 0);
    let (path, token): (String, Option<String>) =
        s.db.lock()
            .unwrap()
            .query_row(
                "SELECT retired_path,token FROM docs WHERE id=?",
                [&page.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
    assert_eq!(path, "page.md");
    assert!(token.is_none());
    assert!(durable_text(&s, &page.id).contains("Accepted text to recover"));
    assert!(trash_items(&s).is_empty());
    assert!(shared_document(&s, "old-link").is_err());
}

#[test]
fn a_trashed_file_moved_back_by_hand_never_becomes_a_second_document() {
    let (_directory, s) = store();
    let page = s.create_document("page.md").unwrap();
    share(&s, &page.id);
    let trash = s.trash_document(&page.id).unwrap();
    fs::rename(
        s.root.join(format!("{TRASH}/{trash}/page.md")),
        s.root.join("page.md"),
    )
    .unwrap();
    assert_eq!(
        s.index_document("page.md").unwrap_err().0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert!(!listed(&s).contains(&"page.md".to_owned()));
    // Out of the trash, its document retires as a missing one does; the
    // file is then a new private document.
    s.retire_missing_documents().unwrap();
    assert_eq!(active(&s, &page.id), 0);
    let found = s.index_document("page.md").unwrap();
    assert_ne!(found.id, page.id);
    assert_eq!(found.permission, "private");
    assert!(found.token.is_none());
}

#[test]
fn a_delete_interrupted_at_any_step_finishes_without_losing_edits() {
    for stage in 0..3 {
        let (_directory, s) = store();
        let page = s.create_document("Notes/page.md").unwrap();
        share(&s, &page.id);
        drop(accept(&s, &page, "Accepted before Locdoc stopped\n"));
        let trash = uuid::Uuid::new_v4().to_string();
        let location = format!("{TRASH}/{trash}/page.md");
        fs::create_dir_all(s.root.join(TRASH).join(&trash)).unwrap();
        journal(
            &s,
            (&trash, Action::Trash, EntryKind::Document, Some(&page.id)),
            "Notes/page.md",
            &location,
        );
        interrupt(&s, stage, "Notes/page.md", &location);
        let s = reopen(s);
        assert_eq!(active(&s, &page.id), 2, "stage {stage}");
        assert_eq!(trash_items(&s).len(), 1);
        assert!(s.root.join(&location).is_file());
        assert!(!s.root.join("Notes/page.md").exists());
        assert_eq!(journaled(&s), 0);
        assert!(shared_document(&s, "old-link").is_err());
        s.retire_missing_documents().unwrap();
        assert_eq!(active(&s, &page.id), 2);
        let (_, documents) = s.restore_trash(&trash).unwrap();
        s.recover_restored(&documents);
        assert_eq!(s.doc(&page.id).unwrap().token.as_deref(), Some("old-link"));
        assert!(
            fs::read_to_string(s.root.join("Notes/page.md"))
                .unwrap()
                .contains("Accepted before Locdoc stopped")
        );
    }
}

#[test]
fn a_restore_interrupted_at_any_step_finishes_with_its_links() {
    for stage in 0..3 {
        let (_directory, s) = store();
        let page = s.create_document("Notes/page.md").unwrap();
        share(&s, &page.id);
        let trash = s.trash_document(&page.id).unwrap();
        let location = format!("{TRASH}/{trash}/page.md");
        journal(
            &s,
            (&trash, Action::Restore, EntryKind::Document, Some(&page.id)),
            &location,
            "Notes/page.md",
        );
        interrupt(&s, stage, &location, "Notes/page.md");
        let s = reopen(s);
        let restored = s.doc(&page.id).unwrap();
        assert_eq!(restored.path, "Notes/page.md", "stage {stage}");
        assert_eq!(restored.token.as_deref(), Some("old-link"));
        assert_eq!(shared_document(&s, "old-link").unwrap().id, page.id);
        assert!(trash_items(&s).is_empty());
        assert_eq!(journaled(&s), 0);
        assert_eq!(s.index_document("Notes/page.md").unwrap().id, page.id);
        assert_eq!(listed(&s), ["Notes", "Notes/page.md"]);
    }
}

#[test]
fn an_interrupted_restore_never_replaces_a_file_that_took_its_path() {
    let (_directory, s) = store();
    let page = s.create_document("page.md").unwrap();
    let trash = s.trash_document(&page.id).unwrap();
    let location = format!("{TRASH}/{trash}/page.md");
    journal(
        &s,
        (&trash, Action::Restore, EntryKind::Document, Some(&page.id)),
        &location,
        "page.md",
    );
    fs::write(s.root.join("page.md"), "A new desktop file").unwrap();
    let s = reopen(s);
    assert_eq!(journaled(&s), 0);
    assert_eq!(active(&s, &page.id), 2);
    assert_eq!(trash_items(&s).len(), 1);
    assert_eq!(
        fs::read_to_string(s.root.join("page.md")).unwrap(),
        "A new desktop file"
    );
    assert!(s.root.join(&location).is_file());
    assert_ne!(s.index_document("page.md").unwrap().id, page.id);
}

#[test]
fn a_desktop_save_during_a_delete_is_put_back_and_keeps_saving() {
    use rusqlite::functions::FunctionFlags;
    let (_directory, s) = store();
    let page = s.create_document("page.md").unwrap();
    share(&s, &page.id);
    let path = s.root.join("page.md");
    let temporary = s.root.join("page.md.tmp");
    {
        // An editor's atomic save lands between the journal and the rename.
        let db = s.db.lock().unwrap();
        db.create_scalar_function("replace_source", 0, FunctionFlags::SQLITE_UTF8, move |_| {
            fs::write(&temporary, "Desktop save during the delete\n")
                .and_then(|()| fs::rename(&temporary, &path))
                .map(|()| 1)
                .map_err(|error| rusqlite::Error::UserFunctionError(Box::new(error)))
        })
        .unwrap();
        db.execute_batch(
            "CREATE TRIGGER replace_during_delete AFTER INSERT ON entry_moves
             BEGIN SELECT replace_source(); END;",
        )
        .unwrap();
    }
    let error = s.trash_document(&page.id).unwrap_err();
    s.db.lock()
        .unwrap()
        .execute_batch("DROP TRIGGER replace_during_delete")
        .unwrap();
    assert_eq!(error.0, StatusCode::CONFLICT);
    assert_eq!(journaled(&s), 0);
    assert!(trash_items(&s).is_empty());
    assert_eq!(s.doc(&page.id).unwrap().token.as_deref(), Some("old-link"));
    assert_eq!(
        fs::read_to_string(s.root.join("page.md")).unwrap(),
        "Desktop save during the delete\n"
    );
    assert_eq!(
        fs::read_dir(s.root.join(TRASH)).unwrap().count(),
        0,
        "the delete leaves nothing behind in the trash"
    );
    // The replacement is the document's own file, and a retry deletes it.
    let trash = s.trash_document(&page.id).unwrap();
    assert_eq!(
        fs::read_to_string(s.root.join(format!("{TRASH}/{trash}/page.md"))).unwrap(),
        "Desktop save during the delete\n"
    );
}

#[test]
fn a_rejected_delete_commit_never_moves_the_file() {
    let (_directory, s) = store();
    let page = s.create_document("page.md").unwrap();
    s.db.lock()
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER reject_delete BEFORE UPDATE OF active ON docs
             BEGIN SELECT RAISE(ABORT,'fixture failure'); END;",
        )
        .unwrap();
    assert!(s.trash_document(&page.id).is_err());
    assert!(s.root.join("page.md").is_file());
    assert!(!s.root.join(TRASH).exists());
    assert_eq!(active(&s, &page.id), 1);
    assert_eq!(journaled(&s), 0);
}

#[test]
fn a_deleted_folder_suspends_its_links_and_grants_until_it_is_restored() {
    let (_directory, s) = store();
    let page = s.create_document("Shared/page.md").unwrap();
    let note = s.create_document("Shared/Inner/note.md").unwrap();
    share(&s, &page.id);
    let link = folder_link(&s, "Shared");
    allow_mcp_folder(&s, "Shared");
    let room = s.room(&note).unwrap();
    let mut events = room.lock().unwrap().tx.subscribe();
    let trash = s.trash_folder("Shared").unwrap();
    assert!(std::iter::from_fn(|| events.try_recv().ok()).any(|frame| frame == [126]));
    assert!(!s.root.join("Shared").exists());
    assert!(
        s.root
            .join(format!("{TRASH}/{trash}/Shared/Inner/note.md"))
            .is_file()
    );
    assert!(s.doc(&page.id).is_err() && s.doc(&note.id).is_err());
    assert!(folders::grant(&s, &link).is_err());
    assert!(shared_document(&s, "old-link").is_err());
    assert!(mcp_access::require_folder(&s, "Shared").is_err());
    assert!(listed(&s).is_empty());
    assert_eq!(
        trash_items(&s),
        [(trash.clone(), "folder".into(), "Shared".into())]
    );
    // A new folder at its name gets none of its grants, and blocks the restore.
    s.create_folder("Shared").unwrap();
    assert!(!mcp_access::folder_access(&s, "Shared").unwrap().mcp_allowed);
    assert!(folders::grant(&s, &link).is_err());
    assert_eq!(s.restore_trash(&trash).unwrap_err().0, StatusCode::CONFLICT);
    fs::remove_dir(s.root.join("Shared")).unwrap();
    let (path, mut documents) = s.restore_trash(&trash).unwrap();
    documents.sort();
    let mut expected = vec![page.id.clone(), note.id.clone()];
    expected.sort();
    assert_eq!((path.as_str(), documents), ("Shared", expected));
    assert_eq!(folders::grant(&s, &link).unwrap().path, "Shared");
    assert!(mcp_access::folder_access(&s, "Shared").unwrap().mcp_direct);
    assert_eq!(shared_document(&s, "old-link").unwrap().id, page.id);
    assert_eq!(s.doc(&note.id).unwrap().path, "Shared/Inner/note.md");
    assert!(trash_items(&s).is_empty());
    s.retire_missing_documents().unwrap();
    assert_eq!(
        s.index_document("Shared/Inner/note.md").unwrap().id,
        note.id
    );
}

#[test]
fn a_folder_delete_interrupted_at_any_step_finishes_and_restores() {
    for stage in 0..3 {
        let (_directory, s) = store();
        let page = s.create_document("Shared/page.md").unwrap();
        share(&s, &page.id);
        let link = folder_link(&s, "Shared");
        drop(accept(&s, &page, "Accepted before Locdoc stopped\n"));
        let trash = uuid::Uuid::new_v4().to_string();
        let location = format!("{TRASH}/{trash}/Shared");
        fs::create_dir_all(s.root.join(TRASH).join(&trash)).unwrap();
        journal(
            &s,
            (&trash, Action::Trash, EntryKind::Folder, None),
            "Shared",
            &location,
        );
        interrupt(&s, stage, "Shared", &location);
        let s = reopen(s);
        assert_eq!(active(&s, &page.id), 2, "stage {stage}");
        assert_eq!(journaled(&s), 0);
        assert!(folders::grant(&s, &link).is_err());
        s.retire_missing_documents().unwrap();
        assert_eq!(active(&s, &page.id), 2);
        let (_, documents) = s.restore_trash(&trash).unwrap();
        s.recover_restored(&documents);
        assert_eq!(folders::grant(&s, &link).unwrap().path, "Shared");
        assert_eq!(s.doc(&page.id).unwrap().token.as_deref(), Some("old-link"));
        assert!(
            fs::read_to_string(s.root.join("Shared/page.md"))
                .unwrap()
                .contains("Accepted before Locdoc stopped")
        );
    }
}

#[test]
fn an_empty_folder_goes_to_the_trash_and_back() {
    let (_directory, s) = store();
    s.create_folder("Empty/Inner").unwrap();
    let trash = s.trash_folder("Empty").unwrap();
    assert!(!s.root.join("Empty").exists());
    assert_eq!(
        trash_items(&s),
        [(trash.clone(), "folder".into(), "Empty".into())]
    );
    assert_eq!(s.restore_trash(&trash).unwrap().0, "Empty");
    assert!(s.root.join("Empty/Inner").is_dir());
    assert_eq!(
        s.trash_folder("Missing").unwrap_err().0,
        StatusCode::NOT_FOUND
    );
    s.create_document("page.md").unwrap();
    assert_eq!(
        s.trash_folder("page.md").unwrap_err().0,
        StatusCode::BAD_REQUEST
    );
}

#[test]
fn approved_images_follow_a_folder_that_moves_or_returns_from_the_trash() {
    let (_directory, s) = store();
    let page = s.create_document("Album/page.md").unwrap();
    share(&s, &page.id);
    let png = BASE64
        .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFlsAAAAASUVORK5CYII=")
        .unwrap();
    fs::write(s.root.join("Album/photo.png"), &png).unwrap();
    fs::write(s.root.join("Album/page.md"), "![photo](photo.png)\n").unwrap();
    let room = s.room(&page).unwrap();
    assert!(s.persist(&page, &mut room.lock().unwrap()).unwrap());
    drop(room);
    let visitor = |s: &Store| {
        let request = Media {
            path: "photo.png".into(),
            token: Some("old-link".into()),
        };
        media_file(s, &page.id, &request, &HeaderMap::new()).map(|_| ())
    };
    visitor(&s).unwrap();
    s.rename_folder("Album", "Trip").unwrap();
    visitor(&s).unwrap();
    let trash = s.trash_folder("Trip").unwrap();
    assert!(visitor(&s).is_err());
    s.restore_trash(&trash).unwrap();
    visitor(&s).unwrap();
}

#[test]
fn moves_and_deletes_wait_for_a_busy_room_instead_of_misplacing_its_edits() {
    use std::time::Duration;
    let (_directory, s) = store();
    let page = s.create_document("Drafts/page.md").unwrap();
    let room = accept(&s, &page, "Accepted while the room was busy\n");
    let expected = room_text(&room.lock().unwrap());
    // A socket's frame holds the room while the move starts.
    let busy = room.lock().unwrap();
    let worker = {
        let s = s.clone();
        std::thread::spawn(move || s.rename_folder("Drafts", "Kept"))
    };
    std::thread::sleep(Duration::from_millis(150));
    assert!(!worker.is_finished(), "the move waits for the room");
    assert!(s.root.join("Drafts/page.md").is_file());
    drop(busy);
    assert_eq!(worker.join().unwrap().unwrap(), "Kept");
    let moved = s.doc(&page.id).unwrap();
    assert_eq!(moved.path, "Kept/page.md");
    let mut events = room.lock().unwrap().tx.subscribe();
    let busy = room.lock().unwrap();
    let worker = {
        let s = s.clone();
        let id = page.id.clone();
        std::thread::spawn(move || s.trash_document(&id))
    };
    std::thread::sleep(Duration::from_millis(150));
    assert!(!worker.is_finished(), "the delete waits for the room");
    drop(busy);
    let trash = worker.join().unwrap().unwrap();
    assert!(std::iter::from_fn(|| events.try_recv().ok()).any(|frame| frame == [126]));
    assert_eq!(durable_text(&s, &page.id), expected);
    let (path, documents) = s.restore_trash(&trash).unwrap();
    assert_eq!(path, "Kept/page.md");
    s.recover_restored(&documents);
    assert_eq!(
        fs::read_to_string(s.root.join("Kept/page.md")).unwrap(),
        expected
    );
}

#[test]
fn a_delete_first_commits_edits_a_failed_transaction_kept_in_memory() {
    let (_directory, s) = store();
    let page = s.create_document("page.md").unwrap();
    let room = s.room(&page).unwrap();
    assert!(s.persist(&page, &mut room.lock().unwrap()).unwrap());
    s.db.lock()
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER reject_delta BEFORE INSERT ON doc_updates
             BEGIN SELECT RAISE(ABORT,'simulated journal outage'); END;",
        )
        .unwrap();
    let frame = append_frame(&room, "Kept in memory for its retry\n");
    assert!(process_frame(&s, &page, &room, &frame, true, true, &mut Peer::default()).is_err());
    let expected = room_text(&room.lock().unwrap());
    assert!(expected.contains("Kept in memory for its retry"));
    // While the journal refuses the edit, the delete refuses too.
    assert!(s.trash_document(&page.id).is_err());
    assert_eq!(active(&s, &page.id), 1);
    assert!(s.root.join("page.md").is_file());
    assert_eq!(journaled(&s), 0);
    s.db.lock()
        .unwrap()
        .execute_batch("DROP TRIGGER reject_delta")
        .unwrap();
    let trash = s.trash_document(&page.id).unwrap();
    assert_eq!(durable_text(&s, &page.id), expected);
    let (_, documents) = s.restore_trash(&trash).unwrap();
    s.recover_restored(&documents);
    assert_eq!(
        fs::read_to_string(s.root.join("page.md")).unwrap(),
        expected
    );
}

#[test]
fn a_desktop_save_a_stopped_delete_carried_into_the_trash_comes_back() {
    let (_directory, s) = store();
    let page = s.create_document("page.md").unwrap();
    share(&s, &page.id);
    let trash = uuid::Uuid::new_v4().to_string();
    let location = format!("{TRASH}/{trash}/page.md");
    fs::create_dir_all(s.root.join(TRASH).join(&trash)).unwrap();
    journal(
        &s,
        (&trash, Action::Trash, EntryKind::Document, Some(&page.id)),
        "page.md",
        &location,
    );
    // An editor's atomic save replaced the file after the journal, the
    // rename carried that save into the trash, and Locdoc stopped before
    // it could put it back.
    fs::write(s.root.join("page.md.tmp"), "Desktop save\n").unwrap();
    fs::rename(s.root.join("page.md.tmp"), s.root.join("page.md")).unwrap();
    interrupt(&s, 1, "page.md", &location);
    let s = reopen(s);
    assert_eq!(journaled(&s), 0);
    assert!(trash_items(&s).is_empty());
    assert_eq!(
        fs::read_to_string(s.root.join("page.md")).unwrap(),
        "Desktop save\n"
    );
    s.retire_missing_documents().unwrap();
    let kept = s.doc(&page.id).unwrap();
    assert_eq!(kept.token.as_deref(), Some("old-link"));
    assert_eq!(s.index_document("page.md").unwrap().id, page.id);
    let room = s.room(&kept).unwrap();
    assert!(s.persist(&kept, &mut room.lock().unwrap()).unwrap());
    assert_eq!(room_text(&room.lock().unwrap()), "Desktop save\n");
}

#[test]
fn a_room_held_through_a_delete_never_accepts_beside_the_restored_one() {
    let (_directory, s) = store();
    let page = s.create_document("page.md").unwrap();
    // A socket keeps the room it joined before the delete.
    let stale = s.room(&page).unwrap();
    let trash = s.trash_document(&page.id).unwrap();
    let (_, documents) = s.restore_trash(&trash).unwrap();
    s.recover_restored(&documents);
    let restored = s.doc(&page.id).unwrap();
    let fresh = s.room(&restored).unwrap();
    assert!(!Arc::ptr_eq(&stale, &fresh));
    // Its next frame arrives on that room, after the restore.
    let frame = append_frame(&stale, "Stale edit\n");
    let error = process_frame(
        &s,
        &restored,
        &stale,
        &frame,
        true,
        true,
        &mut Peer::default(),
    )
    .unwrap_err();
    assert_eq!(error.0, StatusCode::NOT_FOUND);
    assert!(!durable_text(&s, &page.id).contains("Stale edit"));
    let frame = append_frame(&fresh, "Fresh edit\n");
    process_frame(
        &s,
        &restored,
        &fresh,
        &frame,
        true,
        true,
        &mut Peer::default(),
    )
    .unwrap();
    assert!(s.persist(&restored, &mut fresh.lock().unwrap()).unwrap());
    let saved = fs::read_to_string(s.root.join("page.md")).unwrap();
    assert!(saved.contains("Fresh edit") && !saved.contains("Stale edit"));
}
