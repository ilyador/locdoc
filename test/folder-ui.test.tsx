import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React from "react";

let dom, render, renderHook, fireEvent, screen, waitFor, cleanup, act;
let useWorkspace, DocumentSidebar, FolderShare;
const response = (body) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
const entries = [
  { kind: "folder", path: "Design", id: null, shared: true },
  { kind: "file", path: "Design/a.md", id: "a", shared: true },
  { kind: "file", path: "b.md", id: "b", shared: true },
];
before(async () => {
  dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    url: "http://localhost/s/folder-token?doc=b",
    pretendToBeVisual: true,
  });
  for (const key of [
    "window",
    "document",
    "location",
    "history",
    "localStorage",
    "navigator",
    "Node",
    "Element",
    "HTMLElement",
    "HTMLInputElement",
    "MutationObserver",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ]) {
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
  }
  window.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  ({ render, renderHook, fireEvent, screen, waitFor, cleanup, act } =
    await import("@testing-library/react"));
  ({ useWorkspace } = await import("../src/workspace.ts"));
  ({ DocumentSidebar } = await import("../src/document-sidebar.tsx"));
  ({ FolderShare } = await import("../src/sharing.tsx"));
});
afterEach(() => cleanup());
after(() => dom.window.close());

test("folder navigation preserves capability and selection in the URL and loads a scoped tree", async () => {
  const paths = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    paths.push(url);
    if (url.startsWith("/api/open/"))
      return response({
        owner: false,
        root: "",
        guest: "guest",
        publicUrl: location.origin,
        folder: { name: "Notes", permission: "view" },
        entries,
        document: { id: "b" },
      });
    if (url === "/api/tree?token=folder-token") return response({ entries });
    throw Error("Unexpected request " + url);
  };
  const hook = renderHook(() => useWorkspace());
  await waitFor(() => assert.equal(hook.result.current.id, "b"));
  assert.equal(paths[0], "/api/open/folder-token?doc=b");
  assert.equal(hook.result.current.foldersOpen, true);
  assert.equal(hook.result.current.entries.length, 3);
  await act(() => hook.result.current.navigate("b", "a", async () => {}));
  assert.equal(location.pathname, "/s/folder-token");
  assert.equal(location.search, "?doc=a");
  assert.equal(hook.result.current.initialDocument, null);
  await act(() => hook.result.current.loadTree());
  assert.ok(paths.includes("/api/tree?token=folder-token"));
});

test("an empty shared folder settles and can pick up the first new file", async () => {
  let current = [];
  globalThis.fetch = async (input) =>
    String(input).startsWith("/api/open/")
      ? response({
          owner: false,
          root: "",
          guest: "guest",
          publicUrl: location.origin,
          folder: { name: "Empty", permission: "edit" },
          entries: [],
          document: null,
        })
      : response({ entries: current });
  const hook = renderHook(() => useWorkspace());
  await waitFor(() =>
    assert.equal(hook.result.current.config?.folder.name, "Empty"),
  );
  assert.equal(hook.result.current.id, null);
  assert.equal(hook.result.current.error, "");
  current = [{ kind: "file", path: "new.md", id: "new", shared: true }];
  await act(() => hook.result.current.loadTree());
  assert.equal(hook.result.current.id, "new");
});

test("folder sharing has a separate accessible target and does not toggle the folder", () => {
  let toggled = 0,
    shared = "";
  render(
    <DocumentSidebar
      entries={entries}
      id="b"
      query=""
      scope="all"
      collapsed={new Set()}
      toggleFolder={() => toggled++}
      choose={() => {}}
      foldersOpen
      setFoldersOpen={() => {}}
      shareFolder={(path) => (shared = path)}
    />,
  );
  const button = screen.getByRole("button", { name: "Share folder Design" });
  assert.equal(button.parentElement.closest("button"), null);
  fireEvent.click(button);
  assert.equal(shared, "Design");
  assert.equal(toggled, 0);
});

test("a late folder access read cannot populate a different folder dialog", async () => {
  let release;
  globalThis.fetch = async (input) => {
    if (String(input).includes("path=First"))
      return await new Promise(
        (resolve) =>
          (release = () =>
            resolve(
              response({
                permission: "edit",
                shareUrl: "http://localhost/s/first",
              }),
            )),
      );
    return response({
      permission: "view",
      shareUrl: "http://localhost/s/second",
    });
  };
  const view = render(
    <FolderShare
      key="First"
      path="First"
      name="Owner"
      onChanged={async () => {}}
    />,
  );
  await waitFor(() => assert.ok(release));
  view.rerender(
    <FolderShare
      key="Second"
      path="Second"
      name="Owner"
      onChanged={async () => {}}
    />,
  );
  await waitFor(() =>
    assert.equal(
      screen.getByLabelText("Public URL").value,
      "http://localhost/s/second",
    ),
  );
  await act(async () => release());
  assert.equal(
    screen.getByLabelText("Public URL").value,
    "http://localhost/s/second",
  );
});

test("failed permission mutations retain the previous grant and allow a retry", async () => {
  let fail = true,
    changed = 0;
  globalThis.fetch = async (input, init = {}) => {
    if (init.method === "POST")
      return fail
        ? new Response(
            JSON.stringify({ error: "Storage temporarily unavailable" }),
            { status: 503 },
          )
        : response({
            permission: "edit",
            shareUrl: "http://localhost/s/updated",
          });
    return response({
      permission: "view",
      shareUrl: "http://localhost/s/original",
    });
  };
  render(
    <FolderShare
      path="Notes"
      name="Owner"
      onChanged={async () => {
        changed++;
      }}
    />,
  );
  await waitFor(() =>
    assert.equal(screen.getByLabelText("Link access").value, "view"),
  );
  fireEvent.change(screen.getByLabelText("Link access"), {
    target: { value: "edit" },
  });
  await waitFor(() =>
    assert.match(screen.getByRole("alert").textContent, /Storage/),
  );
  assert.equal(screen.getByLabelText("Link access").value, "view");
  assert.equal(changed, 0);
  fail = false;
  fireEvent.change(screen.getByLabelText("Link access"), {
    target: { value: "edit" },
  });
  await waitFor(() =>
    assert.equal(
      screen.getByLabelText("Public URL").value,
      "http://localhost/s/updated",
    ),
  );
  assert.equal(changed, 1);
});
