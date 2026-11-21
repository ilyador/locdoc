import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React from "react";
import * as Y from "yjs";
import { EditorView } from "@codemirror/view";
import { Awareness } from "y-protocols/awareness";

// A document's workspace path, as the Share dialog copies it, pasted into a
// Markdown document in another folder becomes a link that opens it there.
let dom: JSDOM;
let render: typeof import("@testing-library/react").render;
let cleanup: typeof import("@testing-library/react").cleanup;
let act: typeof import("@testing-library/react").act;
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
  ({ render, cleanup, act } = await import("@testing-library/react"));
  ({ MarkdownEditor } = await import("../src/editor"));
});
afterEach(() => cleanup());
after(() => dom.window.close());

const entries = [
  { id: "plan", path: "Projects/Plan.md", kind: "file", shared: false, url: "/d/plan" },
  {
    id: "goals",
    path: "Life Plan/Life goals.md",
    kind: "file",
    shared: false,
    url: "/d/goals",
  },
  { id: "today", path: "Notes/Today.md", kind: "file", shared: false, url: "/d/today" },
] as const;

function open(source: string, path: string, editable = true) {
  const ydoc = new Y.Doc();
  const text = ydoc.getText("content");
  text.insert(0, source);
  const awareness = new Awareness(ydoc);
  const page = render(
    <MarkdownEditor
      ydoc={ydoc}
      provider={{ awareness } as any}
      editable={editable}
      id="paste-fixture"
      path={path}
      entries={entries as any}
      onComment={() => {}}
      onUpload={() => {}}
    />,
  );
  const content = page.container.querySelector<HTMLElement>(".cm-content")!;
  const view = EditorView.findFromDOM(content)!;
  return {
    view,
    text: () => text.toString(),
    link: () =>
      content.querySelector<HTMLAnchorElement>("a.md-link")?.getAttribute("href"),
    // Pastes at the end of the document, as the clipboard holds `copied`.
    paste(copied: string) {
      act(() =>
        view.dispatch({ selection: { anchor: view.state.doc.length } }),
      );
      const event = new window.Event("paste", {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, "clipboardData", {
        value: {
          files: [],
          types: ["text/plain"],
          getData: (type: string) => (type === "text/plain" ? copied : ""),
        },
      });
      act(() => {
        view.contentDOM.dispatchEvent(event);
      });
    },
    close() {
      page.unmount();
      awareness.destroy();
      ydoc.destroy();
    },
  };
}

test("a workspace path pasted into a link is written from the document's folder", () => {
  const doc = open("See [the plan](", "Notes/Today.md");
  try {
    doc.paste("Projects/Plan.md");
    act(() =>
      doc.view.dispatch({
        changes: { from: doc.view.state.doc.length, insert: ")" },
      }),
    );
    assert.equal(doc.text(), "See [the plan](../Projects/Plan.md)");
    assert.equal(doc.link(), "/d/plan", "the link opens the copied document");
  } finally {
    doc.close();
  }
});

test("a path with spaces pasted into a link is bracketed so the link reads it", () => {
  const doc = open("Goals: [mine](", "Notes/Today.md");
  try {
    doc.paste("Life Plan/Life goals.md");
    act(() =>
      doc.view.dispatch({
        changes: { from: doc.view.state.doc.length, insert: ")" },
      }),
    );
    assert.equal(doc.text(), "Goals: [mine](<../Life Plan/Life goals.md>)");
    assert.equal(doc.link(), "/d/goals");
  } finally {
    doc.close();
  }
});

test("other pasted text, and paths in read-only documents, paste as they are", () => {
  const doc = open("Text ", "Notes/Today.md");
  try {
    doc.paste("Projects/Missing.md");
    assert.equal(doc.text(), "Text Projects/Missing.md");
  } finally {
    doc.close();
  }
  const top = open("At the top: ", "Inbox.md");
  try {
    top.paste("Projects/Plan.md");
    assert.equal(top.text(), "At the top: Projects/Plan.md");
  } finally {
    top.close();
  }
  const prose = open("Moved to ", "Notes/Archive/Old.md");
  try {
    prose.paste("Projects/Plan.md");
    assert.equal(
      prose.text(),
      "Moved to ../../Projects/Plan.md",
      "outside a link the path is written from here too, without brackets",
    );
  } finally {
    prose.close();
  }
  const locked = open("Read only ", "Notes/Today.md", false);
  try {
    locked.paste("Projects/Plan.md");
    assert.equal(locked.text(), "Read only ");
  } finally {
    locked.close();
  }
});

test("Fountain and plain text documents paste workspace paths as they are", () => {
  for (const path of ["Notes/Script.fountain", "Notes/todo.txt"]) {
    const doc = open("Ref ", path);
    try {
      doc.paste("Projects/Plan.md");
      assert.equal(doc.text(), "Ref Projects/Plan.md", path);
    } finally {
      doc.close();
    }
  }
});
