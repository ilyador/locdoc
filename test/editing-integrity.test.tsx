import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React from "react";
import * as Y from "yjs";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Awareness } from "y-protocols/awareness";
import { yUndoManagerKeymap } from "y-codemirror.next";
import { commentParser } from "../src/comment-syntax";
import {
  MarkdownEditor,
  toggleInlineFormat,
  type EditorHandle,
} from "../src/editor";

function format(
  source: string,
  from: number,
  to: number,
  marker: "*" | "**" | "_",
  fountain = false,
) {
  const state = EditorState.create({
    doc: source,
    selection: { anchor: from, head: to },
  });
  return state.update(toggleInlineFormat(state, marker, fountain)).state;
}

test("repeating bold toggles off instead of multiplying asterisks in either format", () => {
  for (const fountain of [false, true]) {
    let state = format("sample words", 0, 12, "**", fountain);
    assert.equal(state.doc.toString(), "**sample words**");
    for (let n = 0; n < 20; n++) {
      state = state.update(toggleInlineFormat(state, "**", fountain)).state;
      assert.equal(
        state.doc.toString(),
        n % 2 === 0 ? "sample words" : "**sample words**",
      );
    }
  }
});

test("combined emphasis keeps the independent style and untouched literal stars", () => {
  const source = "The ***X*** marker. A literal \\* stays.";
  const at = source.indexOf("X");
  assert.equal(
    format(source, at, at + 1, "**").doc.toString(),
    "The *X* marker. A literal \\* stays.",
  );
  assert.equal(
    format(source, at, at + 1, "*").doc.toString(),
    "The **X** marker. A literal \\* stays.",
  );
  assert.equal(
    format("****sample words****", 4, 16, "**").doc.toString(),
    "sample words",
  );
  assert.equal(format("_quiet_", 1, 6, "_", true).doc.toString(), "quiet");
  assert.equal(format("*_quiet_*", 2, 7, "_", true).doc.toString(), "*quiet*");
});

test("partial and mixed selections split formatting without changing words or nested styles", () => {
  for (const [source, selected, expected] of [
    ["**hello world**", "hello", "hello **world**"],
    ["**hello world**", "world", "**hello** world"],
    ["**hello brave world**", "brave", "**hello** brave **world**"],
    ["**hello *world* more**", "world", "**hello** *world* **more**"],
  ]) {
    const from = source.indexOf(selected);
    assert.equal(
      format(source, from, from + selected.length, "**").doc.toString(),
      expected,
    );
  }
  assert.equal(format("a **b** c", 0, 9, "**").doc.toString(), "**a b c**");
  assert.equal(
    format("before\n\nafter", 0, 13, "**").doc.toString(),
    "**before**\n\n**after**",
  );
  assert.equal(
    format("*a text*", 1, 7, "_", true).doc.toString(),
    "*_a text_*",
  );
});

test("empty formatting pairs toggle back off at the caret", () => {
  let state = format("word", 4, 4, "**");
  assert.equal(state.doc.toString(), "word****");
  state = state.update(toggleInlineFormat(state, "**")).state;
  assert.equal(state.doc.toString(), "word");
  assert.equal(state.selection.main.head, 4);
});

test("ambiguous partial-character nested emphasis is refused without changing source", () => {
  const source = "***hello world***";
  const state = EditorState.create({
    doc: source,
    selection: { anchor: 4, head: 5 },
  });
  const errors: string[] = [];
  const next = state.update(
    toggleInlineFormat(state, "**", false, (error) => errors.push(error)),
  ).state;
  assert.equal(next.doc.toString(), source);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes("nested formatting"));
});

test("formatting matrix preserves independent styles across word and character selections", () => {
  const project = (source: string) => {
    const spans: { kind: string; from: number; to: number }[] = [];
    commentParser.parse(source).iterate({
      enter(node) {
        if (node.name === "StrongEmphasis" || node.name === "Emphasis")
          spans.push({ kind: node.name, from: node.from, to: node.to });
      },
    });
    return [...source.matchAll(/[a-z]/g)].map((match) => ({
      char: match[0],
      at: match.index,
      bold: spans.some(
        (span) =>
          span.kind === "StrongEmphasis" &&
          span.from <= match.index &&
          match.index < span.to,
      ),
      italic: spans.some(
        (span) =>
          span.kind === "Emphasis" &&
          span.from <= match.index &&
          match.index < span.to,
      ),
    }));
  };
  let cases = 0;
  for (const source of [
    "**hello world**",
    "***hello world***",
    "**hello *world* more**",
    "*hello **world** more*",
    "a **b** c",
    "*hello* more",
    "**hello** **world**",
  ]) {
    const before = project(source);
    for (let start = 0; start < before.length; start++)
      for (let end = start; end < before.length; end++)
        for (const marker of ["*", "**"] as const) {
          cases++;
          const key = marker === "**" ? "bold" : "italic";
          const other = key === "bold" ? "italic" : "bold";
          const remove = before
            .slice(start, end + 1)
            .every((part) => part[key]);
          const state = EditorState.create({
            doc: source,
            selection: { anchor: before[start].at, head: before[end].at + 1 },
          });
          let refused = false;
          const next = state
            .update(
              toggleInlineFormat(state, marker, false, () => {
                refused = true;
              }),
            )
            .state.doc.toString();
          if (refused) {
            assert.equal(next, source);
            continue;
          }
          const after = project(next);
          assert.equal(after.length, before.length);
          for (let n = 0; n < before.length; n++) {
            assert.equal(after[n].char, before[n].char);
            assert.equal(after[n][other], before[n][other]);
            assert.equal(
              after[n][key],
              n >= start && n <= end ? !remove : before[n][key],
            );
          }
        }
  }
  assert.equal(cases, 852);
});

let dom: JSDOM;
let render: typeof import("@testing-library/react").render;
let act: typeof import("@testing-library/react").act;
let cleanup: typeof import("@testing-library/react").cleanup;
before(async () => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  for (const key of [
    "window",
    "Window",
    "document",
    "location",
    "history",
    "localStorage",
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
  ])
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: [
        "getComputedStyle",
        "requestAnimationFrame",
        "cancelAnimationFrame",
      ].includes(key)
        ? dom.window[key].bind(dom.window)
        : dom.window[key],
    });
  dom.window.Range.prototype.getClientRects = () => [] as any;
  dom.window.Range.prototype.getBoundingClientRect = () =>
    new dom.window.DOMRect();
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as any;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  ({ render, act, cleanup } = await import("@testing-library/react"));
});
afterEach(() => cleanup());
after(() => dom.window.close());

function mount(source: string, path = "Note.md") {
  const ydoc = new Y.Doc();
  const text = ydoc.getText("content");
  text.insert(0, source);
  const awareness = new Awareness(ydoc);
  const ref = React.createRef<EditorHandle>();
  const errors: string[] = [];
  const page = render(
    <MarkdownEditor
      ref={ref}
      ydoc={ydoc}
      provider={{ awareness } as any}
      editable
      id="integrity-fixture"
      path={path}
      onChange={() => {}}
      onComment={() => {}}
      onUpload={() => {}}
      onIntegrityError={(message) => errors.push(message)}
    />,
  );
  const view = EditorView.findFromDOM(
    page.container.querySelector(".cm-editor")!,
  )!;
  return {
    text,
    ydoc,
    ref,
    view,
    errors,
    close() {
      page.unmount();
      awareness.destroy();
      ydoc.destroy();
    },
  };
}

test("formatting retains visible and hidden CRDT item identities and supports undo", () => {
  const source = "left[[comment(ana): Keep this record]]right";
  const fixture = mount(source);
  try {
    const tracked = [
      source.indexOf("left"),
      source.indexOf("Keep"),
      source.indexOf("right"),
    ].map((at) => ({
      char: source[at],
      relative: Y.createRelativePositionFromTypeIndex(fixture.text, at),
    }));
    act(() => {
      fixture.view.dispatch({ selection: { anchor: 0, head: source.length } });
      fixture.ref.current!.wrap("**", "**");
    });
    assert.equal(
      fixture.text.toString(),
      "**left**[[comment(ana): Keep this record]]**right**",
    );
    for (const trackedItem of tracked) {
      const position = Y.createAbsolutePositionFromRelativePosition(
        trackedItem.relative,
        fixture.ydoc,
      );
      assert.ok(position !== null, "Original CRDT item must remain reachable");
      assert.equal(fixture.text.toString()[position!.index], trackedItem.char);
    }
    act(() => {
      yUndoManagerKeymap.find((binding) => binding.key === "Mod-z")!.run!(
        fixture.view,
      );
    });
    assert.equal(fixture.text.toString(), source);
  } finally {
    fixture.close();
  }
});

test("successive formatting toggles undo independently and retain backward selections", () => {
  const fixture = mount("sample words");
  try {
    act(() => {
      fixture.view.dispatch({ selection: { anchor: 12, head: 0 } });
      fixture.ref.current!.wrap("**", "**");
    });
    assert.ok(
      fixture.view.state.selection.main.anchor >
        fixture.view.state.selection.main.head,
    );
    act(() => fixture.ref.current!.wrap("**", "**"));
    assert.equal(fixture.text.toString(), "sample words");
    act(() => {
      yUndoManagerKeymap.find((binding) => binding.key === "Mod-z")!.run!(
        fixture.view,
      );
    });
    assert.equal(fixture.text.toString(), "**sample words**");
    act(() => {
      yUndoManagerKeymap.find((binding) => binding.key === "Mod-z")!.run!(
        fixture.view,
      );
    });
    assert.equal(fixture.text.toString(), "sample words");
  } finally {
    fixture.close();
  }
});

test("LF canonical editor inserts at the right line and normalizes pasted line endings", () => {
  const fixture = mount("one\ntwo\nthree");
  try {
    assert.equal(fixture.view.state.lineBreak, "\n");
    act(() => {
      fixture.view.dispatch({ selection: { anchor: 8 } });
      fixture.ref.current!.insert("X\r\nY\rZ");
    });
    assert.equal(fixture.text.toString(), "one\ntwo\nX\nY\nZthree");
    assert.equal(fixture.view.state.doc.toString(), fixture.text.toString());
    assert.equal(fixture.errors.length, 0);
  } finally {
    fixture.close();
  }
});

test("incompatible remote line endings pause editing and recover after canonical resync", async () => {
  const fixture = mount("one\r\ntwo\r\nthree");
  try {
    assert.equal(fixture.errors.length, 1);
    assert.equal(fixture.view.state.doc.length, fixture.text.length);
    assert.equal(fixture.view.state.readOnly, true);
    act(() => fixture.ref.current!.insert("must not apply"));
    assert.equal(fixture.text.toString(), "one\r\ntwo\r\nthree");
    await act(async () => {
      fixture.ydoc.transact(() => {
        fixture.text.delete(3, 1);
        fixture.text.delete(7, 1);
      }, "server-line-ending-migration");
      await Promise.resolve();
    });
    assert.equal(fixture.view.state.readOnly, false);
    act(() => {
      fixture.view.dispatch({ selection: { anchor: 8 } });
      fixture.ref.current!.insert("X");
    });
    assert.equal(fixture.text.toString(), "one\ntwo\nXthree");
  } finally {
    fixture.close();
  }
});

test("native undo after a remote LF migration restores text without reviving CR characters", async () => {
  const fixture = mount("one\r\ntwo");
  const remoteOrigin = {};
  try {
    await act(async () => {
      fixture.ydoc.transact(() => fixture.text.delete(3, 1), remoteOrigin);
      await Promise.resolve();
    });
    act(() => {
      fixture.view.dispatch({ selection: { anchor: 4 } });
      fixture.ref.current!.insert("X");
    });
    assert.equal(fixture.text.toString(), "one\nXtwo");
    act(() =>
      fixture.view.contentDOM.dispatchEvent(
        new dom.window.InputEvent("beforeinput", {
          inputType: "historyUndo",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.equal(fixture.text.toString(), "one\ntwo");
    act(() =>
      fixture.view.contentDOM.dispatchEvent(
        new dom.window.InputEvent("beforeinput", {
          inputType: "historyRedo",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.equal(fixture.text.toString(), "one\nXtwo");
  } finally {
    fixture.close();
  }
});

test("moving the cursor within one line reuses preview decoration sets", () => {
  for (const path of ["Note.md", "Script.fountain"]) {
    const fixture = mount("A **quiet** line.\n\nAnother line.", path);
    try {
      act(() => {
        fixture.view.focus();
        fixture.view.dispatch({ selection: { anchor: 3 } });
      });
      const before = fixture.view.state.facet(EditorView.decorations);
      act(() => fixture.view.dispatch({ selection: { anchor: 4 } }));
      const after = fixture.view.state.facet(EditorView.decorations);
      assert.equal(before.length, after.length);
      for (let n = 0; n < before.length; n++)
        assert.ok(
          before[n] === after[n],
          "Same-line selection must reuse preview decorations",
        );
    } finally {
      fixture.close();
    }
  }
});

test("counter updates are coalesced in their own component during sustained editing", async () => {
  const { DocumentWordMetrics } = await import("../src/document-workspace");
  const doc = new Y.Doc();
  const text = doc.getText("content");
  text.insert(0, "one");
  const page = render(
    <DocumentWordMetrics text={text} initial="stale fallback" path="Note.md" />,
  );
  try {
    assert.ok(page.container.textContent!.includes("1 word"));
    act(() => {
      for (let n = 0; n < 30; n++) text.insert(text.length, " word");
    });
    assert.ok(
      page.container.textContent!.includes("1 word"),
      "Burst must not rerender counters synchronously",
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 130));
    });
    assert.ok(page.container.textContent!.includes("31 words"));
  } finally {
    page.unmount();
    doc.destroy();
  }
});
