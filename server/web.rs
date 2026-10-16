//! Social previews use the same live capabilities as document access.
use super::*;
use axum::{extract::OriginalUri, response::Html};
use std::sync::LazyLock;

const APP_TITLE: &str = "Locdoc — Local Markdown, together.";
const APP_DESCRIPTION: &str =
    "Write, comment, and work together on Markdown files that stay on your computer.";

fn shared_doc(s: &Store, token: &str, selected: Option<&str>) -> Result<Option<Document>> {
    if let Ok(folder) = folders::grant(s, token) {
        folders::document(s, &folder, selected)
    } else {
        shared_document(s, token).map(Some)
    }
}

fn preview(
    s: &Store,
    token: &str,
    selected: Option<&str>,
) -> Result<Option<(Document, social::Preview)>> {
    let Some(doc) = shared_doc(s, token, selected)? else {
        return Ok(None);
    };
    let room = s.room(&doc)?;
    let source = {
        let mut room = room.lock().unwrap();
        s.persist(&doc, &mut room)?;
        room_text(&room)
    };
    let value = social::Preview::new(&source, &doc.path);
    Ok(Some((doc, value)))
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
    let shared =
        token.and_then(|token| preview(&s, token, selection.doc.as_deref()).ok().flatten());
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
            format!("{}/social/locdoc-v1.png", s.public_url),
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
    let (doc, value) = preview(&s, &token, selection.doc.as_deref())?.ok_or_else(denied)?;
    let png = social::image(value).await?;
    // Rendering runs off-thread. Recheck revocation before returning cached or new bytes.
    shared_doc(&s, &token, Some(&doc.id))?.ok_or_else(denied)?;
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
