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
let WorkspaceView, useWorkspace;
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
  ({ useWorkspace } = await import("../src/workspace.ts"));
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
