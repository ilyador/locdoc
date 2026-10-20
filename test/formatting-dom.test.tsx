import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { JSDOM } from "jsdom";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { NodeType, Tree } from "@lezer/common";
import { MarkdownEditor, livePreview } from "../src/editor";
import { emphasisContentRange } from "../src/emphasis-range";

let dom: JSDOM;
let render: typeof import("@testing-library/react").render;
let act: typeof import("@testing-library/react").act;
let waitFor: typeof import("@testing-library/react").waitFor;
before(async () => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true,
  });
  for (const key of [
    "window",
    "Window",
    "document",
    "navigator",
    "Node",
    "NodeFilter",
    "HTMLElement",
    "Element",
    "MutationObserver",
    "DOMRect",
  ])
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: dom.window[key],
    });
  for (const key of [
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "getComputedStyle",
  ])
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: dom.window[key].bind(dom.window),
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
  ({ render, act, waitFor } = await import("@testing-library/react"));
});
after(() => dom.window.close());

function wordNode(content: HTMLElement) {
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  while (walker.nextNode())
    if (walker.currentNode.nodeValue === "mispelled") return walker.currentNode;
  assert.fail("Formatted word must have its own visible text node");
}

function wordStyles(word: Node) {
  const styles = new Set<string>();
  for (let parent = word.parentElement; parent; parent = parent.parentElement)
    for (const style of ["md-strong", "md-em", "fountain-underline"])
      if (parent.classList.contains(style)) styles.add(style);
  return [...styles].sort();
}

for (const path of ["Note.md", "Note.fountain"])
  for (const formatted of [
    "**mispelled**",
    "*mispelled*",
    "***mispelled***",
    "**bold *mispelled* tail**",
    "*italic **mispelled** tail*",
    "_mispelled_",
  ])
    test(`${path} retains formatted word DOM while revealing ${formatted} source`, async () => {
      const source = `Prelude.\n\nA ${formatted} word.\n\nTail.`;
      const ydoc = new Y.Doc();
      ydoc.getText("content").insert(0, source);
      const awareness = new Awareness(ydoc);
      const page = render(
        <MarkdownEditor
          ydoc={ydoc}
          provider={{ awareness } as any}
          editable
          id="formatting-dom"
          path={path}
          onComment={() => {}}
          onUpload={() => {}}
        />,
      );
      try {
        const content =
          page.container.querySelector<HTMLElement>(".cm-content")!;
        const view = EditorView.findFromDOM(content)!;
        act(() => view.focus());
        const word = wordNode(content);
        const styles = wordStyles(word);
        for (let pass = 0; pass < 3; pass++) {
          await act(async () => {
            view.dispatch({
              selection: { anchor: source.indexOf("mispelled") + 3 },
            });
          });
          await waitFor(() =>
            assert.ok(
              content.textContent!.includes(formatted),
              "Editing must reveal formatting delimiters",
            ),
          );
          assert.ok(
            content.contains(word),
            "Revealing delimiters must retain the formatted word text node",
          );
          assert.equal(word.nodeValue, "mispelled");
          assert.deepEqual(wordStyles(word), styles);
          act(() => view.dispatch({ selection: { anchor: 0 } }));
          await waitFor(() =>
            assert.ok(
              !content.textContent!.includes(formatted),
              "Leaving the line must hide formatting delimiters",
            ),
          );
          assert.ok(
            content.contains(word),
            "Hiding delimiters must retain the formatted word text node",
          );
          assert.deepEqual(wordStyles(word), styles);
          assert.equal(content.getAttribute("spellcheck"), "true");
          assert.equal(view.state.doc.toString(), source);
          assert.equal(ydoc.getText("content").toString(), source);
        }
      } finally {
        page.unmount();
        awareness.destroy();
        ydoc.destroy();
      }
    });

test("Markdown preview retains word DOM without relying on a second syntax-highlighting layer", () => {
  const source = "Prelude.\n\nA **mispelled** word.\n\nTail.";
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: source,
      extensions: [
        markdown({ base: markdownLanguage }),
        livePreview("word-dom"),
      ],
    }),
  });
  try {
    const word = wordNode(view.contentDOM);
    for (const anchor of [source.indexOf("mispelled") + 3, 0]) {
      view.dispatch({ selection: { anchor } });
      assert.ok(
        view.contentDOM.contains(word),
        "Preview alone must preserve the formatted word text node",
      );
      assert.deepEqual(wordStyles(word), ["md-strong"]);
      assert.equal(view.state.doc.toString(), source);
    }
  } finally {
    view.destroy();
  }
});

test("emphasis content falls back to its source range when direct delimiter bounds are incomplete", () => {
  const emphasis = NodeType.define({ id: 0, name: "Emphasis" });
  const marker = NodeType.define({ id: 1, name: "EmphasisMark" });
  const incomplete = new Tree(emphasis, [new Tree(marker, [], [], 1)], [0], 8)
    .topNode;
  assert.deepEqual(emphasisContentRange(incomplete), { from: 0, to: 8 });
  const complete = new Tree(
    emphasis,
    [new Tree(marker, [], [], 1), new Tree(marker, [], [], 1)],
    [0, 7],
    8,
  ).topNode;
  assert.deepEqual(emphasisContentRange(complete), { from: 1, to: 7 });
});
