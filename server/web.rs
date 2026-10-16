//! Public app metadata never includes document content or workspace details.
use super::*;
use axum::{extract::OriginalUri, response::Html};

pub(super) async fn shell(
    State(s): State<App>,
    OriginalUri(uri): OriginalUri,
) -> Result<Html<String>> {
    let template = tokio::fs::read_to_string("dist/index.html").await?;
    Ok(Html(render(&template, &s.public_url, uri.path())))
}

fn render(template: &str, public_url: &str, path: &str) -> String {
    let public_url = public_url.trim_end_matches('/');
    template
        .replace(
            "__LOCDOC_PAGE_URL__",
            &attribute(&format!("{public_url}{path}")),
        )
        .replace("__LOCDOC_PUBLIC_URL__", &attribute(public_url))
}

fn attribute(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_uses_configured_urls_and_escapes_attributes() {
        let template = r#"<meta property="og:url" content="__LOCDOC_PAGE_URL__"><meta property="og:image" content="__LOCDOC_PUBLIC_URL__/social/locdoc-v1.png">"#;
        let html = render(template, "https://notes.example/", "/s/a&b");
        assert!(html.contains("https://notes.example/s/a&amp;b"));
        assert!(html.contains("https://notes.example/social/locdoc-v1.png"));
        assert!(!html.contains("__LOCDOC_"));
        assert_eq!(attribute("\"'><&"), "&quot;&#39;&gt;&lt;&amp;");
    }
}
