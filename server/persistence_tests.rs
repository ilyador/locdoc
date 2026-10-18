use super::*;
fn fixture() -> (tempfile::TempDir, App) {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::open(
        dir.path().join("docs"),
        dir.path().join("state"),
        "http://localhost".into(),
    )
    .unwrap();
    (dir, s)
}
fn update(room: &Arc<Mutex<Room>>, from: u32, remove: u32, insert: &str) -> Vec<u8> {
    let peer = Doc::with_options(Options {
        offset_kind: OffsetKind::Utf16,
        ..Options::default()
    });
    peer.transact_mut()
        .apply_update(
            Update::decode_v1(
                &room
                    .lock()
                    .unwrap()
                    .awareness
                    .doc()
                    .transact()
                    .encode_state_as_update_v1(&StateVector::default()),
            )
            .unwrap(),
        )
        .unwrap();
    let before = peer.transact().state_vector();
    let t = peer.get_or_insert_text("content");
    if remove != 0 {
        t.remove_range(&mut peer.transact_mut(), from, remove);
    }
    if !insert.is_empty() {
        t.insert(&mut peer.transact_mut(), from, insert);
    }
    Message::Sync(SyncMessage::Update(
        peer.transact().encode_state_as_update_v1(&before),
    ))
    .encode_v1()
}
fn apply(s: &Store, d: &Document, r: &Arc<Mutex<Room>>, from: u32, remove: u32, insert: &str) {
    let bytes = update(r, from, remove, insert);
    process_frame(s, d, r, &bytes, true, true, &mut Peer::default()).unwrap();
}
#[test]
fn crlf_files_have_canonical_positions_and_preserve_disk_endings() {
    let (_dir, s) = fixture();
    let path = s.root.join("windows.md");
    fs::write(&path, "Alpha\r\nBravo\r\nCharlie\r\n").unwrap();
    let d = s.index_document("windows.md").unwrap();
    let r = s.room(&d).unwrap();
    s.persist(&d, &mut r.lock().unwrap()).unwrap();
    assert_eq!(room_text(&r.lock().unwrap()), "Alpha\nBravo\nCharlie\n");
    apply(&s, &d, &r, 12, 0, "X");
    s.persist(&d, &mut r.lock().unwrap()).unwrap();
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "Alpha\r\nBravo\r\nXCharlie\r\n"
    );
    fs::write(&path, "Desktop\r\nNew line\r\n").unwrap();
    s.persist(&d, &mut r.lock().unwrap()).unwrap();
    assert_eq!(room_text(&r.lock().unwrap()), "Desktop\nNew line\n");
    apply(&s, &d, &r, 8, 0, "Y");
    s.persist(&d, &mut r.lock().unwrap()).unwrap();
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "Desktop\r\nYNew line\r\n"
    );
}
#[test]
fn mixed_line_endings_follow_existing_newlines_through_browser_edits_and_restart() {
    let (dir, s) = fixture();
    let path = s.root.join("mixed.md");
    fs::write(&path, "😀 A\r\nB\nC\rD\r\n").unwrap();
    let d = s.index_document("mixed.md").unwrap();
    let r = s.room(&d).unwrap();
    s.persist(&d, &mut r.lock().unwrap()).unwrap();
    apply(&s, &d, &r, 5, 0, "Inserted\n");
    apply(&s, &d, &r, 0, 0, "Prefix ");
    s.persist(&d, &mut r.lock().unwrap()).unwrap();
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "Prefix 😀 A\r\nInserted\r\nB\nC\rD\r\n"
    );
    // Delete one newline and insert another elsewhere. Existing LF and CR
    // separators must stay with their CRDT characters, rather than line numbers.
    apply(&s, &d, &r, 20, 1, "");
    s.persist(&d, &mut r.lock().unwrap()).unwrap();
    let before_restart = fs::read_to_string(&path).unwrap();
    drop(r);
    drop(s);
    let s = Store::open(
        dir.path().join("docs"),
        dir.path().join("state"),
        "http://localhost".into(),
    )
    .unwrap();
    let r = s.room(&d).unwrap();
    apply(&s, &d, &r, 0, 0, "Next ");
    s.persist(&d, &mut r.lock().unwrap()).unwrap();
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        format!("Next {before_restart}")
    );
    fs::write(&path, "Desktop\nSecond\r\nThird\r").unwrap();
    s.persist(&d, &mut r.lock().unwrap()).unwrap();
    apply(&s, &d, &r, 0, 0, "Web ");
    s.persist(&d, &mut r.lock().unwrap()).unwrap();
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "Web Desktop\nSecond\r\nThird\r"
    );
}
#[test]
fn first_mixed_ending_projection_recovers_its_exact_prewrite_bytes_after_a_crash() {
    let (dir, s) = fixture();
    let path = s.root.join("mixed-crash.md");
    let original = "First\r\nSecond\nThird\r";
    fs::write(&path, original).unwrap();
    let d = s.index_document("mixed-crash.md").unwrap();
    let r = s.room(&d).unwrap();
    s.persist(&d, &mut r.lock().unwrap()).unwrap();
    apply(&s, &d, &r, 0, 5, "Changed");
    {
        let mut room = r.lock().unwrap();
        let target = text::projection(
            room.awareness.doc(),
            room.engine.baseline(),
            room.engine.source(),
            &room_text(&room),
            room.engine.ending(),
        )
        .unwrap();
        room.freeze_observed_projection(target.into_bytes(), original.as_bytes());
        s.store_room(&d, &mut room).unwrap();
        let (digest, preimage): (String, Option<Vec<u8>>) =
            s.db.lock()
                .unwrap()
                .query_row(
                    "SELECT write_before_hash,write_before FROM docs WHERE id=?",
                    [&d.id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
        assert_eq!(digest, hex::encode(Sha256::digest(original.as_bytes())));
        assert!(
            preimage.is_none(),
            "ordinary writes must not store another full file copy"
        );
    }
    let mut torn = original.as_bytes().to_vec();
    torn[..3].copy_from_slice(b"Cha");
    fs::write(&path, &torn).unwrap();
    drop(r);
    drop(s);
    let s = Store::open(
        dir.path().join("docs"),
        dir.path().join("state"),
        "http://localhost".into(),
    )
    .unwrap();
    s.recover_pending().unwrap();
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "Changed\r\nSecond\nThird\r"
    );
    let room = s.room(&d).unwrap();
    assert_eq!(room_text(&room.lock().unwrap()), "Changed\nSecond\nThird\n");
    assert!(s.persist(&d, &mut room.lock().unwrap()).unwrap());
}
#[test]
fn repeated_crashes_preserve_exact_torn_preimages_when_new_edits_retarget_the_write() {
    let (dir, s) = fixture();
    let path = s.root.join("repeated-crash.md");
    let original = "Original\r\nSecond\nThird\r";
    fs::write(&path, original).unwrap();
    let d = s.index_document("repeated-crash.md").unwrap();
    let r = s.room(&d).unwrap();
    s.persist(&d, &mut r.lock().unwrap()).unwrap();
    apply(&s, &d, &r, 0, 8, "😀 First attempt");
    {
        let mut room = r.lock().unwrap();
        let target = text::projection(
            room.awareness.doc(),
            room.engine.baseline(),
            room.engine.source(),
            &room_text(&room),
            room.engine.ending(),
        )
        .unwrap();
        room.freeze_observed_projection(target.into_bytes(), original.as_bytes());
        s.store_room(&d, &mut room).unwrap();
    }
    let mut first_torn = original.as_bytes().to_vec();
    first_torn[..2].copy_from_slice(&"😀".as_bytes()[..2]);
    fs::write(&path, &first_torn).unwrap();
    drop(r);
    drop(s);
    let s = Store::open(
        dir.path().join("docs"),
        dir.path().join("state"),
        "http://localhost".into(),
    )
    .unwrap();
    let r = s.room(&d).unwrap();
    apply(&s, &d, &r, 0, 0, "Newest ");
    let expected;
    {
        let mut room = r.lock().unwrap();
        expected = text::projection(
            room.awareness.doc(),
            room.engine.baseline(),
            room.engine.source(),
            &room_text(&room),
            room.engine.ending(),
        )
        .unwrap();
        room.freeze_observed_projection(expected.as_bytes().to_vec(), &first_torn);
        s.store_room(&d, &mut room).unwrap();
        assert_eq!(room.engine.before(), Some(first_torn.as_slice()));
    }
    let mut second_torn = first_torn;
    second_torn[0] = expected.as_bytes()[0];
    fs::write(&path, &second_torn).unwrap();
    assert!(
        String::from_utf8(second_torn).is_err(),
        "fixture must include an interrupted UTF-8 scalar"
    );
    drop(r);
    drop(s);
    let s = Store::open(
        dir.path().join("docs"),
        dir.path().join("state"),
        "http://localhost".into(),
    )
    .unwrap();
    s.recover_pending().unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), expected);
    let room = s.room(&d).unwrap();
    assert_eq!(room_text(&room.lock().unwrap()), text::canonical(&expected));
    let retained: bool = s
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT write_before IS NOT NULL OR write_before_hash IS NOT NULL FROM docs WHERE id=?",
            [&d.id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        !retained,
        "successful projection must release the exceptional preimage"
    );
}
#[test]
fn accepted_delta_replays_on_startup_without_a_browser_open() {
    let (dir, s) = fixture();
    let path = s.root.join("pending.md");
    fs::write(&path, "Original").unwrap();
    let d = s.index_document("pending.md").unwrap();
    let r = s.room(&d).unwrap();
    s.persist(&d, &mut r.lock().unwrap()).unwrap();
    apply(&s, &d, &r, 8, 0, " Browser");
    assert_eq!(fs::read_to_string(&path).unwrap(), "Original");
    let bytes: i64 =
        s.db.lock()
            .unwrap()
            .query_row(
                "SELECT sum(length(content)) FROM doc_updates WHERE doc=?",
                [&d.id],
                |row| row.get(0),
            )
            .unwrap();
    assert!(bytes < 200, "small edits must append bounded deltas");
    drop(r);
    drop(s);
    let s = Store::open(
        dir.path().join("docs"),
        dir.path().join("state"),
        "http://localhost".into(),
    )
    .unwrap();
    s.recover_pending().unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "Original Browser");
}
#[test]
fn delete_only_deltas_survive_restarts_and_checkpoint_compaction() {
    let (dir, s) = fixture();
    let path = s.root.join("delete.md");
    fs::write(&path, "abc").unwrap();
    let d = s.index_document("delete.md").unwrap();
    let r = s.room(&d).unwrap();
    s.persist(&d, &mut r.lock().unwrap()).unwrap();
    apply(&s, &d, &r, 1, 1, "");
    drop(r);
    drop(s);
    let s = Store::open(
        dir.path().join("docs"),
        dir.path().join("state"),
        "http://localhost".into(),
    )
    .unwrap();
    s.recover_pending().unwrap();
    let r = s.room(&d).unwrap();
    assert_eq!(room_text(&r.lock().unwrap()), "ac");
    for _ in 0..140 {
        apply(&s, &d, &r, 1, 0, "x");
        s.persist(&d, &mut r.lock().unwrap()).unwrap();
    }
    assert!(r.lock().unwrap().journal_len() < 128);
    let expected = room_text(&r.lock().unwrap());
    drop(r);
    drop(s);
    let s = Store::open(
        dir.path().join("docs"),
        dir.path().join("state"),
        "http://localhost".into(),
    )
    .unwrap();
    assert_eq!(room_text(&s.room(&d).unwrap().lock().unwrap()), expected);
}
#[test]
fn protected_recovery_is_not_evicted_by_fifty_normal_autosaves() {
    let (_dir, s) = fixture();
    let d = s.create_document("history.md").unwrap();
    s.snapshot(&d, "Recovery browser version", true).unwrap();
    for i in 0..70 {
        s.db.lock()
            .unwrap()
            .execute(
                "UPDATE revisions SET created=0 WHERE doc=? AND kind='autosave'",
                [&d.id],
            )
            .unwrap();
        s.snapshot(&d, &format!("Desktop save {i}"), false).unwrap();
    }
    let count: i64 =
        s.db.lock()
            .unwrap()
            .query_row(
                "SELECT count(*) FROM revisions WHERE doc=? AND content='Recovery browser version'",
                [&d.id],
                |r| r.get(0),
            )
            .unwrap();
    assert_eq!(count, 1);
}
#[test]
fn large_unrelated_rewrite_is_exact_and_has_a_diff_deadline() {
    let old = "abcde12345\n".repeat(10_000);
    let new = "98765zyxwv\n".repeat(10_000);
    let doc = Doc::with_options(Options {
        offset_kind: OffsetKind::Utf16,
        ..Options::default()
    });
    apply_text(&doc, "", &old);
    let start = std::time::Instant::now();
    apply_text(&doc, &old, &new);
    assert_eq!(
        doc.get_or_insert_text("content")
            .get_string(&doc.transact()),
        new
    );
    assert!(
        start.elapsed() < std::time::Duration::from_secs(3),
        "rewrite exceeded bounded reconciliation budget"
    );
}

#[test]
fn startup_recovery_repairs_torn_utf8_and_preserves_exact_observed_bytes() {
    let (dir, s) = fixture();
    let path = s.root.join("torn.md");
    fs::write(&path, "Old text").unwrap();
    let d = s.index_document("torn.md").unwrap();
    let r = s.room(&d).unwrap();
    s.persist(&d, &mut r.lock().unwrap()).unwrap();
    apply(&s, &d, &r, 0, 8, "😀 intended");
    {
        let mut room = r.lock().unwrap();
        let target = text::render(&room_text(&room), room.engine.ending()).into_bytes();
        room.freeze_projection(target);
        s.store_room(&d, &mut room).unwrap();
    }
    // A process interruption after only the first two bytes of a UTF-8 scalar.
    let mut observed = b"Old text".to_vec();
    observed[..2].copy_from_slice(&"😀".as_bytes()[..2]);
    fs::write(&path, &observed).unwrap();
    drop(r);
    drop(s);
    let s = Store::open(
        dir.path().join("docs"),
        dir.path().join("state"),
        "http://localhost".into(),
    )
    .unwrap();
    s.recover_pending().unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "😀 intended");
    let archive = fs::read_dir(s.data.join("recovery"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert_eq!(fs::read(archive).unwrap(), observed);
}
#[test]
fn desktop_save_after_an_interruption_preserves_both_branches_for_owner_recovery() {
    let (dir, s) = fixture();
    let path = s.root.join("after-crash.md");
    fs::write(&path, "First\nLast\n").unwrap();
    let d = s.index_document("after-crash.md").unwrap();
    let r = s.room(&d).unwrap();
    s.persist(&d, &mut r.lock().unwrap()).unwrap();
    apply(&s, &d, &r, 6, 0, "Browser\n");
    {
        let mut room = r.lock().unwrap();
        let target = text::render(&room_text(&room), room.engine.ending()).into_bytes();
        room.freeze_projection(target);
        s.store_room(&d, &mut room).unwrap();
    }
    fs::write(&path, "First\nDesktop last\n").unwrap();
    drop(r);
    drop(s);
    let s = Store::open(
        dir.path().join("docs"),
        dir.path().join("state"),
        "http://localhost".into(),
    )
    .unwrap();
    s.recover_pending().unwrap();
    let desktop = "First\nDesktop last\n";
    let accepted = "First\nBrowser\nLast\n";
    assert_eq!(fs::read_to_string(&path).unwrap(), desktop);
    let room = s.room(&d).unwrap();
    assert_eq!(room_text(&room.lock().unwrap()), accepted);
    assert_eq!(
        room_text(&room.lock().unwrap())
            .matches("Browser\n")
            .count(),
        1
    );
    assert!(room.lock().unwrap().conflicted());
    assert!(!s.persist(&d, &mut room.lock().unwrap()).unwrap());
    let phase: i64 =
        s.db.lock()
            .unwrap()
            .query_row("SELECT write_intent FROM docs WHERE id=?", [&d.id], |row| {
                row.get(0)
            })
            .unwrap();
    assert_eq!(
        phase, 2,
        "The unresolved causal base must be a durable conflict"
    );
    let protected: Vec<String> =
        s.db.lock()
            .unwrap()
            .prepare("SELECT content FROM revisions WHERE doc=? AND kind='recovery'")
            .unwrap()
            .query_map([&d.id], |row| row.get(0))
            .unwrap()
            .collect::<std::result::Result<_, _>>()
            .unwrap();
    assert!(protected.iter().any(|source| source == accepted));
    assert!(protected.iter().any(|source| source == desktop));
    let archive = s.data.join("recovery").join(format!(
        "{}-{}.bin",
        d.id,
        hex::encode(Sha256::digest(desktop.as_bytes()))
    ));
    assert_eq!(fs::read(archive).unwrap(), desktop.as_bytes());
    assert_eq!(fs::read_to_string(&path).unwrap(), desktop);
}
#[test]
fn repeated_desktop_autosaves_do_not_replace_the_only_browser_recovery_generation() {
    let (_dir, s) = fixture();
    let path = s.root.join("protected.md");
    fs::write(&path, "Start").unwrap();
    let d = s.index_document("protected.md").unwrap();
    let r = s.room(&d).unwrap();
    s.persist(&d, &mut r.lock().unwrap()).unwrap();
    apply(&s, &d, &r, 5, 0, " Browser");
    s.persist(&d, &mut r.lock().unwrap()).unwrap();
    for i in 0..70 {
        fs::write(&path, format!("Desktop save {i}")).unwrap();
        s.persist(&d, &mut r.lock().unwrap()).unwrap();
    }
    let count:i64=s.db.lock().unwrap().query_row("SELECT count(*) FROM revisions WHERE doc=? AND kind='recovery' AND content='Start Browser'",[&d.id],|r|r.get(0)).unwrap();
    assert_eq!(count, 1);
}
