import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";
import React from "react";
import { fileApi } from "./fixtures/file-api.ts";

// The owner's whole workspace, as the browser mounts it: every document gets a
// fresh DocumentWorkspace, and the sidebar mounts again inside it. jsdom keeps
// each element's scrollTop without layout, so a list that mounts again starts
// at 0 unless it takes its position back.
let render, fireEvent, screen, waitFor, cleanup;
let WorkspaceView, useWorkspace;
let workspace;

before(async () => {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
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
      value:
        typeof dom.window[key] === "function" &&
        ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(key)
          ? dom.window[key].bind(dom.window)
          : dom.window[key],
      configurable: true,
      writable: true,
    });
  window.matchMedia = () =>
    ({ matches: false, addEventListener() {}, removeEventListener() {} }) as any;
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
  ({ render, fireEvent, screen, waitFor, cleanup } =
    await import("@testing-library/react"));
  ({ WorkspaceView } = await import("../src/app.tsx"));
  ({ useWorkspace } = await import("../src/workspace.ts"));
});
afterEach(() => {
  cleanup();
  for (const key of ["locdoc.sidebarView", "locdoc.document", "locdoc.sidebar"])
    localStorage.removeItem(key);
  Object.defineProperty(window, "innerWidth", {
    value: 1024,
    configurable: true,
    writable: true,
  });
});
after(() => window.close());

function App() {
  workspace = useWorkspace();
  return <WorkspaceView workspace={workspace} />;
}
// Enough documents for a long list: a folder of twelve and forty-eight more,
// listed newest first in By date.
const files = [
  "Notes/",
  ...Array.from({ length: 12 }, (_, n) => `Notes/Note ${String(n).padStart(2, "0")}.md`),
  ...Array.from({ length: 48 }, (_, n) => `Doc ${String(n).padStart(2, "0")}.md`),
];
const idOf = (path: string) => path.replace(/\W+/g, "-").toLowerCase();
async function open(view: "date" | "folders", document: string) {
  const api = fileApi(files);
  globalThis.fetch = api.fetch as typeof fetch;
  localStorage.setItem("locdoc.sidebarView", view);
  localStorage.setItem("locdoc.document", idOf(document));
  localStorage.setItem("locdoc.sidebar", "open");
  render(<App />);
  await waitFor(() => assert.ok(workspace.entries.length));
  await opened(document);
}
const list = () => document.querySelector<HTMLElement>(".file-tree")!;
const row = (path: string) =>
  document.querySelector<HTMLElement>(`[role="treeitem"][data-path="${path}"]`)!;
const focused = () => (document.activeElement as HTMLElement)?.dataset?.path;
// The next document's workspace has mounted once its editor shows it and its
// row is current.
async function opened(path: string) {
  await waitFor(() => assert.equal(workspace.id, idOf(path)));
  await waitFor(() => assert.equal(row(path).getAttribute("aria-current"), "page"));
  await waitFor(() =>
    assert.ok(screen.queryByRole("textbox", { name: "Markdown document" })),
  );
}

test("By date stays where it was when a document opens by click or from the keyboard", async () => {
  await open("date", "Doc 47.md");
  const first = list();
  first.scrollTop = 840;
  fireEvent.click(row("Doc 30.md"));
  await opened("Doc 30.md");
  assert.ok(list() !== first, "Each document's workspace mounts the sidebar again");
  assert.equal(list().scrollTop, 840, "A click leaves the list where it was");
  assert.equal(focused(), "Doc 30.md");

  // Down moves to the next row, and the browser scrolls it into view.
  fireEvent.keyDown(row("Doc 30.md"), { key: "ArrowDown" });
  assert.equal(focused(), "Doc 29.md");
  list().scrollTop = 882;
  fireEvent.keyDown(row("Doc 29.md"), { key: "Enter" });
  await opened("Doc 29.md");
  assert.equal(list().scrollTop, 882, "Enter leaves the list where it was");
  assert.equal(focused(), "Doc 29.md", "The opened row keeps keyboard focus");
});

test("the Folders tree stays where it was when a document inside a folder opens", async () => {
  await open("folders", "Doc 00.md");
  fireEvent.click(row("Notes"));
  assert.ok(row("Notes/Note 07.md"), "Notes opens");
  list().scrollTop = 294;
  fireEvent.click(row("Notes/Note 07.md"));
  await opened("Notes/Note 07.md");
  assert.equal(list().scrollTop, 294);
  assert.equal(row("Notes").getAttribute("aria-expanded"), "true");
});

test("on a narrow screen the sidebar closes after a choice and opens again where the list was", async () => {
  Object.defineProperty(window, "innerWidth", {
    value: 390,
    configurable: true,
    writable: true,
  });
  await open("date", "Doc 47.md");
  list().scrollTop = 1260;
  fireEvent.click(row("Doc 12.md"));
  await opened("Doc 12.md");
  await waitFor(() => assert.equal(workspace.sidebar, false));
  assert.equal(document.querySelector(".sidebar")!.classList.contains("is-open"), false);
  assert.equal(list().scrollTop, 1260, "The closed sidebar keeps its place");
  fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
  assert.equal(document.querySelector(".sidebar")!.classList.contains("is-open"), true);
  assert.equal(list().scrollTop, 1260, "It opens where the list was");
});

test("By date and Folders each return to their own place, also after a document opens", async () => {
  await open("date", "Doc 47.md");
  // The browser reports every scroll, including those of the keyboard.
  const scrollTo = (top: number) => {
    list().scrollTop = top;
    fireEvent.scroll(list());
  };
  scrollTo(840);
  fireEvent.click(screen.getByRole("tab", { name: "Folders" }));
  assert.equal(list().scrollTop, 0, "Folders starts at its own top");
  scrollTo(126);
  fireEvent.click(screen.getByRole("tab", { name: "By date" }));
  assert.equal(list().scrollTop, 840, "By date returns to where it was");
  fireEvent.click(row("Doc 30.md"));
  await opened("Doc 30.md");
  assert.equal(list().scrollTop, 840);
  fireEvent.click(screen.getByRole("tab", { name: "Folders" }));
  assert.equal(list().scrollTop, 126, "Folders kept its place meanwhile");
});

test("a new folder's name field stays in sight when it brings up Folders", async () => {
  // Rows are 42px tall in a 420px list; scrolling an element into view moves
  // the list as little as it must, like the browser's block: "nearest".
  const prototype = window.Element.prototype as any;
  const native = prototype.scrollIntoView;
  prototype.scrollIntoView = function () {
    const list = this.closest(".file-tree");
    const item = this.closest('[role="treeitem"]');
    if (!list || !item) return;
    const top = [...list.querySelectorAll('[role="treeitem"]')].indexOf(item) * 42;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + 42 > list.scrollTop + 420) list.scrollTop = top + 42 - 420;
  };
  try {
    await open("date", "Doc 47.md");
    fireEvent.click(screen.getByRole("tab", { name: "Folders" }));
    list().scrollTop = 1260;
    fireEvent.scroll(list());
    fireEvent.click(screen.getByRole("tab", { name: "By date" }));
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    const field = screen.getByRole("textbox", { name: "New folder name" });
    assert.ok(document.activeElement === field, "The name field takes focus");
    assert.equal(
      screen.getByRole("tab", { name: "Folders" }).getAttribute("aria-selected"),
      "true",
    );
    assert.equal(list().scrollTop, 0, "Folders shows the field at its top");
  } finally {
    prototype.scrollIntoView = native;
  }
});
