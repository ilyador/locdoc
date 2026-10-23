import { isolate } from "./bidi";
import type { DocumentFormat } from "./document-format";

// What each format's editor recognizes, as the footer's syntax reference
// shows it. An example is real source: its runs alternate between what the
// writer types (even entries) and their own words (odd entries).
// test/syntax-reference.test.tsx renders every example in its format's editor,
// so the reference never lists syntax Locdoc does not show as described.
export type SyntaxExample = {
  source: readonly string[];
  meaning: string;
};
export type SyntaxGroup = { title: string; examples: SyntaxExample[] };
export type SyntaxReference = {
  summary: string;
  // The groups of each column on a wide screen; a narrow one reads the
  // columns one after another.
  columns: SyntaxGroup[][];
};

export const exampleSource = (example: SyntaxExample) =>
  example.source.join("");

// Comment records read the same in every format; only what keeps a record
// literal differs.
function comments(literal: string): SyntaxGroup {
  return {
    title: "Comments",
    examples: [
      {
        source: ["", "Text", "[[comment(", "alex", "): ", "Note", "]]"],
        meaning: "A comment on the text just before it",
      },
      {
        source: [
          "[[comment(",
          "alex",
          "): ",
          "Note",
          "]]\n[[comment(",
          "sam",
          "): ",
          "Reply",
          "]]",
        ],
        meaning: "A record on the next line replies",
      },
      {
        source: [
          "[[comment(",
          "alex",
          "): ",
          "One",
          "]]\n\n[[comment(",
          "sam",
          "): ",
          "Two",
          "]]",
        ],
        meaning: "A blank line starts a new conversation",
      },
      {
        source: ["\\]  \\)  \\\\  \\n"],
        meaning: "Inside a record: ], ) in a name, a backslash, a line break",
      },
      {
        source: ["\\[[comment(", "alex", "): ", "Note", "]]"],
        meaning: literal,
      },
    ],
  };
}

const markdown: SyntaxReference = {
  summary: "Formats as you type. The line you are editing shows its markers.",
  columns: [
    [
      {
        title: "Text",
        examples: [
          {
            source: ["# ", "Heading"],
            meaning: "Heading; add # for smaller ones, up to six",
          },
          {
            source: ["", "Heading", "\n==="],
            meaning:
              "Also a heading; a line of --- under it makes a smaller one",
          },
          { source: ["**", "bold", "**"], meaning: "Bold" },
          { source: ["*", "italic", "*"], meaning: "Italic, or _italic_" },
          { source: ["~~", "deleted", "~~"], meaning: "Strikethrough" },
          { source: ["`", "code", "`"], meaning: "Inline code" },
          {
            source: ["\\*", "not italic", "\\*"],
            meaning: "A backslash keeps a symbol as typed",
          },
        ],
      },
      {
        title: "Links and media",
        examples: [
          {
            source: ["[", "label", "](", "https://example.com", ")"],
            meaning: "Link",
          },
          {
            source: ["[", "label", "](", "notes.md", ")"],
            meaning: "Link to another document, by relative path",
          },
          {
            source: ["https://", "example.com"],
            meaning: "A web address links by itself",
          },
          {
            source: ["![", "alt text", "](", "photo.png", ")"],
            meaning: "Local image; on its own line it shows as a figure",
          },
          {
            source: ["![", "alt text", "](", "clip.mp4", ")"],
            meaning: "Local video: MP4, WebM or MOV",
          },
        ],
      },
      {
        title: "Lines and paragraphs",
        examples: [
          {
            source: ["", "First line", "\n", "Second line"],
            meaning: "Each line shows as its own paragraph",
          },
          {
            source: ["", "Paragraph", "\n\n", "Next one"],
            meaning: "A blank line adds space and ends a list or quote",
          },
        ],
      },
    ],
    [
      {
        title: "Lists",
        examples: [
          {
            source: ["- ", "Item"],
            meaning: "Bulleted list; * or + also work",
          },
          { source: ["1. ", "Item"], meaning: "Numbered list" },
          { source: ["- [ ] ", "Task"], meaning: "Task with a checkbox" },
          { source: ["- [x] ", "Done"], meaning: "Checked task" },
          {
            source: ["- ", "Item", "\n  - ", "Nested"],
            meaning: "Indent an item to nest it",
          },
        ],
      },
      {
        title: "Blocks",
        examples: [
          { source: ["> ", "Quote"], meaning: "Blockquote" },
          {
            source: ["```\n", "code", "\n```"],
            meaning: "Code block between fences",
          },
          {
            source: [
              "| ",
              "Tea  ",
              " | ",
              "Cups",
              " |\n| ----- | ---: |\n| ",
              "Green",
              " | ",
              "   2",
              " |",
            ],
            meaning: "Table; a colon in the dashes aligns a column",
          },
          {
            source: ["---"],
            meaning: "Horizontal rule, after a blank line",
          },
        ],
      },
      comments("Stays text, as does a record in code or a link"),
    ],
  ],
};

const fountain: SyntaxReference = {
  summary: "Formats as you type. The line you are editing shows its markers.",
  columns: [
    [
      {
        title: "Scenes and action",
        examples: [
          {
            source: ["INT. ", "HOUSE - DAY"],
            meaning: "Scene heading after a blank line: INT, EXT, EST or I/E",
          },
          {
            source: ["פנים. ", "בית - יום"],
            meaning: `In Hebrew: ${isolate("פנים.")}, ${isolate("חוץ.")} or ${isolate("פנים/חוץ.")}`,
          },
          { source: [".", "FLASHBACK"], meaning: "Forced scene heading" },
          {
            source: ["", "She waits by the door."],
            meaning: "Action: any other paragraph",
          },
          {
            source: ["!", "THE LIGHTS GO OUT."],
            meaning: "Forced action, for a line in capitals",
          },
        ],
      },
      {
        title: "Dialogue",
        examples: [
          {
            source: ["", "MAYA", "\n", "Where were you?"],
            meaning: "Character in capitals after a blank line, then dialogue",
          },
          {
            source: ["@", "McKenna"],
            meaning: "Forced character, for a name in mixed case",
          },
          {
            source: ["@", "מאיה", "\n", "איפה היית?"],
            meaning: "Hebrew has no capitals: every Hebrew character needs @",
          },
          {
            source: ["(", "quietly", ")"],
            meaning: "Parenthetical, under a character or in dialogue",
          },
          {
            source: ["", "SAM", " ^"],
            meaning: "Dual dialogue: ^ after the second character",
          },
          { source: ["~", "Lyrics"], meaning: "Lyrics" },
        ],
      },
      {
        title: "Transitions and layout",
        examples: [
          {
            source: ["", "CUT ", "TO:"],
            meaning: "Transition: capitals ending in TO:, between blank lines",
          },
          { source: ["> ", "FADE OUT."], meaning: "Forced transition" },
          { source: ["> ", "THE END", " <"], meaning: "Centered text" },
          { source: ["==="], meaning: "Page break" },
        ],
      },
      {
        title: "Title page",
        examples: [
          {
            source: ["Title: ", "The Signal", "\nAuthor: ", "Sam Lee"],
            meaning:
              "At the very top: Title, Credit, Author, Draft date and more",
          },
        ],
      },
    ],
    [
      {
        title: "Emphasis",
        examples: [
          { source: ["*", "italic", "*"], meaning: "Italic" },
          { source: ["**", "bold", "**"], meaning: "Bold" },
          { source: ["***", "bold italic", "***"], meaning: "Bold italic" },
          { source: ["_", "underline", "_"], meaning: "Underline" },
          {
            source: ["\\*", "not italic", "\\*"],
            meaning: "A backslash keeps a symbol as typed",
          },
        ],
      },
      {
        title: "Outline and notes",
        examples: [
          {
            source: ["# ", "Act one"],
            meaning: "Section; add # for smaller ones",
          },
          { source: ["= ", "Synopsis"], meaning: "Synopsis" },
          {
            source: ["[[", "Note", "]]"],
            meaning: "Note; a blank line ends it, unless it holds two spaces",
          },
          {
            source: ["/* ", "Cut scene", " */"],
            meaning: "Boneyard: text left out of the script, over any lines",
          },
        ],
      },
      comments("Stays text"),
    ],
  ],
};

const text: SyntaxReference = {
  summary: "Saved exactly as typed. Nothing is formatted.",
  columns: [
    [
      {
        title: "Text",
        examples: [
          {
            source: ["", "First line", "\n", "Second line"],
            meaning: "Each line is its own paragraph",
          },
          {
            source: ["**not bold**  # not a heading"],
            meaning: "Symbols stay as typed: no formatting, links or images",
          },
        ],
      },
      comments(
        "Stays text; a record in backticks or a link is still a comment",
      ),
    ],
  ],
};

export const syntaxReference: Record<DocumentFormat, SyntaxReference> = {
  markdown,
  fountain,
  text,
};
