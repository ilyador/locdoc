//! The file action routes over HTTP: owner-only, with the contract's
//! response shapes and refusals.
use super::*;

const MCP_TOKEN: &str = "mcp_a_1111111111111111111111111111111111111111111111111111111111111111";

/// A store whose MCP connection `MCP_TOKEN` may read, write and share.
fn store() -> (tempfile::TempDir, App) {
    let directory = tempfile::tempdir().unwrap();
    let mut s = Store::open(
        directory.path().join("docs"),
        directory.path().join("state"),
        "http://localhost:3477".into(),
    )
    .unwrap();
    let credentials = {
        let db = s.db.lock().unwrap();
        db.execute(
            "INSERT INTO mcp_clients(id,name,redirects,created,expires)
             VALUES('test-client','Test','[]',?,?)",
            params![now(), now() + 3600],
        )
        .unwrap();
        db.execute(
            "INSERT INTO mcp_connections(
                id,client,scope,access_hash,access_expires,refresh_hash,expires,created)
             VALUES('connector-test','test-client','locdoc:read locdoc:write locdoc:share',
                ?,?,?,?,?)",
            params![
                hash(MCP_TOKEN),
                now() + 3600,
                hash("mcp-test-refresh"),
                now() + 3600,
                now()
            ],
        )
        .unwrap();
        mcp_auth::Credentials::load(&db).unwrap()
    };
    Arc::get_mut(&mut s).unwrap().mcp_credentials = credentials;
    (directory, s)
}

async fn serve(s: &App) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let application = router(s.clone());
    let server = tokio::spawn(async move { axum::serve(listener, application).await.unwrap() });
    (base, server)
}

/// A request with `credential` applied, answering status and JSON body.
async fn call(
    base: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
    credential: &dyn Fn(reqwest::RequestBuilder) -> reqwest::RequestBuilder,
) -> (StatusCode, Value) {
    let client = reqwest::Client::new();
    let mut request = client.request(method.parse().unwrap(), format!("{base}{path}"));
    if let Some(body) = body {
        request = request
            .header(header::CONTENT_TYPE, "application/json")
            .body(body.to_string());
    }
    let response = credential(request).send().await.unwrap();
    let status = response.status();
    let bytes = response.bytes().await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn a_duplicate_holds_the_accepted_text_without_its_comment_records() {
    let (_directory, s) = store();
    let page = s.create_document("page.md").unwrap();
    s.db.lock()
        .unwrap()
        .execute(
            "UPDATE docs SET permission='edit',token='document-link' WHERE id=?",
            [&page.id],
        )
        .unwrap();
    let room = s.room(&page).unwrap();
    assert!(s.persist(&page, &mut room.lock().unwrap()).unwrap());
    // The accepted text waits for the desktop application holding the file.
    let desktop = fs::OpenOptions::new()
        .append(true)
        .open(s.root.join("page.md"))
        .unwrap();
    let frame = crate::documents::tests::append_frame(
        &room,
        "Body text.\n\n[[comment(Ana): A note]]\n[[comment(Ben): A reply]]\n\nMore text.\n",
    );
    process_frame(&s, &page, &room, &frame, true, true, &mut Peer::default()).unwrap();
    assert!(!s.persist(&page, &mut room.lock().unwrap()).unwrap());
    let (base, server) = serve(&s).await;
    let key = s.key.clone();
    let owner = move |request: reqwest::RequestBuilder| request.bearer_auth(&key);
    let (status, copy) = call(
        &base,
        "POST",
        &format!("/api/docs/{}/duplicate", page.id),
        Some(json!({"path": "Copies/page copy.md"})),
        &owner,
    )
    .await;
    server.abort();
    drop(desktop);
    assert_eq!(status, StatusCode::OK);
    let expected = "# page\n\nBody text.\n\nMore text.\n";
    assert_eq!(
        fs::read_to_string(s.root.join("Copies/page copy.md")).unwrap(),
        expected
    );
    let copy = s.doc(copy["id"].as_str().unwrap()).unwrap();
    assert_eq!(copy.permission, "private");
    assert!(copy.token.is_none());
    let room = s.room(&copy).unwrap();
    assert_eq!(room_text(&room.lock().unwrap()), expected);
    assert!(s.persist(&copy, &mut room.lock().unwrap()).unwrap());
    let comments: i64 =
        s.db.lock()
            .unwrap()
            .query_row(
                "SELECT count(*) FROM comments WHERE doc=?",
                [&copy.id],
                |row| row.get(0),
            )
            .unwrap();
    assert_eq!(comments, 0);
    // The original keeps its text, records and link.
    assert!(
        room_text(&s.room(&page).unwrap().lock().unwrap()).contains("[[comment(Ana): A note]]")
    );
    assert_eq!(shared_document(&s, "document-link").unwrap().id, page.id);
}

#[test]
fn a_duplicate_carries_only_the_image_approvals_the_original_had() {
    let (_directory, s) = store();
    let page = s.create_document("Album/page.md").unwrap();
    let png = BASE64
        .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFlsAAAAASUVORK5CYII=")
        .unwrap();
    fs::write(s.root.join("Album/approved.png"), &png).unwrap();
    fs::write(s.root.join("Album/private.png"), &png).unwrap();
    fs::write(s.root.join("Album/page.md"), "![approved](approved.png)\n").unwrap();
    let room = s.room(&page).unwrap();
    assert!(s.persist(&page, &mut room.lock().unwrap()).unwrap());
    // A link editor adds a reference to a private image; that edit never
    // approves it.
    let frame = crate::documents::tests::append_frame(&room, "![planted](private.png)\n");
    process_frame(&s, &page, &room, &frame, true, false, &mut Peer::default()).unwrap_err();
    let frame = crate::documents::tests::append_frame(&room, "![planted](private.png");
    process_frame(&s, &page, &room, &frame, true, false, &mut Peer::default()).unwrap();
    let frame = crate::documents::tests::append_frame(&room, ")\n");
    process_frame(&s, &page, &room, &frame, true, true, &mut Peer::default()).unwrap();
    let source = room_text(&room.lock().unwrap());
    let approved = s.media_path(&page, "approved.png").unwrap();
    let private = s.media_path(&page, "private.png").unwrap();
    assert!(s.attachment_allowed(&page, &approved));
    assert!(!s.attachment_allowed(&page, &private));
    let ending = room.lock().unwrap().engine.ending().to_owned();
    let same = s
        .duplicate_document(&page, "Album/copy.md", &source, &ending)
        .unwrap();
    let elsewhere = s
        .duplicate_document(&page, "Other/copy.md", &source, &ending)
        .unwrap();
    for copy in [&same, &elsewhere] {
        // Its first load reads no file approvals the way a desktop file's does.
        let room = s.room(copy).unwrap();
        assert_eq!(room_text(&room.lock().unwrap()), source);
    }
    assert!(s.attachment_allowed(&same, &approved));
    assert!(s.active_attachment_allowed(&same, &approved));
    assert!(!s.attachment_allowed(&same, &private));
    // From another folder the same spelling names no approved file.
    assert!(
        s.media_path(&elsewhere, "approved.png")
            .is_err_and(|error| error.0 == StatusCode::NOT_FOUND)
    );
}
