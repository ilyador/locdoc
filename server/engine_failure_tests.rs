//! Adversarial checks of the document engine's externally observable promises.
//! SQLite triggers fail real transactions at specific durable boundaries; no
//! production delay/failure hooks or application documents are involved.
use super::*;

fn fixture(source: &str) -> (tempfile::TempDir, App, Document, Arc<Mutex<Room>>) {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(
        directory.path().join("docs"),
        directory.path().join("state"),
        "http://localhost:3477".into(),
    )
    .unwrap();
    fs::write(store.root.join("engine.md"), source).unwrap();
    let document = store.index_document("engine.md").unwrap();
    let room = store.room(&document).unwrap();
    assert!(store.persist(&document, &mut room.lock().unwrap()).unwrap());
    (directory, store, document, room)
}

fn replica(room: &Arc<Mutex<Room>>) -> Doc {
    let doc = Doc::with_options(Options {
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
    doc.transact_mut()
        .apply_update(Update::decode_v1(&state).unwrap())
        .unwrap();
    doc
}

fn append(doc: &Doc, value: &str) -> Vec<u8> {
    let before = doc.transact().state_vector();
    let text = doc.get_or_insert_text("content");
    let end = text.len(&doc.transact());
    text.insert(&mut doc.transact_mut(), end, value);
    Message::Sync(SyncMessage::Update(
        doc.transact().encode_state_as_update_v1(&before),
    ))
    .encode_v1()
}

fn accepted(
    store: &Store,
    document: &Document,
    room: &Arc<Mutex<Room>>,
    frame: &[u8],
    peer: &mut Peer,
) {
    process_frame(store, document, room, frame, true, true, peer).unwrap();
}

fn durable_source(store: &Store, document: &Document) -> String {
    let doc = Doc::with_options(Options {
        offset_kind: OffsetKind::Utf16,
        ..Options::default()
    });
    let db = store.db.lock().unwrap();
    let state: Vec<u8> = db
        .query_row("SELECT state FROM docs WHERE id=?", [&document.id], |r| {
            r.get(0)
        })
        .unwrap();
    doc.transact_mut()
        .apply_update(Update::decode_v1(&state).unwrap())
        .unwrap();
    let mut statement = db
        .prepare("SELECT content FROM doc_updates WHERE doc=? ORDER BY seq")
        .unwrap();
    for state in statement
        .query_map([&document.id], |r| r.get::<_, Vec<u8>>(0))
        .unwrap()
    {
        doc.transact_mut()
            .apply_update(Update::decode_v1(&state.unwrap()).unwrap())
            .unwrap();
    }
    doc.get_or_insert_text("content")
        .get_string(&doc.transact())
}

fn assert_no_source_or_receipt(receiver: &mut broadcast::Receiver<Vec<u8>>) {
    while let Ok(frame) = receiver.try_recv() {
        assert!(
            !matches!(
                Message::decode_v1(&frame).unwrap(),
                Message::Sync(SyncMessage::Update(_)) | Message::Custom(127, _)
            ),
            "An aborted operation must publish neither source nor save receipt"
        );
    }
}

fn checkpoint(
    store: &Store,
    document: &Document,
    room: &Arc<Mutex<Room>>,
    peer: &mut Peer,
) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    let response = process_frame(
        store,
        document,
        room,
        &Message::Custom(124, id.as_bytes().to_vec()).encode_v1(),
        true,
        true,
        peer,
    )
    .unwrap();
    assert!(matches!(
        Message::decode_v1(&response[0]).unwrap(),
        Message::Custom(122, _)
    ));
    id
}

fn desktop_opener_during_intent(store: &Store, document: &Document) {
    opener_during_intent(store, document, true);
}

/// Break the real Linux lease at the intent transaction's final metadata
/// statement, immediately before the engine's last pre-write lease check.
/// O_NONBLOCK causes the opener to yield rather than wait for our own lease.
fn opener_during_intent(store: &Store, document: &Document, write: bool) {
    use rusqlite::functions::FunctionFlags;
    use std::os::unix::fs::OpenOptionsExt;
    let path = store.root.join(&document.path);
    let db = store.db.lock().unwrap();
    db.create_scalar_function(
        "break_projection_lease",
        0,
        FunctionFlags::SQLITE_UTF8,
        move |_| match fs::OpenOptions::new()
            .read(!write)
            .write(write)
            .custom_flags(libc::O_NONBLOCK)
            .open(&path)
        {
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => Ok(1),
            _ => Err(rusqlite::Error::UserFunctionError(Box::new(
                std::io::Error::other(
                    "The deterministic desktop opener must encounter the projection lease",
                ),
            ))),
        },
    )
    .unwrap();
    db.execute_batch(
        "CREATE TRIGGER desktop_opener BEFORE UPDATE OF write_intent ON docs
         WHEN NEW.write_intent=1 BEGIN SELECT break_projection_lease(); END;",
    )
    .unwrap();
}

#[test]
fn a_desktop_opener_before_the_first_byte_cancels_the_intent_and_merges_normally() {
    for restart in [false, true] {
        let (directory, store, document, room) = fixture("Original\r\nEnding\n");
        let mut peer = Peer::default();
        accepted(
            &store,
            &document,
            &room,
            &append(&replica(&room), "Browser line\n"),
            &mut peer,
        );
        checkpoint(&store, &document, &room, &mut peer);
        let mut events = room.lock().unwrap().tx.subscribe();
        desktop_opener_during_intent(&store, &document);
        assert!(!store.persist(&document, &mut room.lock().unwrap()).unwrap());
        assert_eq!(
            fs::read(store.root.join(&document.path)).unwrap(),
            b"Original\r\nEnding\n"
        );
        assert_no_source_or_receipt(&mut events);
        {
            let room = room.lock().unwrap();
            assert!(room.engine.waiting());
            assert!(
                !room.engine.interrupted(),
                "No bytes were written, so this is not an interrupted projection"
            );
            assert!(!room.engine.conflicted());
        }
        let (intent, target): (i64, Option<Vec<u8>>) = store
            .db
            .lock()
            .unwrap()
            .query_row(
                "SELECT write_intent,write_target FROM docs WHERE id=?",
                [&document.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            intent, 0,
            "Cancellation must be durable before releasing the lease"
        );
        assert!(target.is_none());
        store
            .db
            .lock()
            .unwrap()
            .execute_batch("DROP TRIGGER desktop_opener;")
            .unwrap();
        fs::write(store.root.join(&document.path), "Desktop\r\nEnding\n").unwrap();
        drop(events);
        let store = if restart {
            drop(room);
            drop(store);
            Store::open(
                directory.path().join("docs"),
                directory.path().join("state"),
                "http://localhost:3477".into(),
            )
            .unwrap()
        } else {
            store
        };
        let room = store.room(&document).unwrap();
        assert!(store.persist(&document, &mut room.lock().unwrap()).unwrap());
        let expected = "Desktop\nEnding\nBrowser line\n";
        assert_eq!(room_text(&room.lock().unwrap()), expected);
        assert_eq!(durable_source(&store, &document), expected);
        assert_eq!(
            text::canonical(&fs::read_to_string(store.root.join(&document.path)).unwrap()),
            expected
        );
        assert!(!room.lock().unwrap().conflicted());
    }
}

#[test]
fn a_desktop_reader_during_the_intent_waits_for_the_completed_projection() {
    let (_directory, store, document, room) = fixture("Original\nEnding\n");
    let mut peer = Peer::default();
    accepted(
        &store,
        &document,
        &room,
        &append(&replica(&room), "Browser line\n"),
        &mut peer,
    );
    let receipt = checkpoint(&store, &document, &room, &mut peer);
    let mut events = room.lock().unwrap().tx.subscribe();
    opener_during_intent(&store, &document, false);
    // A polling reader only needs consistent bytes. Its open waits for this
    // write instead of cancelling every projection that it happens to overlap.
    assert!(store.persist(&document, &mut room.lock().unwrap()).unwrap());
    assert_eq!(
        fs::read_to_string(store.root.join(&document.path)).unwrap(),
        "Original\nEnding\nBrowser line\n"
    );
    let mut acknowledged = false;
    while let Ok(frame) = events.try_recv() {
        if let Message::Custom(127, id) = Message::decode_v1(&frame).unwrap() {
            acknowledged |= id == receipt.as_bytes();
        }
    }
    assert!(
        acknowledged,
        "The save receipt follows the completed projection"
    );
    let room = room.lock().unwrap();
    assert!(!room.engine.waiting());
    assert!(!room.engine.interrupted());
    assert!(!room.engine.conflicted());
}

#[test]
fn a_rejected_intent_commit_does_not_invent_an_interrupted_write_in_the_live_room() {
    let (_directory, store, document, room) = fixture("Original\nEnding\n");
    let mut peer = Peer::default();
    accepted(
        &store,
        &document,
        &room,
        &append(&replica(&room), "Browser line\n"),
        &mut peer,
    );
    checkpoint(&store, &document, &room, &mut peer);
    let mut events = room.lock().unwrap().tx.subscribe();
    store
        .db
        .lock()
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER reject_unwritten_intent BEFORE UPDATE OF write_intent ON docs
         WHEN NEW.write_intent=1 BEGIN SELECT RAISE(ABORT,'simulated intent outage'); END;",
        )
        .unwrap();
    assert!(store.persist(&document, &mut room.lock().unwrap()).is_err());
    assert!(!room.lock().unwrap().engine.interrupted());
    assert_eq!(
        fs::read_to_string(store.root.join(&document.path)).unwrap(),
        "Original\nEnding\n"
    );
    assert_no_source_or_receipt(&mut events);
    store
        .db
        .lock()
        .unwrap()
        .execute_batch("DROP TRIGGER reject_unwritten_intent;")
        .unwrap();
    fs::write(store.root.join(&document.path), "Desktop\nEnding\n").unwrap();
    assert!(store.persist(&document, &mut room.lock().unwrap()).unwrap());
    assert_eq!(
        room_text(&room.lock().unwrap()),
        "Desktop\nEnding\nBrowser line\n"
    );
    assert_eq!(
        durable_source(&store, &document),
        "Desktop\nEnding\nBrowser line\n"
    );
    assert!(!room.lock().unwrap().conflicted());
}

#[test]
fn cancellation_commit_failures_retry_before_import_and_remain_conservative_across_crashes() {
    for restart in [false, true] {
        let (directory, store, document, room) = fixture("Original\nEnding\n");
        let mut peer = Peer::default();
        accepted(
            &store,
            &document,
            &room,
            &append(&replica(&room), "Browser line\n"),
            &mut peer,
        );
        checkpoint(&store, &document, &room, &mut peer);
        let mut events = room.lock().unwrap().tx.subscribe();
        desktop_opener_during_intent(&store, &document);
        store
            .db
            .lock()
            .unwrap()
            .execute_batch(
                "CREATE TRIGGER reject_cancellation BEFORE UPDATE OF write_intent ON docs
             WHEN OLD.write_intent=1 AND NEW.write_intent=0
             BEGIN SELECT RAISE(ABORT,'simulated cancellation outage'); END;",
            )
            .unwrap();
        assert!(store.persist(&document, &mut room.lock().unwrap()).is_err());
        {
            let mut room = room.lock().unwrap();
            assert!(!room.engine.interrupted());
            assert!(
                room.engine.needs_commit(),
                "The known cancellation must remain pending for retry"
            );
            assert!(
                room.ensure_committed(&store, &document).is_err(),
                "Readers cannot bypass an uncommitted cancellation"
            );
        }
        assert_eq!(
            fs::read_to_string(store.root.join(&document.path)).unwrap(),
            "Original\nEnding\n"
        );
        assert_no_source_or_receipt(&mut events);
        let durable_intent: i64 = store
            .db
            .lock()
            .unwrap()
            .query_row(
                "SELECT write_intent FROM docs WHERE id=?",
                [&document.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            durable_intent, 1,
            "A failed cancellation cannot erase the durable crash evidence"
        );
        store
            .db
            .lock()
            .unwrap()
            .execute_batch("DROP TRIGGER desktop_opener; DROP TRIGGER reject_cancellation;")
            .unwrap();
        let desktop = "Desktop\nEnding\n";
        fs::write(store.root.join(&document.path), desktop).unwrap();
        drop(events);
        let store = if restart {
            drop(room);
            drop(store);
            Store::open(
                directory.path().join("docs"),
                directory.path().join("state"),
                "http://localhost:3477".into(),
            )
            .unwrap()
        } else {
            store
        };
        let room = store.room(&document).unwrap();
        let saved = store.persist(&document, &mut room.lock().unwrap()).unwrap();
        if restart {
            assert!(!saved);
            assert!(room.lock().unwrap().conflicted());
            assert_eq!(
                room_text(&room.lock().unwrap()),
                "Original\nEnding\nBrowser line\n"
            );
            assert_eq!(
                fs::read_to_string(store.root.join(&document.path)).unwrap(),
                desktop
            );
        } else {
            assert!(saved);
            assert!(!room.lock().unwrap().conflicted());
            assert_eq!(
                room_text(&room.lock().unwrap()),
                "Desktop\nEnding\nBrowser line\n"
            );
        }
    }
}

#[test]
fn cancelling_a_recovery_retry_preserves_the_older_frozen_intent() {
    let (_directory, store, document, room) = fixture("Original\nEnding\n");
    let mut peer = Peer::default();
    accepted(
        &store,
        &document,
        &room,
        &append(&replica(&room), "Earlier browser line\n"),
        &mut peer,
    );
    {
        let mut room = room.lock().unwrap();
        let target = room_text(&room).into_bytes();
        room.freeze_projection(target);
        store.store_room(&document, &mut room).unwrap();
    }
    accepted(
        &store,
        &document,
        &room,
        &append(&replica(&room), "Latest browser line\n"),
        &mut peer,
    );
    let previous: (Vec<u8>, Vec<u8>, String) = store
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT write_target,write_state,write_before_hash FROM docs WHERE id=?",
            [&document.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    desktop_opener_during_intent(&store, &document);
    assert!(!store.persist(&document, &mut room.lock().unwrap()).unwrap());
    store
        .db
        .lock()
        .unwrap()
        .execute_batch("DROP TRIGGER desktop_opener;")
        .unwrap();
    let restored: (Vec<u8>, Vec<u8>, String) = store
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT write_target,write_state,write_before_hash FROM docs WHERE id=?",
            [&document.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        restored, previous,
        "Cancellation must restore the prior exact bytes and causal state"
    );
    assert!(room.lock().unwrap().engine.interrupted());
    assert!(!room.lock().unwrap().conflicted());
    assert_eq!(
        fs::read_to_string(store.root.join(&document.path)).unwrap(),
        "Original\nEnding\n"
    );
    assert!(store.persist(&document, &mut room.lock().unwrap()).unwrap());
    assert_eq!(
        room_text(&room.lock().unwrap()),
        "Original\nEnding\nEarlier browser line\nLatest browser line\n"
    );
}

#[test]
fn checkpoint_compaction_abort_preserves_the_previous_journal_and_retries_exactly_once() {
    let (_directory, store, document, room) = fixture("Base");
    let client = replica(&room);
    let mut peer = Peer::default();
    for _ in 0..127 {
        accepted(&store, &document, &room, &append(&client, "x"), &mut peer);
    }
    let previous = durable_source(&store, &document);
    assert_eq!(previous.len(), 131);
    let mut events = room.lock().unwrap().tx.subscribe();
    store.db.lock().unwrap().execute_batch(
        "CREATE TRIGGER reject_checkpoint_delete BEFORE DELETE ON doc_updates BEGIN SELECT RAISE(ABORT,'simulated checkpoint outage'); END;",
    ).unwrap();
    let last = append(&client, "Z");
    assert!(process_frame(&store, &document, &room, &last, true, true, &mut peer).is_err());
    assert_eq!(durable_source(&store, &document), previous);
    assert_eq!(
        fs::read_to_string(store.root.join(&document.path)).unwrap(),
        "Base"
    );
    assert_no_source_or_receipt(&mut events);
    store
        .db
        .lock()
        .unwrap()
        .execute_batch("DROP TRIGGER reject_checkpoint_delete;")
        .unwrap();
    accepted(&store, &document, &room, &last, &mut peer);
    let expected = format!("{previous}Z");
    assert_eq!(durable_source(&store, &document), expected);
    assert!(store.persist(&document, &mut room.lock().unwrap()).unwrap());
    store.rooms.lock().unwrap().remove(&document.id);
    drop(room);
    let reopened = store.room(&document).unwrap();
    assert_eq!(room_text(&reopened.lock().unwrap()), expected);
    assert_eq!(
        fs::read_to_string(store.root.join(&document.path)).unwrap(),
        expected
    );
}

#[test]
fn independent_peer_drafts_survive_a_rejected_commit_and_duplicate_retries() {
    let (directory, store, document, room) = fixture("Base\n");
    let a = append(&replica(&room), "Peer-A\n");
    let b = append(&replica(&room), "Peer-B\n");
    let mut peer_a = Peer::default();
    let mut peer_b = Peer::default();
    let mut events = room.lock().unwrap().tx.subscribe();
    store.db.lock().unwrap().execute_batch(
        "CREATE TRIGGER reject_first_delta BEFORE INSERT ON doc_updates BEGIN SELECT RAISE(ABORT,'simulated journal outage'); END;",
    ).unwrap();
    assert!(process_frame(&store, &document, &room, &a, true, true, &mut peer_a).is_err());
    assert_eq!(durable_source(&store, &document), "Base\n");
    assert_no_source_or_receipt(&mut events);
    store
        .db
        .lock()
        .unwrap()
        .execute_batch("DROP TRIGGER reject_first_delta;")
        .unwrap();
    // The other client has an independent base and may arrive before the
    // rejected client reconnects. Replayed deltas must remain idempotent.
    accepted(&store, &document, &room, &b, &mut peer_b);
    accepted(&store, &document, &room, &a, &mut peer_a);
    accepted(&store, &document, &room, &a, &mut peer_a);
    let expected = durable_source(&store, &document);
    for token in ["Base", "Peer-A", "Peer-B"] {
        assert_eq!(expected.matches(token).count(), 1);
    }
    let receipts = [
        checkpoint(&store, &document, &room, &mut peer_a),
        checkpoint(&store, &document, &room, &mut peer_b),
    ];
    assert!(store.persist(&document, &mut room.lock().unwrap()).unwrap());
    let mut saved = Vec::new();
    while let Ok(frame) = events.try_recv() {
        if let Message::Custom(127, id) = Message::decode_v1(&frame).unwrap() {
            saved.push(String::from_utf8(id).unwrap());
        }
    }
    assert_eq!(saved.len(), 2);
    for receipt in receipts {
        assert_eq!(saved.iter().filter(|id| **id == receipt).count(), 1);
    }
    drop(events);
    drop(room);
    drop(store);
    let reopened = Store::open(
        directory.path().join("docs"),
        directory.path().join("state"),
        "http://localhost:3477".into(),
    )
    .unwrap();
    reopened.recover_pending().unwrap();
    assert_eq!(durable_source(&reopened, &document), expected);
    assert_eq!(
        fs::read_to_string(reopened.root.join(&document.path)).unwrap(),
        expected
    );
}

#[test]
fn a_failed_write_intent_commit_never_touches_the_file_and_accepted_text_recovers() {
    for after_intent in [false, true] {
        let (directory, store, document, room) = fixture("Before\r\nUnchanged\n");
        let mut peer = Peer::default();
        accepted(
            &store,
            &document,
            &room,
            &append(&replica(&room), "Accepted browser line\n"),
            &mut peer,
        );
        let expected = durable_source(&store, &document);
        checkpoint(&store, &document, &room, &mut peer);
        let mut events = room.lock().unwrap().tx.subscribe();
        let trigger = if after_intent {
            "CREATE TRIGGER reject_write_intent BEFORE UPDATE OF write_intent ON docs WHEN NEW.write_intent=1 BEGIN SELECT RAISE(ABORT,'simulated intent metadata outage'); END;"
        } else {
            "CREATE TRIGGER reject_write_intent BEFORE UPDATE OF write_target ON docs WHEN NEW.write_target IS NOT NULL BEGIN SELECT RAISE(ABORT,'simulated intent target outage'); END;"
        };
        store.db.lock().unwrap().execute_batch(trigger).unwrap();
        assert!(store.persist(&document, &mut room.lock().unwrap()).is_err());
        assert_eq!(
            fs::read(store.root.join(&document.path)).unwrap(),
            b"Before\r\nUnchanged\n"
        );
        assert_eq!(durable_source(&store, &document), expected);
        let (intent, target): (bool, Option<Vec<u8>>) = store
            .db
            .lock()
            .unwrap()
            .query_row(
                "SELECT write_intent,write_target FROM docs WHERE id=?",
                [&document.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(!intent);
        assert!(
            target.is_none(),
            "An aborted intent transaction must be atomic"
        );
        assert_no_source_or_receipt(&mut events);
        drop(events);
        drop(room);
        drop(store);
        let reopened = Store::open(
            directory.path().join("docs"),
            directory.path().join("state"),
            "http://localhost:3477".into(),
        )
        .unwrap();
        reopened
            .db
            .lock()
            .unwrap()
            .execute_batch("DROP TRIGGER reject_write_intent;")
            .unwrap();
        reopened.recover_pending().unwrap();
        assert_eq!(durable_source(&reopened, &document), expected);
        assert_eq!(
            text::canonical(&fs::read_to_string(reopened.root.join(&document.path)).unwrap()),
            expected
        );
    }
}

#[test]
fn a_stale_room_cannot_accept_edits_or_receipts_after_its_identity_is_retired() {
    let (_directory, store, document, room) = fixture("Original identity\n");
    let frame = append(&replica(&room), "A stale browser edit\n");
    let mut events = room.lock().unwrap().tx.subscribe();
    // A request can retain a room handle while discovery retires its identity.
    // Model that exact database boundary without following a deliberate move
    // or creating another document with the same path.
    store
        .db
        .lock()
        .unwrap()
        .execute("UPDATE docs SET active=0 WHERE id=?", [&document.id])
        .unwrap();
    let mut peer = Peer::default();
    let receipt = uuid::Uuid::new_v4().to_string();
    assert!(
        process_frame(
            &store,
            &document,
            &room,
            &Message::Custom(124, receipt.into_bytes()).encode_v1(),
            true,
            true,
            &mut peer,
        )
        .is_err(),
        "A retired identity must never report a stale browser draft as saved"
    );
    assert!(
        process_frame(&store, &document, &room, &frame, true, true, &mut peer).is_err(),
        "The engine must validate live identity inside its commit boundary"
    );
    assert_no_source_or_receipt(&mut events);
    assert_eq!(durable_source(&store, &document), "Original identity\n");
    assert_eq!(
        fs::read_to_string(store.root.join(&document.path)).unwrap(),
        "Original identity\n"
    );
}

#[test]
fn a_cold_document_with_a_leased_file_retries_promptly_and_leaves_cached_documents_available() {
    use std::time::Duration;
    let (_directory, store, cached, _cached_room) = fixture("Already available\n");
    fs::write(store.root.join("cold.md"), "Cold document\n").unwrap();
    let cold = store.index_document("cold.md").unwrap();
    // Media initialization is a separate durable transaction. A process can
    // stop after it commits and before the initial CRDT checkpoint is stored.
    store
        .db
        .lock()
        .unwrap()
        .execute("UPDATE docs SET media_initialized=1 WHERE id=?", [&cold.id])
        .unwrap();
    let lease = disk::DiskFile::open(&store.root.join(&cold.path))
        .unwrap()
        .unwrap();
    let (cold_done, cold_result) = std::sync::mpsc::channel();
    let worker = store.clone();
    let cold_document = cold.clone();
    let cold_thread = std::thread::spawn(move || {
        let outcome = worker.room(&cold_document);
        cold_done
            .send(matches!(outcome, Err(ApiError(StatusCode::CONFLICT, _))))
            .unwrap();
    });
    let promptly_retryable = cold_result.recv_timeout(Duration::from_millis(500));
    let (cached_done, cached_result) = std::sync::mpsc::channel();
    let worker = store.clone();
    let cached_thread = std::thread::spawn(move || {
        cached_done.send(worker.room(&cached).is_ok()).unwrap();
    });
    let independently_available = cached_result.recv_timeout(Duration::from_millis(250));
    // Always release the kernel lease and join before reporting a failure.
    drop(lease);
    cold_thread.join().unwrap();
    cached_thread.join().unwrap();
    assert!(
        promptly_retryable.unwrap_or(false),
        "A cold leased file must return a retryable error without waiting for the lease timeout"
    );
    assert!(
        independently_available.unwrap_or(false),
        "A cold file open must not hold the global document cache map"
    );
    let reopened = store.room(&cold).unwrap();
    assert_eq!(room_text(&reopened.lock().unwrap()), "Cold document\n");
}

#[test]
fn simultaneous_cold_opens_share_one_authoritative_document_engine() {
    let (_directory, store, _cached, _cached_room) = fixture("Already available\n");
    fs::write(
        store.root.join("simultaneous.md"),
        "One authoritative source\n",
    )
    .unwrap();
    let document = store.index_document("simultaneous.md").unwrap();
    let start = Arc::new(std::sync::Barrier::new(5));
    let mut workers = Vec::new();
    for _ in 0..4 {
        let app = store.clone();
        let document = document.clone();
        let start = start.clone();
        workers.push(std::thread::spawn(move || {
            start.wait();
            app.room(&document).unwrap()
        }));
    }
    start.wait();
    let rooms = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect::<Vec<_>>();
    for room in &rooms {
        assert!(
            Arc::ptr_eq(room, &rooms[0]),
            "Concurrent cold opens must not fork the live CRDT"
        );
    }
    assert_eq!(
        room_text(&rooms[0].lock().unwrap()),
        "One authoritative source\n"
    );
}

#[test]
fn a_new_peer_edit_after_a_failed_final_commit_survives_crash_and_stale_desktop_import() {
    let (directory, store, document, room) = fixture("Opening\nEnding\n");
    let mut peer_a = Peer::default();
    accepted(
        &store,
        &document,
        &room,
        &append(&replica(&room), "Accepted-A\n"),
        &mut peer_a,
    );
    checkpoint(&store, &document, &room, &mut peer_a);
    let mut events = room.lock().unwrap().tx.subscribe();
    store.db.lock().unwrap().execute_batch(
        "CREATE TRIGGER reject_final_baseline BEFORE UPDATE OF disk_state ON docs BEGIN SELECT RAISE(ABORT,'simulated baseline outage'); END;",
    ).unwrap();
    assert!(store.persist(&document, &mut room.lock().unwrap()).is_err());
    assert_eq!(
        fs::read_to_string(store.root.join(&document.path)).unwrap(),
        "Opening\nEnding\nAccepted-A\n"
    );
    assert_no_source_or_receipt(&mut events);
    store
        .db
        .lock()
        .unwrap()
        .execute_batch("DROP TRIGGER reject_final_baseline;")
        .unwrap();
    let mut peer_b = Peer::default();
    accepted(
        &store,
        &document,
        &room,
        &append(&replica(&room), "Accepted-B\n"),
        &mut peer_b,
    );
    // A desktop editor opened before A was written, then saved after that
    // fsync. This complete external replacement must not erase accepted B.
    fs::write(
        store.root.join(&document.path),
        "Desktop opening\nEnding\nAccepted-A\n",
    )
    .unwrap();
    drop(events);
    drop(room);
    drop(store);
    let reopened = Store::open(
        directory.path().join("docs"),
        directory.path().join("state"),
        "http://localhost:3477".into(),
    )
    .unwrap();
    reopened.recover_pending().unwrap();
    let room = reopened.room(&document).unwrap();
    assert!(
        reopened
            .persist(&document, &mut room.lock().unwrap())
            .unwrap()
    );
    let recovered = room_text(&room.lock().unwrap());
    for token in ["Desktop opening", "Ending", "Accepted-A", "Accepted-B"] {
        assert_eq!(recovered.matches(token).count(), 1);
    }
    assert_eq!(durable_source(&reopened, &document), recovered);
    assert_eq!(
        fs::read_to_string(reopened.root.join(&document.path)).unwrap(),
        recovered
    );
}

#[tokio::test]
async fn desktop_changes_after_an_uncertain_projection_preserve_both_versions_for_explicit_recovery()
 {
    let (directory, store, document, room) = fixture("Opening\nEnding\n");
    accepted(
        &store,
        &document,
        &room,
        &append(&replica(&room), "Accepted browser line\n"),
        &mut Peer::default(),
    );
    store.db.lock().unwrap().execute_batch(
        "CREATE TRIGGER reject_crash_baseline BEFORE UPDATE OF disk_state ON docs BEGIN SELECT RAISE(ABORT,'simulated final commit outage'); END;",
    ).unwrap();
    assert!(store.persist(&document, &mut room.lock().unwrap()).is_err());
    let projected = fs::read_to_string(store.root.join(&document.path)).unwrap();
    assert_eq!(projected, "Opening\nEnding\nAccepted browser line\n");
    // The desktop app has read the fully fsynced file after Locdoc released its
    // lease. Its save includes the browser line, but SQLite still has the old
    // causal baseline because the final projection transaction failed.
    fs::write(
        store.root.join(&document.path),
        projected.replacen("Opening", "Desktop opening", 1),
    )
    .unwrap();
    drop(room);
    drop(store);
    let reopened = Store::open(
        directory.path().join("docs"),
        directory.path().join("state"),
        "http://localhost:3477".into(),
    )
    .unwrap();
    reopened
        .db
        .lock()
        .unwrap()
        .execute_batch("DROP TRIGGER reject_crash_baseline;")
        .unwrap();
    reopened.recover_pending().unwrap();
    let recovered = reopened.room(&document).unwrap();
    let source = room_text(&recovered.lock().unwrap());
    let accepted_source = "Opening\nEnding\nAccepted browser line\n";
    let desktop_source = "Desktop opening\nEnding\nAccepted browser line\n";
    assert_eq!(source, accepted_source);
    assert_eq!(durable_source(&reopened, &document), source);
    assert_eq!(
        fs::read_to_string(reopened.root.join(&document.path)).unwrap(),
        desktop_source
    );
    let mut events = recovered.lock().unwrap().tx.subscribe();
    assert!(
        !reopened
            .persist(&document, &mut recovered.lock().unwrap())
            .unwrap_or(false),
        "An unknown desktop causal base must not be guessed or acknowledged"
    );
    let response = process_frame(
        &reopened,
        &document,
        &recovered,
        &Message::Custom(124, uuid::Uuid::new_v4().to_string().into_bytes()).encode_v1(),
        true,
        true,
        &mut Peer::default(),
    );
    if let Ok(frames) = response {
        for frame in frames {
            assert!(
                !matches!(Message::decode_v1(&frame).unwrap(), Message::Custom(127, _)),
                "Conflicted projections must never acknowledge a save"
            );
        }
    }
    assert_no_source_or_receipt(&mut events);
    assert_eq!(durable_source(&reopened, &document), accepted_source);
    assert_eq!(
        fs::read_to_string(reopened.root.join(&document.path)).unwrap(),
        desktop_source
    );
    let archived = reopened.data.join("recovery").join(format!(
        "{}-{}.bin",
        document.id,
        hex::encode(Sha256::digest(desktop_source.as_bytes()))
    ));
    assert_eq!(fs::read(archived).unwrap(), desktop_source.as_bytes());
    let intent: i64 = reopened
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT write_intent FROM docs WHERE id=?",
            [&document.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        intent, 2,
        "Conflict must remain a distinct durable phase across restart"
    );
    drop(events);
    drop(recovered);
    drop(reopened);
    let reopened = Store::open(
        directory.path().join("docs"),
        directory.path().join("state"),
        "http://localhost:3477".into(),
    )
    .unwrap();
    reopened.recover_pending().unwrap();
    assert_eq!(
        room_text(&reopened.room(&document).unwrap().lock().unwrap()),
        accepted_source
    );
    assert_eq!(
        fs::read_to_string(reopened.root.join(&document.path)).unwrap(),
        desktop_source
    );
    let result = maintenance::rebuild(
        State(reopened.clone()),
        AxPath(document.id.clone()),
        security::Owner,
        Json(serde_json::from_value(json!({"source":"disk"})).unwrap()),
    )
    .await
    .unwrap()
    .0;
    let result = serde_json::to_value(result).unwrap();
    let archive: Value = serde_json::from_slice(
        &fs::read(reopened.data.join(result["archive"].as_str().unwrap())).unwrap(),
    )
    .unwrap();
    assert_eq!(archive["filesystemSource"], desktop_source);
    assert!(
        archive["versions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|version| version["content"] == accepted_source)
    );
    let resolved = reopened.room(&document).unwrap();
    assert_eq!(room_text(&resolved.lock().unwrap()), desktop_source);
    assert_eq!(durable_source(&reopened, &document), desktop_source);
}

fn owner_headers(store: &Store) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::AUTHORIZATION,
        format!("Bearer {}", store.key).parse().unwrap(),
    );
    headers.insert(
        header::COOKIE,
        format!("locdoc_guest={}", "a".repeat(64)).parse().unwrap(),
    );
    headers
}

#[tokio::test]
async fn aborted_comment_metadata_never_leaks_source_and_retry_is_idempotent_after_restart() {
    let (directory, store, document, room) = fixture("The selected passage.\n");
    let headers = owner_headers(&store);
    let request = uuid::Uuid::new_v4().to_string();
    let body = json!({"name":"Writer","body":"A durable note","requestId":request});
    let mut events = room.lock().unwrap().tx.subscribe();
    store.db.lock().unwrap().execute_batch(
        "CREATE TRIGGER reject_comment_metadata BEFORE INSERT ON comments BEGIN SELECT RAISE(ABORT,'simulated comment outage'); END;",
    ).unwrap();
    let result = comments::add(
        State(store.clone()),
        AxPath(document.id.clone()),
        Query(Access::default()),
        headers.clone(),
        Json(serde_json::from_value(body.clone()).unwrap()),
    )
    .await;
    assert!(result.is_err());
    assert_eq!(durable_source(&store, &document), "The selected passage.\n");
    assert_no_source_or_receipt(&mut events);
    assert!(
        document_payload(&store, &headers, &document, &Access::default()).is_err(),
        "A bootstrap must not bypass an uncommitted comment command"
    );
    let mut peer = Peer::default();
    assert!(
        process_frame(
            &store,
            &document,
            &room,
            &Message::Custom(124, uuid::Uuid::new_v4().to_string().into_bytes()).encode_v1(),
            true,
            true,
            &mut peer,
        )
        .is_err(),
        "A checkpoint must retry source and comment metadata as one command"
    );
    assert_no_source_or_receipt(&mut events);
    store
        .db
        .lock()
        .unwrap()
        .execute_batch("DROP TRIGGER reject_comment_metadata;")
        .unwrap();
    let mut comment_id = None;
    for _ in 0..2 {
        let result = comments::add(
            State(store.clone()),
            AxPath(document.id.clone()),
            Query(Access::default()),
            headers.clone(),
            Json(serde_json::from_value(body.clone()).unwrap()),
        )
        .await
        .unwrap()
        .0;
        let id = result["id"].as_str().unwrap().to_string();
        if let Some(previous) = &comment_id {
            assert_eq!(previous, &id);
        }
        comment_id = Some(id);
    }
    let reply_request = uuid::Uuid::new_v4().to_string();
    let reply = json!({"name":"Other writer","body":"A durable reply","requestId":reply_request});
    for _ in 0..2 {
        let _ = comments::edit(
            State(store.clone()),
            AxPath((document.id.clone(), comment_id.clone().unwrap())),
            Query(Access::default()),
            headers.clone(),
            Json(serde_json::from_value(reply.clone()).unwrap()),
        )
        .await
        .unwrap();
    }
    assert!(store.persist(&document, &mut room.lock().unwrap()).unwrap());
    let expected = room_text(&room.lock().unwrap());
    assert_eq!(
        expected
            .matches("[[comment(Writer): A durable note]]")
            .count(),
        1
    );
    assert_eq!(
        expected
            .matches("[[comment(Other writer): A durable reply]]")
            .count(),
        1
    );
    drop(events);
    drop(room);
    drop(store);
    let reopened = Store::open(
        directory.path().join("docs"),
        directory.path().join("state"),
        "http://localhost:3477".into(),
    )
    .unwrap();
    reopened.recover_pending().unwrap();
    let row: String = reopened
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT data FROM comments WHERE id=?",
            [comment_id.unwrap()],
            |r| r.get(0),
        )
        .unwrap();
    let row: Value = serde_json::from_str(&row).unwrap();
    let rows: i64 = reopened
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT count(*) FROM comments WHERE doc=?",
            [&document.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        rows, 1,
        "Retrying an aborted post must not leave an orphan metadata row"
    );
    assert_eq!(row["requestId"], request);
    assert_eq!(row["replyRequests"].as_array().unwrap().len(), 1);
    assert_eq!(row["replies"].as_array().unwrap().len(), 1);
    assert_eq!(durable_source(&reopened, &document), expected);
    assert_eq!(
        fs::read_to_string(reopened.root.join(&document.path)).unwrap(),
        expected
    );
}
