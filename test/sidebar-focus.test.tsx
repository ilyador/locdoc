import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";
import React from "react";
import { fileApi } from "./fixtures/file-api.ts";

// The owner's workspace as the browser mounts it, on a phone-width screen
// where the sidebar is a drawer over the document, and on a desktop. jsdom
// has no Tab order, so these tests check the inert state and where focus
// lands.
let render, fireEvent, screen, waitFor, cleanup, within;
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
  // Browsers refuse focus inside an inert subtree; jsdom would grant it.
  const focus = window.HTMLElement.prototype.focus;
  window.HTMLElement.prototype.focus = function (options) {
    if (!this.closest("[inert]")) focus.call(this, options);
  };
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
  ({ render, fireEvent, screen, waitFor, cleanup, within } =
    await import("@testing-library/react"));
  ({ WorkspaceView } = await import("../src/app.tsx"));
  ({ useWorkspace } = await import("../src/workspace.ts"));
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
// Listed newest first in By date: Doc 4 to Doc 0.
const files = ["Notes/", ...Array.from({ length: 5 }, (_, n) => `Doc ${n}.md`)];
const idOf = (path: string) => path.replace(/\W+/g, "-").toLowerCase();
async function open(document: string, { narrow }: { narrow: boolean }) {
  width(narrow ? 390 : 1024);
  const api = fileApi(files);
  globalThis.fetch = api.fetch as typeof fetch;
  localStorage.setItem("locdoc.sidebarView", "date");
  localStorage.setItem("locdoc.document", idOf(document));
  localStorage.setItem("locdoc.sidebar", "closed");
  render(<App />);
  await waitFor(() => assert.ok(workspace.entries.length));
  await opened(document);
  return api;
}
const row = (path: string) =>
  document.querySelector<HTMLElement>(
    `[role="treeitem"][data-path="${path}"]`,
  )!;
const main = () => document.querySelector<HTMLElement>("main.workspace")!;
const sidebar = () => document.querySelector<HTMLElement>(".sidebar")!;
const trigger = () => screen.getByRole("button", { name: "Open sidebar" });
const close = () =>
  within(sidebar()).getByRole("button", { name: "Close sidebar" });
const focused = () => (document.activeElement as HTMLElement)?.dataset?.path;
const press = (key: string, target = document.activeElement!) =>
  fireEvent.keyDown(target, { key });
// The next document's workspace has mounted once its editor shows it and its
// row is current.
async function opened(path: string) {
  await waitFor(() => assert.equal(workspace.id, idOf(path)));
  await waitFor(() =>
    assert.equal(row(path).getAttribute("aria-current"), "page"),
  );
  await waitFor(() =>
    assert.ok(screen.queryByRole("textbox", { name: "Markdown document" })),
  );
}
// Pressing Open sidebar from the keyboard.
function openSidebar() {
  const button = trigger();
  button.focus();
  fireEvent.click(button);
}

test("on a narrow screen the drawer takes focus as it opens, keeps the document out of reach and closes with Escape", async () => {
  await open("Doc 2.md", { narrow: true });
  assert.equal(main().hasAttribute("inert"), false);
  openSidebar();
  assert.equal(workspace.sidebar, true);
  assert.equal(
    focused(),
    "Doc 2.md",
    "Focus enters the drawer at the open document's row",
  );
  assert.equal(
    main().hasAttribute("inert"),
    true,
    "The document, its toolbar and its footer behind the drawer cannot take focus",
  );
  assert.equal(sidebar().hasAttribute("inert"), false);
  press("ArrowDown");
  assert.equal(focused(), "Doc 1.md", "The tree's keys work in the drawer");
  press("Escape");
  assert.equal(workspace.sidebar, false, "Escape closes the drawer");
  assert.equal(main().hasAttribute("inert"), false);
  assert.ok(
    document.activeElement === trigger(),
    "Focus returns to Open sidebar",
  );
});

test("a document opened from the narrow drawer gets focus back to Open sidebar", async () => {
  await open("Doc 4.md", { narrow: true });
  const drawer = sidebar();
  const listed = row("Doc 0.md");
  openSidebar();
  assert.equal(focused(), "Doc 4.md");
  press("ArrowDown");
  press("ArrowDown");
  press("Enter");
  await opened("Doc 2.md");
  await waitFor(() => assert.equal(workspace.sidebar, false));
  assert.ok(
    sidebar() === drawer && row("Doc 0.md") === listed,
    "The drawer and its rows stay mounted for the next document",
  );
  assert.ok(
    document.activeElement === trigger(),
    "The next document's Open sidebar has focus, not the page",
  );
  assert.equal(main().hasAttribute("inert"), false);
  // The drawer opens again at the document now open.
  openSidebar();
  assert.equal(focused(), "Doc 2.md");
});

test("Close sidebar and the scrim give focus back, and Escape a field uses stays with it", async () => {
  await open("Doc 3.md", { narrow: true });
  openSidebar();
  fireEvent.click(close());
  assert.equal(workspace.sidebar, false);
  assert.ok(document.activeElement === trigger(), "Close sidebar");
  openSidebar();
  fireEvent.click(document.querySelector(".sidebar-scrim")!);
  assert.equal(workspace.sidebar, false);
  assert.ok(document.activeElement === trigger(), "the scrim");

  openSidebar();
  press("F2");
  const field = screen.getByRole("textbox", { name: "Rename Doc 3.md" });
  assert.ok(document.activeElement === field);
  press("Escape", field);
  assert.equal(workspace.sidebar, true, "Escape cancels the rename only");
  assert.equal(focused(), "Doc 3.md");
  press("Escape");
  assert.equal(workspace.sidebar, false);
});

test("Ctrl+K opens the drawer at its search field, and Escape gives focus back", async () => {
  await open("Doc 1.md", { narrow: true });
  const fonts = screen.getByRole("button", { name: "Fonts and appearance" });
  fonts.focus();
  fireEvent.keyDown(fonts, { key: "k", ctrlKey: true });
  assert.equal(workspace.sidebar, true);
  assert.ok(
    document.activeElement ===
      screen.getByRole("textbox", { name: "Find a document" }),
    "The search field has focus",
  );
  assert.equal(main().hasAttribute("inert"), true);
  press("Escape");
  assert.equal(workspace.sidebar, false);
  assert.ok(
    document.activeElement === fonts,
    "Focus returns to the control that had it",
  );
});

test("a document created from the narrow drawer opens ready for writing", async () => {
  await open("Doc 0.md", { narrow: true });
  openSidebar();
  fireEvent.click(screen.getAllByRole("button", { name: "New document" })[0]);
  const field = screen.getByRole("textbox", { name: "New document name" });
  fireEvent.change(field, { target: { value: "Fresh" } });
  press("Enter", field);
  await waitFor(() => assert.equal(workspace.id, "new-1"));
  await waitFor(() => assert.equal(workspace.sidebar, false));
  await waitFor(() =>
    assert.ok(
      document.activeElement ===
        screen.getByRole("textbox", { name: "Markdown document" }),
      "The new document's editor has focus",
    ),
  );
});

test("on a desktop the sidebar takes focus as it opens but never covers the document", async () => {
  await open("Doc 1.md", { narrow: false });
  openSidebar();
  assert.equal(focused(), "Doc 1.md", "Open sidebar does not drop focus");
  assert.equal(main().hasAttribute("inert"), false);
  press("Escape");
  assert.equal(workspace.sidebar, true, "Escape leaves a desktop sidebar open");
  fireEvent.click(close());
  assert.ok(document.activeElement === trigger());
});
