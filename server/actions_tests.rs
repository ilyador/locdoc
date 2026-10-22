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

fn folder_token(s: &Store, path: &str) -> String {
    let shared = folders::share_folder(
        s,
        serde_json::from_value(json!({"path": path, "permission": "edit"})).unwrap(),
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

#[tokio::test]
async fn link_visitors_folder_visitors_and_mcp_connections_cannot_use_file_actions() {
    let (_directory, s) = store();
    let page = s.create_document("Shared/page.md").unwrap();
    s.db.lock()
        .unwrap()
        .execute(
            "UPDATE docs SET permission='edit',token='document-link' WHERE id=?",
            [&page.id],
        )
        .unwrap();
    s.db.lock()
        .unwrap()
        .execute("INSERT INTO mcp_documents(doc) VALUES(?)", [&page.id])
        .unwrap();
    let folder = folder_token(&s, "Shared");
    let gone = s.create_document("Shared/gone.md").unwrap();
    let trash = s.trash_document(&gone.id).unwrap();
    let (base, server) = serve(&s).await;
    let routes = [
        ("DELETE", format!("/api/docs/{}", page.id), None),
        (
            "POST",
            format!("/api/docs/{}/duplicate", page.id),
            Some(json!({"path": "Shared/copy.md"})),
        ),
        (
            "PATCH",
            "/api/folders".to_owned(),
            Some(json!({"from": "Shared", "to": "Moved"})),
        ),
        (
            "DELETE",
            "/api/folders".to_owned(),
            Some(json!({"path": "Shared"})),
        ),
        ("GET", "/api/trash".to_owned(), None),
        ("POST", format!("/api/trash/{trash}/restore"), None),
    ];
    let document_link = |request: reqwest::RequestBuilder| {
        request
            .query(&[("token", "document-link")])
            .header("x-locdoc-share", "document-link")
    };
    let folder_link = |request: reqwest::RequestBuilder| {
        request
            .query(&[("token", folder.as_str())])
            .header("x-locdoc-share", folder.as_str())
    };
    let connector = |request: reqwest::RequestBuilder| request.bearer_auth(MCP_TOKEN);
    let anonymous = |request: reqwest::RequestBuilder| request;
    let visitors: [(
        &str,
        &dyn Fn(reqwest::RequestBuilder) -> reqwest::RequestBuilder,
    ); 4] = [
        ("document link", &document_link),
        ("folder link", &folder_link),
        ("MCP connection", &connector),
        ("no credential", &anonymous),
    ];
    for (method, path, body) in &routes {
        for (visitor, credential) in &visitors {
            let (status, _) = call(&base, method, path, body.clone(), credential).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{visitor}: {method} {path}");
        }
    }
    server.abort();
    // Nothing changed.
    assert_eq!(s.doc(&page.id).unwrap().path, "Shared/page.md");
    assert!(s.root.join("Shared/page.md").is_file());
    assert!(!s.root.join("Shared/copy.md").exists());
    assert!(!s.root.join("Moved").exists());
    assert_eq!(actions::items(&s).unwrap().len(), 1);
    assert!(s.doc(&gone.id).is_err());
}

#[tokio::test]
async fn file_actions_answer_with_the_contract_shapes_and_refusals() {
    let (_directory, s) = store();
    let (base, server) = serve(&s).await;
    let key = s.key.clone();
    let owner = move |request: reqwest::RequestBuilder| request.bearer_auth(&key);
    let (status, page) = call(
        &base,
        "POST",
        "/api/files",
        Some(json!({"path": "Notes/page.md", "kind": "file"})),
        &owner,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let id = page["id"].as_str().unwrap().to_owned();
    s.create_folder("Notes/Folder.md").unwrap();
    for (path, expected) in [
        ("Notes/page.md", StatusCode::CONFLICT),
        ("Notes/Folder.md", StatusCode::CONFLICT),
        ("Notes/copy.txt.exe", StatusCode::BAD_REQUEST),
        ("../copy.md", StatusCode::BAD_REQUEST),
    ] {
        let (status, body) = call(
            &base,
            "POST",
            &format!("/api/docs/{id}/duplicate"),
            Some(json!({"path": path})),
            &owner,
        )
        .await;
        assert_eq!(status, expected, "duplicate to {path}");
        assert!(body["error"].is_string(), "{body}");
    }
    let (status, _) = call(
        &base,
        "POST",
        "/api/docs/unknown/duplicate",
        Some(json!({"path": "Notes/copy.md"})),
        &owner,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, copy) = call(
        &base,
        "POST",
        &format!("/api/docs/{id}/duplicate"),
        Some(json!({"path": "Notes/copy.md"})),
        &owner,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(copy["path"], "Notes/copy.md");
    assert_eq!(copy["permission"], "private");
    assert_ne!(copy["id"], page["id"]);
    assert!(copy.get("token").is_none());
    s.create_folder("Taken").unwrap();
    for (from, to, expected) in [
        ("Notes", "Notes/Inner", StatusCode::BAD_REQUEST),
        ("Notes", "Taken", StatusCode::CONFLICT),
        ("Missing", "Elsewhere", StatusCode::NOT_FOUND),
    ] {
        let (status, body) = call(
            &base,
            "PATCH",
            "/api/folders",
            Some(json!({"from": from, "to": to})),
            &owner,
        )
        .await;
        assert_eq!(status, expected, "{from} -> {to}");
        assert!(body["error"].is_string(), "{body}");
    }
    let (status, moved) = call(
        &base,
        "PATCH",
        "/api/folders",
        Some(json!({"from": "Notes", "to": "Taken/Archive"})),
        &owner,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(moved, json!({"ok": true, "path": "Taken/Archive"}));
    let (status, deleted) = call(&base, "DELETE", &format!("/api/docs/{id}"), None, &owner).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(deleted["ok"], true);
    let item = &deleted["trash"];
    assert_eq!(item["kind"], "document");
    assert_eq!(item["path"], "Taken/Archive/page.md");
    assert_eq!(item["documents"], 1);
    assert!(item["deleted"].as_i64().unwrap() > 0);
    let trash = item["id"].as_str().unwrap().to_owned();
    let (status, gone) = call(&base, "GET", &format!("/api/docs/{id}"), None, &owner).await;
    assert_eq!(status, StatusCode::GONE);
    assert_eq!(gone["error"], "trashed");
    assert_eq!(gone["trash"], *item);
    let anonymous = |request: reqwest::RequestBuilder| request;
    let (status, refusal) = call(&base, "GET", &format!("/api/docs/{id}"), None, &anonymous).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(refusal.get("trash").is_none());
    let (status, _) = call(&base, "DELETE", &format!("/api/docs/{id}"), None, &owner).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (_, tree) = call(&base, "GET", "/api/tree", None, &owner).await;
    let paths: Vec<&str> = tree["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["path"].as_str().unwrap())
        .collect();
    assert_eq!(
        paths,
        [
            "Taken",
            "Taken/Archive",
            "Taken/Archive/Folder.md",
            "Taken/Archive/copy.md"
        ]
    );
    let (status, folder) = call(
        &base,
        "DELETE",
        "/api/folders",
        Some(json!({"path": "Taken/Archive"})),
        &owner,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(folder["trash"]["kind"], "folder");
    assert_eq!(folder["trash"]["path"], "Taken/Archive");
    assert_eq!(folder["trash"]["documents"], 1);
    for path in ["Missing", "Taken/Archive"] {
        let (status, _) = call(
            &base,
            "DELETE",
            "/api/folders",
            Some(json!({"path": path})),
            &owner,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
    }
    let (_, listing) = call(&base, "GET", "/api/trash", None, &owner).await;
    let items = listing["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0], folder["trash"], "newest first");
    assert_eq!(items[1], *item);
    let (status, _) = call(&base, "POST", "/api/trash/unknown/restore", None, &owner).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // A path taken meanwhile is a conflict with a clear message.
    s.create_folder("Taken/Archive").unwrap();
    let folder_id = folder["trash"]["id"].as_str().unwrap().to_owned();
    let restore = format!("/api/trash/{folder_id}/restore");
    let (status, conflict) = call(&base, "POST", &restore, None, &owner).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        conflict["error"],
        "Taken/Archive already exists. Rename or move it, then restore again."
    );
    fs::remove_dir(s.root.join("Taken/Archive")).unwrap();
    let (status, restored) = call(&base, "POST", &restore, None, &owner).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(restored, json!({"ok": true, "path": "Taken/Archive"}));
    let (status, restored) = call(
        &base,
        "POST",
        &format!("/api/trash/{trash}/restore"),
        None,
        &owner,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(restored["path"], "Taken/Archive/page.md");
    let (_, listing) = call(&base, "GET", "/api/trash", None, &owner).await;
    assert_eq!(listing, json!({"items": []}));
    let (status, document) = call(&base, "GET", &format!("/api/docs/{id}"), None, &owner).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(document["path"], "Taken/Archive/page.md");
    server.abort();
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

#[test]
fn a_plain_text_duplicate_carries_no_image_approvals() {
    let (_directory, s) = store();
    let page = s.create_document("Album/page.md").unwrap();
    let png = BASE64
        .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFlsAAAAASUVORK5CYII=")
        .unwrap();
    fs::write(s.root.join("Album/approved.png"), &png).unwrap();
    fs::write(s.root.join("Album/page.md"), "![approved](approved.png)\n").unwrap();
    let room = s.room(&page).unwrap();
    assert!(s.persist(&page, &mut room.lock().unwrap()).unwrap());
    drop(room);
    let approved = s.media_path(&page, "approved.png").unwrap();
    assert!(s.attachment_allowed(&page, &approved));
    // As plain text the same characters are text, never media.
    s.rename_document(&page.id, "Album/page.txt").unwrap();
    let page = s.doc(&page.id).unwrap();
    let room = s.room(&page).unwrap();
    let source = room_text(&room.lock().unwrap());
    let ending = room.lock().unwrap().engine.ending().to_owned();
    drop(room);
    let copy = s
        .duplicate_document(&page, "Album/copy.txt", &source, &ending)
        .unwrap();
    let rows: i64 =
        s.db.lock()
            .unwrap()
            .query_row(
                "SELECT (SELECT count(*) FROM active_media WHERE doc=?1)
                  + (SELECT count(*) FROM trusted_references WHERE doc=?1)",
                [&copy.id],
                |row| row.get(0),
            )
            .unwrap();
    assert_eq!(rows, 0);
    // Turning the copy into Markdown later approves nothing either.
    s.rename_document(&copy.id, "Album/copy.md").unwrap();
    let copy = s.doc(&copy.id).unwrap();
    assert!(!s.attachment_allowed(&copy, &approved));
}

/// One JSON-RPC exchange with the MCP endpoint.
async fn rpc(endpoint: &str, request: Value) -> Value {
    let response = reqwest::Client::new()
        .post(endpoint)
        .header("Accept", "application/json, text/event-stream")
        .header("MCP-Protocol-Version", "2025-06-18")
        .header("Content-Type", "application/json")
        .bearer_auth(MCP_TOKEN)
        .body(request.to_string())
        .send()
        .await
        .unwrap();
    serde_json::from_slice(&response.bytes().await.unwrap()).unwrap()
}

#[tokio::test]
async fn mcp_finds_a_trashed_document_as_it_finds_a_removed_one_and_cannot_delete() {
    let (_directory, s) = store();
    let page = s.create_document("page.md").unwrap();
    let removed = s.create_document("removed.md").unwrap();
    for document in [&page, &removed] {
        s.db.lock()
            .unwrap()
            .execute("INSERT INTO mcp_documents(doc) VALUES(?)", [&document.id])
            .unwrap();
    }
    let (base, server) = serve(&s).await;
    let endpoint = format!("{base}/mcp");
    rpc(
        &endpoint,
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
            "protocolVersion":"2025-06-18","capabilities":{},
            "clientInfo":{"name":"Locdoc test","version":"1"}
        }}),
    )
    .await;
    let tools = rpc(
        &endpoint,
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}),
    )
    .await;
    let names: Vec<&str> = tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    assert!(
        !names
            .iter()
            .any(|name| ["delete", "trash", "restore_trash", "duplicate"]
                .iter()
                .any(|word| name.contains(word))),
        "{names:?}"
    );
    let read = |id: &str| {
        json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{
            "name":"read_document","arguments":{"doc_id":id}
        }})
    };
    let before = rpc(&endpoint, read(&page.id)).await;
    assert_eq!(
        before["result"]["structuredContent"]["content"],
        "# page\n\n"
    );
    s.trash_document(&page.id).unwrap();
    fs::remove_file(s.root.join("removed.md")).unwrap();
    s.retire_missing_documents().unwrap();
    let trashed = rpc(&endpoint, read(&page.id)).await;
    let retired = rpc(&endpoint, read(&removed.id)).await;
    assert_eq!(trashed["result"]["isError"], true);
    assert_eq!(
        trashed["result"]["structuredContent"],
        retired["result"]["structuredContent"]
    );
    let listed = rpc(
        &endpoint,
        json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{
            "name":"list_documents","arguments":{}
        }}),
    )
    .await;
    assert_eq!(listed["result"]["structuredContent"]["entries"], json!([]));
    server.abort();
}
