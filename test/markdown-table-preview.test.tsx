import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { documentPreview } from "../src/markdown-preview";
import { linkEvents } from "../src/editor-events";
import { parseMarkdownTable } from "../src/markdown-table";

let dom: JSDOM;
const views: EditorView[] = [];
before(() => {
  dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://locdoc.test",
    pretendToBeVisual: true,
  });
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
  const captures = new WeakMap<Element, number>();
  HTMLElement.prototype.setPointerCapture = function (id) {
    captures.set(this, id);
  };
  HTMLElement.prototype.hasPointerCapture = function (id) {
    return captures.get(this) === id;
  };
  HTMLElement.prototype.releasePointerCapture = function () {
    captures.delete(this);
  };
});
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});
after(() => dom.window.close());

const table =
  "| Name | Link |\n| :--- | ---: |\n| Ada | [**Notes**](Sibling.md) |";
const source = `Before.\n\n${table}\n\nAfter.`;
function editor(text = source, editable = true) {
  const opened: string[] = [];
  const access = new Compartment();
  const view = new EditorView({
    state: EditorState.create({
      doc: text,
      extensions: [
        documentPreview("table", undefined, "Notes/Table.md", [
          {
            id: "sibling",
            path: "Notes/Sibling.md",
            kind: "file",
            shared: false,
            url: "/d/sibling",
          },
        ]),
        history(),
        access.of(EditorState.readOnly.of(!editable)),
        linkEvents(({ url }) => opened.push(url)),
      ],
    }),
    parent: document.body,
  });
  views.push(view);
  return { view, opened, access };
}
function handle(view: EditorView) {
  return view.dom.querySelector<HTMLElement>(".md-table-resize")!;
}
function measure(view: EditorView, sizes = [180, 220]) {
  view.dom
    .querySelectorAll<HTMLElement>("thead th")
    .forEach(
      (cell, index) =>
        (cell.getBoundingClientRect = () =>
          new dom.window.DOMRect(0, 0, sizes[index], 40)),
    );
}
function pointer(target: HTMLElement, type: string, x: number, id = 1) {
  const event = new dom.window.MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    button: 0,
  });
  Object.defineProperties(event, {
    pointerId: { value: id },
    pointerType: { value: "touch" },
  });
  target.dispatchEvent(event);
}
function proportions(view: EditorView) {
  return Array.from(
    view.dom.querySelectorAll<HTMLTableColElement>("col"),
    (col) => parseFloat(col.style.width),
  );
}

test("table cells render formatted links and the shared preview opens them without entering source", () => {
  for (const editable of [true, false]) {
    const { view, opened } = editor(source, editable);
    const widget = view.dom.querySelector(".md-table-preview");
    const link = view.dom.querySelector<HTMLAnchorElement>("td a")!;
    assert.ok(link, "a document link in a table must render");
    assert.equal(link.getAttribute("href"), "/d/sibling");
    assert.equal(link.textContent, "Notes");
    assert.equal(link.querySelector("strong")?.textContent, "Notes");
    assert.equal(
      link.closest("button"),
      null,
      "anchors are never nested in edit buttons",
    );
    link.click();
    link.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    assert.deepEqual(opened, ["/d/sibling", "/d/sibling"]);
    assert.ok(
      view.dom.querySelector(".md-table-preview") === widget,
      "opening a link keeps the table preview",
    );
    assert.equal(view.state.doc.toString(), source);
  }
});

test("table web/autolinks, escapes, code and emphasis preview while HTML, media and unsafe links remain inert", () => {
  const row =
    "| [Web](https://example.com?a=1&amp;b=2) | <https://example.org> | https://example.net | **bold** *em* ~~old~~ `x < y` one \\| two | <script>alert(1)</script> ![x](image.png) [bad](javascript:alert%281%29) |";
  const { view } = editor(
    `| A | B | C | D | E |\n| --- | --- | --- | --- | --- |\n${row}`,
    false,
  );
  const links = Array.from(
    view.dom.querySelectorAll<HTMLAnchorElement>("tbody a"),
  );
  assert.deepEqual(
    links.map((link) => link.href),
    [
      "https://example.com/?a=1&b=2",
      "https://example.org/",
      "https://example.net/",
    ],
  );
  assert.equal(view.dom.querySelector("tbody code")?.textContent, "x < y");
  assert.equal(view.dom.querySelector("tbody em")?.textContent, "em");
  assert.equal(view.dom.querySelector("tbody s")?.textContent, "old");
  assert.ok(view.dom.textContent?.includes("one | two"));
  assert.equal(
    view.dom.querySelectorAll("tbody script, tbody img, tbody video").length,
    0,
  );
  assert.ok(view.dom.textContent?.includes("javascript:alert"));
  assert.ok(view.dom.textContent?.includes("<script>alert(1)</script>"));
});

test("clicking an ordinary cell still places the caret at its mapped Markdown source", () => {
  const { view } = editor();
  view.dispatch({ changes: { from: 0, insert: "A prefix.\n\n" } });
  view.dom.querySelector<HTMLElement>("tbody td .md-table-cell")!.click();
  assert.equal(
    view.state.selection.main.head,
    view.state.doc.toString().indexOf("Ada"),
  );
  assert.equal(view.dom.querySelector(".md-table-preview"), null);
});

test("a drag previews without writing, commits separator widths once, survives reopening and undoes cleanly", () => {
  const { view } = editor();
  measure(view);
  const boundary = handle(view);
  pointer(boundary, "pointerdown", 180);
  pointer(boundary, "pointermove", 280);
  assert.equal(
    view.state.doc.toString(),
    source,
    "moving a pointer never writes partial document edits",
  );
  assert.ok(proportions(view)[0] > 65);
  pointer(boundary, "pointerup", 280);
  const saved = view.state.doc.toString();
  assert.notEqual(saved, source);
  assert.equal(
    saved
      .split("\n")
      .filter((_, index) => index !== 3)
      .join("\n"),
    source
      .split("\n")
      .filter((_, index) => index !== 3)
      .join("\n"),
    "only the separator line changes",
  );
  const data = parseMarkdownTable(saved.slice(saved.indexOf("| Name")))!;
  assert.deepEqual(data.align, ["left", "right"]);
  assert.deepEqual(data.widths, [70, 30]);
  assert.deepEqual(proportions(editor(saved, false).view), [70, 30]);
  assert.equal(undo(view), true);
  assert.equal(view.state.doc.toString(), source);
});

test("a cancelled drag writes nothing and a remote edit or permission loss cannot be overwritten by its completion", () => {
  for (const action of ["cancel", "edit", "readonly"] as const) {
    const { view, access } = editor();
    measure(view);
    const boundary = handle(view);
    pointer(boundary, "pointerdown", 180);
    pointer(boundary, "pointermove", 280);
    if (action === "cancel") pointer(boundary, "pointercancel", 280);
    if (action === "edit")
      view.dispatch({
        changes: {
          from: source.indexOf("Ada"),
          to: source.indexOf("Ada") + 3,
          insert: "Other",
        },
      });
    if (action === "readonly")
      view.dispatch({
        effects: access.reconfigure(EditorState.readOnly.of(true)),
      });
    pointer(boundary, "pointerup", 280);
    assert.equal(
      view.state.doc.toString(),
      action === "edit" ? source.replace("Ada", "Other") : source,
    );
    if (action === "readonly")
      assert.equal(view.dom.querySelectorAll(".md-table-resize").length, 0);
  }
});

test("keyboard column resizing retains focus, and right-to-left columns follow the visual drag direction", () => {
  const { view } = editor();
  measure(view);
  const boundary = handle(view);
  boundary.focus();
  boundary.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    }),
  );
  assert.ok(proportions(view)[0] > 45);
  assert.ok(
    document.activeElement === handle(view),
    "the new boundary retains keyboard focus",
  );
  const rtl = editor(
    "Before\n\n| שם | Name |\n| --- | --- |\n| דנה | Ada |",
  ).view;
  measure(rtl, [200, 200]);
  const rtlBoundary = handle(rtl);
  assert.equal(rtlBoundary.dir, "rtl");
  pointer(rtlBoundary, "pointerdown", 200);
  pointer(rtlBoundary, "pointermove", 160);
  pointer(rtlBoundary, "pointerup", 160);
  assert.ok(
    proportions(rtl)[0] > 50,
    "dragging a right-hand column left makes it wider",
  );
});

test("a table at the start of a document stays rendered while its widths and links are used", () => {
  const { view, opened } = editor(table);
  measure(view);
  handle(view).focus();
  handle(view).dispatchEvent(
    new dom.window.KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    }),
  );
  assert.ok(handle(view), "resizing never reveals an unplaced caret's source");
  view.dom.querySelector<HTMLAnchorElement>("td a")!.click();
  assert.deepEqual(opened, ["/d/sibling"]);
  assert.ok(handle(view), "opening a link keeps a first-line table rendered");
});

test("another finger cannot take over or complete a column resize", () => {
  const { view } = editor();
  measure(view);
  const boundary = handle(view);
  pointer(boundary, "pointerdown", 180);
  pointer(boundary, "pointermove", 220);
  pointer(boundary, "pointerdown", 300, 2);
  pointer(boundary, "pointermove", 350, 2);
  pointer(boundary, "pointerup", 350, 2);
  assert.equal(
    view.state.doc.toString(),
    source,
    "only the initiating pointer can commit",
  );
  pointer(boundary, "pointerup", 220);
  assert.ok(proportions(view)[0] > 50);
});
