import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EditorState, Text } from "@codemirror/state";
import {
  sourceCommentLayer,
  sourceCommentRanges,
} from "../src/editor-comments";

const indexed = (doc: string) =>
  EditorState.create({ doc, extensions: [sourceCommentLayer] });

function matchesFreshParse(state: EditorState, context: string) {
  const fresh = indexed(state.doc.toString());
  // These are small offset pairs, never parser/view graphs.
  assert.deepEqual(
    sourceCommentRanges(state).map(({ from, to }) => [from, to]),
    sourceCommentRanges(fresh).map(({ from, to }) => [from, to]),
    context,
  );
}

test("ordinary prose edits map source records without serializing the document", () => {
  const paragraph = "A paragraph **with emphasis** and ordinary words.\n\n";
  const source =
    paragraph.repeat(1400) +
    "Final passage[[comment(ana): **A note** with `code` and [brackets].]] end.";
  let state = indexed(source);
  const original = Text.prototype.toString;
  let wholeDocumentReads = 0;
  Text.prototype.toString = function () {
    if (this.length > 10000) {
      wholeDocumentReads++;
      throw new Error("ordinary typing serialized the full document");
    }
    return original.call(this);
  };
  try {
    for (let round = 0; round < 30; round++) {
      const from = state.doc.line(201 + round * 2).from + 4;
      state = state.update({ changes: { from, insert: "é" } }).state;
      assert.equal(sourceCommentRanges(state).length, 1);
    }
    // Raw records already proven to be annotations are not treated as new
    // bracket syntax when typing ordinary text in their visible paragraph.
    state = state.update({
      changes: { from: sourceCommentRanges(state)[0].from - 4, insert: "x" },
    }).state;
    assert.equal(sourceCommentRanges(state).length, 1);
  } finally {
    Text.prototype.toString = original;
  }
  assert.equal(wholeDocumentReads, 0);
  matchesFreshParse(state, "mapped records keep exact offsets");
});

test("mapped comment ranges retain exact parser behavior across structural edits", () => {
  const cases = JSON.parse(
    readFileSync(
      new URL("./fixtures/file-comments.json", import.meta.url),
      "utf8",
    ),
  ) as { name: string; source: string }[];
  for (const fixture of cases) {
    const initial = indexed(fixture.source);
    for (const change of [
      { from: 0, insert: "Prefix " },
      { from: 0, insert: "```md\n" },
      { from: 0, insert: "    " },
      { from: 0, to: Math.min(3, initial.doc.length), insert: "" },
      { from: initial.doc.length, insert: "\n[[comment(ana): Added note]]" },
    ]) {
      const state = initial.update({ changes: change }).state;
      matchesFreshParse(state, fixture.name);
    }
  }
});

test("reference labels spanning lines cannot leave comment visibility stale", () => {
  let state = indexed(
    "[a\nword[[comment(ana): visible until the reference resolves]]][ref]\n\n[other]: /target",
  );
  const from = state.doc.toString().indexOf("other");
  state = state.update({
    changes: { from, to: from + 5, insert: "ref" },
  }).state;
  matchesFreshParse(state, "a distant reference definition can hide a comment");
  assert.equal(sourceCommentRanges(state).length, 0);
  state = state.update({
    changes: { from, to: from + 3, insert: "other" },
  }).state;
  matchesFreshParse(state, "removing the reference reveals the comment again");
  assert.equal(sourceCommentRanges(state).length, 1);
});

test("several ordinary replacements map threads once and keep standalone records hidden", () => {
  let state = indexed(
    "First passage.\n[[comment(ana): First note]]\n\nSecond passage.\n[[comment(alex): Second note]]\n\nLast passage.",
  );
  const source = state.doc.toString();
  state = state.update({
    changes: [
      { from: 2, to: 4, insert: "ri" },
      { from: source.indexOf("Second") + 3, insert: " new" },
      { from: source.indexOf("Last") + 1, to: source.indexOf("Last") + 2 },
    ],
  }).state;
  assert.equal(sourceCommentRanges(state).length, 2);
  matchesFreshParse(state, "multiple changes map from the original positions");
});

test("edits at line and hidden-record boundaries preserve standalone collapsing", () => {
  for (const [source, change] of [
    ["Before\n[[comment(ana): Note]]\n\nAfter", { from: 6, insert: " more" }],
    ["[[comment(ana): Note]] suffix\nAfter", { from: 22, to: 28, insert: "" }],
    ["Before [[comment(ana): Note]]", { from: 29, insert: " after" }],
    [
      "[[comment(ana): First]]\n\n[[comment(alex): Second]]\nAfter",
      { from: 23, to: 24, insert: "" },
    ],
  ] as const) {
    const state = indexed(source).update({ changes: change }).state;
    matchesFreshParse(state, "record boundary changes must be reclassified");
    const decorations: number[][] = [];
    state
      .field(sourceCommentLayer)
      .decorations.between(0, state.doc.length, (from, to) => {
        decorations.push([from, to]);
      });
    assert.deepEqual(
      decorations,
      sourceCommentRanges(state).map(({ from, to }) => [from, to]),
    );
  }
});

test("ordinary punctuation that creates a reference definition reparses comments", () => {
  const source =
    "[label[[comment(ana): Initially visible]]][ref]\n\n[ref] /target";
  const initial = indexed(source);
  assert.equal(sourceCommentRanges(initial).length, 1);
  const from = source.lastIndexOf("[ref]") + 5;
  const state = initial.update({ changes: { from, insert: ":" } }).state;
  matchesFreshParse(state, "a colon completes the reference definition");
  assert.equal(sourceCommentRanges(state).length, 0);
});

test("turning prose into an empty list marker rechecks following indented records", () => {
  for (const marker of ["+", "1.", "22)"]) {
    const initial = indexed(
      "Text\n        [[comment(ana): Following indented record]]",
    );
    const state = initial.update({
      changes: { from: 0, to: 4, insert: marker },
    }).state;
    matchesFreshParse(
      state,
      "an empty list item changes following block context",
    );
  }
});
