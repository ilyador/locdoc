import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import { moveLineDown } from "@codemirror/commands";
import { insertNewlineContinueMarkup } from "@codemirror/lang-markdown";
import { ySyncAnnotation } from "y-codemirror.next";
import { documentPreview } from "../src/markdown-preview";

const open = (doc: string, path = "Note.md") =>
  EditorState.create({
    doc,
    extensions: documentPreview("n", undefined, path),
  });
const after = (state: EditorState, spec: TransactionSpec) =>
  state.update({ userEvent: "delete", ...spec }).state.doc.toString();
const line = (state: EditorState, number: number) => {
  const { from, to } = state.doc.line(number);
  return { from, to: Math.min(to + 1, state.doc.length) };
};

test("deleting an item renumbers the items after it", () => {
  const state = open("1. Milk\n2. Eggs\n3. Bread\n4. Jam");
  assert.equal(
    after(state, { changes: { ...line(state, 2), insert: "" } }),
    "1. Milk\n2. Bread\n3. Jam",
  );
});

test("deleting the first item keeps the list's starting number", () => {
  const one = open("1. Milk\n2. Eggs\n3. Bread");
  assert.equal(
    after(one, { changes: { ...line(one, 1), insert: "" } }),
    "1. Eggs\n2. Bread",
  );
  const three = open("3. Milk\n4. Eggs\n5. Bread");
  assert.equal(
    after(three, { changes: { ...line(three, 2), insert: "" } }),
    "3. Milk\n4. Bread",
  );
});

test("a number the writer types sets where the list starts", () => {
  const state = open("1. Milk\n2. Eggs\n3. Bread");
  assert.equal(
    after(state, {
      changes: { from: 0, to: 1, insert: "5" },
      userEvent: "input.type",
    }),
    "5. Milk\n6. Eggs\n7. Bread",
  );
});

test("pasted and moved items are numbered in sequence, delimiters kept", () => {
  const state = open("1) Milk\n2) Eggs");
  assert.equal(
    after(state, {
      changes: { from: state.doc.line(2).from, insert: "1) Tea\n2) Rice\n" },
      userEvent: "input.paste",
    }),
    "1) Milk\n2) Tea\n3) Rice\n4) Eggs",
  );
  let moved = open("1. Milk\n2. Eggs\n3. Bread");
  moveLineDown({
    state: moved,
    dispatch: (tr) => {
      moved = tr.state;
    },
  });
  assert.equal(moved.doc.toString(), "1. Eggs\n2. Milk\n3. Bread");
});

test("Enter still continues a list once, without a second renumbering", () => {
  let state = open("1. Milk\n2. Eggs");
  state = state.update({ selection: { anchor: 7 } }).state;
  insertNewlineContinueMarkup({
    state,
    dispatch: (tr) => {
      state = tr.state;
    },
  });
  assert.equal(state.doc.toString(), "1. Milk\n2. \n3. Eggs");
});

test("a nested list renumbers on its own and leaves the outer list alone", () => {
  const state = open("1. Shop\n   1. Milk\n   2. Eggs\n   3. Bread\n2. Cook");
  assert.equal(
    after(state, { changes: { ...line(state, 3), insert: "" } }),
    "1. Shop\n   1. Milk\n   2. Bread\n2. Cook",
  );
});

test("items indented by two spaces keep their own numbering", () => {
  // Markdown puts these in one list with the items above them; writers
  // mean them as a numbered list of their own.
  const doc =
    "1. First\n2. Second\n  1. Sub a\n  2. Sub b\n  3. Sub c\n3. Third\n4. Fourth";
  const outer = open(doc);
  assert.equal(
    after(outer, { changes: { ...line(outer, 6), insert: "" } }),
    "1. First\n2. Second\n  1. Sub a\n  2. Sub b\n  3. Sub c\n3. Fourth",
  );
  const inner = open(doc);
  assert.equal(
    after(inner, { changes: { ...line(inner, 3), insert: "" } }),
    "1. First\n2. Second\n  1. Sub b\n  2. Sub c\n3. Third\n4. Fourth",
  );
  const gap = open("1. First\n2. Second\n  1. Sub a\n3. Third\n4. Fourth");
  assert.equal(
    after(gap, { changes: { ...line(gap, 4), insert: "" } }),
    "1. First\n2. Second\n  1. Sub a\n3. Fourth",
  );
});

test("typing inside an item never rewrites numbers the writer repeated", () => {
  const state = open("1. Milk\n1. Eggs\n1. Bread");
  assert.equal(
    after(state, {
      changes: { from: 7, insert: " and honey" },
      userEvent: "input.type",
    }),
    "1. Milk and honey\n1. Eggs\n1. Bread",
  );
});

test("edits from other writers and plain text documents are left as they are", () => {
  const shared = open("1. Milk\n2. Eggs\n3. Bread");
  assert.equal(
    after(shared, {
      changes: { ...line(shared, 2), insert: "" },
      annotations: ySyncAnnotation.of({} as never),
    }),
    "1. Milk\n3. Bread",
  );
  for (const path of ["Note.txt", "Script.fountain"]) {
    const other = open("1. Milk\n2. Eggs\n3. Bread", path);
    assert.equal(
      after(other, { changes: { ...line(other, 2), insert: "" } }),
      "1. Milk\n3. Bread",
      path,
    );
  }
});
