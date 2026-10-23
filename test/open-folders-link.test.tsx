import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React from "react";

// A folder link visitor's open folders. The link's paths start at its
// folder, so its browser keeps them apart from the owner's workspace and
// from every other link.
let render, fireEvent, waitFor, cleanup, act;
let useWorkspace, openFoldersKey, WorkspaceSidebar;
let workspace;
let renders: Set<string>[] = [];
const response = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
const folder = (path: string) => ({
  kind: "folder",
  path,
  id: null,
  shared: true,
});
const file = (path: string, id: string) => ({
  kind: "file",
  path,
  id,
  shared: true,
});
let listed = [];

before(async () => {
  const dom = new JSDOM(
    "<!doctype html><html><head></head><body></body></html>",
    {
      url: "http://localhost/s/folder-token",
      pretendToBeVisual: true,
    },
  );
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
  window.matchMedia = () =>
    ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }) as any;
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as any;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.startsWith("/api/open/folder-token"))
      return response({
        owner: false,
        root: "",
        guest: "guest",
        publicUrl: location.origin,
        folder: { name: "Shared", permission: "view" },
        entries: structuredClone(listed),
        document: null,
      });
    if (url === "/api/tree?token=folder-token")
      return response({ entries: structuredClone(listed) });
    throw new Error(`Unexpected request ${url}`);
  }) as typeof fetch;
  ({ render, fireEvent, waitFor, cleanup, act } =
    await import("@testing-library/react"));
  ({ useWorkspace, openFoldersKey } = await import("../src/workspace.ts"));
  ({ WorkspaceSidebar } = await import("../src/workspace-sidebar.tsx"));
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});
after(() => window.close());

function Visitor() {
  workspace = useWorkspace();
  renders.push(workspace.expanded);
  return (
    <WorkspaceSidebar
      workspace={workspace}
      searchInput={{ current: null }}
      choose={() => {}}
      prepare={async () => {}}
      onCreate={() => {}}
      onShareFolder={() => {}}
      onSettings={() => {}}
    />
  );
}
async function load() {
  renders = [];
  render(<Visitor />);
  await waitFor(() => assert.ok(row("b.md")));
  // What the first listing changed is stored once its effects run.
  await act(async () => {});
}
const row = (path: string) =>
  document.querySelector<HTMLElement>(`[role="treeitem"][data-path="${path}"]`);
const rows = () =>
  Array.from(
    document.querySelectorAll<HTMLElement>('[role="treeitem"][data-path]'),
    (element) => element.dataset.path,
  );
const toggle = (path: string) => fireEvent.click(row(path)!);
const OWNER = "locdoc.openFolders.owner";

test("a folder link's open folders come back for its visitor, apart from the owner's and other links'", async () => {
  listed = [
    folder("Design"),
    file("Design/a.md", "a"),
    folder("Notes"),
    file("Notes/n.md", "n"),
    file("b.md", "b"),
  ];
  const link = openFoldersKey("folder-token");
  const other = openFoldersKey("other-token");
  // The owner's workspace and another link have folders of the same names.
  localStorage.setItem(OWNER, JSON.stringify(["Design"]));
  localStorage.setItem(other, JSON.stringify(["Design", "Notes"]));
  await load();
  assert.deepEqual(rows(), ["Design", "Notes", "b.md"]);
  toggle("Notes");
  assert.equal(localStorage.getItem(link), JSON.stringify(["Notes"]));
  assert.equal(localStorage.getItem(OWNER), JSON.stringify(["Design"]));
  assert.equal(
    localStorage.getItem(other),
    JSON.stringify(["Design", "Notes"]),
  );
  assert.ok(
    Object.keys(localStorage).every((key) => !key.includes("folder-token")),
    "No key holds the link's token",
  );
  cleanup();
  await load();
  assert.ok(renders[0].has("Notes"), "Restored before the link opens");
  assert.deepEqual(rows(), ["Design", "Notes", "Notes/n.md", "b.md"]);
});

test("a folder link forgets the folders its listing no longer has", async () => {
  listed = [
    folder("Design"),
    folder("Design/Old"),
    file("Design/Old/o.md", "o"),
    file("b.md", "b"),
  ];
  const link = openFoldersKey("folder-token");
  localStorage.setItem(link, JSON.stringify(["Design", "Design/Old", "Gone"]));
  await load();
  assert.equal(
    localStorage.getItem(link),
    JSON.stringify(["Design", "Design/Old"]),
    "Opening the link prunes folders it no longer has",
  );
  assert.deepEqual(rows(), ["Design", "Design/Old", "Design/Old/o.md", "b.md"]);
  // The owner removes the folder from the shared one.
  listed = [file("b.md", "b")];
  await act(() => workspace.loadTree());
  assert.deepEqual(rows(), ["b.md"]);
  assert.equal(localStorage.getItem(link), null);
});
