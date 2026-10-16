//! A bounded, in-process renderer; no commands, remote assets or runtime fonts.
use super::*;
use axum::body::Bytes;
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use resvg::{tiny_skia, usvg};
use std::{collections::VecDeque, sync::LazyLock};

const REGULAR: &[u8] = include_bytes!("../assets/social/Body-Regular.ttf");
const SEMIBOLD: &[u8] = include_bytes!("../assets/social/Body-SemiBold.ttf");
const WORDMARK: &[u8] = include_bytes!("../assets/social/Wordmark.ttf");
static FONTS: LazyLock<Arc<usvg::fontdb::Database>> = LazyLock::new(|| {
    let mut db = usvg::fontdb::Database::new();
    for data in [REGULAR, SEMIBOLD, WORDMARK] {
        db.load_font_data(data.to_vec());
    }
    Arc::new(db)
});
static ICON: LazyLock<String> =
    LazyLock::new(|| BASE64.encode(include_bytes!("../public/icons/icon-512-v5.png")));
static CACHE: Mutex<VecDeque<(String, Bytes)>> = Mutex::new(VecDeque::new());
static RENDERS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

#[derive(Clone)]
pub(super) struct Preview {
    pub title: String,
    pub description: String,
}
impl Preview {
    pub fn new(source: &str, path: &str) -> Self {
        let reading = comments::reading_source(source);
        let end = reading
            .char_indices()
            .nth(32_000)
            .map_or(reading.len(), |(i, _)| i);
        let mut title = String::new();
        let mut body = String::new();
        let mut heading = String::new();
        let mut in_heading = false;
        let mut hidden = 0;
        let options = Options::all()
            .difference(Options::ENABLE_WIKILINKS | Options::ENABLE_SMART_PUNCTUATION);
        for event in Parser::new_ext(&reading[..end], options) {
            match event {
                Event::Start(Tag::CodeBlock(_) | Tag::Image { .. } | Tag::MetadataBlock(_)) => {
                    hidden += 1
                }
                Event::End(TagEnd::CodeBlock | TagEnd::Image | TagEnd::MetadataBlock(_)) => {
                    hidden -= 1
                }
                _ if hidden > 0 => {}
                Event::Start(Tag::Heading { .. }) => {
                    in_heading = true;
                    heading.clear();
                }
                Event::End(TagEnd::Heading(_)) => {
                    if title.is_empty() {
                        title = clean(&heading, 140);
                    }
                    in_heading = false;
                }
                Event::Text(value) | Event::Code(value) => {
                    if in_heading {
                        heading.push_str(&value);
                    } else {
                        body.push_str(&value);
                    }
                }
                Event::SoftBreak
                | Event::HardBreak
                | Event::Rule
                | Event::End(
                    TagEnd::Paragraph | TagEnd::Item | TagEnd::TableCell | TagEnd::TableRow,
                ) => {
                    if in_heading {
                        heading.push(' ');
                    } else {
                        body.push(' ');
                    }
                }
                _ => {}
            }
        }
        if title.is_empty() {
            title = clean(
                &Path::new(path)
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy(),
                140,
            );
        }
        Self {
            title,
            description: clean(&body, 280),
        }
    }
    pub fn fingerprint(&self) -> String {
        hash(&format!("{}\0{}", self.title, self.description))
    }
}

fn clean(value: &str, limit: usize) -> String {
    let value = value
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>();
    let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut result = value.chars().take(limit).collect::<String>();
    if value.chars().count() > limit {
        result.push('…');
    }
    result
}
pub(super) fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn wrap(value: &str, font: &[u8], size: f32, max_lines: usize) -> Vec<String> {
    let face = ttf_parser::Face::parse(font, 0).unwrap();
    let advance = |c| {
        face.glyph_index(c)
            .and_then(|g| face.glyph_hor_advance(g))
            .map_or(size, |v| v as f32 * size / face.units_per_em() as f32)
    };
    let mut remaining = value.trim();
    let mut lines = Vec::new();
    while !remaining.is_empty() && lines.len() < max_lines {
        let mut width = 0.;
        let mut space = 0;
        let mut cut = remaining.len();
        for (i, c) in remaining.char_indices() {
            if width + advance(c) > 1020. {
                cut = i;
                break;
            }
            width += advance(c);
            if c.is_whitespace() {
                space = i;
            }
        }
        if cut == remaining.len() {
            lines.push(remaining.to_string());
            break;
        }
        let split = if space > 0 { space } else { cut };
        let mut line = remaining[..split].trim_end().to_string();
        remaining = remaining[split..].trim_start();
        if lines.len() + 1 == max_lines {
            while line.chars().map(&advance).sum::<f32>() + advance('…') > 1020. {
                line.pop();
            }
            line.push('…');
        }
        lines.push(line);
    }
    lines
}

fn render(value: &Preview) -> Result<Bytes> {
    let title = wrap(&value.title, SEMIBOLD, 64., 2);
    let excerpt = wrap(
        &value.description,
        REGULAR,
        32.,
        if title.len() < 2 { 4 } else { 3 },
    );
    let mut svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="1200" height="630" fill="#f4f4f2"/><defs><clipPath id="icon"><rect x="76" y="68" width="96" height="96" rx="16"/></clipPath></defs><image x="76" y="68" width="96" height="96" clip-path="url(#icon)" href="data:image/png;base64,{}"/><text x="196" y="137" font-family="Locdoc Social Display" font-size="58" fill="#173349">LOCDOC.</text>"##,
        *ICON
    );
    for (i, line) in title.iter().enumerate() {
        svg.push_str(&format!(r##"<text x="76" y="{}" font-family="Locdoc Social Sans" font-weight="600" font-size="64" fill="#173349">{}</text>"##, 264 + i * 76, escape(line)));
    }
    for (i, line) in excerpt.iter().enumerate() {
        svg.push_str(&format!(r##"<text x="76" y="{}" font-family="Locdoc Social Sans" font-size="32" fill="#51606c">{}</text>"##, 264 + title.len().saturating_sub(1) * 76 + 72 + i * 44, escape(line)));
    }
    svg.push_str("</svg>");
    let options = usvg::Options {
        fontdb: FONTS.clone(),
        ..Default::default()
    };
    let tree =
        usvg::Tree::from_str(&svg, &options).map_err(|_| bad("Could not render this preview."))?;
    let mut pixels =
        tiny_skia::Pixmap::new(1200, 630).ok_or_else(|| bad("Could not allocate this preview."))?;
    resvg::render(&tree, tiny_skia::Transform::default(), &mut pixels.as_mut());
    pixels
        .encode_png()
        .map(Bytes::from)
        .map_err(|_| bad("Could not encode this preview."))
}

pub(super) async fn image(value: Preview) -> Result<Bytes> {
    let key = value.fingerprint();
    if let Some((_, png)) = CACHE.lock().unwrap().iter().find(|(k, _)| *k == key) {
        return Ok(png.clone());
    }
    let permit = RENDERS.try_acquire().map_err(|_| {
        ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "Preview renderer is busy. Try again shortly.".into(),
        )
    })?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let png = render(&value)?;
        let mut cache = CACHE.lock().unwrap();
        if !cache.iter().any(|(k, _)| *k == key) {
            if cache.len() == 32 {
                cache.pop_front();
            }
            cache.push_back((key, png.clone()));
        }
        Ok(png)
    })
    .await
    .map_err(|_| bad("Could not generate this preview."))?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preview_extracts_visible_markdown_and_never_hidden_comments_or_destinations() {
        let value = Preview::new(
            "# A **shared** idea\n\nThe [visible words](https://secret.example/path) are here.[[comment(alex): hidden conversation]]\n\n![private alt](local.png)\n\n```sh\nsecret command\n```\n\n<script>secret html</script>",
            "folder/fallback.md",
        );
        assert_eq!(value.title, "A shared idea");
        assert_eq!(value.description, "The visible words are here.");
        assert_eq!(Preview::new("", "folder/Fallback.md").title, "Fallback");
    }
    #[test]
    fn long_unicode_text_wraps_with_ellipsis_and_renders_as_png() {
        let value = Preview::new(
            &format!(
                "# {}\n\n{}",
                "Очень длинный заголовок ".repeat(20),
                "Plain text & <image> words. ".repeat(40)
            ),
            "note.md",
        );
        let lines = wrap(&value.title, SEMIBOLD, 64., 2);
        assert_eq!(lines.len(), 2);
        assert!(lines[1].ends_with('…'));
        let png = render(&value).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(u32::from_be_bytes(png[16..20].try_into().unwrap()), 1200);
    }

    #[test]
    fn front_matter_never_becomes_preview_content() {
        for fence in ["---", "+++"] {
            let source = format!(
                "{fence}\nprivate_notes: preview-canary\ninternal_owner: another-canary\n{fence}\n\n# Actual title\n\nOpening prose for sharing."
            );
            let value = Preview::new(&source, "note.md");
            assert_eq!(value.title, "Actual title");
            assert_eq!(value.description, "Opening prose for sharing.");
        }
    }
}
