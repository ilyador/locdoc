use super::*;
use yrs::{Assoc, IndexedSequence};

fn fixture(source: &str) -> (tempfile::TempDir, App, Document) {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(
        directory.path().join("docs"),
        directory.path().join("state"),
        "http://localhost:3477".into(),
    )
    .unwrap();
    fs::write(store.root.join("test.md"), source).unwrap();
    let document = store.index_document("test.md").unwrap();
    (directory, store, document)
}

fn epoch(store: &Store, id: &str) -> String {
    store
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT collaboration_epoch FROM docs WHERE id=?",
            [id],
            |row| row.get(0),
        )
        .unwrap()
}

fn anchor(document: &Doc, position: u32, assoc: Assoc) -> Value {
    let text = document.get_or_insert_text("content");
    json!(
        text.sticky_index(&document.transact(), position, assoc)
            .unwrap()
    )
}

#[test]
fn rebuilding_refuses_active_clients_and_preserves_anchored_comment_metadata() {
    let source = "Keep this line.\n\n[[comment(ana): A note]]\n";
    let (_directory, store, document) = fixture(source);
    let room = store.room(&document).unwrap();
    store.persist(&document, &mut room.lock().unwrap()).unwrap();
    let metadata = {
        let room = room.lock().unwrap();
        let doc = room.awareness.doc();
        json!({"id":"stable-thread", "guest":"owner", "name":"ana", "body":"A note", "created":42, "resolved":true,
            "source":anchor(doc,source.find("[[comment").unwrap() as u32,Assoc::After),
            "anchor":{"start":anchor(doc,0,Assoc::After),"end":anchor(doc,4,Assoc::Before)},
            "quote":"Keep", "replies":[]})
    };
    store
        .db
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO comments(id,doc,guest,data) VALUES(?,?,?,?)",
            params!["stable-thread", document.id, "owner", metadata.to_string()],
        )
        .unwrap();
    let connection = room.lock().unwrap().tx.subscribe();
    assert_eq!(
        rebuild_document(&store, &document.id, RebuildSource::Durable)
            .unwrap_err()
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(epoch(&store, &document.id), "");
    drop(connection);
    drop(room);
    let result = rebuild_document(&store, &document.id, RebuildSource::Durable).unwrap();
    assert_ne!(result.collaboration_epoch, "");
    assert_eq!(result.preserved_comments, 1);
    assert_eq!(result.archived_comments, 0);
    let archive: Value =
        serde_json::from_slice(&fs::read(store.data.join(result.archive)).unwrap()).unwrap();
    assert_eq!(archive["comments"][0]["data"], metadata.to_string());
    let stored: String = store
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT data FROM comments WHERE id='stable-thread'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let stored: Value = serde_json::from_str(&stored).unwrap();
    assert_eq!(stored["created"], 42);
    assert_eq!(stored["resolved"], true);
    assert_ne!(stored["source"], metadata["source"]);
    let reopened = store.room(&document).unwrap();
    assert_eq!(room_text(&reopened.lock().unwrap()), source);
    assert_eq!(
        fs::read_to_string(store.root.join("test.md")).unwrap(),
        source
    );
}

#[test]
fn corrupt_state_requires_explicit_disk_choice_and_archives_every_opaque_byte() {
    let (_directory, store, document) = fixture("Desktop\r\nsource\r\n");
    let state = vec![255_u8, 128, 1];
    let baseline = vec![128_u8];
    let journal = vec![255_u8, 255];
    {
        let db = store.db.lock().unwrap();
        db.execute(
            "UPDATE docs SET state=?,disk_state=? WHERE id=?",
            params![state, baseline, document.id],
        )
        .unwrap();
        db.execute(
            "INSERT INTO doc_updates(doc,content) VALUES(?,?)",
            params![document.id, journal],
        )
        .unwrap();
        db.execute(
            "INSERT INTO comments(id,doc,guest,data) VALUES('opaque',?,'guest','not-json')",
            [&document.id],
        )
        .unwrap();
    }
    assert_eq!(
        rebuild_document(&store, &document.id, RebuildSource::Durable)
            .unwrap_err()
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(epoch(&store, &document.id), "");
    let result = rebuild_document(&store, &document.id, RebuildSource::Disk).unwrap();
    assert_eq!(result.preserved_comments, 0);
    assert_eq!(result.archived_comments, 1);
    let archive = store.data.join(&result.archive);
    assert_eq!(
        fs::metadata(&archive).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let bundle: Value = serde_json::from_slice(&fs::read(archive).unwrap()).unwrap();
    assert_eq!(
        BASE64.decode(bundle["state"].as_str().unwrap()).unwrap(),
        state
    );
    assert_eq!(
        BASE64
            .decode(bundle["diskState"].as_str().unwrap())
            .unwrap(),
        baseline
    );
    assert_eq!(
        BASE64
            .decode(bundle["updates"][0]["state"].as_str().unwrap())
            .unwrap(),
        journal
    );
    assert_eq!(bundle["comments"][0]["data"], "not-json");
    assert_eq!(bundle["filesystemSource"], "Desktop\r\nsource\r\n");
    let room = store.room(&document).unwrap();
    assert_eq!(room_text(&room.lock().unwrap()), "Desktop\nsource\n");
    assert_eq!(
        fs::read_to_string(store.root.join("test.md")).unwrap(),
        "Desktop\r\nsource\r\n"
    );
}

#[test]
fn corrupt_client_ids_in_saved_state_baseline_or_journal_fail_safely_and_allow_disk_rebuild() {
    fn var(out: &mut Vec<u8>, mut value: u64) {
        while value >= 128 {
            out.push(value as u8 | 128);
            value >>= 7;
        }
        out.push(value as u8);
    }
    let mut corrupt = vec![1, 1];
    // Yrs ClientID supports 53 bits. Its constructor asserts in debug and
    // masks upper bits in release, so this must be refused before decoding.
    var(&mut corrupt, 1u64 << 53);
    corrupt.extend([0, 4, 1, 7]);
    corrupt.extend(b"content");
    corrupt.extend([1, b'x', 0]);
    for target in ["state", "baseline", "journal"] {
        let (_directory, store, document) = fixture("Desktop source\n");
        let room = store.room(&document).unwrap();
        store.persist(&document, &mut room.lock().unwrap()).unwrap();
        store.rooms.lock().unwrap().remove(&document.id);
        drop(room);
        {
            let db = store.db.lock().unwrap();
            match target {
                "state" => {
                    db.execute(
                        "UPDATE docs SET state=? WHERE id=?",
                        params![corrupt, document.id],
                    )
                    .unwrap();
                }
                "baseline" => {
                    db.execute(
                        "UPDATE docs SET disk_state=? WHERE id=?",
                        params![corrupt, document.id],
                    )
                    .unwrap();
                }
                _ => {
                    db.execute(
                        "INSERT INTO doc_updates(doc,content) VALUES(?,?)",
                        params![document.id, corrupt],
                    )
                    .unwrap();
                }
            }
        }
        let open = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| store.room(&document)));
        assert!(
            open.is_ok(),
            "Corrupt {target} must not panic while decoding"
        );
        assert!(
            open.unwrap().is_err(),
            "Corrupt {target} must not open as aliased state"
        );
        let recovery =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| store.recover_pending()));
        assert!(
            recovery.is_ok(),
            "Corrupt {target} must not panic during startup recovery"
        );
        assert!(
            recovery.unwrap().is_ok(),
            "Startup recovery isolates an invalid document"
        );
        assert!(rebuild_document(&store, &document.id, RebuildSource::Durable).is_err());
        let result = rebuild_document(&store, &document.id, RebuildSource::Disk).unwrap();
        let archive: Value =
            serde_json::from_slice(&fs::read(store.data.join(result.archive)).unwrap()).unwrap();
        let original = match target {
            "state" => archive["state"].as_str().unwrap(),
            "baseline" => archive["diskState"].as_str().unwrap(),
            _ => archive["updates"][0]["state"].as_str().unwrap(),
        };
        assert_eq!(BASE64.decode(original).unwrap(), corrupt);
        let reopened = store.room(&document).unwrap();
        assert_eq!(room_text(&reopened.lock().unwrap()), "Desktop source\n");
        assert_eq!(
            fs::read_to_string(store.root.join("test.md")).unwrap(),
            "Desktop source\n"
        );
    }
}

#[test]
fn zero_length_saved_structures_are_isolated_and_rebuildable_without_losing_raw_state() {
    let malformed = vec![1, 1, 1, 0, 0, 0, 0];
    for target in ["state", "baseline", "journal"] {
        let (_directory, store, document) = fixture("Recoverable desktop source\n");
        let room = store.room(&document).unwrap();
        store.persist(&document, &mut room.lock().unwrap()).unwrap();
        store.rooms.lock().unwrap().remove(&document.id);
        drop(room);
        let sql = match target {
            "state" => "UPDATE docs SET state=? WHERE id=?",
            "baseline" => "UPDATE docs SET disk_state=? WHERE id=?",
            _ => "INSERT INTO doc_updates(content,doc) VALUES(?,?)",
        };
        store
            .db
            .lock()
            .unwrap()
            .execute(sql, params![malformed, document.id])
            .unwrap();
        assert!(
            store.room(&document).is_err(),
            "Malformed {target} must never become a live room"
        );
        store.recover_pending().unwrap();
        let result = rebuild_document(&store, &document.id, RebuildSource::Disk).unwrap();
        let archive: Value =
            serde_json::from_slice(&fs::read(store.data.join(result.archive)).unwrap()).unwrap();
        let saved = match target {
            "state" => archive["state"].as_str().unwrap(),
            "baseline" => archive["diskState"].as_str().unwrap(),
            _ => archive["updates"][0]["state"].as_str().unwrap(),
        };
        assert_eq!(BASE64.decode(saved).unwrap(), malformed);
        assert_eq!(
            room_text(&store.room(&document).unwrap().lock().unwrap()),
            "Recoverable desktop source\n"
        );
    }
}

#[test]
fn recovery_export_preserves_invalid_utf8_file_bytes_without_decoding_state() {
    let (_directory, store, document) = fixture("Source");
    let bytes = vec![b'a', 255, b'\n'];
    fs::write(store.root.join("test.md"), &bytes).unwrap();
    let bundle = capture(&store, &document, Ok(bytes.clone()), None).unwrap();
    assert_eq!(
        BASE64.decode(bundle.filesystem_bytes.unwrap()).unwrap(),
        bytes
    );
    assert!(bundle.filesystem_source.is_none());
    assert!(bundle.filesystem_error.is_some());
    assert_eq!(
        rebuild_document(&store, &document.id, RebuildSource::Disk)
            .unwrap_err()
            .0,
        StatusCode::CONFLICT
    );
}

#[test]
fn invalid_historical_schema_is_rejected_before_durable_recovery_projects_source() {
    let (_directory, store, document) = fixture("Keep the desktop file");
    let baseline = Doc::with_options(Options {
        offset_kind: OffsetKind::Utf16,
        ..Options::default()
    });
    baseline.get_or_insert_text("content").insert(
        &mut baseline.transact_mut(),
        0,
        "Keep the desktop file",
    );
    let invalid = Doc::with_options(Options {
        offset_kind: OffsetKind::Utf16,
        ..Options::default()
    });
    invalid.get_or_insert_text("content").insert(
        &mut invalid.transact_mut(),
        0,
        "Do not project this source",
    );
    invalid.get_or_insert_text("unexpected").insert(
        &mut invalid.transact_mut(),
        0,
        "invisible root",
    );
    store
        .db
        .lock()
        .unwrap()
        .execute(
            "UPDATE docs SET state=?,disk_state=? WHERE id=?",
            params![
                invalid
                    .transact()
                    .encode_state_as_update_v1(&StateVector::default()),
                baseline
                    .transact()
                    .encode_state_as_update_v1(&StateVector::default()),
                document.id,
            ],
        )
        .unwrap();
    assert_eq!(
        rebuild_document(&store, &document.id, RebuildSource::Durable)
            .unwrap_err()
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        fs::read_to_string(store.root.join("test.md")).unwrap(),
        "Keep the desktop file"
    );
    assert_eq!(epoch(&store, &document.id), "");
    assert!(rebuild_document(&store, &document.id, RebuildSource::Disk).is_ok());
}

#[test]
fn failed_rebuild_transaction_keeps_original_state_and_the_fsynced_archive() {
    let (_directory, store, document) = fixture("Source");
    store.db.lock().unwrap().execute_batch("CREATE TRIGGER fail_rebuild BEFORE UPDATE ON docs BEGIN SELECT RAISE(ABORT,'simulated outage'); END;").unwrap();
    assert!(rebuild_document(&store, &document.id, RebuildSource::Disk).is_err());
    assert_eq!(epoch(&store, &document.id), "");
    let archive = fs::read_dir(store.data.join("recovery"))
        .unwrap()
        .collect::<std::result::Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(archive.len(), 1);
    let bundle: Value = serde_json::from_slice(&fs::read(archive[0].path()).unwrap()).unwrap();
    assert!(bundle["state"].is_null());
    assert_eq!(bundle["filesystemSource"], "Source");
    assert_eq!(
        fs::read_to_string(store.root.join("test.md")).unwrap(),
        "Source"
    );
}

#[tokio::test]
async fn recovery_routes_are_owner_only_even_when_the_document_has_a_public_link() {
    let (_directory, store, document) = fixture("Private source");
    store
        .db
        .lock()
        .unwrap()
        .execute(
            "UPDATE docs SET permission='edit',token='public-capability' WHERE id=?",
            [&document.id],
        )
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let application = router(store.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, application).await.unwrap();
    });
    let client = reqwest::Client::new();
    for suffix in ["recovery", "rebuild"] {
        let url = format!(
            "{base}/api/docs/{}/{suffix}?token=public-capability",
            document.id
        );
        let response = if suffix == "recovery" {
            client.get(&url).send().await.unwrap()
        } else {
            client
                .post(&url)
                .header(header::CONTENT_TYPE, "application/json")
                .body(json!({"source":"disk"}).to_string())
                .send()
                .await
                .unwrap()
        };
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
    let response = client
        .get(format!("{base}/api/docs/{}/recovery", document.id))
        .bearer_auth(&store.key)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bundle: Value = serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
    assert_eq!(bundle["filesystemSource"], "Private source");
    server.abort();
}
