//! A bounded, in-process renderer; no commands, remote assets or runtime fonts.
use super::*;
use axum::body::Bytes;
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use resvg::{tiny_skia, usvg};
use std::{collections::VecDeque, sync::LazyLock};

const REGULAR: &[u8] = include_bytes!("../assets/social/Mono-Regular.ttf");
const SEMIBOLD: &[u8] = include_bytes!("../assets/social/Mono-SemiBold.ttf");
const LABEL: &[u8] = include_bytes!("../assets/social/Body-Regular.ttf");
const WORDMARK: &[u8] = include_bytes!("../assets/social/Wordmark.ttf");
static FONTS: LazyLock<Arc<usvg::fontdb::Database>> = LazyLock::new(|| {
    let mut db = usvg::fontdb::Database::new();
    for data in [REGULAR, SEMIBOLD, LABEL, WORDMARK] {
        db.load_font_data(data.to_vec());
    }
    Arc::new(db)
});
static ICON: LazyLock<String> =
    LazyLock::new(|| BASE64.encode(include_bytes!("../public/icons/icon-512-v5.png")));
static CACHE: Mutex<VecDeque<(String, Bytes)>> = Mutex::new(VecDeque::new());
static RENDERS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
static WAITING: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(8);

#[derive(Clone)]
pub(super) struct Preview {
    pub title: String,
    pub description: String,
    filename: String,
    blocks: Vec<Block>,
}

#[derive(Clone, Debug)]
enum Kind {
    Paragraph,
    Heading,
    Bullet,
    Number(u64),
    Task(bool),
    Rule,
}

#[derive(Clone, Debug)]
struct Block {
    kind: Kind,
    text: String,
    depth: usize,
    quote: bool,
}

fn flush(text: &mut String, kind: &Kind, depth: usize, quote: bool, blocks: &mut Vec<Block>) {
    let value = text
        .lines()
        .map(|line| clean(line, 640))
        .collect::<Vec<_>>()
        .join("\n");
    if !value.trim().is_empty() {
        blocks.push(Block {
            kind: kind.clone(),
            text: value.trim().into(),
            depth,
            quote,
        });
    }
    text.clear();
}

impl Preview {
    pub fn new(source: &str, path: &str) -> Self {
        let reading = comments::reading_source(source);
        let end = reading
            .char_indices()
            .nth(32_000)
            .map_or(reading.len(), |(i, _)| i);
        let mut title = String::new();
        let mut text = String::new();
        let mut blocks = Vec::new();
        let mut kind = Kind::Paragraph;
        let mut lists: Vec<Option<u64>> = Vec::new();
        let mut depth = 0;
        let mut quotes = 0usize;
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
                    flush(&mut text, &kind, depth, quotes > 0, &mut blocks);
                    kind = Kind::Heading;
                }
                Event::End(TagEnd::Heading(_)) => {
                    if title.is_empty() {
                        title = clean(&text, 140);
                        text.clear();
                    } else {
                        flush(&mut text, &kind, depth, quotes > 0, &mut blocks);
                    }
                    kind = Kind::Paragraph;
                }
                Event::Text(value) | Event::Code(value) => {
                    text.push_str(&value);
                }
                Event::Start(Tag::List(start)) => {
                    flush(&mut text, &kind, depth, quotes > 0, &mut blocks);
                    lists.push(start);
                }
                Event::End(TagEnd::List(_)) => {
                    flush(&mut text, &kind, depth, quotes > 0, &mut blocks);
                    lists.pop();
                    depth = lists.len();
                    kind = Kind::Paragraph;
                }
                Event::Start(Tag::Item) => {
                    flush(&mut text, &kind, depth, quotes > 0, &mut blocks);
                    depth = lists.len().saturating_sub(1);
                    kind = if let Some(Some(number)) = lists.last_mut() {
                        let value = *number;
                        *number = number.saturating_add(1);
                        Kind::Number(value)
                    } else {
                        Kind::Bullet
                    };
                }
                Event::TaskListMarker(checked) => kind = Kind::Task(checked),
                Event::Start(Tag::BlockQuote(_)) => {
                    flush(&mut text, &kind, depth, quotes > 0, &mut blocks);
                    quotes += 1;
                }
                Event::End(TagEnd::BlockQuote(_)) => {
                    flush(&mut text, &kind, depth, quotes > 0, &mut blocks);
                    quotes = quotes.saturating_sub(1);
                }
                Event::SoftBreak | Event::HardBreak => text.push('\n'),
                Event::Start(Tag::TableCell) if !text.is_empty() => text.push_str(" · "),
                Event::Rule => {
                    flush(&mut text, &kind, depth, quotes > 0, &mut blocks);
                    blocks.push(Block {
                        kind: Kind::Rule,
                        text: String::new(),
                        depth: 0,
                        quote: false,
                    });
                }
                Event::End(
                    TagEnd::Paragraph | TagEnd::Item | TagEnd::TableRow | TagEnd::TableHead,
                ) => {
                    flush(&mut text, &kind, depth, quotes > 0, &mut blocks);
                    // Following paragraphs inside an item retain its indentation,
                    // while its marker is drawn only on the first paragraph.
                    kind = Kind::Paragraph;
                    depth = lists.len();
                }
                _ => {}
            }
        }
        flush(&mut text, &kind, depth, quotes > 0, &mut blocks);
        let description = clean(
            &blocks
                .iter()
                .map(|v| v.text.as_str())
                .collect::<Vec<_>>()
                .join(" "),
            280,
        );
        // The image needs only its opening few lines. Keep cache keys and render
        // work bounded, without invalidating cards for edits far down the file.
        let mut remaining = 640;
        blocks.truncate(16);
        blocks.retain_mut(|block| {
            if remaining == 0 {
                return false;
            }
            let count = block.text.chars().count();
            if count > remaining {
                block.text = block.text.chars().take(remaining).collect();
                block.text.push('…');
            }
            remaining = remaining.saturating_sub(count);
            true
        });
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
            description,
            filename: clean(
                &Path::new(path)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy(),
                80,
            ),
            blocks,
        }
    }
    pub fn fingerprint(&self) -> String {
        // Include the layout revision and structure: a list and a paragraph can
        // have identical metadata while requiring different preview images.
        hash(&format!(
            "card-3\0{}\0{}\0{}\0{:?}",
            self.title, self.description, self.filename, self.blocks
        ))
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

fn wrap(value: &str, font: &[u8], size: f32, width_limit: f32, max_lines: usize) -> Vec<String> {
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
        let newline = remaining.find('\n');
        let mut cut = newline.unwrap_or(remaining.len());
        for (i, c) in remaining.char_indices() {
            if c == '\n' {
                break;
            }
            if width + advance(c) > width_limit {
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
        let split = if newline == Some(cut) || space == 0 {
            cut
        } else {
            space
        };
        let mut line = remaining[..split].trim_end().to_string();
        remaining = remaining[split..].trim_start();
        if lines.len() + 1 == max_lines {
            while line.chars().map(&advance).sum::<f32>() + advance('…') > width_limit {
                line.pop();
            }
            line.push('…');
        }
        lines.push(line);
    }
    lines
}

fn svg(value: &Preview) -> String {
    let title = wrap(&value.title, SEMIBOLD, 92., 1056., 2);
    let filename = wrap(&value.filename, LABEL, 31., 296., 1).join("");
    let mut svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><defs><clipPath id="icon"><rect x="72" y="477" width="104" height="104" rx="14"/></clipPath></defs><rect width="1200" height="630" fill="#fcfcfa"/><rect width="1200" height="16" fill="#ff634c"/><path d="M72 445h1056" stroke="#cbd3d6"/><image x="72" y="477" width="104" height="104" clip-path="url(#icon)" href="data:image/png;base64,{}"/><text x="204" y="559" font-family="Locdoc Social Display" font-size="62" fill="#263f50">LOCDOC.</text><text x="832" y="551" font-family="Locdoc Social Sans" font-size="31" fill="#66737d">{}</text>"##,
        *ICON,
        escape(&filename)
    );
    for (i, line) in title.iter().enumerate() {
        svg.push_str(&format!(r##"<text x="72" y="{}" font-family="Locdoc Social Mono" font-weight="600" font-size="92" fill="#252b31">{}</text>"##, 145 + i * 100, escape(line)));
    }
    let mut y = 229. + title.len().saturating_sub(1) as f32 * 100.;
    for (index, block) in value.blocks.iter().enumerate() {
        if y > 400. {
            break;
        }
        if matches!(block.kind, Kind::Rule) {
            svg.push_str(&format!(
                r##"<path d="M72 {}h1056" stroke="#cbd3d6"/>"##,
                y - 20.
            ));
            y += 32.;
            continue;
        }
        let heading = matches!(block.kind, Kind::Heading);
        let (size, step, font, weight) = if heading {
            (44., 56., SEMIBOLD, 600)
        } else {
            (39., 53., REGULAR, 400)
        };
        let color = if heading { "#ad431d" } else { "#353d45" };
        let indent = block.depth.min(3) as f32 * 32. + if block.quote { 24. } else { 0. };
        let marker = match block.kind {
            Kind::Number(n) => n.to_string().len() as f32 * 26. + 18.,
            Kind::Bullet | Kind::Task(_) => 40.,
            _ => 0.,
        };
        let x = 72. + indent + marker;
        let available = ((400. - y) / step) as usize + 1;
        let mut lines = wrap(&block.text, font, size, 1056. - indent - marker, available);
        let gap = if matches!(block.kind, Kind::Bullet | Kind::Number(_) | Kind::Task(_)) {
            0.
        } else if heading {
            6.
        } else {
            16.
        };
        if index + 1 < value.blocks.len()
            && y + lines.len() as f32 * step + gap > 400.
            && let Some(last) = lines.last_mut()
            && !last.ends_with('…')
        {
            last.push('…');
            *last = wrap(last, font, size, 1056. - indent - marker, 1).remove(0);
        }
        match block.kind {
            Kind::Bullet => svg.push_str(&format!(r##"<circle cx="{}" cy="{}" r="4" fill="#353d45"/>"##, x - 27., y - 12.)),
            Kind::Number(n) => svg.push_str(&format!(r##"<text x="{}" y="{y}" text-anchor="end" font-family="Locdoc Social Mono" font-size="39" fill="#353d45">{n}.</text>"##, x - 14.)),
            Kind::Task(checked) => {
                svg.push_str(&format!(r##"<rect x="{}" y="{}" width="26" height="26" rx="4" fill="none" stroke="#353d45" stroke-width="2"/>"##, x - 40., y - 27.));
                if checked { svg.push_str(&format!(r##"<path d="M{} {}l6 6 12-14" fill="none" stroke="#353d45" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>"##, x - 36., y - 14.)); }
            }
            _ => {}
        }
        if block.quote {
            svg.push_str(&format!(
                r##"<path d="M{} {}v{}" stroke="#cbd3d6"/>"##,
                72. + indent - 22.,
                y - size * 0.8,
                lines.len() as f32 * step
            ));
        }
        for line in lines {
            svg.push_str(&format!(r##"<text x="{x}" y="{y}" font-family="Locdoc Social Mono" font-weight="{weight}" font-size="{size}" fill="{color}">{}</text>"##, escape(&line)));
            y += step;
        }
        y += gap;
    }
    svg.push_str("</svg>");
    svg
}

fn render(value: &Preview) -> Result<Bytes> {
    let options = usvg::Options {
        fontdb: FONTS.clone(),
        ..Default::default()
    };
    let tree = usvg::Tree::from_str(&svg(value), &options)
        .map_err(|_| bad("Could not render this preview."))?;
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
    // A small cold burst should wait its turn, rather than fail its third image.
    // Bound both CPU work and the waiting queue so crawlers cannot pile up jobs.
    let waiting = WAITING.try_acquire().map_err(|_| {
        ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "Preview renderer is busy. Try again shortly.".into(),
        )
    })?;
    let permit = RENDERS
        .acquire()
        .await
        .map_err(|_| bad("Preview renderer stopped."))?;
    drop(waiting);
    if let Some((_, png)) = CACHE.lock().unwrap().iter().find(|(k, _)| *k == key) {
        return Ok(png.clone());
    }
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
        let lines = wrap(&value.title, SEMIBOLD, 92., 1056., 2);
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

    #[test]
    fn preview_keeps_headings_breaks_nested_lists_and_checkboxes() {
        let value = Preview::new(
            "# A plan\n\nFirst line\nSecond line\n\n## Next steps\n\n3. Choose a place\n   - Bring a notebook\n4. Go outside\n\n- [x] Pack\n- [ ] Leave\n\n> Take your time.",
            "note.md",
        );
        assert_eq!(value.title, "A plan");
        assert_eq!(value.blocks[0].text, "First line\nSecond line");
        assert!(matches!(value.blocks[1].kind, Kind::Heading));
        assert!(matches!(value.blocks[2].kind, Kind::Number(3)));
        assert!(matches!(value.blocks[3].kind, Kind::Bullet));
        assert_eq!(value.blocks[3].depth, 1);
        assert!(matches!(value.blocks[4].kind, Kind::Number(4)));
        assert!(matches!(value.blocks[5].kind, Kind::Task(true)));
        assert!(matches!(value.blocks[6].kind, Kind::Task(false)));
        assert!(value.blocks[7].quote);
        assert_eq!(
            wrap("First line\nSecond line", REGULAR, 39., 1056., 5),
            ["First line", "Second line"]
        );
    }

    #[test]
    fn footer_uses_only_the_basename_and_renames_refresh_the_preview() {
        let first = Preview::new(
            "# Same title\n\nSame text",
            "private-folder/First & <draft>.md",
        );
        let renamed = Preview::new("# Same title\n\nSame text", "private-folder/Renamed.md");
        assert_eq!(first.filename, "First & <draft>.md");
        let markup = svg(&first);
        assert!(!markup.contains("private-folder"));
        assert!(markup.contains("First &amp; &lt;draft&gt;.md"));
        assert_ne!(first.fingerprint(), renamed.fingerprint());
        let long = Preview::new("# Title", &format!("{}.md", "Long filename ".repeat(20)));
        let label = wrap(&long.filename, LABEL, 31., 296., 1);
        assert_eq!(label.len(), 1);
        assert!(label[0].ends_with('…'));
    }

    #[test]
    fn formatting_changes_invalidate_the_image_even_when_metadata_is_identical() {
        let paragraph = Preview::new("# A plan\n\nChoose a place", "note.md");
        let list = Preview::new("# A plan\n\n- Choose a place", "note.md");
        assert_eq!(paragraph.title, list.title);
        assert_eq!(paragraph.description, list.description);
        assert_ne!(paragraph.fingerprint(), list.fingerprint());
        assert_ne!(render(&paragraph).unwrap(), render(&list).unwrap());
    }

    #[tokio::test]
    async fn concurrent_cold_previews_wait_for_bounded_render_capacity() {
        let requests = (0..4).map(|i| {
            image(Preview::new(
                &format!("# Cold card {i}\n\n- A short list"),
                "note.md",
            ))
        });
        for result in futures_util::future::join_all(requests).await {
            assert_eq!(&result.unwrap()[..8], b"\x89PNG\r\n\x1a\n");
        }
    }
}
