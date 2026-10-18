//! Social previews use the same live capabilities as document access.
use super::*;
use axum::{extract::OriginalUri, response::Html};
use std::sync::LazyLock;

const APP_TITLE: &str = "Locdoc — Local Markdown, together.";
const APP_DESCRIPTION: &str =
    "Write, comment, and work together on Markdown files that stay on your computer.";

pub(super) async fn observe_crawlers(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let telegram = req
        .headers()
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.contains("TelegramBot"));
    let request = telegram.then(|| {
        (
            req.method().clone(),
            if req.uri().path().ends_with("/preview.png") {
                "image"
            } else {
                "page"
            },
            std::time::Instant::now(),
        )
    });
    let response = next.run(req).await;
    if let Some((method, kind, started)) = request {
        // Never log capability URLs, IP addresses, titles or document text.
        tracing::info!(%method, kind, status = response.status().as_u16(), elapsed_ms = started.elapsed().as_millis(), "Telegram crawler response");
    }
    response
}

fn shared_doc(s: &Store, token: &str, selected: Option<&str>) -> Result<Option<Document>> {
    if let Ok(folder) = folders::grant(s, token) {
        folders::document(s, &folder, selected)
    } else {
        shared_document(s, token).map(Some)
    }
}

async fn preview(
    s: App,
    token: String,
    selected: Option<String>,
) -> Result<Option<(Document, social::Preview)>> {
    let capability = token.clone();
    let Some(doc) = job(s.clone(), move |s| {
        shared_doc(s, &capability, selected.as_deref())
    })
    .await?
    else {
        return Ok(None);
    };
    doc_job(s, doc.id.clone(), move |s| {
        // Resolution and admission may be separated by a long projection.
        // Recheck the live capability before accessing the accepted source.
        let doc = shared_doc(s, &token, Some(&doc.id))?.ok_or_else(denied)?;
        let room = s.room(&doc)?;
        let mut room = room.lock().unwrap();
        s.store_room(&doc, &mut room)?;
        let value = social::Preview::new(&room_text(&room), &doc.path);
        Ok(Some((doc, value)))
    })
    .await
}

pub(super) async fn shell(
    State(s): State<App>,
    OriginalUri(uri): OriginalUri,
    Query(selection): Query<folders::Selection>,
) -> Result<Html<String>> {
    let template = tokio::fs::read_to_string("dist/index.html").await?;
    let token = uri
        .path()
        .strip_prefix("/s/")
        .map(|v| v.trim_end_matches('/'));
    let shared = if let Some(token) = token {
        preview(s.clone(), token.to_string(), selection.doc.clone())
            .await
            .ok()
            .flatten()
    } else {
        None
    };
    let mut page_url = format!("{}{}", s.public_url, uri.path());
    let (title, description, image, alt) = if let Some((doc, value)) = shared {
        let token = token.unwrap();
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("doc", &doc.id)
            .finish();
        // Preserve the shared URL. Only an explicitly selected folder document
        // needs a query; inventing one gives crawlers a second page to resolve.
        page_url = format!("{}/s/{token}", s.public_url);
        if selection.doc.is_some() {
            page_url.push_str(&format!("?{query}"));
        }
        (
            format!("{} · Locdoc", value.title),
            value.description.clone(),
            format!(
                "{}/s/{token}/preview.png?{query}&v={}",
                s.public_url,
                value.fingerprint()
            ),
            format!("{} — {}", value.title, value.description),
        )
    } else {
        (
            APP_TITLE.into(),
            APP_DESCRIPTION.into(),
            format!("{}/social/locdoc-v4.png", s.public_url),
            "Locdoc’s Origami Hash icon. Local Markdown. Shared ideas.".into(),
        )
    };
    Ok(Html(render(
        &template,
        [&title, &description, &page_url, &image, &alt],
    )))
}

pub(super) async fn preview_image(
    State(s): State<App>,
    AxPath(token): AxPath<String>,
    Query(selection): Query<folders::Selection>,
) -> Result<Response> {
    let (doc, value) = preview(s.clone(), token.clone(), selection.doc)
        .await?
        .ok_or_else(denied)?;
    let png = social::image(value).await?;
    // Rendering runs off-thread. Recheck revocation before returning cached or new bytes.
    job(s, move |s| {
        shared_doc(s, &token, Some(&doc.id))?.ok_or_else(denied)?;
        Ok(())
    })
    .await?;
    Ok(([(header::CONTENT_TYPE, "image/png")], png).into_response())
}

fn render(template: &str, values: [&str; 5]) -> String {
    static FIELDS: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new("__LOCDOC_(TITLE|DESCRIPTION|PAGE_URL|IMAGE_URL|IMAGE_ALT)__").unwrap()
    });
    FIELDS
        .replace_all(template, |c: &regex::Captures<'_>| {
            let index = match &c[1] {
                "TITLE" => 0,
                "DESCRIPTION" => 1,
                "PAGE_URL" => 2,
                "IMAGE_URL" => 3,
                _ => 4,
            };
            social::escape(values[index])
        })
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn social_previews_await_document_admission_without_forcing_file_projection() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(
            directory.path().join("docs"),
            directory.path().join("state"),
            "http://localhost".into(),
        )
        .unwrap();
        fs::write(store.root.join("preview.md"), "# Original title").unwrap();
        let document = store.index_document("preview.md").unwrap();
        store
            .db
            .lock()
            .unwrap()
            .execute(
                "UPDATE docs SET permission='view',token='social-preview-share' WHERE id=?",
                [&document.id],
            )
            .unwrap();
        let room = store.room(&document).unwrap();
        {
            let mut room = room.lock().unwrap();
            store.persist(&document, &mut room).unwrap();
            apply_text(
                room.awareness.doc(),
                "# Original title",
                "# Accepted browser title",
            );
            room.save.edited();
            store.store_room(&document, &mut room).unwrap();
        }
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let busy = room.clone();
        let holder = std::thread::spawn(move || {
            let _guard = busy.lock().unwrap();
            started.send(()).unwrap();
            let _ = wait.recv_timeout(std::time::Duration::from_millis(900));
        });
        ready.await.unwrap();
        let started = std::time::Instant::now();
        let mut requests = Vec::new();
        for _ in 0..6 {
            let app = store.clone();
            requests.push(tokio::spawn(async move {
                preview(app, "social-preview-share".into(), None).await
            }));
        }
        for _ in 0..64 {
            tokio::task::yield_now().await;
        }
        let independent = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            doc_job(store.clone(), "unrelated-document".into(), |_| Ok(())),
        )
        .await;
        let elapsed = started.elapsed();
        let _ = release.send(());
        holder.join().unwrap();
        for request in requests {
            let (_, value) = request.await.unwrap().unwrap().unwrap();
            assert_eq!(value.title, "Accepted browser title");
        }
        assert!(
            matches!(independent, Ok(Ok(()))),
            "Social preview queues must leave storage capacity for other documents"
        );
        assert!(
            elapsed < std::time::Duration::from_millis(500),
            "Social preview room locks must not block the network runtime"
        );
        assert_eq!(
            fs::read_to_string(store.root.join("preview.md")).unwrap(),
            "# Original title"
        );
        assert!(
            room.lock().unwrap().save.needs_projection(),
            "A crawler must not bypass normal save coalescing"
        );
    }
    #[test]
    fn metadata_escapes_content_without_recursively_expanding_document_text() {
        let html = render(
            "<title>__LOCDOC_TITLE__</title><meta content=\"__LOCDOC_DESCRIPTION__\">",
            [
                "\"'><& __LOCDOC_DESCRIPTION__",
                "actual description",
                "",
                "",
                "",
            ],
        );
        assert!(html.contains("&quot;&#39;&gt;&lt;&amp; __LOCDOC_DESCRIPTION__"));
        assert!(html.contains("content=\"actual description\""));
    }
}
