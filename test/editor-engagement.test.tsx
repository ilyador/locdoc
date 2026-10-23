import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React from "react";
import * as Y from "yjs";
import { EditorView } from "@codemirror/view";
import { Awareness } from "y-protocols/awareness";

let dom: JSDOM;
let render: typeof import("@testing-library/react").render;
let cleanup: typeof import("@testing-library/react").cleanup;
let act: typeof import("@testing-library/react").act;
let waitFor: typeof import("@testing-library/react").waitFor;
let MarkdownEditor: typeof import("../src/editor").MarkdownEditor;

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
  ({ render, cleanup, act, waitFor } = await import("@testing-library/react"));
  ({ MarkdownEditor } = await import("../src/editor"));
});
afterEach(() => cleanup());
after(() => dom.window.close());

// A document as Locdoc opens it: the editor has no focus, and its caret sits
// at the start of the document, where nobody placed it.
function open(source: string, path = "Writing/Plot.md") {
  const ydoc = new Y.Doc();
  const text = ydoc.getText("content");
  text.insert(0, source);
  const awareness = new Awareness(ydoc);
  const props = {
    ydoc,
    provider: { awareness } as any,
    editable: true,
    id: "engagement-fixture",
    path,
    onComment() {},
    onUpload() {},
  };
  const page = render(<MarkdownEditor {...props} />);
  const content = page.container.querySelector<HTMLElement>(".cm-content")!;
  const view = EditorView.findFromDOM(content)!;
  assert.equal(view.state.selection.main.head, 0);
  assert.equal(view.hasFocus, false);
  return {
    page,
    props,
    text,
    view,
    // The visible text, which holds source only where the preview reveals it.
    shown: () => content.textContent!,
    figure: () => content.querySelector<HTMLElement>(".embed"),
    line: (selector: string) => content.querySelector(selector)?.textContent,
    close() {
      page.unmount();
      awareness.destroy();
      ydoc.destroy();
    },
  };
}

// The production example: an image alone on the first line, then a heading.
const plot =
  "![Reference image](_attachments/Plot-reference.jpg)\n## Story\n- A first beat.\n- A second beat.";
const imageSource = "![Reference image](_attachments/Plot-reference.jpg)";

test("an image on the first line renders at open and shows its source once clicked", () => {
  const doc = open(plot);
  try {
    const image = doc.figure()?.querySelector("img");
    assert.ok(
      image,
      "the first-line image must render when the document opens",
    );
    assert.equal(image.getAttribute("alt"), "Reference image");
    assert.ok(!doc.shown().includes("!["), "no image source shows at open");
    assert.equal(doc.line(".cm-line.md-h2"), "Story");
    // A click on the image line, as CodeMirror dispatches it.
    act(() =>
      doc.view.dispatch({
        selection: { anchor: 3 },
        userEvent: "select.pointer",
      }),
    );
    assert.ok(doc.figure() === null, "the clicked image shows its source");
    assert.ok(doc.shown().includes(imageSource));
    assert.equal(doc.line(".cm-line.md-h2"), "Story");
  } finally {
    doc.close();
  }
});

test("Edit Markdown on a first-line image reveals its source", () => {
  const doc = open(plot);
  try {
    const edit = doc.figure()?.querySelector<HTMLButtonElement>(".embed-edit");
    assert.ok(edit, "the rendered image must offer Edit Markdown");
    act(() => edit.click());
    assert.equal(doc.view.state.selection.main.head, 0);
    assert.ok(doc.figure() === null, "Edit Markdown must reveal the source");
    assert.ok(doc.shown().includes(imageSource));
  } finally {
    doc.close();
  }
});

test("a heading on the first line renders at open and focusing the editor reveals it", async () => {
  const doc = open("# Written in Sand\n\nThe first paragraph.");
  try {
    assert.equal(
      doc.line(".cm-line.md-h1"),
      "Written in Sand",
      "the heading marker must stay hidden at open",
    );
    act(() => doc.view.focus());
    await waitFor(() =>
      assert.equal(doc.line(".cm-line.md-h1"), "# Written in Sand"),
    );
  } finally {
    doc.close();
  }
});

test("a setext heading shows its underline only while the selection is on the heading", () => {
  const source = "Story\n=====\nA first beat.\n\nScene\n-----\nMore.";
  const doc = open(source);
  const click = (text: string, offset = 0) =>
    act(() =>
      doc.view.dispatch({
        selection: { anchor: source.indexOf(text) + offset },
        userEvent: "select.pointer",
      }),
    );
  try {
    assert.equal(doc.line(".cm-line.md-h1"), "Story", "= underlines a heading");
    assert.equal(doc.line(".cm-line.md-h2"), "Scene", "- a smaller one");
    assert.ok(!/[=-]{5}/.test(doc.shown()), "both underlines are hidden");
    assert.equal(
      doc.page.container.querySelectorAll(".md-rule").length,
      0,
      "an underline is no rule",
    );
    click("Story", 2);
    assert.ok(doc.shown().includes("====="), "its text shows the underline");
    assert.ok(!doc.shown().includes("-----"), "the other one stays hidden");
    assert.equal(doc.line(".cm-line.md-h1"), "Story");
    click("=====", 5);
    assert.ok(doc.shown().includes("====="), "so does the underline's line");
    click("Scene");
    assert.ok(doc.shown().includes("-----"));
    assert.ok(!doc.shown().includes("====="), "away, it hides again");
    click("More.");
    assert.ok(!/[=-]{5}/.test(doc.shown()), "the next line is away");
  } finally {
    doc.close();
  }
});

test("Locdoc's own selections and remote edits reveal nothing; typing does", () => {
  const doc = open("Some **bold** words.\n\nA second paragraph.");
  try {
    assert.ok(!doc.shown().includes("**"), "emphasis renders at open");
    act(() => doc.view.dispatch({ selection: { anchor: 7 } }));
    act(() => doc.text.insert(doc.text.length, " Remote words."));
    assert.ok(doc.shown().includes("Remote words."));
    assert.ok(
      !doc.shown().includes("**"),
      "a selection without a user event and a remote edit reveal nothing",
    );
    act(() =>
      doc.view.dispatch({
        changes: { from: 7, insert: "very " },
        selection: { anchor: 12 },
        userEvent: "input.type",
      }),
    );
    assert.ok(
      doc.shown().includes("Some **very bold** words."),
      "typing reveals the source where the caret is",
    );
  } finally {
    doc.close();
  }
});

test("find reveals the line of each match it selects", () => {
  const doc = open(
    "![Sand map](_media/map.png)\n\nPlain prose.\n\n## Sand dunes\n\nMore.",
  );
  try {
    assert.ok(doc.figure(), "the first-line image renders at open");
    act(() => {
      doc.view.contentDOM.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "f",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    const field = doc.page.container.querySelector<HTMLInputElement>(
      '.find-widget input[name="search"]',
    );
    assert.ok(field, "Mod-f opens the find widget");
    act(() => {
      field.value = "Sand";
      field.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    const selected = () => {
      const { from, to } = doc.view.state.selection.main;
      return `${from}:${doc.view.state.sliceDoc(from, to)}`;
    };
    assert.equal(selected(), "2:Sand", "find selects the first match");
    assert.ok(doc.figure() === null, "the match inside the image shows");
    assert.ok(doc.shown().includes("![Sand map](_media/map.png)"));
    assert.equal(doc.line(".cm-line.md-h2"), "Sand dunes");
    act(() => {
      field.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    assert.equal(selected().split(":")[1], "Sand", "Enter steps to the next");
    assert.ok(doc.figure(), "the image renders again once find moves on");
    assert.equal(doc.line(".cm-line.md-h2"), "## Sand dunes");
  } finally {
    doc.close();
  }
});

test("a new editor lays its document out once as it opens, and still applies later changes", (t) => {
  // Every view binds its dispatch as it is built, from the prototype.
  const dispatch = t.mock.method(EditorView.prototype, "dispatch");
  const doc = open(
    "INT. HOUSE - DAY\n\nMAYA\nWhere were you?",
    "Writing/Plot.fountain",
  );
  try {
    assert.equal(
      dispatch.mock.callCount(),
      0,
      "its configuration is current and it has no comments to show",
    );
    // A permission change applies in the commit that shows it.
    doc.page.rerender(<MarkdownEditor {...doc.props} editable={false} />);
    assert.equal(doc.view.state.readOnly, true);
    // A rename changes its format.
    doc.page.rerender(
      <MarkdownEditor {...doc.props} editable={false} path="Writing/Plot.md" />,
    );
    assert.ok(
      doc.page.container.querySelector('[aria-label="Markdown document"]'),
    );
    // Comments that arrive show, and leave when they go.
    const comment = {
      id: "c1",
      body: "A note",
      name: "alex",
      canResolve: true,
      quote: null,
      anchor: null,
      created: 0,
      resolved: false,
      replies: [],
    };
    doc.page.rerender(
      <MarkdownEditor
        {...doc.props}
        editable={false}
        path="Writing/Plot.md"
        comments={[comment]}
      />,
    );
    assert.ok(doc.page.container.querySelector(".comment-marker"));
    doc.page.rerender(
      <MarkdownEditor
        {...doc.props}
        editable={false}
        path="Writing/Plot.md"
        comments={[]}
      />,
    );
    assert.equal(doc.page.container.querySelector(".comment-marker"), null);
    assert.equal(dispatch.mock.callCount(), 4, "one for each change");
  } finally {
    doc.close();
  }
});

test("a new preview configuration keeps the user's engagement", () => {
  const doc = open("# Title\n\nSee [the other](Other.md).");
  try {
    act(() =>
      doc.view.dispatch({
        selection: { anchor: 3 },
        userEvent: "select.pointer",
      }),
    );
    assert.equal(doc.line(".cm-line.md-h1"), "# Title");
    // Sidebar metadata refreshes reconfigure the preview with new entries.
    doc.page.rerender(
      <MarkdownEditor
        {...doc.props}
        entries={[
          {
            id: "other",
            path: "Writing/Other.md",
            kind: "file",
            shared: false,
            url: "/d/other",
          },
        ]}
      />,
    );
    assert.ok(
      doc.page.container.querySelector('a.md-link[href="/d/other"]'),
      "the preview must use the new entries",
    );
    assert.equal(
      doc.line(".cm-line.md-h1"),
      "# Title",
      "the line the user is on stays revealed",
    );
  } finally {
    doc.close();
  }
});
