//! Markdown as the editor reads it. The editor parses with `markdownLanguage`
//! of @codemirror/lang-markdown: CommonMark with GitHub's tables, task lists
//! and strikethrough, and subscript and superscript. Whatever the server must
//! judge as the editor does parses with this syntax: the images a document
//! previews and serves, which comment records are literal and where a new one
//! goes, and a link preview's excerpt. pulldown-cmark's other extensions read
//! some sources as another structure than the editor shows: a `---` or `+++`
//! block anywhere as metadata, `$…$` as math, `[^1]:` as a footnote, `[[…]]`
//! as a wikilink, a `: ` line under a paragraph as a definition, `{#id}` after
//! a heading as its attributes and `> [!NOTE]` as an alert. Both sides check
//! the cases in test/fixtures/media-references.json and
//! test/fixtures/file-comments.json.
use pulldown_cmark::{Options, Parser};

pub(super) const SYNTAX: Options = Options::ENABLE_TABLES
    .union(Options::ENABLE_TASKLISTS)
    .union(Options::ENABLE_STRIKETHROUGH)
    .union(Options::ENABLE_SUBSCRIPT)
    .union(Options::ENABLE_SUPERSCRIPT);

pub(super) fn parser(source: &str) -> Parser<'_> {
    Parser::new_ext(source, SYNTAX)
}
