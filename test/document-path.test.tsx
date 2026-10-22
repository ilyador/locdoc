import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";
import React from "react";
import { fileApi } from "./fixtures/file-api.ts";

let render, fireEvent, screen, waitFor, cleanup, act;
let WorkspaceView, useWorkspace;
let api: ReturnType<typeof fileApi>;
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
  ({ render, fireEvent, screen, waitFor, cleanup, act } =
    await import("@testing-library/react"));
  ({ WorkspaceView } = await import("../src/app.tsx"));
  ({ useWorkspace } = await import("../src/workspace.ts"));
});
afterEach(() => {
  cleanup();
  for (const key of ["locdoc.sidebarView", "locdoc.document"])
    localStorage.removeItem(key);
});
after(() => window.close());

function App() {
  workspace = useWorkspace();
  return <WorkspaceView workspace={workspace} />;
}
async function open(paths: string[], document: string) {
  api = fileApi(paths);
  globalThis.fetch = api.fetch as typeof fetch;
  localStorage.setItem("locdoc.sidebarView", "folders");
  localStorage.setItem("locdoc.document", document);
  render(<App />);
  await waitFor(() => assert.ok(workspace.entries.length));
}
const editor = () => screen.queryByRole("textbox", { name: "Markdown document" });
const row = (path: string) =>
  document.querySelector<HTMLElement>(`[role="treeitem"][data-path="${path}"]`)!;
const crumbs = () => ({
  folder: document.querySelector(".crumb-folder")?.textContent ?? null,
  title: document.querySelector(".crumb-current .doc-title")?.textContent,
  extension: document.querySelector(".crumb-current .doc-extension")?.textContent,
});
const reads = (path: string) =>
  api.calls.filter((call) => call.method === "GET" && call.path === path).length;
const files = ["Notes/", "Notes/Plan.md", "Script.fountain", "todo.txt"];

test("renaming or moving the open document updates its tab title and breadcrumb at once", async () => {
  await open(files, "notes-plan-md");
  await waitFor(() => assert.ok(editor()));
  assert.equal(document.title, "Plan · locdoc");
  assert.deepEqual(crumbs(), { folder: "Notes", title: "Plan", extension: ".md" });
  fireEvent.click(row("Notes"));
  row("Notes/Plan.md").focus();
  fireEvent.keyDown(row("Notes/Plan.md"), { key: "F2" });
  const field = screen.getByRole("textbox", { name: "Rename Plan.md" });
  fireEvent.change(field, { target: { value: "Roadmap" } });
  // The refreshed listing is held: the change must not wait for it.
  const listing = api.hold("GET /api/tree");
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() => assert.equal(document.title, "Roadmap · locdoc"));
  assert.deepEqual(crumbs(), { folder: "Notes", title: "Roadmap", extension: ".md" });
  assert.ok(editor(), "A rename in the same format keeps the editor");
  await act(async () => listing());
  row("Notes/Roadmap.md").focus();
  fireEvent.keyDown(row("Notes/Roadmap.md"), { key: "F10", shiftKey: true });
  fireEvent.click(screen.getByRole("menuitem", { name: /Move to/ }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Documents" }));
  await waitFor(() => assert.equal(crumbs().folder, null));
  assert.deepEqual(crumbs(), { folder: null, title: "Roadmap", extension: ".md" });
  assert.equal(document.title, "Roadmap · locdoc");
});

test("an external rename updates the title and breadcrumb, and a new format reopens the editor", async () => {
  await open(files, "notes-plan-md");
  await waitFor(() => assert.ok(editor()));
  api.rename("Notes/Plan.md", "Notes/Later plan.md");
  await act(() => workspace.loadTree());
  assert.equal(document.title, "Later plan · locdoc");
  assert.deepEqual(crumbs(), { folder: "Notes", title: "Later plan", extension: ".md" });
  const opened = reads("/api/docs/notes-plan-md");
  api.rename("Notes/Later plan.md", "Notes/Later plan.txt");
  await act(() => workspace.loadTree());
  assert.equal(document.title, "Later plan · locdoc", "Text names drop .txt too");
  assert.equal(crumbs().extension, ".txt");
  await waitFor(() => assert.equal(reads("/api/docs/notes-plan-md"), opened + 1));
  // Plain text has its own editor, without Markdown.
  await waitFor(() =>
    assert.ok(screen.queryByRole("textbox", { name: "Plain text document" })),
  );
  assert.equal(editor(), null);
});

test("Fountain and text documents open with their names, without extensions, as titles", async () => {
  await open(files, "script-fountain");
  await waitFor(() =>
    assert.ok(screen.getByRole("textbox", { name: "Fountain screenplay" })),
  );
  assert.equal(document.title, "Script · locdoc");
  assert.deepEqual(crumbs(), { folder: null, title: "Script", extension: ".fountain" });
});

test("a trashed document opens to Recently deleted, and Restore brings it back", async () => {
  api = fileApi(files);
  await api.fetch("/api/docs/notes-plan-md", { method: "DELETE" });
  globalThis.fetch = api.fetch as typeof fetch;
  localStorage.setItem("locdoc.sidebarView", "folders");
  localStorage.setItem("locdoc.document", "notes-plan-md");
  render(<App />);
  await waitFor(() =>
    assert.ok(
      screen.getByRole("heading", { name: "This document is in Recently deleted." }),
    ),
  );
  assert.ok(screen.queryByRole("alert") === null, "A trashed document is not an error");
  assert.equal(document.title, "Plan · locdoc");
  assert.deepEqual(crumbs(), { folder: "Notes", title: "Plan", extension: ".md" });
  fireEvent.click(screen.getByRole("button", { name: "Restore document" }));
  await waitFor(() => assert.ok(editor()));
  assert.ok(
    api.calls.some((call) => call.path === "/api/trash/trash-1/restore"),
    "Restore uses the trash item from the 410 response",
  );
  assert.equal(editor()!.getAttribute("contenteditable"), "true");
});

test("deleting the open document keeps its text readable until Undo reopens it", async () => {
  await open(files, "notes-plan-md");
  await waitFor(() => assert.ok(editor()));
  fireEvent.click(row("Notes"));
  row("Notes/Plan.md").focus();
  fireEvent.keyDown(row("Notes/Plan.md"), { key: "Delete" });
  await waitFor(() =>
    assert.match(
      document.querySelector(".trash-notice")?.textContent || "",
      /This document is in Recently deleted\./,
    ),
  );
  assert.equal(editor()!.getAttribute("contenteditable"), "false");
  assert.match(editor()!.textContent!, /Plan text/);
  assert.match(
    document.querySelector(".toast-slot")!.textContent!,
    /Plan\.md moved to Recently deleted\./,
  );
  assert.ok(row("Notes/Plan.md") === null, "The tree no longer lists it");
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() =>
    assert.ok(document.querySelector(".trash-notice") === null, "Restored"),
  );
  await waitFor(() =>
    assert.equal(editor()?.getAttribute("contenteditable"), "true"),
  );
  assert.ok(row("Notes/Plan.md"));
});
