//! Link metadata stays inert. External fetches resolve and pin public addresses
//! at every hop, with no cookies, proxy, HTML execution, or remote image loads.
use super::*;
use std::{
    net::{IpAddr, SocketAddr},
    sync::OnceLock,
    time::{Duration, Instant},
};

#[derive(Deserialize)]
pub(super) struct PreviewQuery {
    url: String,
    token: Option<String>,
}

type Cache = Mutex<HashMap<String, (Instant, Value)>>;
static CACHE: OnceLock<Cache> = OnceLock::new();
static FETCHES: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);

fn durable_source(s: &Store, d: &Document, room: &Arc<Mutex<Room>>) -> Result<String> {
    let mut room = room.lock().unwrap();
    // Admission and reading use separate lock acquisitions. An intervening
    // failed import/edit must commit before its text can appear in a preview.
    s.store_room(d, &mut room)?;
    Ok(room_text(&room))
}

pub(super) async fn preview(
    State(s): State<App>,
    AxPath(id): AxPath<String>,
    Query(q): Query<PreviewQuery>,
    h: HeaderMap,
) -> Result<Json<Value>> {
    if q.url.len() > 8192 {
        return Err(bad("This link is too long."));
    }
    let mut url = url::Url::parse(&q.url).map_err(|_| bad("Use an HTTP or HTTPS link."))?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(bad("Use an HTTP or HTTPS link without credentials."));
    }
    let requested = q.url.clone();
    let access = Access {
        token: q.token.clone(),
        ..Access::default()
    };
    let headers = h.clone();
    let owner = doc_job(s.clone(), id.clone(), move |s| {
        let source = s.doc(&id)?;
        let owner = s.access(&headers, &source, &access)?.0;
        if !owner {
            let room = s.room(&source)?;
            let text = durable_source(s, &source, &room)?;
            let referenced = text.contains(&requested) || pulldown_cmark::Parser::new(&text).any(|event| {
                matches!(event, pulldown_cmark::Event::Start(pulldown_cmark::Tag::Link { dest_url, .. }) if dest_url.as_ref() == requested)
            });
            if !referenced {
                return Err(denied());
            }
        }
        Ok(owner)
    }).await?;
    if url.origin()
        == url::Url::parse(&s.public_url)
            .map_err(|_| bad("Invalid public URL."))?
            .origin()
    {
        let path = url.path();
        if !path.starts_with("/d/") && !path.starts_with("/s/") {
            return Ok(Json(
                json!({"kind":"web","url":url.as_str(),"site":url.host_str(),"title":"Locdoc","description":"Your local Markdown workspace."}),
            ));
        }
        let selected_url = url.clone();
        let token = q.token.clone();
        // Resolve first, then acquire target admission. Source admission was
        // released above, so reciprocal document links cannot deadlock.
        let (target, token) = job(s.clone(), move |s| {
            if let Some(id) = selected_url.path().strip_prefix("/d/") {
                Ok((s.doc(id.trim_end_matches('/'))?, token))
            } else {
                let token = selected_url
                    .path()
                    .strip_prefix("/s/")
                    .unwrap()
                    .trim_end_matches('/');
                let target = if let Ok(folder) = folders::grant(s, token) {
                    let selected = selected_url
                        .query_pairs()
                        .find(|(key, _)| key == "doc")
                        .map(|(_, value)| value.into_owned());
                    folders::document(s, &folder, selected.as_deref())?
                        .ok_or_else(|| bad("This folder has no documents yet."))?
                } else {
                    shared_document(s, token)?
                };
                Ok((target, Some(token.to_string())))
            }
        })
        .await?;
        let (target, text) = doc_job(s.clone(), target.id.clone(), move |s| {
            let target = s.doc(&target.id)?;
            s.access(
                &h,
                &target,
                &Access {
                    token,
                    ..Access::default()
                },
            )?;
            let room = s.room(&target)?;
            let text = durable_source(s, &target, &room)?;
            Ok((target, text))
        })
        .await?;
        let title = text
            .lines()
            .find_map(|line| line.strip_prefix("# "))
            .map(|s| plain(s, 160))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                Path::new(&target.path)
                    .file_stem()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            });
        let destination = if !owner && path.starts_with("/d/") {
            format!(
                "{}/s/{}?doc={}",
                s.public_url,
                q.token.as_deref().unwrap_or_default(),
                target.id
            )
        } else {
            url.to_string()
        };
        return Ok(Json(
            json!({"kind":"document","url":destination,"site":"Locdoc","id":target.id,"owner":owner,"title":title,"description":plain(&text, 240)}),
        ));
    }
    validate_url(&url)?;
    url.set_fragment(None);
    let key = url.to_string();
    if let Some((at, value)) = CACHE
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .get(&key)
        && at.elapsed() < Duration::from_secs(900)
    {
        return Ok(Json(value.clone()));
    }
    let _permit = FETCHES.try_acquire().map_err(|_| {
        ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "Link previews are busy. Try again shortly.".into(),
        )
    })?;
    let value = tokio::time::timeout(Duration::from_secs(8), fetch(url))
        .await
        .map_err(|_| bad("This website took too long to respond."))??;
    let mut cache = CACHE.get().unwrap().lock().unwrap();
    cache.retain(|_, (at, _)| at.elapsed() < Duration::from_secs(900));
    if cache.len() >= 256 {
        cache.clear();
    }
    cache.insert(key, (Instant::now(), value.clone()));
    Ok(Json(value))
}

fn validate_url(url: &url::Url) -> Result<()> {
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || !matches!(url.port_or_known_default(), Some(80 | 443))
    {
        return Err(bad("Previews support public HTTP and HTTPS pages only."));
    }
    Ok(())
}

fn public_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(matches!(a, 0 | 10 | 127 | 224..=255)
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192
                    && (b == 168 || (b == 88 && c == 99) || (b == 0 && matches!(c, 0 | 2))))
                || (a == 198 && (matches!(b, 18 | 19) || (b == 51 && c == 100)))
                || (a == 203 && b == 0 && c == 113))
        }
        IpAddr::V6(ip) => {
            let s = ip.segments();
            // Only global unicast; exclude special/tunnel and documentation space.
            (s[0] & 0xe000) == 0x2000
                && !(s[0] == 0x2001 && s[1] < 0x200)
                && !(s[0] == 0x2001 && s[1] == 0xdb8)
                && s[0] != 0x2002
                && !(s[0] == 0x3fff && s[1] < 0x1000)
        }
    }
}

async fn fetch(mut url: url::Url) -> Result<Value> {
    let original = url.to_string();
    let site = url.host_str().unwrap_or_default().to_string();
    for hop in 0..=3 {
        validate_url(&url)?;
        let host = url
            .host_str()
            .ok_or_else(|| bad("Invalid website address."))?
            .trim_matches(['[', ']']);
        let port = url.port_or_known_default().unwrap();
        let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
            .await?
            .take(16)
            .collect();
        if addresses.is_empty() || addresses.iter().any(|a| !public_address(a.ip())) {
            return Err(bad(
                "Private and local network addresses cannot be previewed.",
            ));
        }
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(6))
            .resolve_to_addrs(host, &addresses)
            .build()
            .map_err(|_| bad("Could not prepare this preview."))?;
        let mut response = client
            .get(url.clone())
            .header("User-Agent", "Locdoc-Link-Preview/1.0")
            .header("Accept", "text/html,application/xhtml+xml")
            .send()
            .await
            .map_err(|_| bad("This website could not be reached."))?;
        if response.status().is_redirection() {
            if hop == 3 {
                return Err(bad("This website redirects too many times."));
            }
            let location = response
                .headers()
                .get(header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| bad("Invalid website redirect."))?;
            url = url
                .join(location)
                .map_err(|_| bad("Invalid website redirect."))?;
            continue;
        }
        if !response.status().is_success() {
            return Err(bad("This website does not offer a preview."));
        }
        let mut body = Vec::new();
        let html = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|s| s.starts_with("text/html") || s.starts_with("application/xhtml+xml"));
        if html {
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| bad("This website stopped responding."))?
            {
                let remaining = 128 * 1024 - body.len();
                body.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
                if body.len() == 128 * 1024 {
                    break;
                }
            }
        }
        let (title, description) = metadata(&String::from_utf8_lossy(&body));
        return Ok(
            json!({"kind":"web","url":original,"site":site,"title":if title.is_empty(){site.clone()}else{title},"description":description}),
        );
    }
    unreachable!()
}

fn plain(text: &str, limit: usize) -> String {
    let mut value = String::new();
    for event in pulldown_cmark::Parser::new(text) {
        match event {
            pulldown_cmark::Event::Text(s) | pulldown_cmark::Event::Code(s) => {
                value.push_str(&s);
            }
            pulldown_cmark::Event::SoftBreak
            | pulldown_cmark::Event::HardBreak
            | pulldown_cmark::Event::End(
                pulldown_cmark::TagEnd::Paragraph | pulldown_cmark::TagEnd::Heading(_),
            ) => value.push(' '),
            _ => {}
        }
        if value.len() > limit * 8 {
            break;
        }
    }
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .filter(|c| !c.is_control())
        .take(limit)
        .collect()
}

fn metadata(html: &str) -> (String, String) {
    static META: OnceLock<regex::Regex> = OnceLock::new();
    static ATTR: OnceLock<regex::Regex> = OnceLock::new();
    static TITLE: OnceLock<regex::Regex> = OnceLock::new();
    let tags = META.get_or_init(|| {
        regex::Regex::new(r#"(?is)<meta\b(?:[^'\">]|\"[^\"]*\"|'[^']*')*>"#).unwrap()
    });
    let attributes = ATTR.get_or_init(|| {
        regex::Regex::new(r#"(?is)([\w:-]+)\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\s>]+))"#).unwrap()
    });
    let title_tag =
        TITLE.get_or_init(|| regex::Regex::new(r"(?is)<title\b[^>]*>(.*?)</title\s*>").unwrap());
    let mut title = String::new();
    let mut description = String::new();
    for tag in tags.find_iter(html) {
        let mut key = String::new();
        let mut content = String::new();
        for attr in attributes.captures_iter(tag.as_str()) {
            let value = attr
                .get(2)
                .or_else(|| attr.get(3))
                .or_else(|| attr.get(4))
                .unwrap()
                .as_str();
            match attr[1].to_ascii_lowercase().as_str() {
                "property" | "name" => key = value.to_ascii_lowercase(),
                "content" => content = value.to_string(),
                _ => {}
            }
        }
        match key.as_str() {
            "og:title" => title = plain(&content, 160),
            "og:description" | "description" if description.is_empty() => {
                description = plain(&content, 280)
            }
            _ => {}
        }
    }
    if title.is_empty()
        && let Some(c) = title_tag.captures(html)
    {
        title = plain(&c[1], 160);
    }
    (title, description)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn queued_source_and_target_previews_leave_runtime_and_storage_capacity() {
        for blocked_target in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let store = Store::open(
                directory.path().join("docs"),
                directory.path().join("state"),
                "http://localhost:3477".into(),
            )
            .unwrap();
            fs::write(store.root.join("target.md"), "# Target").unwrap();
            let target = store.index_document("target.md").unwrap();
            let url = if blocked_target {
                format!("http://localhost:3477/d/{}", target.id)
            } else {
                "http://localhost:3477/".into()
            };
            fs::write(store.root.join("source.md"), format!("[Link]({url})")).unwrap();
            let source = store.index_document("source.md").unwrap();
            store
                .db
                .lock()
                .unwrap()
                .execute(
                    "UPDATE docs SET permission='view',token='source-preview-share' WHERE id=?",
                    [&source.id],
                )
                .unwrap();
            let blocked = if blocked_target { &target } else { &source };
            let room = store.room(blocked).unwrap();
            let (started, ready) = tokio::sync::oneshot::channel();
            let (release, wait) = std::sync::mpsc::channel();
            let holder = std::thread::spawn(move || {
                let _guard = room.lock().unwrap();
                started.send(()).unwrap();
                // A bound also makes the pre-fix runtime starvation failure
                // terminate without needing its stalled Tokio timer.
                let _ = wait.recv_timeout(Duration::from_millis(700));
            });
            ready.await.unwrap();
            let started = Instant::now();
            let mut requests = Vec::new();
            for _ in 0..6 {
                let app = store.clone();
                let id = source.id.clone();
                let query = PreviewQuery {
                    url: url.clone(),
                    token: Some("source-preview-share".into()),
                };
                let mut headers = HeaderMap::new();
                if blocked_target {
                    headers.insert(
                        header::AUTHORIZATION,
                        format!("Bearer {}", store.key).parse().unwrap(),
                    );
                }
                requests.push(tokio::spawn(async move {
                    preview(State(app), AxPath(id), Query(query), headers).await
                }));
            }
            for _ in 0..64 {
                tokio::task::yield_now().await;
            }
            let independent = tokio::time::timeout(
                Duration::from_millis(300),
                doc_job(store.clone(), "unrelated-document".into(), |_| Ok(())),
            )
            .await;
            let elapsed = started.elapsed();
            let _ = release.send(());
            holder.join().unwrap();
            for request in requests {
                assert!(request.await.unwrap().is_ok());
            }
            assert!(
                matches!(independent, Ok(Ok(()))),
                "Preview queues must leave storage capacity for other documents"
            );
            assert!(
                elapsed < Duration::from_millis(300),
                "Preview room locks must not block the network runtime"
            );
        }
    }
    #[test]
    fn a_preview_cannot_read_an_import_that_failed_after_room_admission() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(
            directory.path().join("docs"),
            directory.path().join("state"),
            "http://localhost:3477".into(),
        )
        .unwrap();
        fs::write(store.root.join("preview.md"), "# Durable title").unwrap();
        let document = store.index_document("preview.md").unwrap();
        // The request has already obtained its room. A desktop import then
        // reaches live memory but fails to commit before the preview locks it.
        let room = store.room(&document).unwrap();
        store.persist(&document, &mut room.lock().unwrap()).unwrap();
        store.db.lock().unwrap().execute_batch(
            "CREATE TRIGGER fail_preview_import BEFORE INSERT ON doc_updates BEGIN SELECT RAISE(ABORT,'test preview storage outage'); END;"
        ).unwrap();
        fs::write(
            store.root.join(&document.path),
            "# Uncommitted imported title",
        )
        .unwrap();
        assert!(store.persist(&document, &mut room.lock().unwrap()).is_err());
        assert_eq!(
            room_text(&room.lock().unwrap()),
            "# Uncommitted imported title"
        );
        assert!(
            durable_source(&store, &document, &room).is_err(),
            "preview must fail while the imported source cannot commit"
        );
        store
            .db
            .lock()
            .unwrap()
            .execute_batch("DROP TRIGGER fail_preview_import;")
            .unwrap();
        assert_eq!(
            durable_source(&store, &document, &room).unwrap(),
            "# Uncommitted imported title"
        );
        let journal_count: i64 = store
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
            journal_count > 0,
            "preview source is durable before it is returned"
        );
    }

    #[test]
    fn blocks_private_special_and_encoded_loopback_addresses() {
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "172.31.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "198.18.0.1",
            "224.0.0.1",
            "::1",
            "::ffff:127.0.0.1",
            "fc00::1",
            "fe80::1",
            "2002:7f00:1::",
            "2001:db8::1",
        ] {
            assert!(!public_address(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"] {
            assert!(public_address(ip.parse().unwrap()), "{ip}");
        }
    }
    #[test]
    fn rejects_credentials_schemes_and_unusual_ports() {
        for url in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "https://user:pass@example.com",
            "https://example.com:8080",
        ] {
            assert!(validate_url(&url::Url::parse(url).unwrap()).is_err());
        }
    }
    #[test]
    fn reads_inert_bounded_metadata_with_attributes_in_any_order() {
        let (title, desc) = metadata(
            r#"<title>Fallback</title><meta content='A &amp; B' property='og:title'><META CONTENT="Hello &quot;world&quot;" NAME=description><script>alert(1)</script>"#,
        );
        assert_eq!(title, "A & B");
        assert_eq!(desc, "Hello \"world\"");
        assert_eq!(plain("<script>alert(1)</script>", 80), "");
        assert_eq!(plain(&"x".repeat(2000), 160).len(), 160);
    }
}
