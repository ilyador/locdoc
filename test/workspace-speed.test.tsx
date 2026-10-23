import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";
import React from "react";
import { fileApi } from "./fixtures/file-api.ts";

// The owner's whole workspace, as the browser mounts it. The tree is listed
// again every four seconds while a document is open; what the workspace
// does with a listing decides how much renders again while the owner types.
let render, screen, waitFor, cleanup, act, fireEvent;
let WorkspaceView, useWorkspace, spliceEntries;
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
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ])
    Object.defineProperty(globalThis, key, {
      value:
        typeof dom.window[key] === "function" &&
        [
          "getComputedStyle",
          "requestAnimationFrame",
          "cancelAnimationFrame",
        ].includes(key)
          ? dom.window[key].bind(dom.window)
          : dom.window[key],
      configurable: true,
      writable: true,
    });
  window.matchMedia = () =>
    ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }) as any;
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
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
  ({ render, screen, waitFor, cleanup, act, fireEvent } =
    await import("@testing-library/react"));
  ({ WorkspaceView } = await import("../src/app.tsx"));
  ({ useWorkspace, spliceEntries } = await import("../src/workspace.ts"));
});
afterEach(() => {
  cleanup();
  for (const key of ["locdoc.sidebarView", "locdoc.document", "locdoc.sidebar"])
    localStorage.removeItem(key);
});
after(() => window.close());

function App() {
  workspace = useWorkspace();
  return <WorkspaceView workspace={workspace} />;
}
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
const row = (path: string) =>
  document.querySelector<HTMLElement>(
    `[role="treeitem"][data-path="${path}"]`,
  )!;
async function open(document: string) {
  const api = fileApi(files);
  globalThis.fetch = api.fetch as typeof fetch;
  localStorage.setItem("locdoc.sidebarView", "date");
  localStorage.setItem("locdoc.document", idOf(document));
  localStorage.setItem("locdoc.sidebar", "open");
  render(<App />);
  await waitFor(() => assert.ok(workspace.entries.length));
  await waitFor(() =>
    assert.ok(screen.queryByRole("textbox", { name: "Markdown document" })),
  );
  return api;
}

test("a listing that finds no change keeps the tree the workspace shows", async () => {
  const api = await open("Doc 47.md");
  const shown = workspace.entries;
  await act(() => workspace.loadTree());
  assert.ok(
    workspace.entries === shown,
    "an unchanged listing changes nothing that depends on the tree",
  );
  // Saving a document changes its time; the other entries stay as they were.
  api.items.find((item) => item.path === "Doc 12.md")!.modified = 2_000_000;
  await act(() => workspace.loadTree());
  const listed = workspace.entries;
  assert.ok(listed !== shown, "a changed listing is shown");
  const saved = listed.find((entry) => entry.path === "Doc 12.md")!;
  assert.equal(saved.modified, 2_000_000);
  assert.ok(
    listed.every((entry) => entry === saved || shown.includes(entry)),
    "every other entry keeps its object",
  );
  assert.equal(
    document.querySelector('[role="treeitem"]')!.getAttribute("data-path"),
    "Doc 12.md",
    "the saved document moves to the top of By date",
  );
  assert.ok(row("Doc 12.md"));
});

test("an unchanged tree is listed again by its tag, without a body, and the listing it names stands", async () => {
  const api = await open("Doc 47.md");
  const listings = () => api.calls.filter((call) => call.path === "/api/tree");
  const first = listings()[0];
  assert.equal(first.held, null, "the first listing names no tag");
  const shown = workspace.entries;
  await act(() => workspace.loadTree());
  const again = listings().at(-1)!;
  assert.ok(again.held?.startsWith('W/"'), "the next one names its tag");
  assert.equal(again.unchanged, true, "and is answered without a body");
  assert.ok(workspace.entries === shown, "the tree shown stays as it is");
  assert.equal(workspace.error, "");
  // A 304 confirms the listing the tag was given for, not whatever the
  // sidebar shows meanwhile: a change the server never made is undone, as a
  // full listing would undo it.
  act(() =>
    workspace.patchEntries((entries) =>
      entries.filter((entry) => entry.path !== "Doc 12.md"),
    ),
  );
  assert.equal(row("Doc 12.md"), null);
  await act(() => workspace.loadTree());
  assert.equal(listings().at(-1)!.unchanged, true);
  assert.ok(
    workspace.entries.some((entry) => entry.path === "Doc 12.md"),
    "the listing the server confirmed is shown again",
  );
  assert.ok(row("Doc 12.md"));
  // A changed tree comes in full, with a new tag, and is asked by that one.
  api.items.find((item) => item.path === "Doc 12.md")!.modified = 2_000_000;
  await act(() => workspace.loadTree());
  const changed = listings().at(-1)!;
  assert.equal(changed.unchanged, false);
  assert.equal(
    workspace.entries.find((entry) => entry.path === "Doc 12.md")!.modified,
    2_000_000,
  );
  await act(() => workspace.loadTree());
  assert.equal(listings().at(-1)!.unchanged, true);
  assert.notEqual(listings().at(-1)!.held, again.held);
});

test("a changed tree comes as only what changed since the listing held, which the sidebar shows", async () => {
  const api = await open("Doc 47.md");
  const listings = () => api.calls.filter((call) => call.path === "/api/tree");
  const shown = workspace.entries;
  // Typing in a document changes its time: only that entry is sent.
  api.items.find((item) => item.path === "Doc 12.md")!.modified = 2_000_000;
  await act(() => workspace.loadTree());
  assert.equal(listings().at(-1)!.spliced, true, "only what changed is sent");
  const listed = workspace.entries;
  const saved = listed.find((entry) => entry.path === "Doc 12.md")!;
  assert.equal(saved.modified, 2_000_000);
  assert.ok(
    listed.every((entry) => entry === saved || shown.includes(entry)),
    "every other entry keeps its object",
  );
  assert.equal(
    document.querySelector('[role="treeitem"]')!.getAttribute("data-path"),
    "Doc 12.md",
    "the saved document moves to the top of By date",
  );
  // A rename on the desktop, a new document and a removed one.
  api.rename("Doc 30.md", "Doc thirty.md");
  api.items.push({
    ...api.items.find((i) => i.path === "Doc 01.md")!,
    path: "Doc new.md",
    id: "doc-new",
    title: "Doc new",
  });
  api.items.splice(
    api.items.findIndex((i) => i.path === "Doc 02.md"),
    1,
  );
  await act(() => workspace.loadTree());
  assert.equal(listings().at(-1)!.spliced, true);
  assert.ok(row("Doc thirty.md") && row("Doc new.md"));
  assert.equal(row("Doc 30.md"), null);
  assert.equal(row("Doc 02.md"), null);
  assert.deepEqual(
    workspace.entries.map((entry) => [entry.path, entry.modified]),
    api.items.map((item) => [item.path, item.modified]),
    "the splices make the listing the server holds",
  );
  // Asked again by the tag the splice came with, it is unchanged.
  await act(() => workspace.loadTree());
  assert.equal(listings().at(-1)!.unchanged, true);
  assert.equal(workspace.error, "");
});

test("a splice applies only where it fits the listing kept", () => {
  const entry = (path: string) => ({
    path,
    kind: "file",
    id: path,
    shared: false,
  });
  const kept = { entries: ["a", "b", "c", "d"].map(entry) };
  const [a, b, c, d] = kept.entries;
  const e = entry("e");
  const made = spliceEntries(kept, {
    edits: [
      [0, 0, [e]],
      [1, 2, []],
      [4, 0, [entry("f")]],
    ],
  })!;
  assert.deepEqual(
    made.entries.map((item) => item.path),
    ["e", "a", "d", "f"],
  );
  assert.ok(
    made.entries[1] === a && made.entries[2] === d,
    "kept entries are the objects they were",
  );
  assert.deepEqual(spliceEntries(kept, { edits: [] })!.entries, [a, b, c, d]);
  for (const edits of [
    undefined,
    "edits",
    [
      [2, 1, []],
      [1, 0, []],
    ],
    [[3, 2, []]],
    [[-1, 0, []]],
    [[0, 1.5, []]],
    [[0, 0, [null]]],
    [[0, 0, [{ kind: "file" }]]],
    [[0, 0]],
  ])
    assert.equal(spliceEntries(kept, { edits }), null, JSON.stringify(edits));
  assert.equal(spliceEntries(kept, null), null);
});

// The next document's workspace has mounted once its row is current and its
// editor shows it.
async function opened(path: string) {
  await waitFor(() => assert.equal(workspace.id, idOf(path)));
  await waitFor(() =>
    assert.equal(row(path).getAttribute("aria-current"), "page"),
  );
  await waitFor(() =>
    assert.ok(screen.queryByRole("textbox", { name: "Markdown document" })),
  );
}

test("opening a document keeps the sidebar and the rows it lists", async () => {
  await open("Doc 47.md");
  const sidebar = document.querySelector(".sidebar");
  const listed = row("Doc 40.md");
  fireEvent.click(row("Doc 30.md"));
  await opened("Doc 30.md");
  assert.ok(
    document.querySelector(".sidebar") === sidebar,
    "the sidebar stays mounted",
  );
  assert.ok(
    row("Doc 40.md") === listed,
    "the rows of other documents are not built again",
  );
  assert.equal(row("Doc 47.md").getAttribute("aria-current"), null);
  // The keyboard shortcut still finds the sidebar's search, opening it.
  act(() => workspace.setSidebar(false));
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  assert.equal(workspace.sidebar, true);
  assert.ok(
    document.activeElement ===
      screen.getByRole("textbox", { name: "Find a document" }),
    "Ctrl K focuses the search",
  );
});

test("a listing in which only a document's time changed leaves the editor as it is", async () => {
  const { EditorView } = await import("@codemirror/view");
  const api = await open("Doc 47.md");
  // The document's comments arrive after its editor shows.
  await waitFor(() =>
    assert.ok(api.calls.some((call) => call.path.endsWith("/comments"))),
  );
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  const view = EditorView.findFromDOM(
    screen.getByRole("textbox", { name: "Markdown document" }),
  )!;
  // Every transaction reaches the view through its own bound dispatch.
  const native = view.dispatch;
  let dispatched = 0;
  view.dispatch = (...specs) => {
    dispatched++;
    return native(...specs);
  };
  try {
    // Saving another document changes only its time.
    api.items.find((item) => item.path === "Doc 12.md")!.modified = 2_000_000;
    await act(() => workspace.loadTree());
    assert.equal(
      workspace.entries.find((entry) => entry.path === "Doc 12.md")!.modified,
      2_000_000,
    );
    assert.equal(dispatched, 0, "the preview's links resolve as before");
    // A rename moves a link target, so the preview resolves links again.
    api.rename("Doc 12.md", "Doc twelve.md");
    await act(() => workspace.loadTree());
    assert.ok(dispatched > 0, "the preview follows the rename");
  } finally {
    view.dispatch = native;
  }
});
