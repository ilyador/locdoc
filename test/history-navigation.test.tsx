import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";
import React from "react";
import { fileApi } from "./fixtures/file-api.ts";

// Back and Forward move between the documents someone opened, as each
// document has its own address.
let render, fireEvent, screen, waitFor, cleanup, act;
let WorkspaceView, useWorkspace, DraftJournal;
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
  ({ DraftJournal } = await import("../src/drafts.ts"));
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
const row = (path: string) =>
  document.querySelector<HTMLElement>(`[role="treeitem"][data-path="${path}"]`)!;
const shown = () => ({
  id: workspace.id,
  address: location.pathname,
  title: document.title,
});
// jsdom traverses history in a later task, as browsers do. Without an entry
// of this page to go to, no popstate comes.
const traverse = async (step: () => void) => {
  let timer;
  const moved = new Promise<void>((resolve, reject) => {
    window.addEventListener("popstate", () => resolve(), { once: true });
    timer = setTimeout(
      () => reject(new Error("no history entry of this page to go to")),
      2000,
    );
  });
  step();
  try {
    await moved;
  } finally {
    clearTimeout(timer);
  }
};

test("Back and Forward reopen the documents chosen in the sidebar", async () => {
  history.replaceState(null, "", "/");
  api = fileApi(["Notes/", "Notes/Plan.md", "Script.fountain", "todo.txt"]);
  globalThis.fetch = api.fetch as typeof fetch;
  localStorage.setItem("locdoc.sidebarView", "folders");
  localStorage.setItem("locdoc.document", "notes-plan-md");
  render(<App />);
  await waitFor(() =>
    assert.deepEqual(shown(), {
      id: "notes-plan-md",
      address: "/d/notes-plan-md",
      title: "Plan · locdoc",
    }),
  );
  // The document the workspace opened by itself takes the address it
  // opened with: Back leaves Locdoc from there.
  const start = history.length;
  fireEvent.click(row("Script.fountain"));
  await waitFor(() =>
    assert.deepEqual(shown(), {
      id: "script-fountain",
      address: "/d/script-fountain",
      title: "Script · locdoc",
    }),
  );
  fireEvent.click(row("todo.txt"));
  await waitFor(() => assert.equal(location.pathname, "/d/todo-txt"));
  assert.equal(history.length, start + 2, "each chosen document adds one entry");

  await traverse(() => history.back());
  await waitFor(() =>
    assert.deepEqual(shown(), {
      id: "script-fountain",
      address: "/d/script-fountain",
      title: "Script · locdoc",
    }),
  );
  await traverse(() => history.back());
  await waitFor(() =>
    assert.deepEqual(shown(), {
      id: "notes-plan-md",
      address: "/d/notes-plan-md",
      title: "Plan · locdoc",
    }),
  );
  await traverse(() => history.forward());
  await waitFor(() => assert.equal(workspace.id, "script-fountain"));
  assert.equal(location.pathname, "/d/script-fountain");
  assert.equal(history.length, start + 2, "going back and forward adds no entries");

  // Choosing a document after going back replaces what was ahead.
  fireEvent.click(row("Notes"));
  fireEvent.click(row("Notes/Plan.md"));
  await waitFor(() => assert.equal(workspace.id, "notes-plan-md"));
  assert.equal(location.pathname, "/d/notes-plan-md");
  assert.equal(history.length, start + 2);
  await traverse(() => history.back());
  await waitFor(() => assert.equal(workspace.id, "script-fountain"));
});

test("a document that cannot store its drafts keeps its address when Back is pressed", async () => {
  history.replaceState(null, "", "/");
  api = fileApi(["a.md", "b.md"]);
  globalThis.fetch = api.fetch as typeof fetch;
  localStorage.setItem("locdoc.document", "a-md");
  render(<App />);
  await waitFor(() => assert.equal(location.pathname, "/d/a-md"));
  fireEvent.click(row("b.md"));
  await waitFor(() => assert.equal(workspace.id, "b-md"));
  await waitFor(() => assert.equal(location.pathname, "/d/b-md"));
  const start = history.length;
  const flush = DraftJournal.prototype.flush;
  DraftJournal.prototype.flush = () =>
    Promise.reject(new Error("storage is unavailable"));
  try {
    await traverse(() => history.back());
    await waitFor(() =>
      assert.match(
        screen.getByRole("alert").textContent,
        /Could not store unsaved changes/,
      ),
    );
  } finally {
    DraftJournal.prototype.flush = flush;
  }
  assert.equal(workspace.id, "b-md", "the document stays open");
  assert.equal(location.pathname, "/d/b-md", "its address comes back");
  assert.equal(history.length, start, "in place of the entry ahead");
  // Back tries again once the drafts can be stored.
  await traverse(() => history.back());
  await waitFor(() => assert.equal(workspace.id, "a-md"));
  assert.equal(location.pathname, "/d/a-md");
});
