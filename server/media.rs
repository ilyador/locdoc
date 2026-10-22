//! Uploads, attachment serving and the owner's font library.
use super::*;

pub(super) async fn upload(
    State(s): State<App>,
    AxPath(id): AxPath<String>,
    Query(a): Query<Access>,
    h: HeaderMap,
    mut multipart: Multipart,
) -> Result<Json<Value>> {
    let d = s.doc(&id)?;
    if !s.access(&h, &d, &a)?.1 {
        return Err(denied());
    }
    let permit = s.uploads.clone().try_acquire_owned().map_err(|_| {
        ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "Two uploads are already running. Try again when one finishes.".into(),
        )
    })?;
    let field = multipart
        .next_field()
        .await
        .map_err(|_| bad("Choose an image or video."))?
        .ok_or_else(|| bad("Choose a file."))?;
    let name = field.file_name().unwrap_or("attachment").to_string();
    let bytes = field
        .bytes()
        .await
        .map_err(|_| bad("The file is too large. Images: 5 MB; videos: 20 MB."))?;
    doc_job(s, id.clone(), move |s| {
        let _permit = permit;
        let current = s.doc(&d.id)?;
        if !s.access(&h, &current, &a)?.1 {
            return Err(denied());
        }
        upload_payload(s, current, id, name, &bytes)
    })
    .await
    .map(Json)
}
fn upload_payload(s: &Store, d: Document, id: String, name: String, bytes: &[u8]) -> Result<Value> {
    let kind = infer::get(bytes).ok_or_else(|| {
        bad("Unsupported file. Use PNG, JPEG, GIF, WebP, AVIF, MP4, WebM, or MOV.")
    })?;
    let mime = kind.mime_type();
    let video = mime.starts_with("video/");
    if !allowed_mime(mime) {
        return Err(bad("Unsupported image or video format."));
    }
    if bytes.len() > if video { 20 * MB } else { 5 * MB } {
        return Err(bad(if video {
            "Videos must be 20 MB or smaller."
        } else {
            "Images must be 5 MB or smaller."
        }));
    }
    let room = s.room(&d)?;
    let usage = s.usage(&d, &room_text(&room.lock().unwrap()));
    if usage + bytes.len() > DOC_LIMIT {
        return Err(bad(
            "This document would exceed its 50 MB attachment limit.",
        ));
    }
    let rel = format!(
        ".assets/{}/{}.{}",
        id,
        uuid::Uuid::new_v4(),
        kind.extension()
    );
    s.write_upload(&d, &rel, bytes)?;
    let depth = Path::new(&d.path).parent().unwrap().components().count();
    let reference = format!("{}{rel}", "../".repeat(depth));
    let usage = s.usage(&d, &room_text(&room.lock().unwrap()));
    Ok(json!({"path":reference,"name":name,"bytes":bytes.len(),"video":video,"usage":usage}))
}
#[derive(Deserialize)]
pub(super) struct Media {
    pub(super) path: String,
    pub(super) token: Option<String>,
}
pub(super) async fn media(
    State(s): State<App>,
    AxPath(id): AxPath<String>,
    Query(q): Query<Media>,
    h: HeaderMap,
) -> Result<Response> {
    let authorize = h.clone();
    let (path, len, mime) =
        doc_job(s, id.clone(), move |s| media_file(s, &id, &q, &authorize)).await?;
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let mut start = 0;
    let mut end = len - 1;
    let mut partial = false;
    if let Some(value) = h
        .get(header::RANGE)
        .and_then(|x| x.to_str().ok())
        .and_then(|x| x.strip_prefix("bytes="))
    {
        let (a, b) = value.split_once('-').ok_or_else(|| bad("Invalid range"))?;
        if a.is_empty() {
            let suffix: usize = b.parse().map_err(|_| bad("Invalid range"))?;
            if suffix == 0 {
                return Err(bad("Invalid range"));
            }
            start = len.saturating_sub(suffix);
        } else {
            start = a.parse().map_err(|_| bad("Invalid range"))?;
            if !b.is_empty() {
                end = b.parse().map_err(|_| bad("Invalid range"))?;
            }
        }
        if start >= len || end < start {
            return Err(ApiError(
                StatusCode::RANGE_NOT_SATISFIABLE,
                "Invalid byte range".into(),
            ));
        }
        end = end.min(len - 1);
        partial = true;
    }
    let mut file = tokio::fs::File::open(&path).await?;
    file.seek(std::io::SeekFrom::Start(start as u64)).await?;
    let body = axum::body::Body::from_stream(tokio_util::io::ReaderStream::new(
        file.take((end - start + 1) as u64),
    ));
    let mut res = (
        if partial {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        },
        body,
    )
        .into_response();
    res.headers_mut()
        .insert(header::CONTENT_TYPE, mime.parse().unwrap());
    res.headers_mut().insert(
        header::CONTENT_LENGTH,
        (end - start + 1).to_string().parse().unwrap(),
    );
    res.headers_mut()
        .insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
    res.headers_mut()
        .insert(header::CACHE_CONTROL, "private, no-store".parse().unwrap());
    if partial {
        res.headers_mut().insert(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{len}").parse().unwrap(),
        );
    }

    Ok(res)
}
pub(super) fn media_file(
    s: &Store,
    id: &str,
    q: &Media,
    h: &HeaderMap,
) -> Result<(PathBuf, usize, &'static str)> {
    let d = s.doc(id)?;
    let capability = q
        .token
        .as_deref()
        .is_some_and(|token| browser_auth::media_allowed(s, &d.id, token));
    let owner = capability
        || s.access(
            h,
            &d,
            &Access {
                token: q.token.clone(),
                ..Access::default()
            },
        )?
        .0;
    let path = s.media_path(&d, &q.path)?;
    if !owner || capability {
        // Never open the Markdown file here: even a read would break our
        // projection lease. Room source is committed before its lock is freed.
        let existing = s.rooms.lock().unwrap().get(&d.id).cloned();
        let room = match existing {
            Some(room) => room,
            None => s.room(&d)?,
        };
        let mut room = room.lock().unwrap();
        let allowed = room
            .references(s, &d)?
            .iter()
            .filter_map(|p| s.media_path(&d, p).ok())
            .any(|p| p == path);
        if !allowed || (!capability && !s.active_attachment_allowed(&d, &path)) {
            return Err(denied());
        }
    }
    use std::io::Read;
    let metadata = fs::metadata(&path)?;
    let len = metadata.len() as usize;
    if len == 0 || len > 20 * MB {
        return Err(bad("Attachment is empty or exceeds the 20 MB maximum."));
    }
    let mut prefix = [0; 512];
    let n = fs::File::open(&path)?.read(&mut prefix)?;
    let kind = infer::get(&prefix[..n]).ok_or_else(|| bad("Unsupported attachment."))?;
    if !allowed_mime(kind.mime_type()) {
        return Err(denied());
    }
    if kind.mime_type().starts_with("image/") && len > 5 * MB {
        return Err(bad("Image exceeds 5 MB."));
    }
    if owner {
        // The owner's editor sees an approved image edited in place.
        s.refresh_served_media(&d, &q.path, &metadata);
    }
    Ok((path, len, kind.mime_type()))
}
pub(super) async fn font_list(State(s): State<App>) -> Result<Json<Value>> {
    let db = s.db.lock().unwrap();
    let mut q = db.prepare("SELECT family FROM fonts ORDER BY family")?;
    Ok(Json(
        json!({"fonts":q.query_map([],|r|r.get::<_,String>(0))?.filter_map(|x|x.ok()).collect::<Vec<_>>()}),
    ))
}
pub(super) async fn font_css(State(s): State<App>) -> Result<Response> {
    let db = s.db.lock().unwrap();
    let mut q = db.prepare("SELECT css FROM fonts")?;
    let css = q
        .query_map([], |r| r.get::<_, String>(0))?
        .filter_map(|x| x.ok())
        .collect::<Vec<_>>()
        .join("\n");
    Ok((
        [
            (header::CONTENT_TYPE, "text/css"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        css,
    )
        .into_response())
}
#[derive(Deserialize)]
pub(super) struct FontRequest {
    family: String,
}
pub(super) async fn install_font(
    State(s): State<App>,
    _owner: security::Owner,
    Json(b): Json<FontRequest>,
) -> Result<Json<Value>> {
    let family = b.family.trim();
    if family.is_empty()
        || family.len() > 80
        || !family
            .chars()
            .all(|c| c.is_alphanumeric() || c == ' ' || c == '-')
    {
        return Err(bad("Enter a Google Fonts family name, for example Lora."));
    }
    let count: i64 =
        s.db.lock()
            .unwrap()
            .query_row("SELECT count(*) FROM fonts", [], |r| r.get(0))?;
    if count >= 50 {
        return Err(bad("The 50-family font library is full."));
    }
    let mut url = url::Url::parse("https://fonts.googleapis.com/css2").unwrap();
    url.query_pairs_mut()
        .append_pair("family", &format!("{family}:wght@400;500;600;700"))
        .append_pair("display", "swap");
    let css = s
        .http
        .get(url)
        .header("User-Agent", "Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36")
        .send()
        .await
        .map_err(|_| bad("Google Fonts is unreachable. Try again."))?
        .error_for_status()
        .map_err(|_| bad("Font not found. Check the exact Google Fonts family name."))?
        .text()
        .await
        .map_err(|_| bad("Font download failed."))?;
    let re = regex::Regex::new(r"https://fonts\.gstatic\.com/[^)\s]+").unwrap();
    let urls: Vec<String> = re
        .find_iter(&css)
        .map(|m| m.as_str().to_string())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    if urls.is_empty() || urls.len() > 100 {
        return Err(bad("No downloadable font files found."));
    }
    fs::create_dir_all(s.data.join("fonts"))?;
    let mut installed = css;
    for source in urls {
        let name = format!("{}.woff2", hash(&source));
        let dest = s.data.join("fonts").join(&name);
        if !dest.exists() {
            let response = s
                .http
                .get(&source)
                .send()
                .await
                .map_err(|_| bad("Font download failed."))?
                .error_for_status()
                .map_err(|_| bad("Font download failed."))?;
            if response.content_length().unwrap_or(0) > 5 * MB as u64 {
                return Err(bad("Font file is too large."));
            }
            let bytes = response
                .bytes()
                .await
                .map_err(|_| bad("Font download failed."))?;
            if bytes.len() > 5 * MB {
                return Err(bad("Font file is too large."));
            }
            fs::write(dest, bytes)?;
        }
        installed = installed.replace(&source, &format!("/fonts/{name}"));
    }
    s.db.lock().unwrap().execute(
        "INSERT OR REPLACE INTO fonts(family,css) VALUES(?,?)",
        params![family, installed],
    )?;
    Ok(Json(json!({"family":family})))
}
fn allowed_mime(mime: &str) -> bool {
    [
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "image/avif",
        "video/mp4",
        "video/webm",
        "video/quicktime",
    ]
    .contains(&mime)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{peer_update, store};

    #[test]
    fn guest_media_uses_committed_room_source_without_breaking_its_projection_lease() {
        let (_dir, s) = store();
        fs::write(s.root.join("media.md"), "Hello").unwrap();
        let d = s.index_document("media.md").unwrap();
        s.db.lock()
            .unwrap()
            .execute(
                "UPDATE docs SET permission='edit',token='media-share' WHERE id=?",
                [&d.id],
            )
            .unwrap();
        let d = s.doc(&d.id).unwrap();
        let room = s.room(&d).unwrap();
        let image = BASE64.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFlsAAAAASUVORK5CYII=").unwrap();
        s.write_upload(&d, ".assets/media.png", &image).unwrap();
        process_frame(
            &s,
            &d,
            &room,
            &peer_update(&room, "\n![new](.assets/media.png)"),
            true,
            false,
            &mut Peer::default(),
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(s.root.join("media.md")).unwrap(),
            "Hello"
        );
        let lease = DiskFile::open(&s.root.join("media.md")).unwrap().unwrap();
        let (send, receive) = std::sync::mpsc::channel();
        let worker = s.clone();
        let id = d.id.clone();
        let request = std::thread::spawn(move || {
            let result = media_file(
                &worker,
                &id,
                &Media {
                    path: ".assets/media.png".into(),
                    token: Some("media-share".into()),
                },
                &HeaderMap::new(),
            );
            send.send(result.map(|(_, size, mime)| (size, mime)))
                .unwrap();
        });
        let response = receive.recv_timeout(std::time::Duration::from_secs(1));
        let intact = lease.intact();
        drop(lease);
        request.join().unwrap();
        assert!(
            intact,
            "Image requests must not interrupt the note's write lease"
        );
        assert_eq!(response.unwrap().unwrap(), (image.len(), "image/png"));
    }
    #[tokio::test]
    async fn reopening_a_room_does_not_grant_an_untrusted_future_attachment() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(
            dir.path().join("docs"),
            dir.path().join("state"),
            "http://localhost:3478".into(),
        )
        .unwrap();
        fs::write(s.root.join("shared.md"), "hello\n").unwrap();
        let registered = s.index_document("shared.md").unwrap();
        s.db.lock()
            .unwrap()
            .execute(
                "UPDATE docs SET permission='edit',token='review-share' WHERE id=?",
                [&registered.id],
            )
            .unwrap();
        let d = s.doc(&registered.id).unwrap();
        let room = s.room(&d).unwrap();
        let peer = Doc::with_options(Options {
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
        peer.transact_mut()
            .apply_update(Update::decode_v1(&state).unwrap())
            .unwrap();
        let before = peer.transact().state_vector();
        let text = peer.get_or_insert_text("content");
        let len = text.len(&peer.transact());
        text.insert(
            &mut peer.transact_mut(),
            len,
            "\n![private](future-private.png",
        );
        let update = peer.transact().encode_state_as_update_v1(&before);
        process_frame(
            &s,
            &d,
            &room,
            &Message::Sync(SyncMessage::Update(update)).encode_v1(),
            true,
            false,
            &mut Peer::default(),
        )
        .unwrap();
        // A later local owner action creates a private file with the guessed name.
        fs::write(s.root.join("future-private.png"),BASE64.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFlsAAAAASUVORK5CYII=").unwrap()).unwrap();
        let path = s.media_path(&d, "future-private.png").unwrap();
        assert!(!s.attachment_allowed(&d, &path));
        s.rooms.lock().unwrap().remove(&d.id);
        drop(room);
        let _reopened = s.room(&d).unwrap();
        let status = match media(
            State(s.clone()),
            AxPath(d.id.clone()),
            Query(Media {
                path: "future-private.png".into(),
                token: Some("review-share".into()),
            }),
            HeaderMap::new(),
        )
        .await
        {
            Ok(response) => response.status(),
            Err(error) => error.0,
        };
        assert_eq!(
            status,
            StatusCode::FORBIDDEN,
            "A cold room must not publish a formerly private attachment"
        );
    }
}
