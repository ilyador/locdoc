use super::*;

fn fixture(source: &str) -> (tempfile::TempDir, App, Document) {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(
        directory.path().join("docs"),
        directory.path().join("state"),
        "http://localhost:3477".into(),
    )
    .unwrap();
    fs::write(store.root.join("interrupted.md"), source).unwrap();
    let document = store.index_document("interrupted.md").unwrap();
    (directory, store, document)
}

fn replace_frame(room: &Arc<Mutex<Room>>, source: &str) -> Vec<u8> {
    let room = room.lock().unwrap();
    let current = room_text(&room);
    let peer = Doc::with_options(Options {
        offset_kind: OffsetKind::Utf16,
        ..Options::default()
    });
    peer.transact_mut()
        .apply_update(
            Update::decode_v1(
                &room
                    .awareness
                    .doc()
                    .transact()
                    .encode_state_as_update_v1(&StateVector::default()),
            )
            .unwrap(),
        )
        .unwrap();
    let before = peer.transact().state_vector();
    apply_text(&peer, &current, source);
    Message::Sync(SyncMessage::Update(
        peer.transact().encode_state_as_update_v1(&before),
    ))
    .encode_v1()
}

fn accepted_edit(store: &Store, document: &Document, room: &Arc<Mutex<Room>>, source: &str) {
    let frame = replace_frame(room, source);
    process_frame(
        store,
        document,
        room,
        &frame,
        true,
        true,
        &mut Peer::default(),
    )
    .unwrap();
}

fn interrupted_projection(store: &Store, document: &Document, room: &Arc<Mutex<Room>>) {
    let mut room = room.lock().unwrap();
    let intended = text::render(&room_text(&room), room.engine.ending());
    room.freeze_projection(intended.into_bytes());
    store.store_room(document, &mut room).unwrap();
}

#[test]
fn interrupted_projection_uses_its_frozen_target_after_newer_prepend_or_replace() {
    for restart in [false, true] {
        for latest in [
            "New introduction.\nOriginal line and first browser edit.",
            "Completely rewritten accepted source.",
        ] {
            let (directory, store, document) = fixture("Original line");
            let room = store.room(&document).unwrap();
            store.persist(&document, &mut room.lock().unwrap()).unwrap();
            accepted_edit(
                &store,
                &document,
                &room,
                "Original line and first browser edit.",
            );
            interrupted_projection(&store, &document, &room);
            let torn = b"Original line and f";
            fs::write(store.root.join(&document.path), torn).unwrap();
            accepted_edit(&store, &document, &room, latest);
            assert!(room.lock().unwrap().engine.interrupted());
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
            store.recover_pending().unwrap();
            let room = store.room(&document).unwrap();
            assert_eq!(room_text(&room.lock().unwrap()), latest);
            assert_eq!(
                fs::read(store.root.join(&document.path)).unwrap(),
                latest.as_bytes()
            );
            let archived = store.data.join("recovery").join(format!(
                "{}-{}.bin",
                document.id,
                hex::encode(Sha256::digest(torn))
            ));
            assert_eq!(fs::read(archived).unwrap(), torn);
            assert!(store.persist(&document, &mut room.lock().unwrap()).unwrap());
            assert!(!room.lock().unwrap().engine.needs_projection());
        }
    }
}

#[test]
fn a_failed_commit_after_recovering_a_frozen_projection_remains_restart_safe() {
    let (directory, store, document) = fixture("Original line");
    let room = store.room(&document).unwrap();
    store.persist(&document, &mut room.lock().unwrap()).unwrap();
    accepted_edit(
        &store,
        &document,
        &room,
        "Original line and first browser edit.",
    );
    interrupted_projection(&store, &document, &room);
    fs::write(store.root.join(&document.path), b"Original line and f").unwrap();
    let latest = "New introduction.\nOriginal line and first browser edit.";
    accepted_edit(&store, &document, &room, latest);
    let receipt = uuid::Uuid::new_v4().to_string();
    process_frame(
        &store,
        &document,
        &room,
        &Message::Custom(124, receipt.as_bytes().to_vec()).encode_v1(),
        true,
        true,
        &mut Peer::default(),
    )
    .unwrap();
    let mut received = room.lock().unwrap().tx.subscribe();
    store.db.lock().unwrap().execute_batch(
        "CREATE TRIGGER fail_frozen_baseline BEFORE UPDATE OF disk_state ON docs BEGIN SELECT RAISE(ABORT,'test final commit failure'); END;"
    ).unwrap();
    assert!(store.persist(&document, &mut room.lock().unwrap()).is_err());
    assert_eq!(
        fs::read_to_string(store.root.join(&document.path)).unwrap(),
        latest
    );
    assert!(room.lock().unwrap().engine.needs_projection());
    while let Ok(message) = received.try_recv() {
        assert!(!matches!(
            Message::decode_v1(&message).unwrap(),
            Message::Custom(127, _)
        ));
    }
    drop(received);
    drop(room);
    drop(store);
    let store = Store::open(
        directory.path().join("docs"),
        directory.path().join("state"),
        "http://localhost:3477".into(),
    )
    .unwrap();
    store.recover_pending().unwrap();
    assert!(
        store.room(&document).is_err(),
        "a room with uncommitted recovery metadata is not exposed"
    );
    let interrupted: bool = store
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
        interrupted,
        "recovery remains durably pending while its baseline commit is blocked"
    );
    store
        .db
        .lock()
        .unwrap()
        .execute_batch("DROP TRIGGER fail_frozen_baseline;")
        .unwrap();
    store.recover_pending().unwrap();
    assert_eq!(
        fs::read_to_string(store.root.join(&document.path)).unwrap(),
        latest
    );
    let room = store.room(&document).unwrap();
    assert_eq!(room_text(&room.lock().unwrap()), latest);
    assert!(store.persist(&document, &mut room.lock().unwrap()).unwrap());
    assert!(!room.lock().unwrap().engine.needs_projection());
}
