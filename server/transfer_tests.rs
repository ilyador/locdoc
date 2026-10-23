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
