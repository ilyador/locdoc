import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React from "react";
import { fileApi } from "./fixtures/file-api.ts";

// The folders the owner leaves open in Folders, as this browser remembers
// them across reloads and tabs: the real workspace and sidebar over the
// in-memory file API. A reload is the workspace mounting again.
let render, renderHook, fireEvent, screen, waitFor, cleanup, act;
let useWorkspace, openFoldersKey, WorkspaceSidebar;
let api: ReturnType<typeof fileApi>;
let workspace;
// The open folders each render of the mounted workspace started from.
let renders: Set<string>[] = [];
const KEY = "locdoc.openFolders.owner";

before(async () => {
  const dom = new JSDOM(
    "<!doctype html><html><head></head><body></body></html>",
    {
      url: "http://localhost/",
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
  ({ render, renderHook, fireEvent, screen, waitFor, cleanup, act } =
    await import("@testing-library/react"));
  ({ useWorkspace, openFoldersKey } = await import("../src/workspace.ts"));
  ({ WorkspaceSidebar } = await import("../src/workspace-sidebar.tsx"));
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});
after(() => window.close());

function Tab() {
  workspace = useWorkspace();
  renders.push(workspace.expanded);
  return (
    <WorkspaceSidebar
      workspace={workspace}
      searchInput={{ current: null }}
      choose={(entry) =>
        void workspace.navigate(workspace.id, entry.id, async () => {})
      }
      prepare={async () => {}}
      onCreate={() => {}}
      onShareFolder={() => {}}
      onSettings={() => {}}
    />
  );
}
const files = [
  "Notes/",
  "Notes/Plan.md",
  "Notes/Sub/",
  "Notes/Sub/Deep.fountain",
  "Archive/",
  "Archive/Old.md",
  "a.md",
];
function serve(paths = files) {
  api = fileApi(paths);
  globalThis.fetch = api.fetch as typeof fetch;
}
// The owner's workspace loads, as after a reload, in Folders.
async function load() {
  renders = [];
  localStorage.setItem("locdoc.sidebarView", "folders");
  render(<Tab />);
  await waitFor(() => assert.ok(row("a.md")));
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
const stored = () => JSON.parse(localStorage.getItem(KEY) ?? "null");
const entry = (path: string) =>
  workspace.entries.find((item) => item.path === path);
async function rename(path: string, name: string) {
  row(path)!.focus();
  fireEvent.keyDown(row(path)!, { key: "F2" });
  const field = screen.getByRole("textbox", { name: `Rename ${path}` });
  fireEvent.change(field, { target: { value: name } });
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() => assert.ok(row(name)));
}
// Another application changes the documents folder.
function removeOutside(folder: string) {
  for (const item of api.items.filter(
    (other) => other.path === folder || other.path.startsWith(`${folder}/`),
  ))
    api.items.splice(api.items.indexOf(item), 1);
}

test("open folders come back as they were left after a reload, from the first render", async () => {
  serve();
  await load();
  assert.deepEqual(rows(), ["Archive", "Notes", "a.md"]);
  assert.equal(
    localStorage.getItem(KEY),
    null,
    "Nothing is stored until a folder opens",
  );
  toggle("Notes");
  toggle("Notes/Sub");
  assert.deepEqual(stored(), ["Notes", "Notes/Sub"]);
  cleanup();
  await load();
  assert.ok(
    renders[0].has("Notes") && renders[0].has("Notes/Sub"),
    "Restoration is synchronous, before the tree is listed or painted",
  );
  assert.deepEqual(rows(), [
    "Archive",
    "Notes",
    "Notes/Sub",
    "Notes/Sub/Deep.fountain",
    "Notes/Plan.md",
    "a.md",
  ]);
  assert.equal(row("Notes")!.getAttribute("aria-expanded"), "true");
  assert.deepEqual(stored(), ["Notes", "Notes/Sub"], "Loading writes nothing");
  // Closing is remembered too; a folder inside a closed one stays as it was.
  toggle("Notes");
  assert.deepEqual(stored(), ["Notes/Sub"]);
  cleanup();
  await load();
  assert.deepEqual(rows(), ["Archive", "Notes", "a.md"]);
  toggle("Notes");
  assert.equal(row("Notes/Sub")!.getAttribute("aria-expanded"), "true");
});

test("a folder renamed or moved in Locdoc keeps its open folders under its new path", async () => {
  serve();
  await load();
  toggle("Notes");
  toggle("Notes/Sub");
  await rename("Notes", "Journal");
  await waitFor(() => assert.ok(row("Journal/Sub/Deep.fountain")));
  await waitFor(() => assert.deepEqual(stored(), ["Journal", "Journal/Sub"]));
  // Move to opens the folder it moves into.
  await act(() => workspace.files.move(entry("Journal/Sub"), "Archive"));
  await waitFor(() => assert.ok(row("Archive/Sub/Deep.fountain")));
  await waitFor(() =>
    assert.deepEqual(stored(), ["Archive", "Archive/Sub", "Journal"]),
  );
  cleanup();
  await load();
  assert.deepEqual(rows(), [
    "Archive",
    "Archive/Sub",
    "Archive/Sub/Deep.fountain",
    "Archive/Old.md",
    "Journal",
    "Journal/Plan.md",
    "a.md",
  ]);
});

test("a deleted folder and the folders in it are forgotten, and so are folders gone from the tree", async () => {
  serve();
  // Folders left open on an earlier visit that no longer exist.
  localStorage.setItem(KEY, JSON.stringify(["Gone", "Gone/Deeper", "Notes"]));
  await load();
  assert.deepEqual(stored(), ["Notes"], "The first listing prunes them");
  toggle("Notes/Sub");
  toggle("Archive");
  assert.deepEqual(stored(), ["Archive", "Notes", "Notes/Sub"]);
  row("Notes")!.focus();
  // The listing after it waits: the deletion itself forgets them.
  const release = api.hold("GET /api/tree");
  fireEvent.keyDown(row("Notes")!, { key: "Delete" });
  await waitFor(() => assert.ok(row("Notes") === null, "Notes is deleted"));
  await waitFor(() => assert.deepEqual(stored(), ["Archive"]));
  await act(async () => release());
  // Undo puts the folder back closed, with nothing inside it open.
  act(() => void workspace.files.undo());
  await waitFor(() => assert.ok(row("Notes")));
  assert.equal(row("Notes")!.getAttribute("aria-expanded"), "false");
  toggle("Notes");
  assert.equal(row("Notes/Sub")!.getAttribute("aria-expanded"), "false");
  assert.deepEqual(stored(), ["Archive", "Notes"]);
  // Another application removes a folder, then makes one of that name.
  removeOutside("Archive");
  await act(() => workspace.loadTree());
  assert.ok(row("Archive") === null, "Archive is gone");
  assert.deepEqual(stored(), ["Notes"]);
  api.items.push({
    path: "Archive",
    kind: "folder",
    id: null,
    shared: false,
    modified: 0,
    title: "Archive",
  });
  await act(() => workspace.loadTree());
  assert.equal(row("Archive")!.getAttribute("aria-expanded"), "false");
  removeOutside("Notes");
  await act(() => workspace.loadTree());
  assert.equal(
    localStorage.getItem(KEY),
    null,
    "Nothing open is left to store",
  );
});

test("a listing asked for before a folder opened cannot close it", async () => {
  serve(["Notes/", "Notes/Plan.md", "a.md"]);
  await load();
  toggle("Notes");
  row("Notes/Plan.md")!.focus();
  fireEvent.keyDown(row("Notes/Plan.md")!, { key: "Delete" });
  await waitFor(() =>
    assert.ok(row("Notes/Plan.md") === null, "Plan.md is deleted"),
  );
  removeOutside("Notes");
  await act(() => workspace.loadTree());
  assert.equal(localStorage.getItem(KEY), null);
  // Restoring the document makes its folder again, as the server does, and
  // opens it. A poll asked for before that answers after it.
  const restoring = api.fetch;
  globalThis.fetch = (async (input, init) => {
    const answer = await restoring(input, init);
    if (/\/restore$/.test(String(input)))
      api.items.push({
        path: "Notes",
        kind: "folder",
        id: null,
        shared: false,
        modified: 0,
        title: "Notes",
      });
    return answer;
  }) as typeof fetch;
  const releasePoll = api.hold("GET /api/tree");
  let poll;
  act(() => {
    poll = workspace.loadTree();
  });
  const releaseRefresh = api.hold("GET /api/tree");
  act(() => void workspace.files.undo());
  await waitFor(() => assert.deepEqual(stored(), ["Notes"]));
  await act(async () => {
    releasePoll();
    await poll;
  });
  assert.ok(row("Notes") === null, "The poll's older tree is shown");
  assert.deepEqual(
    stored(),
    ["Notes"],
    "but it judges only folders open when it was asked for",
  );
  await act(async () => releaseRefresh());
  await waitFor(() => assert.ok(row("Notes/Plan.md")));
  assert.equal(row("Notes")!.getAttribute("aria-expanded"), "true");
});

test("the owner's open folders are kept apart from each folder link's", async () => {
  serve();
  const link = openFoldersKey("folder-token");
  assert.notEqual(link, KEY);
  assert.notEqual(openFoldersKey("other-token"), link);
  assert.ok(!link.includes("folder-token"), "A link's key holds no token");
  localStorage.setItem(link, JSON.stringify(["Gone", "Notes"]));
  await load();
  assert.equal(
    row("Notes")!.getAttribute("aria-expanded"),
    "false",
    "A link's open folders do not open the owner's",
  );
  toggle("Archive");
  assert.deepEqual(
    stored(),
    ["Archive"],
    "The owner's go under the owner's key",
  );
  removeOutside("Archive");
  await act(() => workspace.loadTree());
  assert.equal(localStorage.getItem(KEY), null);
  assert.equal(
    localStorage.getItem(link),
    JSON.stringify(["Gone", "Notes"]),
    "The owner's changes and listings leave the link's folders alone",
  );
});

test("storage that refuses or holds a damaged value leaves the tree working as before", async () => {
  serve();
  localStorage.setItem(KEY, JSON.stringify(["Notes"]));
  const storage = window.Storage.prototype;
  const { getItem, setItem, removeItem } = storage;
  const refuse = (method: (...args: any[]) => any) =>
    function (this: Storage, key: string, ...rest: unknown[]) {
      if (String(key).startsWith("locdoc.openFolders"))
        throw new window.DOMException(
          "The operation is insecure.",
          "SecurityError",
        );
      return method.call(this, key, ...rest);
    };
  try {
    storage.getItem = refuse(getItem);
    storage.setItem = refuse(setItem);
    storage.removeItem = refuse(removeItem);
    await load();
    assert.deepEqual(rows(), ["Archive", "Notes", "a.md"]);
    toggle("Notes");
    toggle("Archive");
    assert.equal(row("Notes")!.getAttribute("aria-expanded"), "true");
    toggle("Notes");
    assert.equal(row("Notes")!.getAttribute("aria-expanded"), "false");
    cleanup();
    // Storage that can be read but not written, as when it is full.
    storage.getItem = getItem;
    await load();
    assert.equal(row("Notes")!.getAttribute("aria-expanded"), "true");
    toggle("Archive");
    assert.equal(row("Archive")!.getAttribute("aria-expanded"), "true");
    removeOutside("Notes");
    await act(() => workspace.loadTree());
    assert.deepEqual(rows(), ["Archive", "Archive/Old.md", "a.md"]);
    cleanup();
  } finally {
    Object.assign(storage, { getItem, setItem, removeItem });
  }
  assert.deepEqual(stored(), ["Notes"], "Nothing was written meanwhile");
  // A damaged value opens nothing, and the next change replaces it.
  serve();
  localStorage.setItem(KEY, "{not json");
  await load();
  assert.deepEqual(rows(), ["Archive", "Notes", "a.md"]);
  toggle("Archive");
  assert.deepEqual(stored(), ["Archive"]);
  cleanup();
  localStorage.setItem(
    KEY,
    JSON.stringify([7, null, "", { path: "Archive" }, "Notes"]),
  );
  await load();
  assert.deepEqual(rows(), [
    "Archive",
    "Notes",
    "Notes/Sub",
    "Notes/Plan.md",
    "a.md",
  ]);
});

test("search opens folders for its matches without changing the folders remembered", async () => {
  serve();
  await load();
  toggle("Notes");
  const search = screen.getByRole("textbox", { name: "Find a document" });
  fireEvent.change(search, { target: { value: "deep" } });
  assert.deepEqual(rows(), ["Notes", "Notes/Sub", "Notes/Sub/Deep.fountain"]);
  // Folders opened and closed in the results are the search's own.
  toggle("Notes/Sub");
  assert.deepEqual(rows(), ["Notes", "Notes/Sub"]);
  toggle("Notes");
  assert.deepEqual(rows(), ["Notes"]);
  fireEvent.change(search, { target: { value: "old" } });
  assert.deepEqual(rows(), ["Archive", "Archive/Old.md"]);
  await act(() => workspace.loadTree());
  assert.deepEqual(stored(), ["Notes"]);
  fireEvent.change(search, { target: { value: "" } });
  const normal = ["Archive", "Notes", "Notes/Sub", "Notes/Plan.md", "a.md"];
  assert.deepEqual(rows(), normal);
  assert.deepEqual(stored(), ["Notes"]);
  cleanup();
  await load();
  assert.deepEqual(rows(), normal);
});

test("tabs keep each other's open folders, the last change to a folder wins, and a reload shows them", async () => {
  serve();
  await load();
  toggle("Notes");
  // A second tab loads, then each tab changes other folders.
  const other = renderHook(() => useWorkspace());
  await waitFor(() => assert.ok(other.result.current.entries.length));
  assert.ok(other.result.current.expanded.has("Notes"));
  toggle("Archive");
  assert.ok(
    !other.result.current.expanded.has("Archive"),
    "The other tab shows it once it loads again",
  );
  act(() =>
    other.result.current.setExpanded(
      (open: Set<string>) => new Set([...open, "Notes/Sub"]),
    ),
  );
  assert.deepEqual(stored(), ["Archive", "Notes", "Notes/Sub"]);
  // The second tab moves Notes into Archive. The first tab's next listing
  // no longer finds Notes, and forgets only that.
  await act(() =>
    other.result.current.files.move(
      other.result.current.entries.find((item) => item.path === "Notes"),
      "Archive",
    ),
  );
  assert.deepEqual(stored(), ["Archive", "Archive/Notes", "Archive/Notes/Sub"]);
  await act(() => workspace.loadTree());
  assert.ok(!workspace.expanded.has("Notes"));
  assert.deepEqual(stored(), ["Archive", "Archive/Notes", "Archive/Notes/Sub"]);
  // The first tab closes Archive; the second, which still shows it open,
  // then closes a folder inside it. Archive stays closed.
  toggle("Archive");
  act(() =>
    other.result.current.setExpanded(
      (open: Set<string>) =>
        new Set([...open].filter((path) => path !== "Archive/Notes/Sub")),
    ),
  );
  assert.deepEqual(stored(), ["Archive/Notes"]);
  cleanup();
  await load();
  assert.deepEqual(rows(), ["Archive", "a.md"]);
  toggle("Archive");
  assert.deepEqual(rows(), [
    "Archive",
    "Archive/Notes",
    "Archive/Notes/Sub",
    "Archive/Notes/Plan.md",
    "Archive/Old.md",
    "a.md",
  ]);
});
