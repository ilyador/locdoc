use super::*;

fn fixture(source: &str) -> (tempfile::TempDir, App, Document) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(
        dir.path().join("docs"),
        dir.path().join("state"),
        "http://localhost:3477".into(),
    )
    .unwrap();
    fs::write(store.root.join("test.md"), source).unwrap();
    let document = store.index_document("test.md").unwrap();
    (dir, store, document)
}

fn doc() -> Doc {
    Doc::with_options(Options {
        offset_kind: OffsetKind::Utf16,
        ..Options::default()
    })
}

fn decoded(state: &[u8]) -> Doc {
    let document = doc();
    document
        .transact_mut()
        .apply_update(Update::decode_v1(state).unwrap())
        .unwrap();
    document
}

fn source(document: &Doc) -> String {
    document
        .get_or_insert_text("content")
        .get_string(&document.transact())
}

fn append_frame(room: &Arc<Mutex<Room>>, value: &str) -> Vec<u8> {
    let peer = decoded(
        &room
            .lock()
            .unwrap()
            .awareness
            .doc()
            .transact()
            .encode_state_as_update_v1(&StateVector::default()),
    );
    let before = peer.transact().state_vector();
    let text = peer.get_or_insert_text("content");
    let end = text.len(&peer.transact());
    text.insert(&mut peer.transact_mut(), end, value);
    Message::Sync(SyncMessage::Update(
        peer.transact().encode_state_as_update_v1(&before),
    ))
    .encode_v1()
}

#[test]
fn accepted_updates_are_durable_before_broadcast_but_receipts_wait_for_projection() {
    let (_dir, store, document) = fixture("Start");
    let room = store.room(&document).unwrap();
    store.persist(&document, &mut room.lock().unwrap()).unwrap();
    let mut receiver = room.lock().unwrap().tx.subscribe();
    let mut peer = Peer::default();
    let update = append_frame(&room, " browser");
    process_frame(&store, &document, &room, &update, true, true, &mut peer).unwrap();
    assert!(matches!(
        Message::decode_v1(&receiver.try_recv().unwrap()).unwrap(),
        Message::Sync(SyncMessage::Update(_))
    ));
    assert_eq!(
        fs::read_to_string(store.root.join("test.md")).unwrap(),
        "Start"
    );
    // Rehydrate SQLite state at exactly the point a peer has received its update.
    store.rooms.lock().unwrap().remove(&document.id);
    let restored = store.room(&document).unwrap();
    assert_eq!(room_text(&restored.lock().unwrap()), "Start browser");

    let old = uuid::Uuid::new_v4().to_string();
    let latest = uuid::Uuid::new_v4().to_string();
    for receipt in [&old, &latest] {
        let reply = process_frame(
            &store,
            &document,
            &room,
            &Message::Custom(124, receipt.as_bytes().to_vec()).encode_v1(),
            true,
            true,
            &mut peer,
        )
        .unwrap();
        assert!(matches!(
            Message::decode_v1(&reply[0]).unwrap(),
            Message::Custom(122, _)
        ));
    }
    assert_eq!(room.lock().unwrap().engine.receipts.len(), 1);
    store.persist(&document, &mut room.lock().unwrap()).unwrap();
    let mut completed = vec![];
    while let Ok(bytes) = receiver.try_recv() {
        if let Message::Custom(127, receipt) = Message::decode_v1(&bytes).unwrap() {
            completed.push(String::from_utf8(receipt).unwrap());
        }
    }
    assert_eq!(completed, vec![latest]);
    assert_eq!(
        fs::read_to_string(store.root.join("test.md")).unwrap(),
        "Start browser"
    );
}

#[test]
fn the_first_accepted_edit_keeps_its_original_disk_baseline_across_restart() {
    let (dir, store, document) = fixture("Before");
    let room = store.room(&document).unwrap();
    process_frame(
        &store,
        &document,
        &room,
        &append_frame(&room, " browser"),
        true,
        true,
        &mut Peer::default(),
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(store.root.join("test.md")).unwrap(),
        "Before"
    );
    drop(room);
    drop(store);
    let store = Store::open(
        dir.path().join("docs"),
        dir.path().join("state"),
        "http://localhost:3477".into(),
    )
    .unwrap();
    store.recover_pending().unwrap();
    assert_eq!(
        fs::read_to_string(store.root.join("test.md")).unwrap(),
        "Before browser"
    );
    assert_eq!(
        room_text(&store.room(&document).unwrap().lock().unwrap()),
        "Before browser"
    );
}

#[test]
fn bounded_journal_checkpoints_pending_edits_and_reopens_without_replaying_text() {
    let (_dir, store, document) = fixture("Start");
    let room = store.room(&document).unwrap();
    store.persist(&document, &mut room.lock().unwrap()).unwrap();
    let mut peer = Peer::default();
    for _ in 0..140 {
        process_frame(
            &store,
            &document,
            &room,
            &append_frame(&room, "x"),
            true,
            true,
            &mut peer,
        )
        .unwrap();
    }
    let expected = format!("Start{}", "x".repeat(140));
    let count: i64 = store
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT count(*) FROM doc_updates WHERE doc=?",
            [&document.id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        count > 0 && count < 128,
        "Journal must compact while projection is pending"
    );
    store.persist(&document, &mut room.lock().unwrap()).unwrap();
    let count: i64 = store
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT count(*) FROM doc_updates WHERE doc=?",
            [&document.id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(count < 128);
    store.rooms.lock().unwrap().remove(&document.id);
    drop(room);
    let restored = store.room(&document).unwrap();
    assert_eq!(room_text(&restored.lock().unwrap()), expected);
    assert_eq!(
        fs::read_to_string(store.root.join("test.md")).unwrap(),
        expected
    );
}

#[test]
fn a_retried_durable_import_still_reaches_connected_peers() {
    let (_dir, store, document) = fixture("Before");
    let room = store.room(&document).unwrap();
    store.persist(&document, &mut room.lock().unwrap()).unwrap();
    let mut receiver = room.lock().unwrap().tx.subscribe();
    store.db.lock().unwrap().execute_batch(
        "CREATE TRIGGER fail_update BEFORE INSERT ON doc_updates BEGIN SELECT RAISE(ABORT,'test storage outage'); END;",
    ).unwrap();
    fs::write(store.root.join("test.md"), "Before and desktop").unwrap();
    assert!(store.persist(&document, &mut room.lock().unwrap()).is_err());
    assert!(
        receiver.try_recv().is_err(),
        "Uncommitted import must stay private"
    );
    store
        .db
        .lock()
        .unwrap()
        .execute_batch("DROP TRIGGER fail_update;")
        .unwrap();
    assert!(store.persist(&document, &mut room.lock().unwrap()).unwrap());
    let mut published = false;
    while let Ok(bytes) = receiver.try_recv() {
        if matches!(
            Message::decode_v1(&bytes).unwrap(),
            Message::Sync(SyncMessage::Update(_))
        ) {
            published = true;
        }
    }
    assert!(
        published,
        "Committed retry must publish the previously blocked import"
    );
}

#[test]
fn legacy_unicode_line_endings_share_migration_ids_with_the_desktop_baseline() {
    for ending in ["\r\n", "\r"] {
        let raw = format!("😀one{ending}two{ending}three");
        let (_dir, store, document) = fixture(&raw);
        let baseline = doc();
        apply_text(&baseline, "", &raw);
        let baseline_state = baseline
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let live = decoded(&baseline_state);
        live.get_or_insert_text("content")
            .insert(&mut live.transact_mut(), 0, "X");
        let live_state = live
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        store
            .db
            .lock()
            .unwrap()
            .execute(
                "UPDATE docs SET state=?,disk_state=? WHERE id=?",
                params![live_state, baseline_state, document.id],
            )
            .unwrap();
        let room = store.room(&document).unwrap();
        {
            let room = room.lock().unwrap();
            assert_eq!(room_text(&room), "X😀one\ntwo\nthree");
            assert_eq!(room.engine.source(), "😀one\ntwo\nthree");
            let desktop = decoded(room.engine.baseline());
            assert_eq!(source(&desktop), room.engine.source());
            let vector = desktop.transact().state_vector();
            apply_text(&desktop, room.engine.source(), "😀one\nTWO\nthree");
            let diff = desktop.transact().encode_state_as_update_v1(&vector);
            let verifier = decoded(
                &room
                    .awareness
                    .doc()
                    .transact()
                    .encode_state_as_update_v1(&StateVector::default()),
            );
            verifier
                .transact_mut()
                .apply_update(Update::decode_v1(&diff).unwrap())
                .unwrap();
            assert_eq!(source(&verifier), "X😀one\nTWO\nthree");
        }
        // The first durable transaction must store the migrated baseline even
        // while a desktop app holds the file and projection cannot complete.
        let writer = fs::OpenOptions::new()
            .append(true)
            .open(store.root.join("test.md"))
            .unwrap();
        assert!(!store.persist(&document, &mut room.lock().unwrap()).unwrap());
        let saved_baseline: Vec<u8> = store
            .db
            .lock()
            .unwrap()
            .query_row(
                "SELECT disk_state FROM docs WHERE id=?",
                [&document.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(source(&decoded(&saved_baseline)), "😀one\ntwo\nthree");
        store.rooms.lock().unwrap().remove(&document.id);
        drop(room);
        let restored = store.room(&document).unwrap();
        assert_eq!(room_text(&restored.lock().unwrap()), "X😀one\ntwo\nthree");
        drop(writer);
        fs::write(
            store.root.join("test.md"),
            format!("😀one{ending}TWO{ending}three"),
        )
        .unwrap();
        assert!(
            store
                .persist(&document, &mut restored.lock().unwrap())
                .unwrap()
        );
        assert_eq!(
            fs::read_to_string(store.root.join("test.md")).unwrap(),
            format!("X😀one{ending}TWO{ending}three")
        );
    }
}

#[test]
fn failed_post_fsync_commit_keeps_projection_pending_and_receipts_unacknowledged() {
    let (_dir, store, document) = fixture("Before");
    let room = store.room(&document).unwrap();
    store.persist(&document, &mut room.lock().unwrap()).unwrap();
    let mut peer = Peer::default();
    process_frame(
        &store,
        &document,
        &room,
        &append_frame(&room, " browser"),
        true,
        true,
        &mut peer,
    )
    .unwrap();
    let receipt = uuid::Uuid::new_v4().to_string();
    process_frame(
        &store,
        &document,
        &room,
        &Message::Custom(124, receipt.as_bytes().to_vec()).encode_v1(),
        true,
        true,
        &mut peer,
    )
    .unwrap();
    let mut receiver = room.lock().unwrap().tx.subscribe();
    store.db.lock().unwrap().execute_batch(
        "CREATE TRIGGER fail_baseline BEFORE UPDATE OF disk_state ON docs BEGIN SELECT RAISE(ABORT,'test baseline commit outage'); END;"
    ).unwrap();
    assert!(store.persist(&document, &mut room.lock().unwrap()).is_err());
    assert_eq!(
        fs::read_to_string(store.root.join("test.md")).unwrap(),
        "Before browser"
    );
    assert!(room.lock().unwrap().engine.needs_projection());
    let intent: bool = store
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT write_intent FROM docs WHERE id=?",
            [&document.id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        intent,
        "Accepted intent must survive the failed final commit"
    );
    while let Ok(bytes) = receiver.try_recv() {
        assert!(
            !matches!(Message::decode_v1(&bytes).unwrap(), Message::Custom(127, _)),
            "A failed baseline commit cannot acknowledge a save"
        );
    }
    store
        .db
        .lock()
        .unwrap()
        .execute_batch("DROP TRIGGER fail_baseline;")
        .unwrap();
    assert!(store.persist(&document, &mut room.lock().unwrap()).unwrap());
    assert!(!room.lock().unwrap().engine.needs_projection());
    let completed = std::iter::from_fn(|| receiver.try_recv().ok())
        .filter_map(|bytes| {
            if let Message::Custom(127, value) = Message::decode_v1(&bytes).unwrap() {
                Some(value)
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    assert_eq!(completed, vec![receipt.into_bytes()]);
}

#[test]
fn new_browser_edits_preserve_a_blocked_interrupted_write_intent() {
    let (_dir, store, document) = fixture("Old text");
    let room = store.room(&document).unwrap();
    store.persist(&document, &mut room.lock().unwrap()).unwrap();
    let mut peer = Peer::default();
    process_frame(
        &store,
        &document,
        &room,
        &append_frame(&room, " first"),
        true,
        true,
        &mut peer,
    )
    .unwrap();
    {
        let mut r = room.lock().unwrap();
        let target = text::render(&room_text(&r), r.engine.ending()).into_bytes();
        r.freeze_projection(target);
        store.store_room(&document, &mut r).unwrap();
    }
    fs::write(store.root.join("test.md"), "Old text f").unwrap();
    let writer = fs::OpenOptions::new()
        .append(true)
        .open(store.root.join("test.md"))
        .unwrap();
    assert!(!store.persist(&document, &mut room.lock().unwrap()).unwrap());
    process_frame(
        &store,
        &document,
        &room,
        &append_frame(&room, " second"),
        true,
        true,
        &mut peer,
    )
    .unwrap();
    assert!(room.lock().unwrap().engine.interrupted());
    assert!(room.lock().unwrap().engine.waiting());
    let intent: bool = store
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT write_intent FROM docs WHERE id=?",
            [&document.id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        intent,
        "A newer durable edit must not erase an interrupted write"
    );
    drop(writer);
    assert!(store.persist(&document, &mut room.lock().unwrap()).unwrap());
    assert_eq!(
        fs::read_to_string(store.root.join("test.md")).unwrap(),
        "Old text first second"
    );
    assert!(!room.lock().unwrap().engine.interrupted());
    assert!(!room.lock().unwrap().engine.waiting());
}

#[test]
fn bootstrap_cannot_expose_a_desktop_import_that_failed_its_sql_commit() {
    let (_dir, store, document) = fixture("Before");
    let room = store.room(&document).unwrap();
    store.persist(&document, &mut room.lock().unwrap()).unwrap();
    let mut headers = HeaderMap::new();
    headers.insert(
        header::AUTHORIZATION,
        format!("Bearer {}", store.key).parse().unwrap(),
    );
    store.db.lock().unwrap().execute_batch(
        "CREATE TRIGGER fail_bootstrap_import BEFORE INSERT ON doc_updates BEGIN SELECT RAISE(ABORT,'test import storage outage'); END;"
    ).unwrap();
    fs::write(store.root.join("test.md"), "Before and desktop").unwrap();
    assert!(
        document_payload(&store, &headers, &document, &Access::default()).is_err(),
        "An uncommitted desktop import must not escape through the bootstrap"
    );
    store
        .db
        .lock()
        .unwrap()
        .execute_batch("DROP TRIGGER fail_bootstrap_import;")
        .unwrap();
    let payload = document_payload(&store, &headers, &document, &Access::default()).unwrap();
    assert_eq!(payload["content"], "Before and desktop");
    // A read retries the rejected journal commit, without bypassing the
    // projection retry cadence. Its status must remain honest until fsync.
    if room.lock().unwrap().engine.needs_projection() {
        assert_eq!(payload["diskSaving"], true);
        store.persist(&document, &mut room.lock().unwrap()).unwrap();
    }
    assert!(!room.lock().unwrap().engine.needs_projection());
}

#[test]
fn opening_an_unchanged_synced_document_does_not_rewrite_its_baseline() {
    let (_dir, store, document) = fixture("Already fsynced\n");
    let room = store.room(&document).unwrap();
    store.persist(&document, &mut room.lock().unwrap()).unwrap();
    let mut headers = HeaderMap::new();
    headers.insert(
        header::AUTHORIZATION,
        format!("Bearer {}", store.key).parse().unwrap(),
    );
    store.db.lock().unwrap().execute_batch(
        "CREATE TRIGGER reject_redundant_baseline BEFORE UPDATE OF disk_state ON docs BEGIN SELECT RAISE(ABORT,'test baseline writes unavailable'); END;"
    ).unwrap();
    let before = store.db.lock().unwrap().total_changes();
    for _ in 0..3 {
        let payload = document_payload(&store, &headers, &document, &Access::default()).unwrap();
        assert_eq!(payload["content"], "Already fsynced\n");
        assert!(!room.lock().unwrap().engine.needs_projection());
    }
    assert_eq!(
        store.db.lock().unwrap().total_changes(),
        before,
        "Clean document reads must not issue redundant writes"
    );
    fs::write(store.root.join("test.md"), "Already fsynced\r\n").unwrap();
    assert!(store.persist(&document, &mut room.lock().unwrap()).unwrap());
    let ending: String = store
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT line_ending FROM docs WHERE id=?",
            [&document.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(ending, "crlf");
}

#[test]
fn unchanged_visible_text_still_commits_new_crdt_identity_before_a_receipt() {
    let (_dir, store, document) = fixture("Same source");
    let room = store.room(&document).unwrap();
    store.persist(&document, &mut room.lock().unwrap()).unwrap();
    let before: Vec<u8> = store
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT disk_state FROM docs WHERE id=?",
            [&document.id],
            |row| row.get(0),
        )
        .unwrap();
    let mut peer = Peer::default();
    let client = decoded(&before);
    let vector = client.transact().state_vector();
    let source = client.get_or_insert_text("content");
    {
        let mut txn = client.transact_mut();
        source.remove_range(&mut txn, 0, 11);
        source.insert(&mut txn, 0, "Same source");
    }
    let frame = Message::Sync(SyncMessage::Update(
        client.transact().encode_state_as_update_v1(&vector),
    ))
    .encode_v1();
    process_frame(&store, &document, &room, &frame, true, true, &mut peer).unwrap();
    assert_eq!(room_text(&room.lock().unwrap()), "Same source");
    assert!(room.lock().unwrap().engine.needs_projection());
    let receipt = uuid::Uuid::new_v4().to_string();
    process_frame(
        &store,
        &document,
        &room,
        &Message::Custom(124, receipt.as_bytes().to_vec()).encode_v1(),
        true,
        true,
        &mut peer,
    )
    .unwrap();
    let mut received = room.lock().unwrap().tx.subscribe();
    store.db.lock().unwrap().execute_batch(
        "CREATE TRIGGER reject_identity_baseline BEFORE UPDATE OF disk_state ON docs BEGIN SELECT RAISE(ABORT,'test baseline identity outage'); END;"
    ).unwrap();
    assert!(
        store.persist(&document, &mut room.lock().unwrap()).is_err(),
        "A source-identical CRDT replacement still needs its baseline commit"
    );
    while let Ok(frame) = received.try_recv() {
        assert!(!matches!(
            Message::decode_v1(&frame).unwrap(),
            Message::Custom(127, _)
        ));
    }
    store
        .db
        .lock()
        .unwrap()
        .execute_batch("DROP TRIGGER reject_identity_baseline;")
        .unwrap();
    assert!(store.persist(&document, &mut room.lock().unwrap()).unwrap());
    let after: Vec<u8> = store
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT disk_state FROM docs WHERE id=?",
            [&document.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_ne!(
        decoded(&before).transact().state_vector(),
        decoded(&after).transact().state_vector()
    );
    assert!(room.lock().unwrap().engine.receipts.is_empty());
}
