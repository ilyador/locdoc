//! What responses cost on the wire. A listing polled again unchanged comes
//! back as 304 without a body, in each caller's own view; text is
//! compressed; media ranges, static file ranges and WebSocket upgrades keep
//! their exact bytes.
use super::*;
use std::io::Read;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn store() -> (tempfile::TempDir, App) {
    let directory = tempfile::tempdir().unwrap();
    let mut s = Store::open(
        directory.path().join("docs"),
        directory.path().join("state"),
        "http://localhost:3477".into(),
    )
    .unwrap();
    let web = directory.path().join("web");
    fs::create_dir_all(web.join("assets")).unwrap();
    Arc::get_mut(&mut s).unwrap().web_root = web;
    (directory, s)
}

async fn serve(s: &App) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let application =
        router(s.clone()).into_make_service_with_connect_info::<std::net::SocketAddr>();
    tokio::spawn(async move { axum::serve(listener, application).await.unwrap() });
    base
}

/// A request with exactly these headers: this client adds no Accept-Encoding
/// of its own and decodes nothing.
async fn send(
    method: reqwest::Method,
    base: &str,
    path: &str,
    headers: &[(&str, &str)],
) -> (StatusCode, HeaderMap, Vec<u8>) {
    let mut request = reqwest::Client::new().request(method, format!("{base}{path}"));
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = request.send().await.unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    (status, headers, response.bytes().await.unwrap().to_vec())
}
async fn get(base: &str, path: &str, headers: &[(&str, &str)]) -> (StatusCode, HeaderMap, Vec<u8>) {
    send(reqwest::Method::GET, base, path, headers).await
}

fn header(headers: &HeaderMap, name: header::HeaderName) -> Option<&str> {
    headers.get(name).map(|value| value.to_str().unwrap())
}

fn folder_link(s: &Store, path: &str, permission: &str) -> String {
    let shared = folders::share_folder(
        s,
        serde_json::from_value(json!({"path": path, "permission": permission})).unwrap(),
    )
    .unwrap();
    shared["shareUrl"]
        .as_str()
        .map(|url| url.rsplit('/').next().unwrap().to_owned())
        .unwrap_or_default()
}

fn paths(body: &[u8]) -> Vec<String> {
    let value: Value = serde_json::from_slice(body).unwrap();
    value["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["path"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn an_unchanged_listing_is_answered_without_its_body_in_each_callers_own_view() {
    let (_directory, s) = store();
    s.create_document("Shared/page.md").unwrap();
    s.create_document("private.md").unwrap();
    let token = folder_link(&s, "Shared", "view");
    let base = serve(&s).await;
    let bearer = format!("Bearer {}", s.key);
    let owner = ("authorization", bearer.as_str());
    let folder = format!("/api/tree?token={token}");

    let (status, headers, body) = get(&base, "/api/tree", &[owner]).await;
    assert_eq!(status, StatusCode::OK);
    let tag = header(&headers, header::ETAG).unwrap().to_owned();
    assert!(tag.starts_with("W/\"") && tag.ends_with('"'), "{tag}");
    assert_eq!(paths(&body), ["Shared", "Shared/page.md", "private.md"]);
    // The listing the caller holds: no body, the same tag.
    let (status, headers, body) = get(&base, "/api/tree", &[owner, ("if-none-match", &tag)]).await;
    assert_eq!(status, StatusCode::NOT_MODIFIED);
    assert!(body.is_empty());
    assert_eq!(header(&headers, header::ETAG), Some(tag.as_str()));
    assert_eq!(header(&headers, header::CACHE_CONTROL), Some("no-store"));
    // Among other tags, or as a strong tag, it is still the one held.
    let strong = tag.trim_start_matches("W/").to_owned();
    for held in [format!("\"other\", {tag}"), strong] {
        let (status, _, _) = get(&base, "/api/tree", &[owner, ("if-none-match", &held)]).await;
        assert_eq!(status, StatusCode::NOT_MODIFIED, "{held}");
    }
    let other = [owner, ("if-none-match", "W/\"other\"")];
    assert_eq!(get(&base, "/api/tree", &other).await.0, StatusCode::OK);

    // Any change answers in full, with a new tag.
    s.create_document("Shared/new.md").unwrap();
    let (status, headers, body) = get(&base, "/api/tree", &[owner, ("if-none-match", &tag)]).await;
    assert_eq!(status, StatusCode::OK);
    let changed = header(&headers, header::ETAG).unwrap().to_owned();
    assert_ne!(changed, tag);
    assert!(paths(&body).contains(&"Shared/new.md".to_owned()));

    // A folder link's listing has its own tags. Neither view's tag answers
    // for the other, so a 304 never stands for another caller's listing.
    let (status, headers, body) = get(&base, &folder, &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(paths(&body), ["new.md", "page.md"]);
    let visitor = header(&headers, header::ETAG).unwrap().to_owned();
    assert_ne!(visitor, changed);
    let (status, _, body) = get(&base, &folder, &[("if-none-match", &changed)]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(paths(&body), ["new.md", "page.md"]);
    let (status, _, body) = get(&base, "/api/tree", &[owner, ("if-none-match", &visitor)]).await;
    assert_eq!(status, StatusCode::OK);
    assert!(paths(&body).contains(&"private.md".to_owned()));
    let (status, _, _) = get(&base, &folder, &[("if-none-match", &visitor)]).await;
    assert_eq!(status, StatusCode::NOT_MODIFIED);

    // A tag is no credential: without the owner's, the tree is refused.
    for credential in [None, Some("Bearer not-the-key")] {
        let mut headers = vec![("if-none-match", changed.as_str())];
        headers.extend(credential.map(|value| ("authorization", value)));
        let (status, _, _) = get(&base, "/api/tree", &headers).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{credential:?}");
    }
    // A link turned off is refused, never confirmed as unchanged.
    folder_link(&s, "Shared", "private");
    let (status, _, _) = get(&base, &folder, &[("if-none-match", &visitor)]).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

fn entry(body: &[u8], path: &str) -> Option<Value> {
    let value: Value = serde_json::from_slice(body).unwrap();
    value["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["path"] == path)
        .cloned()
}

/// Polls the owner's tree as a tab does, naming the listing it holds,
/// until that listing shows what `shows` looks for.
async fn listed_until(
    base: &str,
    owner: (&str, &str),
    held: &mut (String, Vec<u8>),
    what: &str,
    shows: impl Fn(&[u8]) -> bool,
) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let (status, headers, body) =
            get(base, "/api/tree", &[owner, ("if-none-match", &held.0)]).await;
        if status == StatusCode::OK {
            *held = (header(&headers, header::ETAG).unwrap().to_owned(), body);
        } else {
            assert_eq!(status, StatusCode::NOT_MODIFIED);
        }
        if shows(&held.1) {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the listing never showed {what}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_listing_is_walked_again_only_once_something_it_shows_may_have_changed() {
    use std::time::{Duration, SystemTime};
    let (_directory, s) = store();
    let plan = s.create_document("Notes/plan.md").unwrap();
    s.create_document("Notes/ideas.md").unwrap();
    s.create_document("todo.md").unwrap();
    let watching = projection::watch(s.clone()).unwrap();
    // The watcher's first settled pass.
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let base = serve(&s).await;
    let bearer = format!("Bearer {}", s.key);
    let owner = ("authorization", bearer.as_str());
    let walks = || s.listings.walks();
    let (status, headers, body) = get(&base, "/api/tree", &[owner]).await;
    assert_eq!(status, StatusCode::OK);
    let mut held = (header(&headers, header::ETAG).unwrap().to_owned(), body);
    let walked = walks();
    // Nothing changed: answered from the listing held, without a walk.
    for _ in 0..5 {
        let (status, _, _) = get(&base, "/api/tree", &[owner, ("if-none-match", &held.0)]).await;
        assert_eq!(status, StatusCode::NOT_MODIFIED);
    }
    assert_eq!(walks(), walked, "an unchanged tree is not walked again");

    // A desktop save changes only that document's time: its entry is
    // patched from the file, without a walk.
    let set_time = |path: &Path, seconds: u64| {
        fs::File::options()
            .append(true)
            .open(path)
            .unwrap()
            .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(seconds))
            .unwrap();
    };
    let plan_file = s.root.join("Notes/plan.md");
    fs::write(&plan_file, "Desktop plan\n").unwrap();
    set_time(&plan_file, 2_000_000_000);
    let time = |body: &[u8]| entry(body, "Notes/plan.md").unwrap()["modified"].as_u64();
    listed_until(&base, owner, &mut held, "the desktop save's time", |body| {
        time(body) == Some(2_000_000_000)
    })
    .await;
    assert_eq!(walks(), walked, "a save patches its entry's time");
    // A write through another name of the file, outside what is listed,
    // still reaches the document's entry.
    fs::create_dir(s.root.join(".backup")).unwrap();
    let link = s.root.join(".backup/plan.md");
    fs::hard_link(&plan_file, &link).unwrap();
    // The new names' notices, then the walk they call for.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let (status, headers, body) = get(&base, "/api/tree", &[owner]).await;
    assert_eq!(status, StatusCode::OK);
    held = (header(&headers, header::ETAG).unwrap().to_owned(), body);
    let linked = walks();
    assert!(linked > walked, "new names are walked");
    fs::write(&link, "Plan saved through its other name\n").unwrap();
    set_time(&link, 2_100_000_000);
    listed_until(
        &base,
        owner,
        &mut held,
        "a write through a hard link",
        |body| time(body) == Some(2_100_000_000),
    )
    .await;
    assert_eq!(walks(), linked, "a hard link's write patches its document");
    // So does Locdoc's own save of typed text: rows that only store the
    // text are no reason to walk.
    {
        let room = s.room(&plan).unwrap();
        let mut room = room.lock().unwrap();
        let source = room_text(&room);
        apply_text(room.awareness.doc(), &source, "Typed plan\n");
        room.engine.edited();
        s.store_room(&plan, &mut room).unwrap();
        assert!(s.persist(&plan, &mut room).unwrap());
    }
    listed_until(&base, owner, &mut held, "the typed save's time", |body| {
        time(body) != Some(2_100_000_000)
    })
    .await;
    assert_eq!(walks(), linked, "typing patches its document's time");

    // Names that change show on the next poll after their notice or row.
    fs::rename(
        s.root.join("Notes/ideas.md"),
        s.root.join("Notes/renamed.md"),
    )
    .unwrap();
    listed_until(&base, owner, &mut held, "a desktop rename", |body| {
        entry(body, "Notes/renamed.md").is_some() && entry(body, "Notes/ideas.md").is_none()
    })
    .await;
    fs::write(s.root.join("desktop.md"), "Made on the desktop\n").unwrap();
    listed_until(&base, owner, &mut held, "a desktop file", |body| {
        entry(body, "desktop.md").is_some()
    })
    .await;
    fs::remove_file(s.root.join("todo.md")).unwrap();
    listed_until(&base, owner, &mut held, "a desktop removal", |body| {
        entry(body, "todo.md").is_none()
    })
    .await;
    s.create_document("Notes/fresh.md").unwrap();
    listed_until(
        &base,
        owner,
        &mut held,
        "a document made in Locdoc",
        |body| entry(body, "Notes/fresh.md").is_some(),
    )
    .await;
    folder_link(&s, "Notes", "view");
    listed_until(&base, owner, &mut held, "a folder link", |body| {
        entry(body, "Notes/plan.md").unwrap()["shared"] == true
    })
    .await;
    let id = entry(&held.1, "Notes/fresh.md").unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    s.trash_document(&id).unwrap();
    listed_until(
        &base,
        owner,
        &mut held,
        "a document deleted in Locdoc",
        |body| entry(body, "Notes/fresh.md").is_none(),
    )
    .await;
    // Once the passes those changes started have settled, the listing
    // stands again.
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let settled = loop {
        let before = walks();
        for _ in 0..5 {
            let (status, headers, body) =
                get(&base, "/api/tree", &[owner, ("if-none-match", &held.0)]).await;
            if status == StatusCode::OK {
                held = (header(&headers, header::ETAG).unwrap().to_owned(), body);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        if walks() == before {
            break before;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the listing never stood"
        );
    };

    // Without a watcher no notice says what changed: every poll walks.
    drop(watching);
    for _ in 0..3 {
        get(&base, "/api/tree", &[owner, ("if-none-match", &held.0)]).await;
    }
    assert_eq!(walks(), settled + 3);
    fs::write(s.root.join("unwatched.md"), "Written with no watcher\n").unwrap();
    let (status, _, body) = get(&base, "/api/tree", &[owner, ("if-none-match", &held.0)]).await;
    assert_eq!(status, StatusCode::OK);
    assert!(entry(&body, "unwatched.md").is_some());
}

#[tokio::test]
async fn a_change_made_through_locdoc_shows_in_the_next_listing_before_any_notice() {
    let (_directory, s) = store();
    s.create_document("plan.md").unwrap();
    // A watcher that has not reported anything yet.
    s.listings.notices.watching(true);
    let base = serve(&s).await;
    let bearer = format!("Bearer {}", s.key);
    let owner = ("authorization", bearer.as_str());
    let (status, headers, _) = get(&base, "/api/tree", &[owner]).await;
    assert_eq!(status, StatusCode::OK);
    let tag = header(&headers, header::ETAG).unwrap().to_owned();
    // Until its notice arrives, a folder made on the desktop is not listed.
    fs::create_dir(s.root.join("Desktop")).unwrap();
    let (status, _, _) = get(&base, "/api/tree", &[owner, ("if-none-match", &tag)]).await;
    assert_eq!(status, StatusCode::NOT_MODIFIED);
    // One the sidebar makes is listed as soon as the request returns, so
    // the listing after it never undoes it.
    let response = reqwest::Client::new()
        .post(format!("{base}/api/files"))
        .header("authorization", &bearer)
        .header("content-type", "application/json")
        .body(json!({"path": "Made", "kind": "folder"}).to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let (status, _, body) = get(&base, "/api/tree", &[owner, ("if-none-match", &tag)]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(paths(&body), ["Desktop", "Made", "plan.md"]);
}

fn comments(body: &[u8]) -> Vec<(String, bool)> {
    let value: Value = serde_json::from_slice(body).unwrap();
    value["comments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|thread| {
            (
                thread["body"].as_str().unwrap().to_owned(),
                thread["canResolve"].as_bool().unwrap(),
            )
        })
        .collect()
}

#[tokio::test]
async fn an_unchanged_comment_list_is_answered_without_its_body_in_each_callers_own_view() {
    let (_directory, s) = store();
    let page = s.create_document("Notes/page.md").unwrap();
    s.db.lock()
        .unwrap()
        .execute(
            "UPDATE docs SET permission='view',token='page-link' WHERE id=?",
            [&page.id],
        )
        .unwrap();
    let base = serve(&s).await;
    let bearer = format!("Bearer {}", s.key);
    let browser = |guest: char| format!("locdoc_guest={}", guest.to_string().repeat(64));
    let (alex, visitor, other) = (browser('a'), browser('b'), browser('c'));
    let owner = [
        ("authorization", bearer.as_str()),
        ("cookie", alex.as_str()),
    ];
    let list = format!("/api/docs/{}/comments", page.id);
    let linked = format!("{list}?token=page-link");
    let post = |body: &'static str| {
        let url = format!("{base}{list}");
        let (bearer, alex) = (bearer.clone(), alex.clone());
        async move {
            let response = reqwest::Client::new()
                .post(url)
                .header("authorization", bearer)
                .header("cookie", alex)
                .header("content-type", "application/json")
                .body(json!({"body": body, "name": "alex"}).to_string())
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
        }
    };
    post("First thought").await;

    let (status, headers, body) = get(&base, &list, &owner).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(comments(&body), [("First thought".to_owned(), true)]);
    let tag = header(&headers, header::ETAG).unwrap().to_owned();
    assert!(tag.starts_with("W/\"") && tag.ends_with('"'), "{tag}");
    // The list the owner holds: no body, the same tag.
    let (status, headers, body) =
        get(&base, &list, &[owner[0], owner[1], ("if-none-match", &tag)]).await;
    assert_eq!(status, StatusCode::NOT_MODIFIED);
    assert!(body.is_empty());
    assert_eq!(header(&headers, header::ETAG), Some(tag.as_str()));
    assert_eq!(header(&headers, header::CACHE_CONTROL), Some("no-store"));

    // A link visitor sees the same thread without the owner's rights, under
    // its own tags: neither view's tag answers for the other.
    let guest = |cookie: &str, held: Option<&str>| {
        let mut headers = vec![("cookie", cookie.to_owned())];
        headers.extend(held.map(|tag| ("if-none-match", tag.to_owned())));
        headers
    };
    let ask = |headers: Vec<(&'static str, String)>| {
        let url = linked.clone();
        let base = base.clone();
        async move {
            let headers: Vec<(&str, &str)> =
                headers.iter().map(|(k, v)| (*k, v.as_str())).collect();
            get(&base, &url, &headers).await
        }
    };
    let (status, headers, body) = ask(guest(&visitor, Some(&tag))).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "the owner's tag is not the visitor's"
    );
    assert_eq!(comments(&body), [("First thought".to_owned(), false)]);
    let visiting = header(&headers, header::ETAG).unwrap().to_owned();
    assert_ne!(visiting, tag);
    let (status, _, body) = ask(guest(&visitor, Some(&visiting))).await;
    assert_eq!(status, StatusCode::NOT_MODIFIED);
    assert!(body.is_empty());
    let (status, _, _) = get(
        &base,
        &list,
        &[owner[0], owner[1], ("if-none-match", &visiting)],
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "the visitor's tag is not the owner's"
    );
    // Another browser on the same link is sent the same list, under its own
    // tag: whose threads a guest may resolve is part of the view.
    let (status, headers, body) = ask(guest(&other, Some(&visiting))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(comments(&body), [("First thought".to_owned(), false)]);
    assert_ne!(header(&headers, header::ETAG), Some(visiting.as_str()));

    // A new thread answers in full, with a new tag.
    post("Second thought").await;
    let (status, headers, body) =
        get(&base, &list, &[owner[0], owner[1], ("if-none-match", &tag)]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(comments(&body).len(), 2);
    assert_ne!(header(&headers, header::ETAG), Some(tag.as_str()));
    let (status, _, body) = ask(guest(&visitor, Some(&visiting))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(comments(&body).len(), 2);

    // A tag is no credential: a link turned off is refused, never confirmed.
    s.db.lock()
        .unwrap()
        .execute(
            "UPDATE docs SET permission='private' WHERE id=?",
            [&page.id],
        )
        .unwrap();
    let (status, _, _) = ask(guest(&visitor, Some(&visiting))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

fn gunzip(bytes: &[u8]) -> Vec<u8> {
    let mut plain = Vec::new();
    flate2::read::GzDecoder::new(bytes)
        .read_to_end(&mut plain)
        .unwrap();
    plain
}
fn unbrotli(bytes: &[u8]) -> Vec<u8> {
    let mut plain = Vec::new();
    brotli::Decompressor::new(bytes, 4096)
        .read_to_end(&mut plain)
        .unwrap();
    plain
}

#[tokio::test]
async fn text_is_compressed_while_ranges_and_socket_upgrades_keep_their_bytes() {
    let (_directory, s) = store();
    for n in 0..60 {
        s.create_document(&format!("Notes/Draft {n}.md")).unwrap();
    }
    // A video the document's desktop file approves, and a link to it.
    let mut video = b"\0\0\0\x18ftypisom\0\0\x02\0isomiso2".to_vec();
    video.extend((0..4096u32).map(|n| (n % 251) as u8));
    fs::write(s.root.join("Notes/clip.mp4"), &video).unwrap();
    fs::write(s.root.join("Notes/page.md"), "Watch: ![clip](clip.mp4)\n").unwrap();
    let page = s.index_document("Notes/page.md").unwrap();
    s.db.lock()
        .unwrap()
        .execute(
            "UPDATE docs SET permission='view',token='page-link' WHERE id=?",
            [&page.id],
        )
        .unwrap();
    s.room(&s.doc(&page.id).unwrap()).unwrap();
    let script = "export const greeting = 'hello';\n".repeat(200);
    fs::write(s.web_root.join("assets/app-1.js"), &script).unwrap();
    let shell = format!(
        "<!doctype html><title>__LOCDOC_TITLE__</title>{}",
        "<p>The page link-preview crawlers read whole.</p>".repeat(60)
    );
    fs::write(s.web_root.join("index.html"), &shell).unwrap();
    let base = serve(&s).await;
    let bearer = format!("Bearer {}", s.key);
    let owner = ("authorization", bearer.as_str());

    // JSON: identity unless the client asks, then gzip or Brotli.
    let (status, headers, plain) = get(&base, "/api/tree", &[owner]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(header(&headers, header::CONTENT_ENCODING), None);
    assert_eq!(
        header(&headers, header::CONTENT_LENGTH),
        Some(plain.len().to_string().as_str())
    );
    let tag = header(&headers, header::ETAG).unwrap().to_owned();
    for (encoding, decode) in [("gzip", gunzip as fn(&[u8]) -> Vec<u8>), ("br", unbrotli)] {
        let (status, headers, body) =
            get(&base, "/api/tree", &[owner, ("accept-encoding", encoding)]).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(header(&headers, header::CONTENT_ENCODING), Some(encoding));
        assert!(
            header(&headers, header::VARY).is_some_and(|vary| vary.contains("accept-encoding")),
            "{encoding}"
        );
        assert_eq!(header(&headers, header::ETAG), Some(tag.as_str()));
        assert!(
            body.len() * 3 < plain.len(),
            "{encoding}: {} of {}",
            body.len(),
            plain.len()
        );
        assert!(decode(&body) == plain, "{encoding} decodes to the listing");
    }
    // A HEAD answer reports the listing's own length, compressed or not.
    let (status, headers, body) = send(
        reqwest::Method::HEAD,
        &base,
        "/api/tree",
        &[owner, ("accept-encoding", "gzip, br")],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.is_empty());
    assert_eq!(header(&headers, header::CONTENT_ENCODING), None);
    assert_eq!(
        header(&headers, header::CONTENT_LENGTH),
        Some(plain.len().to_string().as_str())
    );
    // Pages stay whole for the crawlers that preview links.
    let (status, headers, html) = get(&base, "/", &[("accept-encoding", "gzip, br")]).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.len() > 1024);
    assert_eq!(header(&headers, header::CONTENT_ENCODING), None);
    let (_, headers, _) = send(
        reqwest::Method::HEAD,
        &base,
        "/",
        &[("accept-encoding", "gzip, br")],
    )
    .await;
    assert_eq!(
        header(&headers, header::CONTENT_LENGTH),
        Some(html.len().to_string().as_str())
    );
    // An unchanged listing has nothing to compress.
    let (status, headers, body) = get(
        &base,
        "/api/tree",
        &[
            owner,
            ("accept-encoding", "gzip, br"),
            ("if-none-match", &tag),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::NOT_MODIFIED);
    assert_eq!(header(&headers, header::CONTENT_ENCODING), None);
    assert!(body.is_empty());

    // Media keeps its identity encoding, whole or in ranges, so videos seek.
    let media = format!("/api/docs/{}/media?path=clip.mp4&token=page-link", page.id);
    let (status, headers, body) = get(&base, &media, &[("accept-encoding", "gzip, br")]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(header(&headers, header::CONTENT_ENCODING), None);
    assert_eq!(header(&headers, header::ACCEPT_RANGES), Some("bytes"));
    assert!(body == video, "the whole video");
    let (status, headers, body) = get(
        &base,
        &media,
        &[("accept-encoding", "gzip, br"), ("range", "bytes=100-199")],
    )
    .await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(header(&headers, header::CONTENT_ENCODING), None);
    assert_eq!(
        header(&headers, header::CONTENT_RANGE),
        Some(format!("bytes 100-199/{}", video.len()).as_str())
    );
    assert!(body == video[100..200], "the range's own bytes");

    // A static script is compressed whole; a range of it stays exact.
    let (status, headers, body) =
        get(&base, "/assets/app-1.js", &[("accept-encoding", "gzip")]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(header(&headers, header::CONTENT_ENCODING), Some("gzip"));
    assert_eq!(header(&headers, header::ACCEPT_RANGES), None);
    assert!(gunzip(&body) == script.as_bytes());
    let (status, headers, body) = get(
        &base,
        "/assets/app-1.js",
        &[("accept-encoding", "gzip"), ("range", "bytes=7-12")],
    )
    .await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(header(&headers, header::CONTENT_ENCODING), None);
    assert_eq!(body, b"const ");

    // A browser's WebSocket handshake also offers encodings. The upgrade
    // still switches protocols and the socket carries its first frame.
    let address = base.strip_prefix("http://").unwrap();
    let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
    let handshake = format!(
        "GET /ws/{}?token=page-link HTTP/1.1\r\nHost: {address}\r\nUpgrade: websocket\r\n\
         Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
         Sec-WebSocket-Version: 13\r\nAccept-Encoding: gzip, deflate, br\r\n\r\n",
        page.id
    );
    socket.write_all(handshake.as_bytes()).await.unwrap();
    let mut received = Vec::new();
    let head = loop {
        let mut chunk = [0; 1024];
        let read =
            tokio::time::timeout(std::time::Duration::from_secs(10), socket.read(&mut chunk))
                .await
                .unwrap()
                .unwrap();
        assert!(read > 0, "the server closed the handshake");
        received.extend_from_slice(&chunk[..read]);
        if let Some(end) = received.windows(4).position(|w| w == b"\r\n\r\n") {
            break end + 4;
        }
    };
    let response = String::from_utf8_lossy(&received[..head]).to_ascii_lowercase();
    assert!(response.starts_with("http/1.1 101"), "{response}");
    assert!(!response.contains("content-encoding"), "{response}");
    while received.len() <= head {
        let mut chunk = [0; 1024];
        let read =
            tokio::time::timeout(std::time::Duration::from_secs(10), socket.read(&mut chunk))
                .await
                .unwrap()
                .unwrap();
        assert!(read > 0, "the socket closed before its first frame");
        received.extend_from_slice(&chunk[..read]);
    }
    assert_eq!(received[head] & 0x0f, 2, "a binary sync frame");
}
