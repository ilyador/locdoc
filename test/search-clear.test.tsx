import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";
import React from "react";
import { fileApi } from "./fixtures/file-api.ts";

// The three search fields, with Clear search in each: the sidebar's, the
// link chooser's and the Google Fonts search in Appearance. jsdom moves no
// focus on a press, so each press does what a browser does when the press is
// not prevented: the button takes focus.
let render, fireEvent, screen, waitFor, cleanup, within;
let WorkspaceView, useWorkspace, AppearancePanel, useAppearance;
let workspace;

before(async () => {
  const dom = new JSDOM(
    "<!doctype html><html><head></head><body></body></html>",
    { url: "http://localhost/", pretendToBeVisual: true },
  );
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
    "KeyboardEvent",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ])
    Object.defineProperty(globalThis, key, {
      value: [
        "getComputedStyle",
        "requestAnimationFrame",
        "cancelAnimationFrame",
      ].includes(key)
        ? dom.window[key].bind(dom.window)
        : dom.window[key],
      configurable: true,
      writable: true,
    });
  // The drawer's breakpoint follows the window's width, as style.css does.
  window.matchMedia = (query: string) =>
    ({
      matches: /max-width: 760px/.test(query) && window.innerWidth <= 760,
      addEventListener() {},
      removeEventListener() {},
    }) as any;
  // Browsers refuse focus inside an inert subtree, and inside a dialog that
  // is not open, which they do not render; jsdom would grant it.
  const focus = window.HTMLElement.prototype.focus;
  window.HTMLElement.prototype.focus = function (options) {
    if (!this.closest("[inert], dialog:not([open])")) focus.call(this, options);
  };
  // As in a browser, opening a dialog focuses its first control with the
  // autofocus attribute, or else its first control.
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
    (
      this.querySelector("[autofocus]") ??
      this.querySelector("a[href], button, input, select, textarea, [tabindex]")
    )?.focus();
  };
  window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  window.Range.prototype.getClientRects = () => [] as any;
  window.Range.prototype.getBoundingClientRect = () => new window.DOMRect();
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as any;
  // Document sockets never open here; tests drive the HTTP contract.
  globalThis.WebSocket = class {
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = 0;
    send() {}
    close() {
      this.readyState = 3;
      this.onclose?.({});
    }
    onclose;
  } as any;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  ({ render, fireEvent, screen, waitFor, cleanup, within } =
    await import("@testing-library/react"));
  ({ WorkspaceView } = await import("../src/app.tsx"));
  ({ useWorkspace } = await import("../src/workspace.ts"));
  ({ AppearancePanel, useAppearance } = await import("../src/appearance.tsx"));
});
afterEach(() => {
  cleanup();
  for (const key of ["locdoc.sidebarView", "locdoc.document", "locdoc.sidebar"])
    localStorage.removeItem(key);
  width(1024);
});
after(() => window.close());

function width(value: number) {
  Object.defineProperty(window, "innerWidth", {
    value,
    configurable: true,
    writable: true,
  });
}
function App() {
  workspace = useWorkspace();
  return <WorkspaceView workspace={workspace} />;
}
// A long list: a folder of twelve notes and forty-eight documents, listed
// newest first in By date.
const files = [
  "Notes/",
  ...Array.from(
    { length: 12 },
    (_, n) => `Notes/Note ${String(n).padStart(2, "0")}.md`,
  ),
  ...Array.from(
    { length: 48 },
    (_, n) => `Doc ${String(n).padStart(2, "0")}.md`,
  ),
];
const idOf = (path: string) => path.replace(/\W+/g, "-").toLowerCase();
// The server lists each document with its link, which the link chooser
// offers: a private document's is its /d/ address.
function linkedApi() {
  const api = fileApi(files);
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await api.fetch(input, init);
    const path = new URL(String(input), "http://localhost").pathname;
    if (path !== "/api/tree" || response.status !== 200) return response;
    const body = await response.json();
    for (const entry of body.entries)
      if (entry.kind === "file") entry.url = `http://localhost/d/${entry.id}`;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: response.headers,
    });
  }) as typeof fetch;
}
async function open(document: string, { narrow }: { narrow: boolean }) {
  width(narrow ? 390 : 1024);
  globalThis.fetch = linkedApi();
  localStorage.setItem("locdoc.sidebarView", "date");
  localStorage.setItem("locdoc.document", idOf(document));
  localStorage.setItem("locdoc.sidebar", narrow ? "closed" : "open");
  render(<App />);
  await waitFor(() => assert.ok(workspace.entries.length));
  await waitFor(() => assert.equal(workspace.id, idOf(document)));
  await waitFor(() =>
    assert.ok(screen.queryByRole("textbox", { name: "Markdown document" })),
  );
}
const list = () => document.querySelector<HTMLElement>(".file-tree")!;
const rows = () =>
  [
    ...document.querySelectorAll<HTMLElement>('.file-tree [role="treeitem"]'),
  ].map((row) => row.dataset.path!);
// The browser reports every scroll, including the keyboard's.
const scrollTo = (top: number) => {
  list().scrollTop = top;
  fireEvent.scroll(list());
};
const search = () => screen.getByRole("textbox", { name: "Find a document" });
const clearButton = () =>
  screen.queryByRole("button", { name: "Clear search" });
const type = (field: HTMLElement, value: string) =>
  fireEvent.change(field, { target: { value } });
// A press on Clear search: a browser gives it focus unless the press is
// prevented, then clicks it.
function press(button: HTMLElement) {
  if (fireEvent.mouseDown(button)) button.focus();
  fireEvent.mouseUp(button);
  fireEvent.click(button);
}

test("Clear search shows only while the sidebar search holds text, and clearing it returns the list to its place", async () => {
  await open("Doc 47.md", { narrow: false });
  const everything = rows();
  assert.equal(everything.length, 60);
  scrollTo(1680);
  const box = search().closest<HTMLElement>(".search-box")!;
  assert.ok(clearButton() === null, "An empty search has no Clear search");
  assert.ok(within(box).getByText("Ctrl K"), "It shows its shortcut instead");

  search().focus();
  type(search(), "doc 1");
  const found = rows();
  assert.equal(found.length, 10);
  assert.ok(found.every((path) => path.startsWith("Doc 1")));
  const clear = clearButton()!;
  assert.ok(clear, "Text brings up Clear search");
  assert.ok(
    within(box).queryByText("Ctrl K") === null,
    "Clear search takes the shortcut's place",
  );
  assert.equal(clear.getAttribute("type"), "button");
  assert.equal(clear.tabIndex, -1, "Tab goes from the field to its neighbours");
  scrollTo(84);

  press(clear);
  assert.equal(search().value, "");
  assert.equal(
    workspace.query,
    "",
    "The workspace's search is cleared, as deleting the text would",
  );
  assert.deepEqual(rows(), everything, "The whole list is back");
  assert.equal(
    list().scrollTop,
    1680,
    "The list is back where it was before the search",
  );
  assert.ok(
    document.activeElement === search(),
    "The caret stays in the field",
  );
  assert.ok(clearButton() === null, "Clear search goes with the text");
  assert.ok(within(box).getByText("Ctrl K"));

  // A press while the field has no focus also leaves the caret in it.
  type(search(), "note");
  search().blur();
  press(clearButton()!);
  assert.equal(search().value, "");
  assert.ok(
    document.activeElement === search(),
    "Clearing puts the caret in the field",
  );
});

test("Escape clears the sidebar search first, and in an empty field still closes the drawer", async () => {
  await open("Doc 47.md", { narrow: true });
  fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
  assert.equal(workspace.sidebar, true);
  scrollTo(1260);
  search().focus();
  type(search(), "doc 2");
  assert.equal(rows().length, 10);
  scrollTo(42);

  // An input method's own Escape cancels its composition, not the search.
  fireEvent.keyDown(search(), { key: "Escape", isComposing: true });
  assert.equal(search().value, "doc 2");

  assert.equal(
    fireEvent.keyDown(search(), { key: "Escape" }),
    false,
    "Escape with text is the field's",
  );
  assert.equal(search().value, "");
  assert.equal(workspace.query, "");
  assert.equal(workspace.sidebar, true, "The drawer stays open");
  assert.equal(rows().length, 60);
  assert.equal(list().scrollTop, 1260, "The list is back where it was");
  assert.ok(
    document.activeElement === search(),
    "The caret stays in the field",
  );

  fireEvent.keyDown(search(), { key: "Escape" });
  assert.equal(
    workspace.sidebar,
    false,
    "Escape in an empty field closes the drawer",
  );
  assert.ok(
    document.activeElement ===
      screen.getByRole("button", { name: "Open sidebar" }),
    "Focus goes back to Open sidebar",
  );
});

test("a right-to-left search ends with Clear search on its left", async () => {
  await open("Doc 47.md", { narrow: false });
  const box = search().closest<HTMLElement>(".search-box")!;
  assert.equal(
    box.getAttribute("dir"),
    null,
    "An empty field keeps the interface's direction",
  );
  type(search(), "שלום");
  assert.equal(
    box.getAttribute("dir"),
    "rtl",
    "A Hebrew search reads from the right",
  );
  assert.equal(search().getAttribute("dir"), "auto");
  assert.ok(
    box.lastElementChild === clearButton(),
    "Clear search follows the text, at its inline end",
  );
  type(search(), "notes");
  assert.equal(box.getAttribute("dir"), "ltr");
});

test("Clear search empties the link chooser, shows every destination again and keeps the dialog open", async () => {
  const { EditorView } = await import("@codemirror/view");
  await open("Doc 47.md", { narrow: false });
  const view = EditorView.findFromDOM(
    screen.getByRole("textbox", { name: "Markdown document" }),
  )!;
  const text = view.state.doc.toString();
  fireEvent.click(
    screen.getByRole("button", {
      name: "Insert link (Ctrl K on selected text)",
    }),
  );
  const dialog = document.querySelector("dialog")!;
  const field = () =>
    screen.getByRole("combobox", { name: "Document title or URL" });
  const options = () =>
    screen.queryAllByRole("option").map((option) => option.textContent);
  assert.ok(dialog.open);
  const all = options();
  assert.equal(all.length, 20, "The chooser lists its first twenty documents");
  assert.ok(clearButton() === null, "An empty chooser has no Clear search");

  field().focus();
  type(field(), "doc 1");
  assert.equal(options().length, 10);
  fireEvent.keyDown(field(), { key: "ArrowDown" });
  assert.equal(field().getAttribute("aria-activedescendant"), "link-result-1");
  assert.ok(clearButton(), "Text brings up Clear search");
  press(clearButton()!);
  assert.equal(field().value, "");
  assert.deepEqual(
    options(),
    all,
    "Every destination is back, as for deleted text",
  );
  assert.equal(
    field().getAttribute("aria-activedescendant"),
    "link-result-0",
    "The first destination is active again",
  );
  assert.ok(dialog.open, "The chooser stays open");
  assert.ok(document.activeElement === field(), "The caret stays in the field");
  assert.equal(view.state.doc.toString(), text, "Clearing inserts no link");

  type(field(), "doc 2");
  assert.equal(
    fireEvent.keyDown(field(), { key: "Escape" }),
    false,
    "Escape with text is the field's, not the dialog's",
  );
  assert.equal(field().value, "");
  assert.deepEqual(options(), all);
  assert.ok(dialog.open, "The chooser stays open");
  assert.ok(document.activeElement === field());

  fireEvent.keyDown(field(), { key: "Escape" });
  assert.equal(
    dialog.open,
    false,
    "Escape in an empty field closes the chooser",
  );
  assert.ok(
    screen.queryByRole("combobox", { name: "Document title or URL" }) === null,
    "The chooser is gone",
  );
  assert.equal(view.state.doc.toString(), text);
});

test("Clear search empties the Google Fonts search and its results without closing Appearance", async () => {
  const response = (body: unknown) =>
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input), location.href).pathname;
    if (path === "/font-catalog.json")
      return response({
        fonts: [
          { family: "Space Grotesk", category: "Sans Serif" },
          { family: "Space Mono", category: "Monospace" },
          { family: "Lora", category: "Serif" },
        ],
      });
    return response({ fonts: [] });
  }) as typeof fetch;
  const saved = new Map(Object.entries(localStorage));
  let closed = 0;
  function Panel() {
    return (
      <AppearancePanel
        owner
        value={useAppearance().forFormat("markdown")}
        onClose={() => closed++}
      />
    );
  }
  try {
    render(<Panel />);
    // The panel puts focus on its first tab once it has painted.
    await waitFor(() =>
      assert.ok(
        document.activeElement === screen.getByRole("tab", { name: "Font" }),
      ),
    );
    await screen.findByText(/Search 3 Google Fonts families/);
    const field = screen.getByLabelText(
      "Search Google Fonts",
    ) as HTMLInputElement;
    const results = () =>
      screen.queryByRole("list", { name: "Google Fonts search results" });
    assert.equal(field.type, "search");
    assert.ok(clearButton() === null, "An empty search has no Clear search");

    field.focus();
    type(field, "space");
    assert.equal(within(results()!).getAllByRole("listitem").length, 2);
    assert.ok(clearButton(), "Text brings up Clear search");
    press(clearButton()!);
    assert.equal(field.value, "");
    assert.ok(results() === null, "The results go with the text");
    assert.ok(document.activeElement === field, "The caret stays in the field");
    assert.ok(clearButton() === null, "Clear search goes with the text");
    assert.equal(closed, 0, "Appearance stays open");

    type(field, "mono");
    assert.equal(within(results()!).getAllByRole("listitem").length, 1);
    assert.equal(fireEvent.keyDown(field, { key: "Escape" }), false);
    assert.equal(field.value, "");
    assert.ok(results() === null, "The results go with the text");
    assert.ok(document.activeElement === field);
    assert.equal(
      closed,
      0,
      "Escape with text clears, and Appearance stays open",
    );

    fireEvent.keyDown(field, { key: "Escape" });
    assert.equal(closed, 1, "Escape in an empty field closes Appearance");
  } finally {
    localStorage.clear();
    for (const [key, value] of saved) localStorage.setItem(key, value);
  }
});

test("Insert link puts the caret in the link chooser's field, so typing goes there", async () => {
  await open("Doc 47.md", { narrow: false });
  fireEvent.click(
    screen.getByRole("button", {
      name: "Insert link (Ctrl K on selected text)",
    }),
  );
  assert.ok(document.querySelector("dialog")!.open);
  const field = screen.getByRole("combobox", {
    name: "Document title or URL",
  }) as HTMLInputElement;
  assert.ok(
    document.activeElement === field,
    "The field has focus as the chooser opens, not the chooser's Close button",
  );
  type(document.activeElement as HTMLElement, "doc 1");
  assert.equal(field.value, "doc 1", "What is typed goes into the field");
  assert.equal(screen.queryAllByRole("option").length, 10);
});
