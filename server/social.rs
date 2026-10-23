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
        let source = comments::reading(source, comments::plain(path));
        let end = source
            .char_indices()
            .nth(32_000)
            .map_or(source.len(), |(i, _)| i);
        let format = documents::format(path);
        let reading = match format {
            Some(documents::Format::Fountain) => fountain_excerpt(&source, end, path),
            Some(documents::Format::Text) => source[..end].to_owned(),
            _ => source[front_matter(&source[..end])..end].to_owned(),
        };
        let mut title = String::new();
        let mut text = String::new();
        let mut blocks = Vec::new();
        let mut kind = Kind::Paragraph;
        let mut lists: Vec<Option<u64>> = Vec::new();
        let mut depth = 0;
        let mut quotes = 0usize;
        let mut hidden = 0;
        // Plain text has no Markdown: its paragraphs are the excerpt and its
        // filename is the title.
        let events = if format == Some(documents::Format::Text) {
            for line in reading.lines() {
                if line.trim().is_empty() {
                    flush(&mut text, &kind, depth, false, &mut blocks);
                } else {
                    text.push_str(line);
                    text.push('\n');
                }
            }
            None
        } else {
            Some(markdown::parser(&reading))
        };
        for event in events.into_iter().flatten() {
            match event {
                Event::Start(Tag::CodeBlock(_) | Tag::Image { .. }) => hidden += 1,
                Event::End(TagEnd::CodeBlock | TagEnd::Image) => hidden -= 1,
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
            "card-6\0{}\0{}\0{}\0{:?}",
            self.title, self.description, self.filename, self.blocks
        ))
    }
}

// Where Markdown source starts after the front matter that opens it: YAML
// between `---` lines or TOML between `+++` lines, as site generators and
// note apps write it. A card leaves it out. Such a block further down is no
// front matter: the card shows it as the editor does, as a rule and a heading
// or as a paragraph.
fn front_matter(source: &str) -> usize {
    if !source.starts_with("---") && !source.starts_with("+++") {
        return 0;
    }
    let fences = Options::ENABLE_YAML_STYLE_METADATA_BLOCKS
        | Options::ENABLE_PLUSES_DELIMITED_METADATA_BLOCKS;
    match Parser::new_ext(source, fences).into_offset_iter().next() {
        Some((Event::Start(Tag::MetadataBlock(_)), range)) if range.start == 0 => range.end,
        _ => 0,
    }
}

// The source up to `end` without its notes and boneyards, which the editor
// reads the same way: a note ends at its ]] or, since Fountain never looks
// past a blank line for one, at the blank line that ends its paragraph,
// unless that line holds two spaces. A boneyard ends at its */, however far
// on, and an /* without one is text. A backslash keeps the next character.
fn without_notes(source: &str, end: usize) -> String {
    static BLANK: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"\n[ \t]?\r?(?:\n|$)").unwrap());
    let mut text = String::with_capacity(end);
    let (mut kept, mut at, mut closed) = (0, 0, true);
    while let Some(offset) = source[at..end].find(['\\', '[', '/']) {
        let from = at + offset;
        let rest = &source[from..];
        let length = if let Some(escaped) = rest.strip_prefix('\\') {
            let next = escaped.chars().next().filter(|c| !matches!(c, '\n' | '\r'));
            at = end.min(from + 1 + next.map_or(0, char::len_utf8));
            continue;
        } else if source[from..end].starts_with("[[") {
            let note = &source[from..end];
            let paragraph = BLANK.find(note).map_or(note.len(), |m| m.start());
            note[2..paragraph]
                .find("]]")
                .map_or(paragraph, |close| close + 4)
        } else if let Some(close) = rest
            .strip_prefix("/*")
            .filter(|_| closed)
            .and_then(|boneyard| boneyard.find("*/"))
        {
            close + 4
        } else {
            // An /* without a */ is text, and so is every later one.
            closed &= !rest.starts_with("/*");
            at = from + 1;
            continue;
        };
        text.push_str(&source[kept..from]);
        text.push(' ');
        kept = end.min(from + length);
        at = kept;
    }
    text.push_str(&source[kept..end]);
    text
}

// Social cards use a short reading excerpt, not a second screenplay layout
// engine. Keep title-page contact fields and non-printing notes out of metadata.
fn fountain_excerpt(source: &str, end: usize, path: &str) -> String {
    let source = without_notes(source, end);
    let mut title = String::new();
    let mut body = String::new();
    let mut header = source
        .lines()
        .find(|line| !line.trim().is_empty())
        .is_some_and(|line| {
            line.split_once(':').is_some_and(|(key, _)| {
                matches!(
                    key.trim().to_ascii_lowercase().as_str(),
                    "title"
                        | "credit"
                        | "author"
                        | "authors"
                        | "source"
                        | "contact"
                        | "draft date"
                        | "copyright"
                        | "notes"
                )
            })
        });
    let mut title_field = false;
    let mut header_started = false;
    for line in source.lines() {
        if header {
            if line.trim().is_empty() {
                if header_started {
                    header = false;
                }
                continue;
            }
            header_started = true;
            if let Some((key, value)) = line
                .split_once(':')
                .filter(|(key, _)| !key.starts_with(char::is_whitespace))
            {
                title_field = key.trim().eq_ignore_ascii_case("title");
                if title_field {
                    title.push_str(value.trim());
                }
                continue;
            }
            if line.starts_with(char::is_whitespace) {
                if title_field {
                    title.push(' ');
                    title.push_str(line.trim());
                }
                continue;
            }
            header = false;
        }
        let text = line.trim();
        if text.starts_with('#') || text.starts_with('=') {
            continue;
        }
        let text = if text.starts_with('.') && !text.starts_with("..") {
            body.push_str("\n## ");
            &text[1..]
        } else if text.starts_with(['!', '@', '~', '>']) {
            text[1..].trim().trim_end_matches('<').trim_end()
        } else {
            text
        };
        body.push_str(text);
        body.push('\n');
    }
    if title.is_empty() {
        title = Path::new(path)
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
    }
    format!("# {}\n\n{body}", clean(&title, 140))
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

// Hebrew points and cantillation sit on their letter and take no width, also
// where the face lacks them and usvg draws the line in a face that has them.
fn hebrew_point(c: char) -> bool {
    matches!(
        c as u32,
        0x0591..=0x05BD | 0x05BF | 0x05C1 | 0x05C2 | 0x05C4 | 0x05C5 | 0x05C7
    )
}

// Right-to-left letters, as src/bidi.ts finds them: Hebrew, Arabic, Syriac,
// Thaana, N'Ko, Samaritan and Mandaic, their presentation forms and historic
// blocks.
fn right_to_left(c: char) -> bool {
    matches!(
        c as u32,
        0x0590..=0x08FF | 0xFB1D..=0xFDFF | 0xFE70..=0xFEFC | 0x10800..=0x10FFF | 0x1E800..=0x1EFFF
    )
}

// Whether a line reads right to left, from its first strong character as the
// editor and dir="auto" choose it (src/bidi.ts), or None when it has none.
fn reads_right_to_left(line: &str) -> Option<bool> {
    static STRONG: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"[\p{L}\x{200E}\x{200F}\x{061C}]").unwrap());
    let c = STRONG.find(line)?.as_str().chars().next()?;
    Some(c == '\u{200F}' || right_to_left(c))
}

// Bidi controls, which usvg follows and never draws: a right-to-left isolate,
// a first-strong isolate, which takes the direction of its own text, and the
// end of an isolate.
const RLI: char = '\u{2067}';
const FSI: char = '\u{2068}';
const PDI: char = '\u{2069}';

// A right-to-left line ends at the right margin. usvg lays out every line
// left to right, so the line is an isolate that reads right to left inside it.
fn text_line(left: f32, right: f32, y: f32, rtl: bool, style: &str, line: &str) -> String {
    let line = escape(line);
    if rtl {
        format!(r##"<text x="{right}" y="{y}" text-anchor="end" {style}>{RLI}{line}{PDI}</text>"##)
    } else {
        format!(r##"<text x="{left}" y="{y}" {style}>{line}</text>"##)
    }
}

// A name keeps its own direction, with its extension after it where the
// sidebar shows it (src/bidi.ts).
fn isolate_name(name: &str) -> String {
    static EXTENSION: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"(?i)\.(?:md|fountain|txt)$").unwrap());
    let (stem, extension) = name.split_at(EXTENSION.find(name).map_or(name.len(), |m| m.start()));
    if stem.chars().any(right_to_left) {
        format!("{FSI}{stem}{PDI}{extension}")
    } else {
        name.into()
    }
}

// Lines that fit the width, each with the index of the source line it shows.
fn wrap(
    value: &str,
    font: &[u8],
    size: f32,
    width_limit: f32,
    max_lines: usize,
) -> Vec<(usize, String)> {
    let face = ttf_parser::Face::parse(font, 0).unwrap();
    let advance = |c| {
        if hebrew_point(c) {
            return 0.;
        }
        face.glyph_index(c)
            .and_then(|g| face.glyph_hor_advance(g))
            .map_or(size, |v| v as f32 * size / face.units_per_em() as f32)
    };
    let mut remaining = value.trim();
    let mut source = 0;
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
            lines.push((source, remaining.to_string()));
            break;
        }
        let split = if newline == Some(cut) || space == 0 {
            cut
        } else {
            space
        };
        let mut line = remaining[..split].trim_end().to_string();
        let skipped = &remaining[split..];
        remaining = skipped.trim_start();
        if lines.len() + 1 == max_lines {
            while line.chars().map(&advance).sum::<f32>() + advance('…') > width_limit {
                line.pop();
            }
            line.push('…');
        }
        lines.push((source, line));
        source += skipped[..skipped.len() - remaining.len()]
            .matches('\n')
            .count();
    }
    lines
}

fn svg(value: &Preview) -> String {
    // Each line reads in the direction of its first strong character, and a
    // line without one continues the line before it, as in the editor.
    let mut rtl = reads_right_to_left(&value.title).unwrap_or(false);
    let title = wrap(&value.title, SEMIBOLD, 82., 1056., 2);
    let filename = wrap(&value.filename, LABEL, 29., 674., 1)
        .into_iter()
        .map(|(_, line)| line)
        .collect::<String>();
    let mut svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><defs><clipPath id="icon"><rect x="1000" y="470" width="128" height="128" rx="18"/></clipPath></defs><rect width="1200" height="630" fill="#ffffff"/><rect width="1200" height="16" fill="#ff634c"/><path d="M72 501h1056" stroke="#d8dee2"/><image x="1000" y="470" width="128" height="128" clip-path="url(#icon)" href="data:image/png;base64,{}"/><text x="72" y="582" font-family="Locdoc Social Display" font-size="54" fill="#263f50">LOCDOC.</text><text x="286" y="578" font-family="Locdoc Social Sans" font-size="29" fill="#66737d">{}</text>"##,
        *ICON,
        escape(&isolate_name(&filename))
    );
    let style =
        r##"font-family="Locdoc Social Mono" font-weight="600" font-size="82" fill="#252b31""##;
    for (i, (_, line)) in title.iter().enumerate() {
        let baseline = 140. + i as f32 * 92.;
        svg.push_str(&text_line(72., 1128., baseline, rtl, style, line));
    }
    let mut y = 246. + title.len().saturating_sub(1) as f32 * 92.;
    for (index, block) in value.blocks.iter().enumerate() {
        if y > 450. {
            break;
        }
        if matches!(block.kind, Kind::Rule) {
            svg.push_str(&format!(
                r##"<path d="M72 {}h1056" stroke="#d8dee2"/>"##,
                y - 20.
            ));
            y += 32.;
            continue;
        }
        let directions = block
            .text
            .split('\n')
            .map(|line| {
                rtl = reads_right_to_left(line).unwrap_or(rtl);
                rtl
            })
            .collect::<Vec<_>>();
        let heading = matches!(block.kind, Kind::Heading);
        let (size, step, font, weight) = if heading {
            (43., 58., SEMIBOLD, 600)
        } else {
            (37., 58., REGULAR, 400)
        };
        let color = if heading { "#ad431d" } else { "#353d45" };
        let indent = block.depth.min(3) as f32 * 32. + if block.quote { 24. } else { 0. };
        let marker = match block.kind {
            Kind::Number(n) => (n.to_string().len() as f32 + 1.) * 22.2,
            Kind::Bullet | Kind::Task(_) => 44.4,
            _ => 0.,
        };
        // A right-to-left line mirrors the layout: it ends where a
        // left-to-right line starts, measured from the other margin.
        let x = 72. + indent + marker;
        let right = 1128. - indent - marker;
        let available = ((450. - y) / step) as usize + 1;
        let mut lines = wrap(&block.text, font, size, 1056. - indent - marker, available);
        let gap = if matches!(block.kind, Kind::Bullet | Kind::Number(_) | Kind::Task(_)) {
            0.
        } else if heading {
            10.
        } else {
            16.
        };
        if index + 1 < value.blocks.len()
            && y + lines.len() as f32 * step + gap > 450.
            && let Some((_, last)) = lines.last_mut()
            && !last.ends_with('…')
        {
            last.push('…');
            *last = wrap(last, font, size, 1056. - indent - marker, 1)
                .remove(0)
                .1;
        }
        // The marker and the quote rule stand where the first line starts.
        let first = directions[0];
        match block.kind {
            Kind::Bullet => svg.push_str(&format!(r##"<circle cx="{}" cy="{}" r="4" fill="#353d45"/>"##, if first { right + 33.3 } else { x - 33.3 }, y - 13.)),
            Kind::Number(n) if first => svg.push_str(&format!(r##"<text x="{}" y="{y}" font-family="Locdoc Social Mono" font-size="37" fill="#353d45">{RLI}{n}.{PDI}</text>"##, right + 14.)),
            Kind::Number(n) => svg.push_str(&format!(r##"<text x="{}" y="{y}" text-anchor="end" font-family="Locdoc Social Mono" font-size="37" fill="#353d45">{n}.</text>"##, x - 14.)),
            Kind::Task(checked) => {
                let (frame, mark) = if first { (right + 18.4, right + 22.4) } else { (x - 44.4, x - 40.4) };
                svg.push_str(&format!(r##"<rect x="{frame}" y="{}" width="26" height="26" rx="4" fill="none" stroke="#353d45" stroke-width="2"/>"##, y - 27.));
                if checked { svg.push_str(&format!(r##"<path d="M{mark} {}l6 6 12-14" fill="none" stroke="#353d45" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>"##, y - 14.)); }
            }
            _ => {}
        }
        if block.quote {
            svg.push_str(&format!(
                r##"<path d="M{} {}v{}" stroke="#d8dee2"/>"##,
                if first {
                    1128. - indent + 22.
                } else {
                    72. + indent - 22.
                },
                y - size * 0.8,
                lines.len() as f32 * step
            ));
        }
        let style = format!(
            r##"font-family="Locdoc Social Mono" font-weight="{weight}" font-size="{size}" fill="{color}""##
        );
        for (source, line) in lines {
            svg.push_str(&text_line(x, right, y, directions[source], &style, &line));
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
    use std::collections::BTreeSet;
    #[test]
    fn fountain_cards_use_the_title_and_exclude_contact_notes_and_boneyards() {
        let value = Preview::new(
            "Title: Signal\nAuthor: Private author\nContact:\n    private@example.invalid\n\nINT. STUDIO - DAY\n\n@Morgan\nA quiet signal.\n\n[[Hidden note]]\n\n/* Hidden scene */",
            "Scripts/Signal.fountain",
        );
        assert_eq!(value.title, "Signal");
        assert!(value.description.contains("A quiet signal."));
        for hidden in [
            "Private author",
            "private@example.invalid",
            "Hidden note",
            "Hidden scene",
            "@Morgan",
        ] {
            assert!(!value.description.contains(hidden));
        }
        assert_eq!(
            Preview::new("INT. ROOM - DAY\n\nA room.", "Script.fountain").title,
            "Script"
        );
    }
    #[test]
    fn fountain_cards_end_a_note_at_its_paragraph_and_show_an_unclosed_boneyard() {
        let value = Preview::new(
            "Title: Signal\n\nA lamp.[[Unfinished note\nstill the note\n\nThe signal starts.[[Two\n  \nspaces]]\n\n/* Not closed\n\nThe end. \\[[Kept]]",
            "Signal.fountain",
        );
        for hidden in ["Unfinished", "still the note", "Two", "spaces"] {
            assert!(!value.description.contains(hidden), "{hidden}");
        }
        for shown in [
            "A lamp.",
            "The signal starts.",
            "/* Not closed",
            "The end.",
            "[[Kept]]",
        ] {
            assert!(value.description.contains(shown), "{shown}");
        }
        // A boneyard that closes past the excerpt hides the rest of it.
        let long = format!("Shown.\n\n/* Hidden {}\n*/\n\nAfter.", "word ".repeat(8000));
        let value = Preview::new(&long, "Long.fountain");
        assert!(value.description.contains("Shown."));
        assert!(!value.description.contains("Hidden"));
        // An excerpt can end inside an opener.
        for cut in ["[", "/", "\\"] {
            let source = format!("{}{cut}", "a".repeat(31_999));
            Preview::new(&source, "Cut.fountain");
            Preview::new(&format!("{source}[x]]"), "Cut.fountain");
        }
    }
    #[test]
    fn plain_text_cards_show_the_text_itself_under_the_filename() {
        let value = Preview::new(
            "# Not a heading\n- not a list\n![not an image](photo.png)\n\nSecond paragraph.[[comment(alex): hidden conversation]]\n",
            "Notes/list.txt",
        );
        assert_eq!(value.title, "list");
        assert_eq!(
            value.description,
            "# Not a heading - not a list ![not an image](photo.png) Second paragraph."
        );
        assert_eq!(value.blocks.len(), 2);
        assert!(
            value
                .blocks
                .iter()
                .all(|block| matches!(block.kind, Kind::Paragraph))
        );
    }
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
        let lines = wrap(&value.title, SEMIBOLD, 82., 1056., 2);
        assert_eq!(lines.len(), 2);
        assert!(lines[1].1.ends_with('…'));
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
    fn fenced_blocks_after_the_opening_read_as_the_editor_shows_them() {
        // Further down, the editor shows a --- block as a rule and a heading
        // and a +++ block as a paragraph, hiding only the records it hides.
        let value = Preview::new(
            "# Title\n\nOpening.\n\n---\nShown `[[comment(alex): literal]]`[[comment(ana): hidden]]\n---\n\n+++\nAlso shown\n+++",
            "note.md",
        );
        assert_eq!(value.title, "Title");
        assert_eq!(
            value.description,
            "Opening. Shown [[comment(alex): literal]] +++ Also shown +++"
        );
        assert!(matches!(value.blocks[1].kind, Kind::Rule));
        assert!(matches!(value.blocks[2].kind, Kind::Heading));
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
            wrap("First line\nSecond line", REGULAR, 37., 1056., 5),
            [(0, "First line".into()), (1, "Second line".into())]
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
        let label = wrap(&long.filename, LABEL, 29., 674., 1);
        assert_eq!(label.len(), 1);
        assert!(label[0].1.ends_with('…'));
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

    // A text element as usvg lays it out: its box, the characters its glyphs
    // draw from left to right, with □ for a missing glyph, and the faces they
    // come from. The isolates' hidden controls draw nothing.
    struct Drawn {
        left: f32,
        right: f32,
        text: String,
        faces: BTreeSet<String>,
    }

    fn face(name: &str) -> BTreeSet<String> {
        BTreeSet::from([name.to_string()])
    }

    fn drawn(value: &Preview) -> Vec<Drawn> {
        let options = usvg::Options {
            fontdb: FONTS.clone(),
            ..Default::default()
        };
        let tree = usvg::Tree::from_str(&svg(value), &options).unwrap();
        let mut elements = Vec::new();
        for node in tree.root().children() {
            let usvg::Node::Text(element) = node else {
                continue;
            };
            let mut glyphs = element
                .layouted()
                .iter()
                .flat_map(|span| &span.positioned_glyphs)
                .filter(|glyph| !glyph.text.chars().all(|c| [RLI, FSI, PDI].contains(&c)))
                .collect::<Vec<_>>();
            glyphs.sort_by(|a, b| a.transform().tx.total_cmp(&b.transform().tx));
            elements.push(Drawn {
                left: element.bounding_box().left(),
                right: element.bounding_box().right(),
                text: glyphs
                    .iter()
                    .map(|glyph| match glyph.id.0 {
                        0 => "□".into(),
                        _ => glyph.text.clone(),
                    })
                    .collect(),
                faces: glyphs
                    .iter()
                    .map(|glyph| {
                        let face = tree.fontdb().face(glyph.font).unwrap();
                        format!("{} {}", face.families[0].0, face.weight.0)
                    })
                    .collect(),
            });
        }
        elements
    }

    #[test]
    fn hebrew_titles_and_names_draw_real_letters_in_their_paired_faces() {
        let letters = ('\u{05D0}'..='\u{05EA}').collect::<String>();
        let value = Preview::new(
            &format!("# שלום עולם\n\n{letters} ו־₪100 English\n\n## כותרת משנה"),
            "תכנון 2024.md",
        );
        let elements = drawn(&value);
        assert!(elements.iter().all(|element| !element.text.contains('□')));
        let [_, name, title, paragraph, heading] = &elements[..] else {
            panic!("{} text elements", elements.len());
        };
        // The title, the excerpt and the name draw Hebrew in the face the app
        // pairs with their family: Cascadia Mono, then IBM Plex Sans Hebrew.
        assert_eq!(title.faces, face("Locdoc Social Mono 600"));
        assert!(letters.chars().all(|c| paragraph.text.contains(c)));
        assert!(paragraph.text.contains('₪') && paragraph.text.contains("English"));
        assert_eq!(paragraph.faces, face("Locdoc Social Mono 400"));
        assert_eq!(heading.faces, face("Locdoc Social Mono 600"));
        assert!(name.text.contains('ת') && name.text.contains(".md"));
        assert_eq!(name.faces, face("Locdoc Social Sans 400"));
        // Points Cascadia Mono lacks leave the line to IBM Plex Sans Hebrew.
        let pointed = drawn(&Preview::new("# בְּרֵאשִׁית בָּרָא", "note.md"));
        assert!(!pointed[2].text.contains('□'), "{}", pointed[2].text);
    }

    #[test]
    fn hebrew_lines_read_right_to_left_from_the_right_margin() {
        let value = Preview::new(
            "# שלום world, מה נשמע?\n\n- פריט ראשון\n- [x] בוצע\n\n1. אחד",
            "שלום world.md",
        );
        let elements = drawn(&value);
        // Hebrew reads right to left, an English phrase inside it left to right,
        // and the punctuation between them follows the line. A list marker
        // stands on the right, so its number reads .1 as in the editor. The
        // name keeps its own direction and its extension after it.
        assert_eq!(
            elements
                .iter()
                .map(|element| element.text.as_str())
                .collect::<Vec<_>>(),
            [
                "LOCDOC.",
                "world םולש.md",
                "?עמשנ המ ,world םולש",
                "ןושאר טירפ",
                "עצוב",
                ".1",
                "דחא"
            ]
        );
        // The lines end at the right margin, list items one marker in from it.
        // usvg gives the hidden isolate controls a pixel of width.
        let ends = |element: &Drawn, right: f32| (element.right - right).abs() <= 1.;
        assert!(ends(&elements[2], 1128.));
        assert!(
            elements[3..]
                .iter()
                .filter(|e| e.text != ".1")
                .all(|e| ends(e, 1083.6))
        );
        assert!((elements[5].left - 1097.6).abs() < 0.01);
        let markup = svg(&value);
        assert!(markup.contains(r##"<circle cx="1116.9" cy="233" r="4""##));
        assert!(markup.contains(r##"<rect x="1102" y="277" width="26""##));
        // A Latin card keeps its markup exactly.
        let latin = svg(&Preview::new("# A plan\n\n- [x] Pack", "note.md"));
        assert!(latin.contains(r##"<text x="72" y="140" font-family="Locdoc Social Mono" font-weight="600" font-size="82" fill="#252b31">A plan</text>"##));
        assert!(latin.contains(r##"<rect x="72" y="219" width="26""##));
        assert!(!latin.contains([RLI, FSI, PDI]));
    }

    #[test]
    fn each_excerpt_line_reads_in_the_direction_of_its_first_letter() {
        // A line without a letter, such as a year, continues the line before.
        let value = Preview::new(
            "# Notes on שלום עולם\n\nFirst line\nשורה שנייה\n2024",
            "notes.md",
        );
        let elements = drawn(&value);
        let [_, _, title, first, second, year] = &elements[..] else {
            panic!("{} text elements", elements.len());
        };
        assert_eq!(title.text, "Notes on םלוע םולש");
        assert_eq!(title.left, 72.);
        assert_eq!(first.text, "First line");
        assert_eq!(first.left, 72.);
        assert_eq!(second.text, "היינש הרוש");
        assert!((second.right - 1128.).abs() <= 1.);
        assert_eq!(year.text, "2024");
        assert!((year.right - 1128.).abs() <= 1.);
    }

    #[test]
    fn pointed_hebrew_wraps_where_the_same_letters_do() {
        let plain = "שלום וברכה לכל החברים ".repeat(6);
        let pointed = "שָׁלוֹם וּבְרָכָה לְכָל הַחֲבֵרִים ".repeat(6);
        let letters =
            |(_, line): &(usize, String)| line.chars().filter(|&c| !hebrew_point(c)).collect();
        let lines = wrap(&pointed, SEMIBOLD, 82., 1056., 9);
        assert!(lines.len() > 1);
        assert_eq!(
            lines.iter().map(letters).collect::<Vec<String>>(),
            wrap(&plain, SEMIBOLD, 82., 1056., 9)
                .into_iter()
                .map(|(_, line)| line)
                .collect::<Vec<_>>()
        );
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
