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
    if !documents::has_media(&d.path) {
        return Err(plain_text());
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
    if !documents::has_media(&d.path) {
        return Err(plain_text());
    }
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
fn plain_text() -> ApiError {
    bad("Plain text documents cannot embed images or videos.")
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
    let served = doc_job(s, id.clone(), move |s| {
        Ok(media_file(s, &id, &q, &authorize)
            .map_err(|error| refused(s, &id, &q, &authorize, error)))
    })
    .await?;
    let (path, len, mime) = match served {
        Ok(file) => file,
        Err(refused) => return Ok(refused),
    };
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
/// A refused media request. The owner's editor learns why it has nothing to
/// show; anyone else gets only the error, as before.
fn refused(s: &Store, id: &str, q: &Media, h: &HeaderMap, error: ApiError) -> Response {
    let reason = s
        .doc(id)
        .ok()
        .filter(|d| {
            documents::has_media(&d.path) && requester(s, d, q, h).is_ok_and(|(owner, _)| owner)
        })
        .and_then(|d| owner_file(s, &d, &q.path).err());
    match reason {
        Some(reason) => {
            (error.0, Json(json!({"error": error.1, "reason": reason}))).into_response()
        }
        None => error.into_response(),
    }
}
/// Whether a media request is the owner's, and whether it comes through the
/// owner's media capability for this document.
fn requester(s: &Store, d: &Document, q: &Media, h: &HeaderMap) -> Result<(bool, bool)> {
    let capability = q
        .token
        .as_deref()
        .is_some_and(|token| browser_auth::media_allowed(s, &d.id, token));
    let owner = capability
        || s.access(
            h,
            d,
            &Access {
                token: q.token.clone(),
                ..Access::default()
            },
        )?
        .0;
    Ok((owner, capability))
}
pub(super) fn media_file(
    s: &Store,
    id: &str,
    q: &Media,
    h: &HeaderMap,
) -> Result<(PathBuf, usize, &'static str)> {
    let d = s.doc(id)?;
    let (owner, capability) = requester(s, &d, q, h)?;
    // A plain text document names no media, not even for its owner.
    if !documents::has_media(&d.path) {
        return Err(denied());
    }
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
    let metadata = fs::metadata(&path)?;
    let (len, mime) = media_kind(&path, &metadata)?;
    if owner {
        // The owner's editor sees an approved image edited in place.
        s.refresh_served_media(&d, &q.path, &metadata);
    }
    Ok((path, len, mime))
}
/// The size and type of a file Locdoc serves as media: a supported image up
/// to 5 MB or video up to 20 MB, by its bytes rather than its name.
fn media_kind(path: &Path, metadata: &fs::Metadata) -> Result<(usize, &'static str)> {
    use std::io::Read;
    let len = metadata.len() as usize;
    if len == 0 || len > 20 * MB {
        return Err(bad("Attachment is empty or exceeds the 20 MB maximum."));
    }
    let mut prefix = [0; 512];
    let n = fs::File::open(path)?.read(&mut prefix)?;
    let kind = infer::get(&prefix[..n]).ok_or_else(|| bad("Unsupported attachment."))?;
    if !allowed_mime(kind.mime_type()) {
        return Err(denied());
    }
    if kind.mime_type().starts_with("image/") && len > 5 * MB {
        return Err(bad("Image exceeds 5 MB."));
    }
    Ok((len, kind.mime_type()))
}
/// Whether the editor previews a media reference as a local file: a relative
/// path, never a URL with a scheme (`https:`, `data:` or a drive letter), an
/// absolute path or a fragment. `isLocalMediaPath` in src/markdown-media.ts
/// is the same rule; test/fixtures/media-references.json holds both.
pub(super) fn local_reference(reference: &str) -> bool {
    let scheme = reference.split_once(':').is_some_and(|(scheme, _)| {
        let mut characters = scheme.chars();
        characters
            .next()
            .is_some_and(|first| first.is_ascii_alphabetic())
            && characters.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
    });
    !reference.is_empty() && !scheme && !reference.starts_with(['/', '#'])
}
/// The media references of Markdown source that the editor previews: inline
/// images with a local destination, outside tables and inline links
/// (`[label](destination)`), and not part of the description of an image it
/// previews. Reference-style and linked images stay source text there.
/// `previewedImage` in src/markdown-media.ts is the same rule, and
/// test/fixtures/media-references.json holds both. The source is parsed as
/// `Store::references` parses it, so each is a reference the document serves.
pub(super) fn previewed(content: &str) -> HashSet<String> {
    use pulldown_cmark::{Event, LinkType, Tag, TagEnd};
    let mut previewed = HashSet::new();
    // Whether each open table, link or image keeps the images inside it from
    // previewing, as a table, an inline link and a previewed image do.
    let mut open: Vec<bool> = Vec::new();
    for event in markdown::parser(&comments::reading_source(content)) {
        match event {
            Event::Start(Tag::Table(_)) => open.push(true),
            Event::Start(Tag::Link { link_type, .. }) => open.push(link_type == LinkType::Inline),
            Event::Start(Tag::Image {
                link_type,
                dest_url,
                ..
            }) => {
                let shown = link_type == LinkType::Inline
                    && !open.contains(&true)
                    && local_reference(&dest_url);
                if shown {
                    previewed.insert(dest_url.to_string());
                }
                open.push(shown);
            }
            Event::End(TagEnd::Table | TagEnd::Link | TagEnd::Image) => {
                open.pop();
            }
            _ => {}
        }
    }
    previewed
}
/// Whether a canonical path is in a trash folder: a `.trash`, where other
/// applications keep deleted files, or Locdoc's own `.locdoc-trash`. Media in
/// one is served to nobody, its owner included, unlike a file in another
/// dot-named folder, which only link visitors never see.
pub(super) fn in_trash(path: &Path) -> bool {
    path.components()
        .any(|part| part.as_os_str() == ".trash" || part.as_os_str() == namespace::TRASH)
}
/// The file a local media reference of `d` names, or why Locdoc shows it to
/// nobody, its owner included: `outside` the documents folder, `missing`,
/// in the `state` folder or in a `trash` folder, `invalid` when it is spelled
/// as no path Locdoc opens (an absolute path, backslashes, `://` or broken
/// percent-encoding), or as `unservable` judges the file.
fn owner_file(
    s: &Store,
    d: &Document,
    reference: &str,
) -> std::result::Result<(PathBuf, fs::Metadata), &'static str> {
    let path = s
        .media_path(d, reference)
        .map_err(|_| unresolved(s, d, reference))?;
    let metadata = fs::metadata(&path).map_err(|_| "missing")?;
    match unservable(&path, &metadata) {
        Some(reason) => Err(reason),
        None => Ok((path, metadata)),
    }
}
/// Why `Store::media_path` names no file for a reference of `d`.
fn unresolved(s: &Store, d: &Document, reference: &str) -> &'static str {
    let Ok(decoded) = percent_encoding::percent_decode_str(reference).decode_utf8() else {
        return "invalid";
    };
    if reference.contains("://")
        || reference.contains('\\')
        || decoded.contains('\\')
        || decoded.starts_with('/')
    {
        return "invalid";
    }
    let path = s
        .root
        .join(Path::new(&d.path).parent().unwrap())
        .join(decoded.as_ref());
    match fs::canonicalize(&path) {
        Ok(file) if !file.starts_with(&s.root) => "outside",
        // Inside the documents folder only a state folder kept there and a
        // trash folder are refused.
        Ok(file) if s.in_state(&file) => "state",
        Ok(file) if in_trash(&file) => "trash",
        // It appeared after `Store::media_path` found nothing there.
        Ok(_) => "missing",
        // Nothing is there; a spelling that climbs out names nothing inside.
        Err(_) => {
            let mut spelled = PathBuf::new();
            for part in path.components() {
                match part {
                    std::path::Component::ParentDir => {
                        spelled.pop();
                    }
                    std::path::Component::CurDir => {}
                    part => spelled.push(part),
                }
            }
            if spelled.starts_with(&s.root) {
                "missing"
            } else {
                "outside"
            }
        }
    }
}
/// Why Locdoc serves a file as media to nobody, judged by its bytes as
/// `media_kind` judges them: `unsupported` when it is no image or video
/// Locdoc shows, `too-large` when it is an image over 5 MB or a video over
/// 20 MB.
fn unservable(path: &Path, metadata: &fs::Metadata) -> Option<&'static str> {
    use std::io::Read;
    if !metadata.is_file() || metadata.len() == 0 {
        return Some("unsupported");
    }
    let mut prefix = [0; 512];
    let kind = fs::File::open(path)
        .and_then(|mut file| file.read(&mut prefix))
        .ok()
        .and_then(|n| infer::get(&prefix[..n]))
        .filter(|kind| allowed_mime(kind.mime_type()));
    let Some(kind) = kind else {
        return Some("unsupported");
    };
    let limit = if kind.mime_type().starts_with("video/") {
        20 * MB
    } else {
        5 * MB
    };
    (metadata.len() as usize > limit).then_some("too-large")
}
/// Where link visitors never see a file, whatever approved it: one rule for
/// desktop imports, a first load and the owner's Show to link visitors
/// alike. That is outside the documents folder, in a state folder kept inside
/// it (`state`: it holds the owner key, the database and recovery archives),
/// and under a dot-named file or folder (`hidden`), except Locdoc's own
/// `.assets` uploads at the top of the documents folder. `path` is canonical.
pub(super) fn private_location(s: &Store, path: &Path) -> Option<&'static str> {
    let Ok(relative) = path.strip_prefix(&s.root) else {
        return Some("outside");
    };
    if s.data != s.root && s.data.starts_with(&s.root) && path.starts_with(&s.data) {
        return Some("state");
    }
    relative
        .components()
        .enumerate()
        .any(|(index, part)| {
            let name = part.as_os_str().to_string_lossy();
            name.starts_with('.') && !(index == 0 && name == ".assets")
        })
        .then_some("hidden")
}
/// The media references the owner's editor previews in `content` that link
/// visitors cannot see, and why: first what Locdoc shows nobody, as
/// `owner_file` names it, then `state` or `hidden` as `private_location`
/// names it, and `unapproved` for a file that only waits for the owner's
/// approval.
pub(super) fn hidden_media(s: &Store, d: &Document, content: &str) -> Vec<Value> {
    if !documents::has_media(&d.path) {
        return Vec::new();
    }
    let approvals = s.approvals(d);
    let previewed = previewed(content);
    let mut hidden: Vec<(&String, &str)> = previewed
        .iter()
        .filter_map(|reference| {
            let reason = match owner_file(s, d, reference) {
                Err(reason) => reason,
                Ok((path, _)) => match private_location(s, &path) {
                    Some(reason) => reason,
                    None if approvals.approves(&path) && approvals.active(&path) => return None,
                    None => "unapproved",
                },
            };
            Some((reference, reason))
        })
        .collect();
    hidden.sort();
    hidden
        .into_iter()
        .map(|(path, reason)| json!({"path": path, "reason": reason}))
        .collect()
}
/// What an owner's approval for link visitors would publish, or why it
/// cannot, for exactly the references `hidden_media` calls `unapproved`: an
/// image or video file Locdoc serves outside every `private_location`.
/// Remote links, data URLs and fragments are `outside`.
pub(super) fn publishable(
    s: &Store,
    d: &Document,
    reference: &str,
) -> std::result::Result<Option<namespace::Identity>, &'static str> {
    if !local_reference(reference) {
        return Err("outside");
    }
    let (path, metadata) = owner_file(s, d, reference)?;
    if let Some(reason) = private_location(s, &path) {
        return Err(reason);
    }
    Ok(namespace::Identity::of(&metadata))
}
#[derive(Deserialize)]
pub(super) struct MediaShare {
    paths: Vec<String>,
}
/// The owner's "Show to link visitors" for media references link visitors
/// cannot see. Only the owner approves; each path must be a current media
/// reference of the document and pass `publishable`.
pub(super) async fn share_media(
    State(s): State<App>,
    AxPath(id): AxPath<String>,
    _owner: security::Owner,
    Json(b): Json<MediaShare>,
) -> Result<Json<Value>> {
    if b.paths.len() > 500 || b.paths.iter().any(|path| path.len() > 4096) {
        return Err(bad("Choose up to 500 image paths."));
    }
    doc_job(s, id.clone(), move |s| {
        let d = s.doc(&id)?;
        let room = s.room(&d)?;
        let mut room = room.lock().unwrap();
        let (shared, refused) = room.share_media(s, &d, &b.paths)?;
        let refused = refused
            .into_iter()
            .map(|(path, reason)| json!({"path": path, "reason": reason}))
            .collect::<Vec<_>>();
        Ok(Json(
            json!({"ok": true, "shared": shared, "refused": refused}),
        ))
    })
    .await
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

    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFlsAAAAASUVORK5CYII=";

    fn owner(s: &Store) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            format!("Bearer {}", s.key).parse().unwrap(),
        );
        headers
    }
    fn link(s: &Store, d: &Document, token: &str) -> Document {
        s.db.lock()
            .unwrap()
            .execute(
                "UPDATE docs SET permission='edit',token=? WHERE id=?",
                params![token, d.id],
            )
            .unwrap();
        s.doc(&d.id).unwrap()
    }
    fn served(
        s: &Store,
        d: &Document,
        path: &str,
        token: Option<&str>,
        h: &HeaderMap,
    ) -> StatusCode {
        let request = Media {
            path: path.into(),
            token: token.map(Into::into),
        };
        match media_file(s, &d.id, &request, h) {
            Ok(_) => StatusCode::OK,
            Err(error) => error.0,
        }
    }
    fn approvals(s: &Store, d: &Document) -> i64 {
        s.db.lock()
            .unwrap()
            .query_row(
                "SELECT (SELECT count(*) FROM trusted_references WHERE doc=?1)
                    + (SELECT count(*) FROM active_media WHERE doc=?1)
                    + (SELECT count(*) FROM grants WHERE doc=?1)",
                [&d.id],
                |row| row.get(0),
            )
            .unwrap()
    }

    #[test]
    fn plain_text_image_syntax_is_text_never_approved_served_or_uploaded() {
        let (_dir, s) = store();
        let png = BASE64.decode(PNG).unwrap();
        fs::create_dir_all(s.root.join("Notes")).unwrap();
        fs::write(s.root.join("Notes/photo.png"), &png).unwrap();
        // A desktop Markdown file naming this image would approve it.
        fs::write(s.root.join("Notes/plain.txt"), "![photo](photo.png)\n").unwrap();
        let d = s.index_document("Notes/plain.txt").unwrap();
        let d = link(&s, &d, "plain-link");
        let room = s.room(&d).unwrap();
        fs::write(
            s.root.join("Notes/plain.txt"),
            "![photo](photo.png)\n![again](./photo.png)\n",
        )
        .unwrap();
        assert!(s.persist(&d, &mut room.lock().unwrap()).unwrap());
        assert_eq!(approvals(&s, &d), 0);
        assert_eq!(s.usage(&d, &room_text(&room.lock().unwrap())), 0);
        // A link editor may type image syntax: it is text, not an embed of
        // an unapproved file, so the edit is accepted.
        let typed = peer_update(&room, "![secret](../private.png)\n");
        process_frame(&s, &d, &room, &typed, true, false, &mut Peer::default()).unwrap();
        assert!(room_text(&room.lock().unwrap()).contains("![secret]"));
        assert_eq!(approvals(&s, &d), 0);
        // Nothing is served through it, not even to the owner.
        for (token, headers) in [(Some("plain-link"), HeaderMap::new()), (None, owner(&s))] {
            assert_eq!(
                served(&s, &d, "photo.png", token, &headers),
                StatusCode::FORBIDDEN
            );
        }
        assert_eq!(
            upload_payload(&s, d.clone(), d.id.clone(), "photo.png".into(), &png)
                .unwrap_err()
                .1,
            plain_text().1
        );
        let payload = document_payload(&s, &owner(&s), &d, &Access::default()).unwrap();
        assert_eq!(payload["hiddenMedia"], json!([]));
        // As Markdown its image syntax names media, which a rename does not
        // approve for link visitors; the owner sees what they cannot.
        drop(room);
        s.rename_document(&d.id, "Notes/plain.md").unwrap();
        let markdown = s.doc(&d.id).unwrap();
        assert_eq!(
            served(
                &s,
                &markdown,
                "photo.png",
                Some("plain-link"),
                &HeaderMap::new()
            ),
            StatusCode::FORBIDDEN
        );
        let payload = document_payload(&s, &owner(&s), &markdown, &Access::default()).unwrap();
        assert_eq!(
            payload["hiddenMedia"],
            json!([
                {"path": "../private.png", "reason": "missing"},
                {"path": "./photo.png", "reason": "unapproved"},
                {"path": "photo.png", "reason": "unapproved"},
            ])
        );
    }

    /// One shared page in Album with a link editor, a folder link around it
    /// and an MCP connection, served on a loopback port.
    async fn gallery() -> (tempfile::TempDir, App, Document, String, String, String) {
        let (dir, mut s) = store();
        let png = BASE64.decode(PNG).unwrap();
        for (path, bytes) in [
            ("Album/photo.png", png.as_slice()),
            ("Album/.hidden/secret.png", png.as_slice()),
            ("Album/notes.png", b"Not an image at all".as_slice()),
            ("Album/approved.png", png.as_slice()),
        ] {
            fs::create_dir_all(s.root.join(path).parent().unwrap()).unwrap();
            fs::write(s.root.join(path), bytes).unwrap();
        }
        fs::write(dir.path().join("outside.png"), &png).unwrap();
        // The desktop file approves one image; the rest are typed in the
        // owner's browser, which approves nothing.
        fs::write(s.root.join("Album/page.md"), "![approved](approved.png)\n").unwrap();
        let page = s.index_document("Album/page.md").unwrap();
        let page = link(&s, &page, "page-link");
        let room = s.room(&page).unwrap();
        let upload = format!(".assets/{}/upload.png", page.id);
        s.write_upload(&page, &upload, &png).unwrap();
        let typed = concat!(
            "![photo](photo.png) ![gone](gone.png) ![secret](.hidden/secret.png)\n",
            "![outside](../../outside.png) ![notes](notes.png) ![web](https://example.com/a.png)\n",
        );
        let embed = format!("{typed}![upload](../{upload})\n");
        process_frame(
            &s,
            &page,
            &room,
            &peer_update(&room, &embed),
            true,
            true,
            &mut Peer::default(),
        )
        .unwrap();
        assert!(s.persist(&page, &mut room.lock().unwrap()).unwrap());
        drop(room);
        let folder = folders::share_folder(
            &s,
            serde_json::from_value(json!({"path": "Album", "permission": "edit"})).unwrap(),
        )
        .unwrap();
        let folder = folder["shareUrl"]
            .as_str()
            .unwrap()
            .rsplit('/')
            .next()
            .unwrap()
            .to_owned();
        const CONNECTION: &str =
            "mcp_a_1111111111111111111111111111111111111111111111111111111111111111";
        let credentials = {
            let db = s.db.lock().unwrap();
            db.execute(
                "INSERT INTO mcp_clients(id,name,redirects,created,expires) VALUES('gallery','Gallery','[]',?,?)",
                params![now(), now() + 3600],
            )
            .unwrap();
            db.execute(
                "INSERT INTO mcp_connections(id,client,scope,access_hash,access_expires,refresh_hash,expires,created)
                 VALUES('gallery-connection','gallery','locdoc:read locdoc:write locdoc:share',?,?,?,?,?)",
                params![hash(CONNECTION), now() + 3600, hash("gallery-refresh"), now() + 3600, now()],
            )
            .unwrap();
            db.execute("INSERT INTO mcp_documents(doc) VALUES(?)", [&page.id])
                .unwrap();
            mcp_auth::Credentials::load(&db).unwrap()
        };
        Arc::get_mut(&mut s).unwrap().mcp_credentials = credentials;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let application = router(s.clone());
        tokio::spawn(async move { axum::serve(listener, application).await.unwrap() });
        (dir, s, page, base, folder, CONNECTION.into())
    }

    #[test]
    fn urls_fragments_and_drive_paths_are_never_listed_as_hidden_files() {
        let (_dir, s) = store();
        let png = BASE64.decode(PNG).unwrap();
        fs::create_dir_all(s.root.join("Notes")).unwrap();
        fs::write(s.root.join("Notes/photo.png"), &png).unwrap();
        fs::write(s.root.join("Notes/page.md"), "# Page\n").unwrap();
        let page = s.index_document("Notes/page.md").unwrap();
        let room = s.room(&page).unwrap();
        // Typed in the owner's browser: nothing here is approved.
        let typed = concat!(
            "![photo](photo.png) ![data](data:image/png;base64,AAAA) ![top](#top)\n",
            "![drive](C:/Pictures/x.png) ![mail](mailto:a@example.test)\n",
        );
        process_frame(
            &s,
            &page,
            &room,
            &peer_update(&room, typed),
            true,
            true,
            &mut Peer::default(),
        )
        .unwrap();
        // The editor previews none of the others as local media, so the
        // owner never sees them as images link visitors cannot see.
        let payload = document_payload(&s, &owner(&s), &page, &Access::default()).unwrap();
        assert_eq!(
            payload["hiddenMedia"],
            json!([{"path": "photo.png", "reason": "unapproved"}])
        );
        // Showing one is refused as a remote link is.
        let requested = [
            "data:image/png;base64,AAAA",
            "#top",
            "C:/Pictures/x.png",
            "mailto:a@example.test",
        ]
        .map(String::from);
        let (shared, refused) = room
            .lock()
            .unwrap()
            .share_media(&s, &page, &requested)
            .unwrap();
        assert!(shared.is_empty());
        assert_eq!(
            refused,
            requested.map(|path| (path, "outside")).to_vec(),
            "refusals"
        );
        assert_eq!(approvals(&s, &page), 0);
    }

    #[test]
    fn images_the_editor_never_previews_are_never_listed_as_hidden() {
        let (_dir, s) = store();
        fs::write(s.root.join("page.md"), "# Page\n").unwrap();
        let page = s.index_document("page.md").unwrap();
        let room = s.room(&page).unwrap();
        // Typed in the owner's browser: nothing here is approved, and only
        // the first image previews there.
        let typed = concat!(
            "![shown](shown.png)\n\n![reference][photo]\n\n",
            "[![linked](linked.png)](https://example.test) [![near](near.png)](notes)\n\n",
            "| Photo |\n| --- |\n| ![cell](cell.png) |\n\n[photo]: reference.png\n",
        );
        process_frame(
            &s,
            &page,
            &room,
            &peer_update(&room, typed),
            true,
            true,
            &mut Peer::default(),
        )
        .unwrap();
        let payload = document_payload(&s, &owner(&s), &page, &Access::default()).unwrap();
        assert_eq!(
            payload["hiddenMedia"],
            json!([{"path": "shown.png", "reason": "missing"}])
        );
    }

    #[tokio::test]
    async fn only_the_owner_shows_hidden_images_to_link_visitors_and_only_publishable_files() {
        let (_dir, s, page, base, folder, connection) = gallery().await;
        let client = reqwest::Client::new();
        let document = format!("{base}/api/docs/{}", page.id);
        let hidden = || async {
            let response = client
                .get(&document)
                .bearer_auth(&s.key)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            serde_json::from_slice::<Value>(&response.bytes().await.unwrap()).unwrap()["hiddenMedia"].clone()
        };
        // Each says why; only photo.png waits for nothing but approval.
        assert_eq!(
            hidden().await,
            json!([
                {"path": "../../outside.png", "reason": "outside"},
                {"path": ".hidden/secret.png", "reason": "hidden"},
                {"path": "gone.png", "reason": "missing"},
                {"path": "notes.png", "reason": "unsupported"},
                {"path": "photo.png", "reason": "unapproved"},
            ])
        );
        // Visitors only learn their own view: the owner's list stays private.
        let visitor = client
            .get(format!("{document}?token=page-link"))
            .send()
            .await
            .unwrap();
        assert_eq!(visitor.status(), StatusCode::OK);
        let visitor: Value = serde_json::from_slice(&visitor.bytes().await.unwrap()).unwrap();
        assert!(visitor.get("hiddenMedia").is_none());
        let paths = json!({"paths": [
            "photo.png", "gone.png", ".hidden/secret.png", "../../outside.png",
            "notes.png", "https://example.com/a.png", "elsewhere.png", "approved.png"
        ]});
        let share = |request: reqwest::RequestBuilder| async {
            request
                .header(header::CONTENT_TYPE, "application/json")
                .body(paths.to_string())
                .send()
                .await
                .unwrap()
        };
        let endpoint = format!("{document}/media/share");
        // A link editor, a folder link editor, an MCP connection and an
        // anonymous request can neither approve images nor learn about them.
        for request in [
            client.post(format!("{endpoint}?token=page-link")),
            client.post(&endpoint).header("x-locdoc-share", "page-link"),
            client.post(format!("{endpoint}?token={folder}")),
            client.post(&endpoint).header("x-locdoc-share", &folder),
            client.post(&endpoint).bearer_auth(&connection),
            client.post(&endpoint),
        ] {
            assert_eq!(share(request).await.status(), StatusCode::FORBIDDEN);
        }
        assert_eq!(
            served(&s, &page, "photo.png", Some("page-link"), &HeaderMap::new()),
            StatusCode::FORBIDDEN
        );
        let response = share(client.post(&endpoint).bearer_auth(&s.key)).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            serde_json::from_slice::<Value>(&response.bytes().await.unwrap()).unwrap(),
            json!({"ok": true, "shared": ["photo.png", "approved.png"], "refused": [
                {"path": "gone.png", "reason": "missing"},
                {"path": ".hidden/secret.png", "reason": "hidden"},
                {"path": "../../outside.png", "reason": "outside"},
                {"path": "notes.png", "reason": "unsupported"},
                {"path": "https://example.com/a.png", "reason": "outside"},
                {"path": "elsewhere.png", "reason": "unreferenced"},
            ]})
        );
        for (path, status) in [
            ("photo.png", StatusCode::OK),
            ("approved.png", StatusCode::OK),
            (".hidden/secret.png", StatusCode::FORBIDDEN),
        ] {
            for token in ["page-link", folder.as_str()] {
                assert_eq!(
                    served(&s, &page, path, Some(token), &HeaderMap::new()),
                    status,
                    "{path}"
                );
            }
        }
        assert_eq!(
            hidden().await,
            json!([
                {"path": "../../outside.png", "reason": "outside"},
                {"path": ".hidden/secret.png", "reason": "hidden"},
                {"path": "gone.png", "reason": "missing"},
                {"path": "notes.png", "reason": "unsupported"},
            ])
        );
    }

    #[test]
    fn approvals_tell_every_open_view_to_request_its_media_again() {
        let (_dir, s) = store();
        let png = BASE64.decode(PNG).unwrap();
        fs::create_dir_all(s.root.join("Notes")).unwrap();
        for path in ["Notes/photo.png", "Notes/other.png"] {
            fs::write(s.root.join(path), &png).unwrap();
        }
        fs::write(s.root.join("Notes/page.md"), "# Page\n").unwrap();
        let d = s.index_document("Notes/page.md").unwrap();
        let d = link(&s, &d, "page-link");
        let room = s.room(&d).unwrap();
        // Typed in the owner's browser, so link visitors cannot see it.
        let typed = peer_update(&room, "![photo](./photo.png) ![other](other.png)\n");
        process_frame(&s, &d, &room, &typed, true, true, &mut Peer::default()).unwrap();
        assert!(s.persist(&d, &mut room.lock().unwrap()).unwrap());
        // Every socket of the document, owner and visitors alike, hears the
        // room; the signal is the bare message code.
        let mut events = room.lock().unwrap().tx.subscribe();
        let signal = Message::Custom(engine::MEDIA_APPROVED, Vec::new()).encode_v1();
        let mut signals = || {
            std::iter::from_fn(|| events.try_recv().ok())
                .filter(|frame| *frame == signal)
                .count()
        };
        let visitor = |path: &str| served(&s, &d, path, Some("page-link"), &HeaderMap::new());
        assert_eq!(visitor("./photo.png"), StatusCode::FORBIDDEN);
        // A desktop save that approves nothing says nothing.
        let text = room_text(&room.lock().unwrap());
        fs::write(s.root.join("Notes/page.md"), format!("{text}More\n")).unwrap();
        assert!(s.persist(&d, &mut room.lock().unwrap()).unwrap());
        assert_eq!(signals(), 0);
        // One naming that file another way approves it for the spelling
        // visitors already failed to load.
        let text = room_text(&room.lock().unwrap());
        fs::write(
            s.root.join("Notes/page.md"),
            format!("{text}![again](photo.png)\n"),
        )
        .unwrap();
        assert!(s.persist(&d, &mut room.lock().unwrap()).unwrap());
        assert_eq!(signals(), 1, "a desktop approval");
        assert_eq!(visitor("./photo.png"), StatusCode::OK);
        // So does Show to link visitors, once it approves something.
        let mut room = room.lock().unwrap();
        room.share_media(&s, &d, &["gone.png".into()]).unwrap();
        assert_eq!(signals(), 0);
        room.share_media(&s, &d, &["other.png".into()]).unwrap();
        drop(room);
        assert_eq!(signals(), 1, "Show to link visitors");
        assert_eq!(visitor("other.png"), StatusCode::OK);
    }

    #[test]
    fn no_approval_shows_link_visitors_a_file_in_a_hidden_folder() {
        let (_dir, s) = store();
        let png = BASE64.decode(PNG).unwrap();
        for path in [
            ".secret.png",
            "Notes/.dot/first.png",
            "Notes/.dot/later.png",
            "Notes/.assets/nested.png",
            "Notes/photo.png",
            ".assets/logo.png",
        ] {
            fs::create_dir_all(s.root.join(path).parent().unwrap()).unwrap();
            fs::write(s.root.join(path), &png).unwrap();
        }
        // The desktop file's first load approves what it names, and a
        // desktop import what it adds.
        let first = concat!(
            "![secret](../.secret.png)\n![first](.dot/first.png)\n",
            "![nested](.assets/nested.png)\n![photo](photo.png)\n![logo](../.assets/logo.png)\n",
        );
        fs::write(s.root.join("Notes/page.md"), first).unwrap();
        let d = s.index_document("Notes/page.md").unwrap();
        let d = link(&s, &d, "page-link");
        let room = s.room(&d).unwrap();
        fs::write(
            s.root.join("Notes/page.md"),
            format!("{first}![later](.dot/later.png)\n"),
        )
        .unwrap();
        assert!(s.persist(&d, &mut room.lock().unwrap()).unwrap());
        drop(room);
        // Those approvals are recorded, as older versions recorded them, yet
        // serve no hidden file; Locdoc's own top-level uploads stay served.
        assert!(approvals(&s, &d) >= 12);
        for (path, status) in [
            ("../.secret.png", StatusCode::FORBIDDEN),
            (".dot/first.png", StatusCode::FORBIDDEN),
            (".dot/later.png", StatusCode::FORBIDDEN),
            (".assets/nested.png", StatusCode::FORBIDDEN),
            ("photo.png", StatusCode::OK),
            ("../.assets/logo.png", StatusCode::OK),
        ] {
            assert_eq!(
                served(&s, &d, path, Some("page-link"), &HeaderMap::new()),
                status,
                "{path}"
            );
        }
        let hidden = [
            "../.secret.png",
            ".assets/nested.png",
            ".dot/first.png",
            ".dot/later.png",
        ];
        let payload = document_payload(&s, &owner(&s), &d, &Access::default()).unwrap();
        assert_eq!(
            payload["hiddenMedia"],
            json!(hidden.map(|path| json!({"path": path, "reason": "hidden"})))
        );
        // Showing one is refused for the same reason.
        let requested = hidden.map(String::from);
        let room = s.room(&d).unwrap();
        let (shared, refused) = room
            .lock()
            .unwrap()
            .share_media(&s, &d, &requested)
            .unwrap();
        assert!(shared.is_empty());
        assert_eq!(refused, requested.map(|path| (path, "hidden")).to_vec());
    }

    #[tokio::test]
    async fn media_locdoc_shows_nobody_is_listed_and_only_its_owner_learns_why() {
        let (dir, s) = store();
        let png = BASE64.decode(PNG).unwrap();
        let mp4 = b"\0\0\0\x18ftypisom\0\0\x02\0isomiso2";
        fs::create_dir_all(s.root.join("Notes")).unwrap();
        for (path, bytes, size) in [
            ("big.png", png.as_slice(), 5 * MB + 1),
            ("big.mp4", mp4.as_slice(), 20 * MB + 1),
            ("clip.mp4", mp4.as_slice(), 6 * MB),
            ("photo.png", png.as_slice(), png.len()),
            ("notes.png", b"Not an image at all".as_slice(), 19),
        ] {
            let path = s.root.join("Notes").join(path);
            fs::write(&path, bytes).unwrap();
            fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .unwrap()
                .set_len(size as u64)
                .unwrap();
        }
        fs::write(dir.path().join("outside.png"), &png).unwrap();
        // Locdoc's own trash, and the `.trash` other applications keep at the
        // top of a folder they open: neither is served, not even to the
        // owner, unlike another dot-named folder.
        for path in [
            ".locdoc-trash/item/old.png",
            ".trash/older.png",
            "Notes/.trash/binned.png",
            "Notes/.dot/kept.png",
        ] {
            fs::create_dir_all(s.root.join(path).parent().unwrap()).unwrap();
            fs::write(s.root.join(path), &png).unwrap();
        }
        // The desktop file approves every one of them.
        fs::write(
            s.root.join("Notes/page.md"),
            concat!(
                "![big](big.png) ![clip](big.mp4) ![small](clip.mp4) ![photo](photo.png)\n",
                "![notes](notes.png) ![gone](gone.png) ![outside](../../outside.png)\n",
                "![trashed](../.locdoc-trash/item/old.png) ![windows](pics\\photo.png)\n",
                "![older](../.trash/older.png) ![binned](.trash/binned.png)\n",
                "![kept](.dot/kept.png)\n",
            ),
        )
        .unwrap();
        let d = s.index_document("Notes/page.md").unwrap();
        let d = link(&s, &d, "page-link");
        let payload = document_payload(&s, &owner(&s), &d, &Access::default()).unwrap();
        assert_eq!(
            payload["hiddenMedia"],
            json!([
                {"path": "../../outside.png", "reason": "outside"},
                {"path": "../.locdoc-trash/item/old.png", "reason": "trash"},
                {"path": "../.trash/older.png", "reason": "trash"},
                {"path": ".dot/kept.png", "reason": "hidden"},
                {"path": ".trash/binned.png", "reason": "trash"},
                {"path": "big.mp4", "reason": "too-large"},
                {"path": "big.png", "reason": "too-large"},
                {"path": "gone.png", "reason": "missing"},
                {"path": "notes.png", "reason": "unsupported"},
                {"path": "pics\\photo.png", "reason": "invalid"},
            ])
        );
        let room = s.room(&d).unwrap();
        let (_, refused) = room
            .lock()
            .unwrap()
            .share_media(
                &s,
                &d,
                &[
                    "big.png".into(),
                    "big.mp4".into(),
                    "../.locdoc-trash/item/old.png".into(),
                    "../.trash/older.png".into(),
                    ".dot/kept.png".into(),
                ],
            )
            .unwrap();
        drop(room);
        assert_eq!(
            refused,
            [
                ("big.png".to_string(), "too-large"),
                ("big.mp4".to_string(), "too-large"),
                ("../.locdoc-trash/item/old.png".to_string(), "trash"),
                ("../.trash/older.png".to_string(), "trash"),
                (".dot/kept.png".to_string(), "hidden"),
            ]
        );
        let request = |path: &str, token: Option<&str>, headers: HeaderMap| {
            let request = Query(Media {
                path: path.into(),
                token: token.map(Into::into),
            });
            media(State(s.clone()), AxPath(d.id.clone()), request, headers)
        };
        for path in ["clip.mp4", "photo.png"] {
            let response = request(path, Some("page-link"), HeaderMap::new()).await;
            assert_eq!(response.unwrap().status(), StatusCode::OK, "{path}");
        }
        // The owner's editor loads an image in another dot-named folder.
        let kept = request(".dot/kept.png", None, owner(&s)).await;
        assert_eq!(kept.unwrap().status(), StatusCode::OK);
        for (path, reason) in [
            ("big.png", "too-large"),
            ("big.mp4", "too-large"),
            ("notes.png", "unsupported"),
            ("gone.png", "missing"),
            ("../../outside.png", "outside"),
            ("../.locdoc-trash/item/old.png", "trash"),
            ("../.trash/older.png", "trash"),
            (".trash/binned.png", "trash"),
            ("pics\\photo.png", "invalid"),
        ] {
            // The owner's editor learns why it has no picture to show.
            let refused = request(path, None, owner(&s)).await.unwrap();
            let status = refused.status();
            assert!(status.is_client_error(), "{path}: {status}");
            let body: Value = serde_json::from_slice(
                &axum::body::to_bytes(refused.into_body(), usize::MAX)
                    .await
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(body["reason"], reason, "{path}");
            // A link visitor learns nothing new: the error alone.
            let visitor = match request(path, Some("page-link"), HeaderMap::new()).await {
                Ok(response) => response,
                Err(error) => error.into_response(),
            };
            assert_eq!(visitor.status(), status, "{path}");
            let body: Value = serde_json::from_slice(
                &axum::body::to_bytes(visitor.into_body(), usize::MAX)
                    .await
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(
                body.as_object().unwrap().keys().collect::<Vec<_>>(),
                ["error"],
                "{path}"
            );
        }
    }

    #[tokio::test]
    async fn the_state_folder_inside_the_documents_folder_is_never_published() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("docs");
        let s = Store::open(root.clone(), root.join("state"), "http://localhost".into()).unwrap();
        let png = BASE64.decode(PNG).unwrap();
        fs::create_dir_all(s.data.join("fonts")).unwrap();
        fs::write(s.data.join("fonts/cover.png"), &png).unwrap();
        fs::write(s.root.join("page.md"), "# Page\n").unwrap();
        let page = s.index_document("page.md").unwrap();
        let room = s.room(&page).unwrap();
        let mut room = room.lock().unwrap();
        let text = room.awareness.doc().get_or_insert_text("content");
        let end = text.len(&room.awareness.doc().transact());
        text.insert(
            &mut room.awareness.doc().transact_mut(),
            end,
            "![cover](state/fonts/cover.png)\n",
        );
        room.ensure_committed(&s, &page).unwrap();
        let (shared, refused) = room
            .share_media(&s, &page, &["state/fonts/cover.png".into()])
            .unwrap();
        assert!(shared.is_empty());
        assert_eq!(refused, [("state/fonts/cover.png".to_string(), "state")]);
        drop(room);
        assert_eq!(approvals(&s, &page), 0);
        let payload = document_payload(&s, &owner(&s), &page, &Access::default()).unwrap();
        assert_eq!(
            payload["hiddenMedia"],
            json!([{"path": "state/fonts/cover.png", "reason": "state"}])
        );
    }

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
