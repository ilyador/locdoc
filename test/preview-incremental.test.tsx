import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Compartment,
  EditorSelection,
  EditorState,
  Text,
  Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import { EditorView, type WidgetType } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { JSDOM } from "jsdom";
import { commentMarkdown } from "../src/comment-syntax";
import { sourceCommentLayer } from "../src/editor-comments";
import { engagement } from "../src/editor-engagement";
import { livePreview } from "../src/markdown-preview";

const language = markdown({
  base: markdownLanguage,
  extensions: [commentMarkdown],
});
const preview = livePreview("preview-fixture", undefined, "Notes/Note.md", [
  { id: "linked", path: "Notes/Linked.md", kind: "file", shared: false },
]);

function parsed(state: EditorState) {
  assert.ok(
    ensureSyntaxTree(state, state.doc.length, 2000),
    "Fixture must parse completely before checking its preview",
  );
  state = state.update({}).state;
  assert.equal(syntaxTree(state).length, state.doc.length);
  return state;
}

// Most cases check a selection the user placed, so they start engaged.
function create(
  doc: string,
  selection: EditorSelection | { anchor: number; head?: number } = {
    anchor: 0,
  },
  readOnly = false,
  engaged = true,
) {
  return parsed(
    EditorState.create({
      doc,
      selection,
      extensions: [
        language,
        sourceCommentLayer,
        preview,
        engagement.init(() => engaged),
        EditorState.allowMultipleSelections.of(true),
        EditorState.readOnly.of(readOnly),
      ],
    }),
  );
}

// Compare short scalar rows, never parser/view graphs or a giant failure diff.
// Widget implementation positions may be resolved from their mapped range;
// their visible content and all decoration positions still have to agree.
function decorationRows(state: EditorState) {
  const rows: string[] = [];
  for (const set of state.facet(EditorView.decorations)) {
    assert.ok(typeof set !== "function", "Fixture uses direct decorations");
    if (typeof set === "function") continue;
    for (let cursor = set.iter(); cursor.value; cursor.next()) {
      const { spec } = cursor.value;
      const widget = spec.widget as WidgetType | undefined;
      const details = widget as unknown as Record<string, unknown> | undefined;
      const content = Object.fromEntries(
        ["source", "src", "alt", "label", "checked", "editable"]
          .filter((key) => details && key in details)
          .map((key) => [key, details![key]]),
      );
      rows.push(
        JSON.stringify({
          from: cursor.from,
          to: cursor.to,
          class: spec.class,
          tagName: spec.tagName,
          attributes: spec.attributes,
          block: spec.block,
          widget: widget?.constructor.name,
          content,
        }),
      );
    }
  }
  return rows.sort();
}

function wrapperRows(state: EditorState) {
  const rows: string[] = [];
  for (const set of state.facet(EditorView.blockWrappers)) {
    assert.ok(typeof set !== "function", "Fixture uses direct block wrappers");
    if (typeof set === "function") continue;
    for (let cursor = set.iter(); cursor.value; cursor.next()) {
      const value = cursor.value as unknown as {
        tagName: string;
        attributes: Record<string, string>;
      };
      rows.push(
        JSON.stringify({
          from: cursor.from,
          to: cursor.to,
          tagName: value.tagName,
          attributes: value.attributes,
        }),
      );
    }
  }
  return rows.sort();
}

function assertRows(actual: string[], expected: string[], label: string) {
  assert.equal(actual.length, expected.length, `${label}: range count`);
  for (let index = 0; index < actual.length; index++)
    assert.equal(actual[index], expected[index], `${label}: range ${index}`);
}

function assertFresh(state: EditorState, label: string) {
  const fresh = create(
    state.doc.toString(),
    state.selection,
    state.readOnly,
    state.field(engagement),
  );
  assertRows(decorationRows(state), decorationRows(fresh), `${label}: marks`);
  assertRows(wrapperRows(state), wrapperRows(fresh), `${label}: wrappers`);
}

function update(state: EditorState, spec: TransactionSpec, label: string) {
  const next = parsed(state.update(spec).state);
  assertFresh(next, label);
  return next;
}

function replace(
  state: EditorState,
  before: string,
  insert: string,
  label: string,
) {
  const from = state.doc.toString().indexOf(before);
  assert.ok(from >= 0, `${label}: fixture text must exist`);
  return update(
    state,
    { changes: { from, to: from + before.length, insert } },
    label,
  );
}

const richSource = [
  "Prelude.",
  "## Heading with **strong** and *quiet* words",
  "A paragraph with `code`, ~~removed~~, and [a link](https://example.test).\nA second physical line.",
  "- Parent\n  continuation\n  - Child\n    - Deep\n- [ ] Pending\n- [x] Complete",
  "1. First\n   1. Nested\n2. Second",
  "> A quoted line\n> with a continuation",
  "```md\n**Literal**\n![Literal](_media/not-an-image.png)\n```",
  "| One | Two |\n| --- | :--: |\n| Body | Cell |",
  "![A picture](_media/picture.png)",
  "A [[literal bracket]] and [another document](Linked.md).",
  "Annotated[[comment(ana): Keep **this** record]] text.",
  "---",
  "Tail.",
].join("\n\n");

test("incremental Markdown preview matches a fresh render for ordinary and disjoint edits", () => {
  let state = create(richSource);
  state = replace(state, "paragraph", "paragraph café 😀", "Unicode prose");
  state = replace(
    state,
    "physical",
    "physical\ncontinued",
    "physical line break",
  );
  state = replace(state, "**strong**", "***strong***", "nested emphasis");
  const source = state.doc.toString();
  state = update(
    state,
    {
      changes: [
        { from: source.indexOf("Prelude"), insert: "An opening " },
        {
          from: source.indexOf("Complete"),
          to: source.indexOf("Complete") + "Complete".length,
          insert: "Finished",
        },
        { from: source.indexOf("Tail"), insert: "A final " },
      ],
    },
    "three disjoint changed blocks",
  );
  state = replace(state, "[ ] Pending", "[x] Pending", "checked task");
  state = replace(
    state,
    "![A picture]",
    "![A changed caption]",
    "media caption",
  );
  state = replace(
    state,
    "| Body | Cell |",
    "| **Body** | New cell |",
    "table cell",
  );
  assert.ok(state.doc.toString().includes("café 😀"));
});

test("incremental Markdown invalidation follows fences, tables, lists, quotes and heading boundaries", () => {
  let state = create(richSource);
  state = replace(state, "```md", "ordinary md", "remove opening fence");
  state = replace(state, "ordinary md", "```md", "restore opening fence");
  state = replace(state, "\n```\n\n| One", "\n\n| One", "remove closing fence");
  state = replace(
    state,
    "\n\n| One",
    "\n```\n\n| One",
    "restore closing fence",
  );
  state = replace(
    state,
    "| --- | :--: |",
    "| not a delimiter | :--: |",
    "table becomes prose",
  );
  state = replace(
    state,
    "| not a delimiter | :--: |",
    "| --- | :--: |",
    "prose becomes table",
  );
  state = replace(
    state,
    "  - Child",
    "Child",
    "remove nested item indentation",
  );
  state = replace(
    state,
    "Child",
    "  - Child",
    "restore nested item indentation",
  );
  state = replace(state, "- Parent", "Parent", "remove parent list marker");
  state = replace(state, "Parent", "- Parent", "restore parent list marker");
  state = replace(
    state,
    "> A quoted line",
    "A quoted line",
    "remove block quote marker",
  );
  state = replace(state, "## Heading", "Heading", "remove ATX heading marker");
  state = replace(state, "Tail.", "Tail.\n=====", "add setext heading");
  state = replace(
    state,
    "Tail.\n=====",
    "Tail.\n-----",
    "change setext heading level",
  );
  state = replace(state, "Tail.\n-----", "Tail.", "remove setext heading");
  state = replace(
    state,
    "**Literal**",
    "    indented\n    code",
    "code block physical lines",
  );
});

test("incremental Markdown preview rechecks comment literal context and neighboring visible blocks", () => {
  let state = create(
    "Prelude.\n\nBefore\n[[comment(ana): First]]\n[[comment(ben): Response]]\nAfter\n\nTail.",
  );
  state = replace(state, "First", "First 😀", "source comment body edit");
  state = replace(
    state,
    "Before\n[[comment",
    "Before[[comment",
    "standalone record becomes inline",
  );
  state = replace(
    state,
    "Before[[comment",
    "Before\n[[comment",
    "inline record becomes standalone",
  );
  state = replace(
    state,
    "[[comment(ana)",
    "\\[[comment(ana)",
    "escape first source comment",
  );
  state = replace(
    state,
    "\\[[comment(ana)",
    "[[comment(ana)",
    "unescape first source comment",
  );
  state = replace(
    state,
    "Before\n",
    "Before\n```text\n",
    "fence consumes records and later blocks",
  );
  state = replace(
    state,
    "\nAfter",
    "\n```\nAfter",
    "close comment-containing fence",
  );
  state = replace(
    state,
    "```text\n",
    "",
    "remove comment-containing fence opening",
  );
  state = replace(
    state,
    "\n```\nAfter",
    "\nAfter",
    "remove remaining comment fence",
  );
  state = replace(state, "Response]]", "Response]", "incomplete source record");
  state = replace(state, "Response]", "Response]]", "complete source record");
});

test("selection changes reveal exactly the affected Markdown lines and blocks", () => {
  let state = create(richSource);
  for (const phrase of [
    "strong",
    "quiet",
    "A picture",
    "| Body",
    "Pending",
    "Literal",
    "literal bracket",
    "Tail",
    "Prelude",
  ]) {
    const anchor = state.doc.toString().indexOf(phrase);
    assert.ok(anchor >= 0, "selection fixture must exist");
    state = update(state, { selection: { anchor } }, `caret at ${phrase}`);
  }
  const source = state.doc.toString();
  state = update(
    state,
    {
      selection: EditorSelection.create([
        EditorSelection.cursor(source.indexOf("Heading")),
        EditorSelection.range(source.indexOf("| One"), source.indexOf("Cell")),
        EditorSelection.cursor(source.indexOf("A picture")),
      ]),
    },
    "multiple active Markdown blocks",
  );
  state = update(
    state,
    { selection: { anchor: state.doc.length, head: 0 } },
    "backwards whole-document selection",
  );
  update(
    state,
    { selection: { anchor: 0 } },
    "collapse selection to first line",
  );
});

// The transaction a view dispatches when its focus changes.
function focusChange(state: EditorState, focused: boolean): TransactionSpec {
  return {
    effects: state
      .facet(EditorView.focusChangeEffect)
      .flatMap((effect) => effect(state, focused) ?? []),
  };
}

// Whether the whole-line image is a figure rather than revealed source.
const figure = (state: EditorState) =>
  decorationRows(state).some((row) => {
    const parsed = JSON.parse(row) as { from: number; widget?: string };
    return (
      parsed.widget === "MediaWidget" &&
      parsed.from === state.doc.toString().indexOf("![Cover]")
    );
  });

test("a selection the user never placed reveals nothing until they engage", () => {
  // A new editor's caret sits at the start, here on a whole-line image.
  const source = `![Cover](_media/cover.png)\n\n${richSource}`;
  const opened = create(source, { anchor: 0 }, false, false);
  assert.ok(figure(opened), "the image renders at open");
  // As an engaged editor whose caret is on "Tail.", which has no syntax.
  const untouched = decorationRows(create(source, { anchor: source.length }));
  assertRows(decorationRows(opened), untouched, "opened editor");
  const everything = { anchor: 0, head: source.length };
  assertRows(
    decorationRows(create(source, everything, false, false)),
    untouched,
    "a whole-document selection nobody placed",
  );
  // Locdoc's own selections, remote edits and blur carry no user event.
  let state = update(opened, { selection: everything }, "Locdoc's selection");
  state = update(
    state,
    {
      changes: { from: source.indexOf("Tail"), insert: "Remote " },
      annotations: Transaction.remote.of(true),
    },
    "remote edit",
  );
  state = update(state, focusChange(state, false), "blur");
  state = update(state, { selection: { anchor: 0 } }, "Locdoc's caret");
  assert.equal(state.field(engagement), false);
  assert.ok(figure(state), "nothing above engaged the editor");
  const table = source.indexOf("| Body");
  const heading = source.indexOf("Heading with");
  const engagements: [string, (state: EditorState) => TransactionSpec][] = [
    ["focus", (state) => focusChange(state, true)],
    [
      "click",
      () => ({ selection: { anchor: 3 }, userEvent: "select.pointer" }),
    ],
    ["arrow key", () => ({ selection: { anchor: 1 }, userEvent: "select" })],
    [
      "typing",
      () => ({
        changes: { from: 0, insert: "\n" },
        selection: { anchor: 1 },
        userEvent: "input.type",
      }),
    ],
    [
      "find",
      () => ({
        selection: EditorSelection.create([
          EditorSelection.range(2, 7),
          EditorSelection.range(heading, heading + 7),
          EditorSelection.range(table + 2, table + 6),
        ]),
        userEvent: "select.search.matches",
      }),
    ],
  ];
  for (const [label, engage] of engagements) {
    const engaged = update(state, engage(state), `${label} engages`);
    assert.equal(engaged.field(engagement), true, label);
    assert.ok(!figure(engaged), `${label}: the image's source shows`);
    const moved = update(
      engaged,
      { selection: { anchor: engaged.doc.length } },
      `${label}, then a selection without a user event`,
    );
    assert.ok(figure(moved), `${label}: the image renders once left`);
  }
});

test("remote and boundary edits have the same preview as local fresh source", () => {
  let state = create(richSource);
  state = update(
    state,
    {
      changes: { from: 0, insert: "Remote intro.\n\n" },
      annotations: Transaction.remote.of(true),
    },
    "remote prefix insertion",
  );
  state = update(
    state,
    {
      changes: { from: state.doc.length, insert: "\n\n- Remote ending" },
      annotations: Transaction.remote.of(true),
    },
    "remote final list insertion",
  );
  state = update(
    state,
    { changes: { from: 0, to: state.doc.line(1).to + 1 } },
    "delete first physical line",
  );
  state = update(
    state,
    { changes: { from: 0, to: state.doc.length } },
    "delete whole document",
  );
  state = update(
    state,
    { changes: { from: 0, insert: "# Restored\n\nText." } },
    "type into empty document",
  );
  update(
    state,
    { changes: { from: state.doc.length, insert: "\n" } },
    "trailing newline",
  );
});

test("read-only reconfiguration hides syntax and updates task permissions consistently", () => {
  const permissions = new Compartment();
  let state = parsed(
    EditorState.create({
      doc: richSource,
      selection: { anchor: richSource.indexOf("Pending") },
      extensions: [
        language,
        sourceCommentLayer,
        preview,
        engagement.init(() => true),
        permissions.of(EditorState.readOnly.of(false)),
      ],
    }),
  );
  for (const readOnly of [true, false, true]) {
    state = parsed(
      state.update({
        effects: permissions.reconfigure(EditorState.readOnly.of(readOnly)),
      }).state,
    );
    assert.equal(state.readOnly, readOnly);
    assertFresh(state, `readOnly=${readOnly}`);
  }
});

test("sequences of incomplete Markdown edits keep exactly the fresh-source decoration ranges", () => {
  let state = create(richSource);
  let seed = 0x51a77;
  const random = (limit: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % limit;
  };
  const insertions = [
    "x",
    "*",
    "_",
    "\n",
    "\n\n",
    "- ",
    "> ",
    "```",
    "`",
    "[[",
    "]]",
    "\\",
    "|",
  ];
  for (let index = 0; index < 80; index++) {
    const from = random(state.doc.length + 1);
    const to = Math.min(state.doc.length, from + random(3));
    state = update(
      state,
      { changes: { from, to, insert: insertions[random(insertions.length)] } },
      `incomplete syntax edit ${index}`,
    );
  }
});

function widgets(state: EditorState) {
  const found = new Map<string, WidgetType>();
  for (const set of state.facet(EditorView.decorations)) {
    if (typeof set === "function") continue;
    for (let cursor = set.iter(); cursor.value; cursor.next()) {
      const widget = cursor.value.spec.widget as WidgetType | undefined;
      if (widget) found.set(widget.constructor.name, widget);
    }
  }
  return found;
}

test("a short parser slice preserves already-rendered suffix widgets until the full parse arrives", () => {
  const source =
    Array.from(
      { length: 600 },
      (_, n) =>
        `## Section ${n}\n\nParagraph ${n} has **strong** words.\n\n- Item ${n}\n\n`,
    ).join("") + "- [ ] Distant task\n\nTail.";
  const before = create(source);
  const task = widgets(before).get("TaskWidget");
  assert.ok(task, "Full initial parse must render the suffix task");
  const at = source.indexOf("Paragraph 300") + "Paragraph 300".length;
  const now = Date.now;
  let tick = now();
  let partial: EditorState;
  try {
    // CodeMirror's normal edit-time parse budget is 20 ms. Advance the clock
    // between parser slices so this test never relies on machine speed.
    Date.now = () => (tick += 1000);
    partial = before.update({
      changes: { from: at, insert: " changed" },
    }).state;
  } finally {
    Date.now = now;
  }
  assert.ok(
    syntaxTree(partial).length < partial.doc.length,
    "Fixture must leave an unfinished syntax suffix after the edit-time slice",
  );
  assert.ok(
    widgets(partial).get("TaskWidget") === task,
    "An unfinished parser suffix must retain its already-rendered task",
  );
  const suffixFrom = partial.doc.toString().indexOf("- [ ] Distant task");
  assert.ok(
    wrapperRows(partial).some((row) => JSON.parse(row).from === suffixFrom),
    "An unfinished parser suffix must retain its list indentation wrapper",
  );
  assertFresh(
    parsed(partial),
    "completed background parse after short edit slice",
  );
});

test("ordinary edits retain distant block widgets and do bounded preview work in a long note", (t) => {
  const section = (n: number) =>
    `## Section ${n}\n\nParagraph ${n} with **strong** and *quiet* text.\nSecond line ${n}.\n\n- Item ${n}\n  - Nested ${n}\n\n`;
  const source =
    Array.from({ length: 500 }, (_, n) => section(n)).join("") +
    "| One | Two |\n| --- | --- |\n| Cell | Body |\n\n![Image](_media/far.png)\n\n- [ ] Distant task\n\nTail.";
  let state = create(source);
  const before = widgets(state);
  assert.equal(before.size, 3, "Fixture has table, media and task widgets");
  const lineAt = Text.prototype.lineAt;
  let lineLookups = 0;
  Text.prototype.lineAt = function (position) {
    lineLookups++;
    return lineAt.call(this, position);
  };
  try {
    const at = source.indexOf("Paragraph 250") + "Paragraph 250".length;
    state = parsed(
      state.update({ changes: { from: at, insert: " revised" } }).state,
    );
  } finally {
    Text.prototype.lineAt = lineAt;
  }
  assert.ok(
    lineLookups < 500,
    `One prose edit must not walk the whole note (${lineLookups} line lookups)`,
  );
  t.diagnostic(
    `${source.length} characters, ${state.doc.lines} lines: ${lineLookups} line lookups for one edit and parse completion`,
  );
  for (const [kind, widget] of before)
    if (kind !== "TaskWidget")
      assert.ok(
        widgets(state).get(kind) === widget,
        `Distant ${kind} should be reused after a prose edit`,
      );
  assertFresh(state, "long-note prose edit");
  state = update(
    state,
    { changes: { from: 0, insert: "A prefix.\n\n" } },
    "long-note prefix insertion",
  );
  for (const [kind, widget] of before)
    if (kind !== "TaskWidget")
      assert.ok(
        widgets(state).get(kind) === widget,
        `Mapped ${kind} should be reused after a prefix insertion`,
      );
});

test("a prose edit in a one-megabyte note does not revisit every paragraph", (t) => {
  const source = Array.from(
    { length: 600 },
    (_, n) =>
      `Paragraph ${n}: **strong** text. ${"Ordinary readable prose with words and punctuation. ".repeat(36)}\n\n`,
  ).join("");
  assert.ok(
    source.length >= 1024 * 1024,
    "Performance fixture must exceed one MiB",
  );
  let state = create(source);
  const lineAt = Text.prototype.lineAt;
  let lineLookups = 0;
  Text.prototype.lineAt = function (position) {
    lineLookups++;
    return lineAt.call(this, position);
  };
  try {
    const at = source.indexOf("Paragraph 300:") + "Paragraph 300:".length;
    state = parsed(
      state.update({ changes: { from: at, insert: " revised" } }).state,
    );
  } finally {
    Text.prototype.lineAt = lineAt;
  }
  assert.ok(
    lineLookups < 200,
    `One prose edit must stay local (${lineLookups} line lookups)`,
  );
  t.diagnostic(
    `${source.length} characters, ${state.doc.lines} lines: ${lineLookups} line lookups for one edit and parse completion`,
  );
  assertFresh(state, "one-megabyte local prose edit");
});

test("reused media, table and task controls act at their mapped source positions", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const globals = new Map<string, PropertyDescriptor | undefined>();
  for (const key of [
    "window",
    "Window",
    "document",
    "navigator",
    "Node",
    "Element",
    "HTMLElement",
    "HTMLVideoElement",
    "MutationObserver",
    "DOMRect",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "ResizeObserver",
  ]) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const value = (dom.window as unknown as Record<string, unknown>)[key];
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value:
        typeof value === "function" &&
        [
          "getComputedStyle",
          "requestAnimationFrame",
          "cancelAnimationFrame",
        ].includes(key)
          ? value.bind(dom.window)
          : value,
    });
  }
  dom.window.Range.prototype.getClientRects = () =>
    [] as unknown as DOMRectList;
  dom.window.Range.prototype.getBoundingClientRect = () =>
    new dom.window.DOMRect();
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  const source = [
    "Prelude.",
    "A paragraph.",
    "| One | Two |\n| --- | --- |\n| Cell | Body |",
    "![Image](_media/picture.png)",
    "- [ ] Pending task",
    "Tail.",
  ].join("\n\n");
  let view: EditorView | undefined;
  try {
    view = new EditorView({
      state: create(source),
      parent: dom.window.document.body,
    });
    const table = view.dom.querySelector(".md-table-preview");
    const image = view.dom.querySelector(".embed");
    assert.ok(table && image, "Fixture must render both block widgets");
    view.dispatch({ changes: { from: 0, insert: "A prefix.\n\n" } });
    assert.ok(
      view.dom.querySelector(".md-table-preview") === table,
      "Mapped table must retain its DOM",
    );
    assert.ok(
      view.dom.querySelector(".embed") === image,
      "Mapped image must retain its DOM",
    );
    const tableCell = view.dom.querySelector<HTMLButtonElement>(
      'button[aria-label="Edit row 2, column 1: Cell"]',
    );
    assert.ok(tableCell, "Mapped table cell must be clickable");
    tableCell.click();
    assert.equal(
      view.state.selection.main.head,
      view.state.doc.toString().indexOf("Cell"),
    );
    view.dispatch({ selection: { anchor: 0 } });
    const editImage = view.dom.querySelector<HTMLButtonElement>(".embed-edit");
    assert.ok(editImage, "Mapped media edit control must exist");
    editImage.click();
    assert.equal(
      view.state.selection.main.head,
      view.state.doc.toString().indexOf("![Image]"),
    );
    view.dispatch({ selection: { anchor: 0 } });
    const task = view.dom.querySelector<HTMLInputElement>(".md-task-checkbox");
    assert.ok(task, "Mapped task checkbox must exist");
    task.click();
    assert.ok(
      view.state.doc.toString().includes("- [x] Pending task"),
      "Mapped task control must change its own source marker",
    );
    assert.ok(
      view.state.doc.toString().includes("| Cell | Body |"),
      "Task toggle must leave the earlier table unchanged",
    );
    assertFresh(view.state, "mapped controls after clicking");
  } finally {
    view?.destroy();
    dom.window.close();
    for (const [key, descriptor] of globals)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as unknown as Record<string, unknown>)[key];
  }
});
