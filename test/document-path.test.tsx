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
  await waitFor(() => assert.ok(editor()));
});

test("Fountain and text documents open with their names, without extensions, as titles", async () => {
  await open(files, "script-fountain");
  await waitFor(() =>
    assert.ok(screen.getByRole("textbox", { name: "Fountain screenplay" })),
  );
  assert.equal(document.title, "Script · locdoc");
  assert.deepEqual(crumbs(), { folder: null, title: "Script", extension: ".fountain" });
});
