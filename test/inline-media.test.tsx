import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import React from "react";
import * as Y from "yjs";
import {
  Compartment,
  EditorSelection,
  EditorState,
  type TransactionSpec,
} from "@codemirror/state";
import { EditorView, type WidgetType } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { Awareness } from "y-protocols/awareness";
import { commentMarkdown } from "../src/comment-syntax";
import { sourceCommentLayer } from "../src/editor-comments";
import { livePreview } from "../src/markdown-preview";
import { InlineMediaWidget, MediaWidget } from "../src/markdown-widgets";
import { isLocalMediaPath, wholeLineImage } from "../src/markdown-media";
import type { Comment } from "../src/model";

const language = markdown({
  base: markdownLanguage,
  extensions: [commentMarkdown],
});
const preview = livePreview("media-fixture", "visitor-token", "Notes/Note.md");

function parsed(state: EditorState) {
  assert.ok(
    ensureSyntaxTree(state, state.doc.length, 2000),
    "Fixture must parse completely",
  );
  state = state.update({}).state;
  assert.equal(syntaxTree(state).length, state.doc.length);
  return state;
}

function create(
  doc: string,
  selection: EditorSelection | { anchor: number; head?: number } = {
    anchor: 0,
  },
  readOnly = false,
) {
  return parsed(
    EditorState.create({
      doc,
      selection,
      extensions: [
        language,
        sourceCommentLayer,
        preview,
        EditorState.allowMultipleSelections.of(true),
        EditorState.readOnly.of(readOnly),
      ],
    }),
  );
}

type Rendered = {
  from: number;
  path: string;
  alt: string;
  title: string;
  block: boolean;
};
// Bounded scalar rows; never compare widget or view object graphs.
function media(state: EditorState): Rendered[] {
  const found: Rendered[] = [];
  for (const set of state.facet(EditorView.decorations)) {
    if (typeof set === "function") continue;
    for (let cursor = set.iter(); cursor.value; cursor.next()) {
      const widget = cursor.value.spec.widget as WidgetType | undefined;
      if (!(
        widget instanceof MediaWidget || widget instanceof InlineMediaWidget
      ))
        continue;
      const url = new URL(widget.src, "http://localhost");
      assert.equal(url.pathname, "/api/docs/media-fixture/media");
      assert.equal(url.searchParams.get("token"), "visitor-token");
      found.push({
        from: cursor.from,
        path: url.searchParams.get("path")!,
        alt: widget.alt,
        title: widget.title,
        block: widget instanceof MediaWidget,
      });
    }
  }
  return found.sort((a, b) => a.from - b.from);
}

function rows(state: EditorState) {
  const result: string[] = [];
  for (const set of state.facet(EditorView.decorations)) {
    if (typeof set === "function") continue;
    for (let cursor = set.iter(); cursor.value; cursor.next()) {
      const { spec } = cursor.value;
      const widget = spec.widget as
        | (WidgetType & { src?: string; alt?: string; title?: string })
        | undefined;
      result.push(
        [
          cursor.from,
          cursor.to,
          spec.class || "",
          spec.block ? "block" : "",
          widget?.constructor.name || "",
          widget?.src || "",
          widget?.alt || "",
          widget?.title || "",
        ].join("|"),
      );
    }
  }
  return result.sort();
}

function assertFresh(state: EditorState, label: string) {
  const actual = rows(state);
  const expected = rows(
    create(state.doc.toString(), state.selection, state.readOnly),
  );
  assert.equal(actual.length, expected.length, `${label}: range count`);
  for (let index = 0; index < actual.length; index++)
    assert.equal(actual[index], expected[index], `${label}: range ${index}`);
}

function step(state: EditorState, spec: TransactionSpec, label: string) {
  const next = parsed(state.update(spec).state);
  assertFresh(next, label);
  return next;
}

const fixtures = JSON.parse(
  readFileSync(
    new URL("./fixtures/media-references.json", import.meta.url),
    "utf8",
  ),
) as {
  name: string;
  source: string;
  references: string[];
  rendered: Omit<Rendered, "from">[];
}[];

test("the preview renders exactly the fixture media the server serves", () => {
  for (const fixture of fixtures) {
    // Read-only reveals no source, so every renderable image is a widget.
    const state = create(fixture.source, { anchor: 0 }, true);
    const actual = media(state);
    assert.equal(
      actual.length,
      fixture.rendered.length,
      `${fixture.name}: rendered count`,
    );
    fixture.rendered.forEach((expected, index) => {
      const found = actual[index];
      assert.equal(found.path, expected.path, `${fixture.name}: path`);
      assert.equal(found.alt, expected.alt, `${fixture.name}: alt`);
      assert.equal(found.title, expected.title, `${fixture.name}: title`);
      assert.equal(found.block, expected.block, `${fixture.name}: block`);
      assert.ok(
        fixture.references.includes(found.path),
        `${fixture.name}: ${found.path} must be a server reference`,
      );
    });
  }
});

test("only relative paths can be requested as media", () => {
  for (const path of ["a.png", "../up/b.png", "dir/c d.png", "x%20y.png"])
    assert.equal(isLocalMediaPath(path), true, path);
  for (const path of [
    "",
    "/etc/passwd",
    "https://example.test/a.png",
    "HTTP://example.test/a.png",
    "data:image/png;base64,AAAA",
    "javascript:alert(1)",
    "mailto:x@example.test",
    "file:///tmp/a.png",
    "//example.test/a.png",
    "#fragment",
  ])
    assert.equal(isLocalMediaPath(path), false, path);
});

test("whole-line images, including titled ones, are figures for comment placement", () => {
  const whole = wholeLineImage('![Chart](charts/q3.png "Quarter three")  ');
  assert.equal(whole?.path, "charts/q3.png");
  assert.equal(whole?.title, "Quarter three");
  assert.equal(
    wholeLineImage("![a](<my pic.png> (Paren))")?.path,
    "my pic.png",
  );
  for (const text of [
    "Text ![a](b.png)",
    " ![a](b.png)",
    "![a](b.png) and more",
    "![a](b.png)[[comment(ana): note]]",
    "![a](https://example.test/b.png)",
    "![a][reference]",
    "![a](b.png",
    "- ![a](b.png)",
  ])
    assert.equal(wholeLineImage(text), null, text);
});

const touchSource =
  'Before ![inline](a.png) middle ![second](b.png "Second title") after.\n\n![block](c.png "Block title")\n\nTail';

test("inline images reveal their source only while a selection touches them", () => {
  const source = touchSource;
  const first = source.indexOf("![inline]");
  const firstEnd = source.indexOf(" middle");
  const second = source.indexOf("![second]");
  let state = create(source, { anchor: source.indexOf("Tail") });
  const paths = () => media(state).map((item) => item.path);
  assert.deepEqual(paths(), ["a.png", "b.png", "c.png"]);
  state = step(state, { selection: { anchor: 0 } }, "caret elsewhere on line");
  assert.deepEqual(paths(), ["a.png", "b.png", "c.png"]);
  state = step(state, { selection: { anchor: first } }, "caret at image start");
  assert.deepEqual(paths(), ["b.png", "c.png"]);
  state = step(
    state,
    { selection: { anchor: first + 4 } },
    "caret inside image source",
  );
  assert.deepEqual(paths(), ["b.png", "c.png"]);
  state = step(
    state,
    { selection: { anchor: firstEnd } },
    "caret at image end",
  );
  assert.deepEqual(paths(), ["b.png", "c.png"]);
  state = step(
    state,
    { selection: { anchor: firstEnd + 2 } },
    "caret moved past the image",
  );
  assert.deepEqual(paths(), ["a.png", "b.png", "c.png"]);
  state = step(
    state,
    { selection: { anchor: first - 3, head: second + 2 } },
    "selection across both images",
  );
  assert.deepEqual(paths(), ["c.png"]);
  state = step(
    state,
    {
      selection: EditorSelection.create([
        EditorSelection.cursor(0),
        EditorSelection.cursor(second + 1),
      ]),
    },
    "second cursor touches one image",
  );
  assert.deepEqual(paths(), ["a.png", "c.png"]);
  state = step(
    state,
    { selection: { anchor: source.indexOf("![block]") + 3 } },
    "caret on the figure line",
  );
  assert.deepEqual(paths(), ["a.png", "b.png"]);
  const titled = media(state).find((item) => item.path === "b.png");
  assert.equal(titled?.title, "Second title");
  assert.equal(titled?.block, false);
});

test("edits around inline images keep exactly the fresh-source preview", () => {
  let state = create(touchSource, { anchor: 0 });
  const at = (text: string) => state.doc.toString().indexOf(text);
  state = step(
    state,
    { changes: { from: 0, insert: "Prefix " }, selection: { anchor: 0 } },
    "insert before the images",
  );
  state = step(
    state,
    {
      changes: {
        from: at("(a.png)") + 1,
        to: at("(a.png)") + 6,
        insert: "z.png",
      },
      selection: { anchor: 0 },
    },
    "change a destination remotely",
  );
  state = step(
    state,
    {
      changes: { from: at(" middle"), insert: " and ![third](d.png)" },
      selection: { anchor: 0 },
    },
    "add an inline image",
  );
  state = step(
    state,
    {
      changes: { from: at("![second]"), to: at("![second]") + 1 },
      selection: { anchor: 0 },
    },
    "turn an image into a link",
  );
  state = step(
    state,
    { changes: { from: at("![block]"), insert: "Lead " } },
    "figure becomes inline",
  );
  assert.equal(
    media(state).find((item) => item.path === "c.png")?.block,
    false,
  );
  step(
    state,
    { changes: { from: at("Lead "), to: at("Lead ") + 5 } },
    "inline becomes a figure again",
  );
});

test("read-only views render inline images even where a selection touches them", () => {
  const permissions = new Compartment();
  const first = touchSource.indexOf("![inline]") + 2;
  let state = parsed(
    EditorState.create({
      doc: touchSource,
      selection: { anchor: first },
      extensions: [
        language,
        sourceCommentLayer,
        preview,
        permissions.of(EditorState.readOnly.of(true)),
      ],
    }),
  );
  assert.equal(media(state).length, 3);
  state = parsed(state.update({ selection: { anchor: first + 1 } }).state);
  assert.equal(media(state).length, 3);
  state = parsed(
    state.update({
      effects: permissions.reconfigure(EditorState.readOnly.of(false)),
    }).state,
  );
  assert.equal(media(state).length, 2, "editing reveals the touched source");
  assertFresh(state, "permission change");
});

let dom: JSDOM;
let render: typeof import("@testing-library/react").render;
let cleanup: typeof import("@testing-library/react").cleanup;
let act: typeof import("@testing-library/react").act;
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
});
afterEach(() => cleanup());
after(() => dom.window.close());

function mountView(doc: string, readOnly = false) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: create(doc, { anchor: 0 }, readOnly),
  });
  return {
    view,
    close() {
      view.destroy();
      parent.remove();
    },
  };
}

test("inline media DOM keeps alt and title inert and reveals source on click", () => {
  const source =
    'Look ![a <b>bold</b> alt](pic.png "<img src=x onerror=alert(1)>") here\n\n![clip](clip.mp4 "A clip")';
  const fixture = mountView(source);
  try {
    const inline = fixture.view.dom.querySelector<HTMLElement>(".embed-inline");
    assert.ok(inline, "the inline image must render");
    const image = inline.querySelector("img")!;
    assert.equal(image.getAttribute("alt"), "a <b>bold</b> alt");
    assert.equal(image.getAttribute("title"), "<img src=x onerror=alert(1)>");
    assert.equal(inline.querySelector("b"), null, "alt text is never markup");
    assert.equal(
      fixture.view.dom.querySelectorAll(".embed-inline img").length,
      1,
      "a title never creates another element",
    );
    const video =
      fixture.view.dom.querySelector<HTMLVideoElement>(".embed video");
    assert.ok(video, "a whole-line video is a figure");
    assert.equal(video.getAttribute("title"), "A clip");
    image.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    assert.equal(
      fixture.view.state.selection.main.head,
      source.indexOf("![a"),
      "clicking places the caret at the image source",
    );
    assert.equal(
      fixture.view.dom.querySelector(".embed-inline"),
      null,
      "the touched image shows its source",
    );
  } finally {
    fixture.close();
  }
});

test("clicking an inline image in a read-only view leaves the selection alone", () => {
  const source = "Look ![photo](pic.png) here";
  const fixture = mountView(source, true);
  try {
    const before = fixture.view.state.selection.main.head;
    const image = fixture.view.dom.querySelector(".embed-inline img")!;
    image.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    assert.equal(fixture.view.state.selection.main.head, before);
    assert.ok(fixture.view.dom.querySelector(".embed-inline img"));
  } finally {
    fixture.close();
  }
});

async function commentMarkers(path: string, source: string, line: string) {
  const { MarkdownEditor } = await import("../src/editor");
  const ydoc = new Y.Doc();
  const text = ydoc.getText("content");
  text.insert(0, source);
  const awareness = new Awareness(ydoc);
  const from = source.indexOf(line);
  const anchor = {
    start: Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(text, from),
    ),
    end: Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(text, from + line.length, -1),
    ),
  };
  const comment: Comment = {
    id: "figure-comment",
    body: "On the figure",
    name: "Ana",
    canResolve: true,
    quote: line,
    anchor,
    created: 0,
    resolved: false,
    replies: [],
  };
  const page = render(
    <MarkdownEditor
      ydoc={ydoc}
      provider={{ awareness } as any}
      editable
      id="comment-media"
      path={path}
      comments={[comment]}
      onComment={() => {}}
      onUpload={() => {}}
    />,
  );
  await act(async () => {});
  const marker = page.container.querySelector(
    '[data-comment-id="figure-comment"]',
  );
  const block = !!marker?.closest(".comment-marker-block");
  page.unmount();
  awareness.destroy();
  ydoc.destroy();
  return { marker: !!marker, block };
}

test("a comment on a titled figure follows the figure only where media renders", async () => {
  const line = '![Chart](charts/q3.png "Quarter three")';
  const source = `Intro\n\n${line}\n\nAfter`;
  const markdown = await commentMarkers("Notes/Chart.md", source, line);
  assert.deepEqual(markdown, { marker: true, block: true });
  const screenplay = await commentMarkers("Notes/Chart.fountain", source, line);
  assert.deepEqual(screenplay, { marker: true, block: false });
  const plain = await commentMarkers("Notes/Chart.txt", source, line);
  assert.deepEqual(plain, { marker: true, block: false });
});
