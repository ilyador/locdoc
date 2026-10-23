import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React from "react";
import { fileApi } from "./fixtures/file-api.ts";

// The order of the Folders view: in every folder, the root included, folders
// above documents, each newest first. A folder is as new as the newest
// document anywhere inside it, and one without any comes after the others.
let render, fireEvent, screen, waitFor, cleanup, act, within;
let useWorkspace, DocumentSidebar;
let api: ReturnType<typeof fileApi>;
let workspace;

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
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  ({ render, fireEvent, screen, waitFor, cleanup, act, within } =
    await import("@testing-library/react"));
  ({ useWorkspace } = await import("../src/workspace.ts"));
  ({ DocumentSidebar } = await import("../src/document-sidebar.tsx"));
});
afterEach(() => {
  cleanup();
  for (const key of ["locdoc.sidebarView", "locdoc.document"])
    localStorage.removeItem(key);
});
after(() => window.close());

const name = (path: string) => path.split("/").pop()!;
// Entries as the server lists them: folders have no time of their own.
const folder = (path: string, extra: object = { modified: 0 }) => ({
  kind: "folder",
  path,
  id: null,
  shared: false,
  title: name(path),
  ...extra,
});
const file = (path: string, modified: number) => ({
  kind: "file",
  path,
  id: path.replace(/\W+/g, "-").toLowerCase(),
  shared: false,
  modified,
  title: name(path).replace(/\.md$/, ""),
  format: "markdown",
});
const rows = () =>
  Array.from(
    document.querySelectorAll<HTMLElement>('[role="treeitem"][data-path]'),
    (element) => element.dataset.path,
  );
const row = (path: string) =>
  document.querySelector<HTMLElement>(
    `[role="treeitem"][data-path="${path}"]`,
  )!;
const focused = () => (document.activeElement as HTMLElement)?.dataset?.path;

// A listing as it is, every folder open.
function Listing({
  entries,
  view = "folders",
}: {
  entries: any[];
  view?: string;
}) {
  return (
    <DocumentSidebar
      entries={entries}
      id={null}
      query=""
      view={view}
      setView={() => {}}
      expanded={
        new Set(entries.filter((e) => e.kind === "folder").map((e) => e.path))
      }
      toggleFolder={() => {}}
      choose={() => {}}
    />
  );
}

test("Folders lists folders above documents in every folder, newest first, a folder by the newest document anywhere inside it", () => {
  const entries = [
    folder("Archive"),
    folder("Archive/2019"),
    file("Archive/2019/old.md", 100),
    folder("Projects"),
    folder("Projects/Alpha"),
    file("Projects/Alpha/spec.md", 500),
    folder("Projects/Beta"),
    file("Projects/Beta/notes.md", 900),
    file("Projects/plan.md", 300),
    file("Projects/readme.md", 700),
    folder("Recent"),
    file("Recent/today.md", 850),
    file("a.md", 50),
    file("b.md", 800),
  ];
  const page = render(<Listing entries={entries} />);
  assert.deepEqual(rows(), [
    // Projects' own documents are older than Recent's, but Beta inside it
    // holds the newest change of all.
    "Projects",
    "Projects/Beta",
    "Projects/Beta/notes.md",
    "Projects/Alpha",
    "Projects/Alpha/spec.md",
    "Projects/readme.md",
    "Projects/plan.md",
    "Recent",
    "Recent/today.md",
    "Archive",
    "Archive/2019",
    "Archive/2019/old.md",
    "b.md",
    "a.md",
  ]);
  assert.equal(row("Archive").getAttribute("aria-posinset"), "3");
  assert.equal(row("Archive").getAttribute("aria-setsize"), "5");
  assert.equal(row("Projects/readme.md").getAttribute("aria-posinset"), "3");
  // By date stays a flat list of documents, newest first.
  page.rerender(<Listing entries={entries} view="date" />);
  assert.deepEqual(rows(), [
    "Projects/Beta/notes.md",
    "Recent/today.md",
    "b.md",
    "Projects/readme.md",
    "Projects/Alpha/spec.md",
    "Projects/plan.md",
    "Archive/2019/old.md",
    "a.md",
  ]);
});

test("ties go by name, and folders without a document at any depth follow the others", () => {
  render(
    <Listing
      entries={[
        // Holds only an empty folder, so it is empty too.
        folder("Empty B"),
        folder("Empty B/Inner"),
        // A folder made in this browser, not yet listed by the server.
        folder("Empty A", {}),
        // A listing that has a folder's own time orders the empty ones by it.
        folder("Zeta", { modified: 2000 }),
        folder("Old"),
        file("Old/z.md", 100),
        folder("Folder 10"),
        file("Folder 10/x.md", 400),
        folder("Folder 2"),
        file("Folder 2/y.md", 400),
        file("Note 10.md", 500),
        file("note 3.md", 500),
        file("Note 2.md", 500),
      ]}
    />,
  );
  assert.deepEqual(rows(), [
    "Folder 2",
    "Folder 2/y.md",
    "Folder 10",
    "Folder 10/x.md",
    "Old",
    "Old/z.md",
    "Zeta",
    "Empty A",
    "Empty B",
    "Empty B/Inner",
    "Note 2.md",
    "note 3.md",
    "Note 10.md",
  ]);
});

// The owner's workspace around the sidebar, served by the in-memory API.
function Sidebar() {
  workspace = useWorkspace();
  return (
    <DocumentSidebar
      entries={workspace.entries}
      id={workspace.id}
      query={workspace.query}
      view={workspace.sidebarView}
      setView={workspace.setSidebarView}
      expanded={workspace.expanded}
      toggleFolder={() => {}}
      choose={() => {}}
      fileActions={workspace.files}
      prepare={async () => {}}
    />
  );
}
// Documents are listed with times in the order given here, oldest first.
const workspaceFiles = [
  "Work/",
  "Work/Old/",
  "Work/Old/deep.md",
  "Work/Old/other.md",
  "Work/New/",
  "Work/New/fresh.md",
  "Work/notes.md",
  "Home/",
  "Home/list.md",
  "top.md",
];
async function open() {
  api = fileApi(workspaceFiles);
  globalThis.fetch = api.fetch as typeof fetch;
  localStorage.setItem("locdoc.sidebarView", "folders");
  localStorage.setItem("locdoc.document", "top-md");
  render(<Sidebar />);
  await waitFor(() => assert.ok(workspace.entries.length));
  act(() =>
    workspace.setExpanded(new Set(["Work", "Work/Old", "Work/New", "Home"])),
  );
}
const listed = [
  "Home",
  "Home/list.md",
  "Work",
  "Work/New",
  "Work/New/fresh.md",
  "Work/Old",
  "Work/Old/other.md",
  "Work/Old/deep.md",
  "Work/notes.md",
  "top.md",
];
// The listing after a desktop editor or a collaborator saved deep.md.
const edited = [
  "Work",
  "Work/Old",
  "Work/Old/deep.md",
  "Work/Old/other.md",
  "Work/New",
  "Work/New/fresh.md",
  "Work/notes.md",
  "Home",
  "Home/list.md",
  "top.md",
];
async function edit(path: string, modified = 2000) {
  api.items.find((item) => item.path === path)!.modified = modified;
  await act(() => workspace.loadTree());
}
const sends = (method: string) =>
  api.calls.filter((call) => call.method === method);

test("an edited document moves to the top of its folder, and its folders up through their parents, with the next poll", async () => {
  await open();
  assert.deepEqual(rows(), listed);
  // The owner is on a row the new order moves down.
  row("Home").focus();
  const shown = workspace.entries;
  await edit("Work/Old/deep.md");
  assert.ok(workspace.entries !== shown, "the poll brought the new time");
  assert.deepEqual(rows(), edited);
  for (const path of ["Work", "Work/Old", "Work/New", "Home"])
    assert.equal(
      row(path).getAttribute("aria-expanded"),
      "true",
      `${path} stays open`,
    );
  assert.equal(focused(), "Home", "the row keeps the focus");
  assert.equal(row("Home").getAttribute("tabindex"), "0");
  // An unchanged listing changes nothing.
  const kept = workspace.entries;
  await act(() => workspace.loadTree());
  assert.ok(workspace.entries === kept, "the tree stays as shown");
  assert.deepEqual(rows(), edited);
  // The keyboard goes on from the row in its new place.
  fireEvent.keyDown(row("Home"), { key: "ArrowDown" });
  assert.equal(focused(), "Home/list.md");
});

// Chromium blurs a focused element that moves in the page or leaves it,
// firing blur and focusout first, and lays the page out as it does, with the
// rows it holds at that moment: a list scrolled past their end is pulled
// back. jsdom only drops the focus. These moves and removals happen as they
// do in Chromium, with 42px rows in a 420px list as sidebar-scroll models
// them. React gives the focus and the selection back once its changes are
// in, and runs no handler for the blurs they cause, so a move never commits
// a name field.
function blurOnMove() {
  const node = window.Node.prototype;
  const { insertBefore, appendChild, removeChild } = node;
  let blurs = 0;
  let pulled = 0;
  const blurLeaving = (leaving: Node) => {
    const active = document.activeElement as HTMLElement | null;
    if (!leaving.isConnected || !active || !leaving.contains(active)) return;
    blurs++;
    active.blur();
    const list = document.querySelector<HTMLElement>(".file-tree");
    const rows = list?.querySelectorAll('[role="treeitem"]').length ?? 0;
    const end = Math.max(0, rows * 42 - 420);
    if (list && list.scrollTop > end) {
      pulled++;
      list.scrollTop = end;
    }
  };
  node.insertBefore = function (moved, child) {
    blurLeaving(moved);
    return insertBefore.call(this, moved, child);
  };
  node.appendChild = function (moved) {
    blurLeaving(moved);
    return appendChild.call(this, moved);
  };
  node.removeChild = function (removed) {
    blurLeaving(removed);
    return removeChild.call(this, removed);
  };
  return {
    blurs: () => blurs,
    pulled: () => pulled,
    restore: () =>
      Object.assign(node, { insertBefore, appendChild, removeChild }),
  };
}

for (const mode of ["rename", "create"] as const)
  test(`a ${mode === "rename" ? "rename" : "new document's name"} field keeps its text, selection and focus as an edit moves its row, and still commits`, async () => {
    await open();
    if (mode === "rename") {
      row("Home/list.md").focus();
      fireEvent.keyDown(row("Home/list.md"), { key: "F2" });
    } else act(() => workspace.files.startCreate("file", "Home"));
    const field = screen.getByRole("textbox", {
      name: mode === "rename" ? "Rename list.md" : "New document name in Home",
    });
    fireEvent.change(field, { target: { value: "Shopping" } });
    field.setSelectionRange(3, 5);
    assert.ok(document.activeElement === field);
    const moves = blurOnMove();
    try {
      await edit("Work/Old/deep.md");
      // Anything a blur would have started is under way by now.
      await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    } finally {
      moves.restore();
    }
    assert.deepEqual(rows(), edited, "the edit moved Work's rows above Home's");
    assert.ok(moves.blurs() > 0, "moving its row blurred the field");
    assert.ok(document.activeElement === field, "the field keeps the focus");
    assert.equal(field.value, "Shopping");
    assert.deepEqual([field.selectionStart, field.selectionEnd], [3, 5]);
    assert.equal(
      sends(mode === "rename" ? "PATCH" : "POST").length,
      0,
      "nothing was committed",
    );
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => assert.ok(row("Home/Shopping.md")));
    assert.deepEqual(
      sends(mode === "rename" ? "PATCH" : "POST").map((call) => call.body),
      [
        mode === "rename"
          ? { path: "Home/Shopping.md" }
          : { path: "Home/Shopping.md", kind: "file" },
      ],
    );
  });

test("Move to lists folders by name, whatever the order of the tree", async () => {
  await open();
  await edit("Work/Old/deep.md");
  assert.deepEqual(rows().slice(0, 2), ["Work", "Work/Old"]);
  row("top.md").focus();
  fireEvent.keyDown(row("top.md"), { key: "F10", shiftKey: true });
  fireEvent.click(screen.getByRole("menuitem", { name: /Move to/ }));
  const menu = screen.getByRole("menu", { name: "Move top.md to" });
  assert.deepEqual(
    within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent),
    ["BackMove top.md to", "DocumentsCurrent", "Home", "Work", "New", "Old"],
  );
});

for (const holder of ["row", "rename"] as const)
  test(`the list keeps its offset as an edit moves the ${holder === "row" ? "focused row" : "rename field"} and the chunks after it`, async () => {
    // Two folders of thirty documents, laid out in more than one chunk.
    api = fileApi([
      "Older/",
      ...Array.from(
        { length: 30 },
        (_, n) => `Older/Note ${String(n).padStart(2, "0")}.md`,
      ),
      "Newer/",
      ...Array.from(
        { length: 30 },
        (_, n) => `Newer/Page ${String(n).padStart(2, "0")}.md`,
      ),
    ]);
    globalThis.fetch = api.fetch as typeof fetch;
    localStorage.setItem("locdoc.sidebarView", "folders");
    localStorage.setItem("locdoc.document", "newer-page-00-md");
    render(<Sidebar />);
    await waitFor(() => assert.ok(workspace.entries.length));
    act(() => workspace.setExpanded(new Set(["Older", "Newer"])));
    assert.equal(rows()[0], "Newer");
    row("Older/Note 27.md").focus();
    if (holder === "rename")
      fireEvent.keyDown(row("Older/Note 27.md"), { key: "F2" });
    const focused = document.activeElement;
    const list = document.querySelector<HTMLElement>(".file-tree")!;
    list.scrollTop = 2000;
    const moves = blurOnMove();
    try {
      // Older moves above Newer, and a document under the focused one moves
      // above it: the tree moves the focused row, or the chunk it is in, as
      // it changes the chunks around it.
      await edit("Older/Note 20.md");
    } finally {
      moves.restore();
    }
    assert.deepEqual(rows().slice(0, 3), [
      "Older",
      "Older/Note 20.md",
      "Older/Note 29.md",
    ]);
    assert.ok(moves.pulled() > 0, "the move pulled the list back");
    // A focused row may come back as another element, in another chunk.
    const active = document.activeElement as HTMLElement;
    assert.equal(
      active.closest('[role="treeitem"]')?.getAttribute("data-path"),
      "Older/Note 27.md",
      "the focus stays on its row",
    );
    if (holder === "rename") assert.ok(active === focused, "in its field");
    assert.equal(list.scrollTop, 2000, "the list keeps its offset");
  });
