import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";
import React from "react";
import * as Y from "yjs";

// A link to one shared document. Its sidebar lists no tree; the document's
// own workspace says what the link lets its visitor do.
let render, screen, waitFor, cleanup;
let WorkspaceView, useWorkspace;

before(async () => {
  const dom = new JSDOM(
    "<!doctype html><html><head></head><body></body></html>",
    { url: "http://localhost/s/plan-token", pretendToBeVisual: true },
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
  ({ render, screen, waitFor, cleanup } =
    await import("@testing-library/react"));
  ({ WorkspaceView } = await import("../src/app.tsx"));
  ({ useWorkspace } = await import("../src/workspace.ts"));
});
after(() => {
  cleanup();
  window.close();
});

const response = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
function sharedDocument(edit: boolean) {
  const ydoc = new Y.Doc();
  ydoc.getText("content").insert(0, "Plan text");
  const state = Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString("base64");
  ydoc.destroy();
  return {
    id: "plan",
    path: "Plan.md",
    owner: false,
    edit,
    permission: edit ? "edit" : "view",
    shareUrl: null,
    usage: 0,
    content: "Plan text",
    modified: 1_700_000_000,
    state,
  };
}

function App() {
  return <WorkspaceView workspace={useWorkspace()} />;
}

test("a shared document's sidebar says what its link lets the visitor do", async () => {
  localStorage.setItem("locdoc.guestName", "Dana");
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/open/plan-token"))
      return response({
        owner: false,
        root: "",
        guest: "guest",
        publicUrl: location.origin,
        document: sharedDocument(true),
      });
    if (url.includes("/comments")) return response({ comments: [] });
    return response({});
  }) as typeof fetch;
  render(<App />);
  await waitFor(() =>
    assert.ok(screen.queryByRole("textbox", { name: "Markdown document" })),
  );
  const note = await waitFor(() => {
    const element = document.querySelector(".sidebar .shared-sidebar");
    assert.ok(element, "the note is in the sidebar");
    return element!;
  });
  assert.match(note.textContent!, /Plan\s*\.md/);
  assert.match(
    note.textContent!,
    /You can edit this document and leave comments\./,
  );
  assert.match(note.textContent!, /Anyone with this link/);
  // It sits between the sidebar's search area and its foot, as before.
  const order = [
    ...document
      .querySelector(".sidebar")!
      .querySelectorAll(".brand-row, .shared-sidebar, .sidebar-bottom"),
  ].map((element) => element.className.split(" ")[0]);
  assert.deepEqual(order, ["brand-row", "shared-sidebar", "sidebar-bottom"]);
  assert.equal(document.querySelectorAll(".file-tree").length, 0, "no tree");
});
