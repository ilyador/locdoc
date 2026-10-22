import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React from "react";
import { fileApi } from "./fixtures/file-api.ts";

let render, fireEvent, screen, waitFor, cleanup, act, within;
let useWorkspace, DocumentSidebar, FileActionToast, RecentlyDeleted;
let api: ReturnType<typeof fileApi>;
let workspace;
const copied: string[] = [];

before(async () => {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    url: "http://localhost/",
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
    ({ matches: false, addEventListener() {}, removeEventListener() {} }) as any;
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: async (text: string) => void copied.push(text) },
    configurable: true,
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  ({ render, fireEvent, screen, waitFor, cleanup, act, within } =
    await import("@testing-library/react"));
  ({ useWorkspace } = await import("../src/workspace.ts"));
  ({ DocumentSidebar } = await import("../src/document-sidebar.tsx"));
  ({ FileActionToast } = await import("../src/workspace-feedback.tsx"));
  ({ RecentlyDeleted } = await import("../src/trash.tsx"));
});
afterEach(() => {
  cleanup();
  copied.length = 0;
  for (const key of [
    "locdoc.sidebarView",
    "locdoc.document",
    "locdoc.newDocumentExtension",
  ])
    localStorage.removeItem(key);
});
after(() => window.close());

// The owner's real workspace state around the sidebar, the file toast and the
// announcement region, served by the in-memory contract API.
function Sidebar() {
  workspace = useWorkspace();
  const toggle = (path: string) =>
    workspace.setExpanded((previous: Set<string>) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  return (
    <>
      <DocumentSidebar
        entries={workspace.entries}
        id={workspace.id}
        query={workspace.query}
        view={workspace.sidebarView}
        setView={workspace.setSidebarView}
        expanded={workspace.expanded}
        toggleFolder={toggle}
        choose={(entry) =>
          void workspace.navigate(workspace.id, entry.id, async () => {})
        }
        shareFolder={() => {}}
        fileActions={workspace.files}
        prepare={async () => {}}
      />
      <FileActionToast files={workspace.files} />
      <p data-testid="announcement">{workspace.files.announcement.text}</p>
      {workspace.config?.owner && <RecentlyDeleted files={workspace.files} />}
    </>
  );
}
async function open(
  paths: string[],
  { view = "folders", document = "notes-plan-md", expanded = [] as string[] } = {},
) {
  api = fileApi(paths);
  globalThis.fetch = api.fetch as typeof fetch;
  localStorage.setItem("locdoc.sidebarView", view);
  localStorage.setItem("locdoc.document", document);
  render(<Sidebar />);
  await waitFor(() => assert.ok(workspace.entries.length));
  if (expanded.length)
    act(() => workspace.setExpanded(new Set(expanded)));
}
const tree = () => screen.getByRole("tree");
const row = (path: string) =>
  document.querySelector<HTMLElement>(`[role="treeitem"][data-path="${path}"]`)!;
const rows = () =>
  Array.from(
    document.querySelectorAll<HTMLElement>('[role="treeitem"][data-path]'),
    (element) => element.dataset.path,
  );
const key = (target: Element, key: string, init = {}) =>
  fireEvent.keyDown(target, { key, ...init });
const focused = () => (document.activeElement as HTMLElement)?.dataset?.path;
const toast = () => document.querySelector(".toast-slot")!.textContent || "";
const sends = (method: string) =>
  api.calls.filter((call) => call.method === method);

const workspaceFiles = [
  "Notes/",
  "Notes/Plan.md",
  "Notes/Sub/",
  "Notes/Sub/Deep.fountain",
  "Archive/",
  "a.md",
  "b.txt",
];

test("the folder tree is an ARIA tree with roving focus, arrow keys, Enter and typeahead", async () => {
  await open(workspaceFiles);
  assert.equal(tree().getAttribute("aria-label"), "Folders");
  assert.deepEqual(rows(), ["Archive", "Notes", "a.md", "b.txt"]);
  const tabbable = Array.from(
    document.querySelectorAll('[role="treeitem"][tabindex="0"]'),
  );
  assert.equal(tabbable.length, 1, "Exactly one row takes Tab focus");
  assert.equal(row("Notes").getAttribute("aria-level"), "1");
  assert.equal(row("Notes").getAttribute("aria-setsize"), "4");
  assert.equal(row("Notes").getAttribute("aria-posinset"), "2");
  assert.equal(row("Notes").getAttribute("aria-expanded"), "false");
  row("Archive").focus();
  key(row("Archive"), "ArrowDown");
  assert.equal(focused(), "Notes");
  key(row("Notes"), "ArrowRight");
  assert.equal(row("Notes").getAttribute("aria-expanded"), "true");
  assert.equal(focused(), "Notes", "Right first opens a closed folder");
  assert.deepEqual(rows(), [
    "Archive",
    "Notes",
    "Notes/Sub",
    "Notes/Plan.md",
    "a.md",
    "b.txt",
  ]);
  key(row("Notes"), "ArrowRight");
  assert.equal(focused(), "Notes/Sub", "Right then enters an open folder");
  assert.equal(row("Notes/Sub").getAttribute("aria-level"), "2");
  assert.equal(row("Notes/Sub").getAttribute("tabindex"), "0");
  assert.equal(row("Notes").getAttribute("tabindex"), "-1");
  key(row("Notes/Sub"), "ArrowLeft");
  assert.equal(focused(), "Notes", "Left climbs to the parent folder");
  key(row("Notes"), "ArrowLeft");
  assert.equal(row("Notes").getAttribute("aria-expanded"), "false");
  key(row("Notes"), "End");
  assert.equal(focused(), "b.txt");
  key(row("b.txt"), "Home");
  assert.equal(focused(), "Archive");
  key(row("Archive"), "a");
  assert.equal(focused(), "a.md", "Typing a letter moves to the next match");
  key(row("a.md"), "Enter");
  await waitFor(() => assert.equal(workspace.id, "a-md"));
  assert.equal(row("a.md").getAttribute("aria-current"), "page");
  assert.equal(row("a.md").getAttribute("aria-selected"), "true");
  key(row("a.md"), "ArrowUp");
  assert.equal(focused(), "Notes");
  key(row("Notes"), "Enter");
  assert.equal(row("Notes").getAttribute("aria-expanded"), "true");
});

test("Shift+F10, the menu key and the row button open one menu that returns focus", async () => {
  await open(workspaceFiles, { expanded: ["Notes"] });
  row("Notes/Plan.md").focus();
  key(row("Notes/Plan.md"), "F10", { shiftKey: true });
  const menu = screen.getByRole("menu", { name: "Actions for Plan.md" });
  const labels = within(menu)
    .getAllByRole("menuitem")
    .map((item) => item.querySelector(".context-menu-label")!.textContent);
  assert.deepEqual(labels, [
    "New document…",
    "New folder…",
    "Duplicate",
    "Move to…",
    "Copy path",
    "Copy relative path",
    "Rename…",
    "Delete",
  ]);
  const rename = within(menu).getByRole("menuitem", { name: /Rename/ });
  assert.equal(rename.querySelector("kbd")!.textContent, "F2");
  assert.equal(rename.getAttribute("aria-keyshortcuts"), "F2");
  assert.ok(
    document.activeElement === within(menu).getAllByRole("menuitem")[0],
    "A keyboard menu starts on its first item",
  );
  key(document.activeElement!, "ArrowUp");
  assert.match(document.activeElement!.textContent!, /^Delete/);
  key(document.activeElement!, "Escape");
  assert.ok(screen.queryByRole("menu") === null, "No such element");
  assert.equal(focused(), "Notes/Plan.md");
  key(row("Notes/Plan.md"), "ContextMenu");
  assert.ok(screen.getByRole("menu"));
  key(document.activeElement!, "Tab");
  assert.ok(screen.queryByRole("menu") === null, "No such element");
  assert.equal(focused(), "Notes/Plan.md");
  const more = within(row("Notes")).getByRole("button", {
    name: "More actions for Notes",
  });
  assert.equal(more.getAttribute("tabindex"), "-1");
  fireEvent.click(more, { detail: 1 });
  const folderMenu = screen.getByRole("menu", { name: "Actions for Notes" });
  assert.equal(more.getAttribute("aria-expanded"), "true");
  assert.ok(within(folderMenu).getByRole("menuitem", { name: /Share folder/ }));
  assert.equal(
    within(folderMenu).queryByRole("menuitem", { name: /Duplicate/ }),
    null,
    "Folders cannot be duplicated",
  );
  fireEvent.pointerDown(document.body);
  assert.ok(screen.queryByRole("menu") === null, "No such element");
  assert.equal(row("Notes").getAttribute("aria-expanded"), "true");
});

test("inline creation validates as you type, keeps its text on failure and Escape cancels", async () => {
  await open(workspaceFiles, { expanded: ["Notes"] });
  fireEvent.contextMenu(row("Notes"), { clientX: 40, clientY: 80 });
  fireEvent.click(screen.getByRole("menuitem", { name: /New document/ }));
  const field = screen.getByRole("textbox", { name: "New document name in Notes" });
  assert.ok(document.activeElement === field, "The new name field takes focus");
  assert.ok(
    row("Notes").nextElementSibling === field.closest("li"),
    "The field opens first inside its folder",
  );
  const message = () =>
    document.querySelector(".tree-edit-message")?.textContent || "";
  fireEvent.change(field, { target: { value: ".hidden" } });
  assert.match(message(), /can’t start with a dot/);
  assert.equal(field.getAttribute("aria-invalid"), "true");
  fireEvent.change(field, { target: { value: "a/b" } });
  assert.match(message(), /can’t include \//);
  fireEvent.change(field, { target: { value: "Plan" } });
  assert.equal(message(), "Plan.md already exists here.");
  key(field, "Enter");
  assert.equal(sends("POST").length, 0, "An invalid name is never sent");
  fireEvent.change(field, { target: { value: "Ideas" } });
  assert.equal(message(), "Saved as Ideas.md");
  assert.equal(field.getAttribute("aria-invalid"), null);
  api.fail("POST /api/files", 507, "Disk full");
  key(field, "Enter");
  await waitFor(() => assert.equal(screen.getByRole("alert").textContent, "Disk full"));
  assert.equal(field.value, "Ideas", "A failed request keeps the typed name");
  key(field, "Enter");
  await waitFor(() => assert.ok(screen.queryByRole("textbox") === null, "No such element"));
  assert.deepEqual(
    sends("POST").map((call) => call.body),
    [
      { path: "Notes/Ideas.md", kind: "file" },
      { path: "Notes/Ideas.md", kind: "file" },
    ],
  );
  await waitFor(() => assert.equal(workspace.id, "new-1"));
  assert.ok(rows().includes("Notes/Ideas.md"));
  assert.match(screen.getByTestId("announcement").textContent!, /Created Ideas\.md/);

  row("a.md").focus();
  key(row("a.md"), "F10", { shiftKey: true });
  fireEvent.click(screen.getByRole("menuitem", { name: /New folder/ }));
  const folder = screen.getByRole("textbox", { name: "New folder name" });
  fireEvent.change(folder, { target: { value: "Drafts" } });
  key(folder, "Escape");
  assert.ok(screen.queryByRole("textbox") === null, "No such element");
  assert.equal(sends("POST").length, 2, "Escape cancels without a request");
  assert.equal(focused(), "a.md", "Escape returns focus to the row");
});

test("an inline name with text survives a later New and is never replaced", async () => {
  await open(workspaceFiles);
  act(() => workspace.files.startCreate("folder", ""));
  const field = screen.getByRole("textbox", { name: "New folder name" });
  fireEvent.change(field, { target: { value: "Keep me" } });
  api.fail("POST /api/files", 503, "Try again shortly");
  key(field, "Enter");
  await waitFor(() => assert.ok(screen.getByRole("alert")));
  act(() => workspace.files.startCreate("file", ""));
  assert.equal(screen.getAllByRole("textbox").length, 1);
  assert.equal(
    screen.getByRole("textbox", { name: "New folder name" }).value,
    "Keep me",
  );
});

test("a late create cannot redirect a later choice, and a late rename keeps a later deletion", async () => {
  await open(workspaceFiles);
  act(() => workspace.files.startCreate("file", ""));
  const field = screen.getByRole("textbox", { name: "New document name" });
  fireEvent.change(field, { target: { value: "Later" } });
  const releaseCreate = api.hold("POST /api/files");
  key(field, "Enter");
  await waitFor(() => assert.equal(field.readOnly, true));
  key(row("a.md"), "Enter");
  await waitFor(() => assert.equal(workspace.id, "a-md"));
  await act(async () => {
    releaseCreate();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await waitFor(() => assert.ok(row("Later.md")));
  assert.equal(workspace.id, "a-md", "The finished create did not open itself");

  row("b.txt").focus();
  key(row("b.txt"), "F2");
  const rename = screen.getByRole("textbox", { name: "Rename b.txt" });
  fireEvent.change(rename, { target: { value: "c.txt" } });
  const releaseRename = api.hold("PATCH /api/docs/b-txt");
  key(rename, "Enter");
  await waitFor(() => assert.equal(row("b.txt").getAttribute("aria-busy"), "true"));
  key(row("a.md"), "Delete");
  await waitFor(() => assert.ok(row("a.md") === null, "Deleted while renaming"));
  await act(async () => {
    releaseRename();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await waitFor(() => assert.ok(row("c.txt")));
  assert.ok(row("a.md") === null, "The rename did not bring the deleted row back");
});

test("a waiting name field comes back into view, and one for a vanished item gives way", async () => {
  await open(workspaceFiles);
  row("Notes").focus();
  key(row("Notes"), "F2");
  const field = screen.getByRole("textbox", { name: "Rename Notes" });
  fireEvent.change(field, { target: { value: ".bad" } });
  key(field, "Enter");
  act(() => workspace.setSidebarView("date"));
  assert.ok(screen.queryByRole("textbox") === null, "Folders are not listed by date");
  act(() => workspace.files.startCreate("file"));
  assert.equal(workspace.sidebarView, "folders", "The waiting folder rename shows again");
  assert.equal(screen.getByRole("textbox", { name: "Rename Notes" }).value, ".bad");
  // The folder is deleted elsewhere; its waiting rename no longer blocks.
  await act(async () => {
    await api.fetch("/api/folders", {
      method: "DELETE",
      body: JSON.stringify({ path: "Notes" }),
    });
    await workspace.loadTree();
  });
  act(() => workspace.files.startCreate("folder", ""));
  assert.ok(screen.getByRole("textbox", { name: "New folder name" }));
});

test("F2 renames in place, keeps text on failure, and a stale listing cannot revert it", async () => {
  await open(workspaceFiles, { expanded: ["Notes"] });
  row("Notes/Plan.md").focus();
  key(row("Notes/Plan.md"), "F2");
  const field = screen.getByRole("textbox", { name: "Rename Plan.md" });
  assert.equal(field.value, "Plan.md");
  assert.equal(field.selectionStart, 0);
  assert.equal(field.selectionEnd, 4, "Renaming selects the name, not .md");
  fireEvent.change(field, { target: { value: "Plan.txt" } });
  assert.match(
    document.querySelector(".tree-edit-message")!.textContent!,
    /Opens as plain text/,
  );
  fireEvent.change(field, { target: { value: "Plan v2.md" } });
  api.fail("PATCH /api/docs/notes-plan-md", 409, "That name was just taken.");
  key(field, "Enter");
  await waitFor(() =>
    assert.equal(screen.getByRole("alert").textContent, "That name was just taken."),
  );
  assert.equal(field.value, "Plan v2.md");
  // A listing that started before the rename answers after it.
  const releaseListing = api.hold("GET /api/tree");
  const stale = workspace.loadTree();
  key(field, "Enter");
  await waitFor(() => assert.ok(row("Notes/Plan v2.md")));
  assert.equal(focused(), "Notes/Plan v2.md");
  assert.deepEqual(sends("PATCH").at(-1)!.body, { path: "Notes/Plan v2.md" });
  await act(async () => {
    releaseListing();
    await stale;
  });
  assert.ok(row("Notes/Plan v2.md"), "The stale listing did not undo the rename");
  assert.ok(row("Notes/Plan.md") === null, "The row is gone");
  key(row("Notes/Plan v2.md"), "F2");
  const again = screen.getByRole("textbox", { name: "Rename Plan v2.md" });
  key(again, "Escape");
  assert.equal(focused(), "Notes/Plan v2.md");
  assert.equal(sends("PATCH").length, 2);
});

test("folder renames keep the folder open and move everything inside it", async () => {
  await open(workspaceFiles, { expanded: ["Notes", "Notes/Sub"] });
  row("Notes").focus();
  key(row("Notes"), "F2");
  const field = screen.getByRole("textbox", { name: "Rename Notes" });
  fireEvent.change(field, { target: { value: "Journal" } });
  key(field, "Enter");
  await waitFor(() => assert.ok(row("Journal/Sub/Deep.fountain")));
  assert.deepEqual(sends("PATCH")[0].body, { from: "Notes", to: "Journal" });
  assert.equal(row("Journal").getAttribute("aria-expanded"), "true");
  assert.equal(row("Journal/Sub").getAttribute("aria-expanded"), "true");
});

test("Delete moves to Recently deleted with Undo; a late undo keeps a newer deletion's toast", async () => {
  await open(workspaceFiles);
  row("a.md").focus();
  key(row("a.md"), "Delete");
  await waitFor(() => assert.ok(row("a.md") === null, "The row is gone"));
  assert.equal(sends("DELETE")[0].path, "/api/docs/a-md");
  assert.equal(focused(), "b.txt", "Focus moves to the next row");
  assert.match(toast(), /a\.md moved to Recently deleted\./);
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() => assert.ok(row("a.md")));
  assert.equal(sends("POST").at(-1)!.path, "/api/trash/trash-1/restore");
  assert.match(toast(), /Restored a\.md\./);

  key(row("b.txt"), "Delete");
  await waitFor(() => assert.match(toast(), /b\.txt moved/));
  const releaseRestore = api.hold("POST /api/trash/trash-2/restore");
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() =>
    assert.equal(screen.getByRole("button", { name: "Restoring…" }).disabled, true),
  );
  row("a.md").focus();
  key(row("a.md"), "Delete");
  await waitFor(() => assert.match(toast(), /a\.md moved/));
  await act(async () => {
    releaseRestore();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await waitFor(() => assert.ok(row("b.txt")));
  assert.equal(sends("POST").at(-1)!.path, "/api/trash/trash-2/restore");
  assert.match(toast(), /a\.md moved to Recently deleted\./);
  assert.ok(screen.getByRole("button", { name: "Undo" }), "The newer Undo stays");
  assert.match(screen.getByTestId("announcement").textContent!, /Restored b\.txt/);

  row("b.txt").focus();
  key(row("b.txt"), "z", { ctrlKey: true });
  await waitFor(() => assert.ok(row("a.md")));
  assert.equal(sends("POST").at(-1)!.path, "/api/trash/trash-3/restore");
  assert.equal(api.trash.length, 0);

  // Restoring onto a taken name explains the conflict and keeps the item.
  key(row("a.md"), "Delete");
  await waitFor(() => assert.match(toast(), /a\.md moved/));
  await act(async () => {
    await api.fetch("/api/files", {
      method: "POST",
      body: JSON.stringify({ path: "a.md", kind: "file" }),
    });
  });
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() => assert.match(toast(), /Could not restore a\.md\. a\.md is taken/));
  assert.equal(api.trash.length, 1);
});

test("Ctrl+Z restores the latest deletion after its toast closes, until another change", async () => {
  await open(workspaceFiles);
  const restores = () =>
    api.calls.filter((call) => call.path.endsWith("/restore")).length;
  row("a.md").focus();
  key(row("a.md"), "Delete");
  await waitFor(() => assert.ok(row("a.md") === null, "Deleted"));
  act(() => workspace.files.dismissToast());
  key(row("b.txt"), "z", { ctrlKey: true });
  await waitFor(() => assert.ok(row("a.md")));
  assert.equal(focused(), "a.md", "Undo focuses what it restored");
  key(row("b.txt"), "Delete");
  await waitFor(() => assert.ok(row("b.txt") === null, "Deleted"));
  act(() => workspace.files.dismissToast());
  key(row("a.md"), "F2");
  const field = screen.getByRole("textbox", { name: "Rename a.md" });
  fireEvent.change(field, { target: { value: "c.md" } });
  key(field, "Enter");
  await waitFor(() => assert.ok(row("c.md")));
  key(row("c.md"), "z", { ctrlKey: true });
  await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
  assert.equal(restores(), 1, "A later rename ends the deletion's undo");
  assert.ok(row("b.txt") === null, "b.txt stays in Recently deleted");
});

test("deleting a folder reports its documents and failures leave the tree alone", async () => {
  await open(workspaceFiles);
  api.fail("DELETE /api/folders", 503, "Storage is busy.");
  row("Notes").focus();
  key(row("Notes"), "Delete");
  await waitFor(() => assert.match(toast(), /Could not delete Notes\. Storage is busy\./));
  assert.ok(row("Notes"));
  key(row("Notes"), "Delete");
  await waitFor(() =>
    assert.match(toast(), /Notes and 2 documents moved to Recently deleted\./),
  );
  assert.deepEqual(sends("DELETE").map((call) => call.body), [
    { path: "Notes" },
    { path: "Notes" },
  ]);
  assert.ok(row("Notes") === null, "The row is gone");
});

function transfer() {
  return {
    data: new Map<string, string>(),
    dropEffect: "none",
    effectAllowed: "all",
    types: [] as string[],
    setData(type: string, value: string) {
      this.data.set(type, value);
      this.types.push(type);
    },
    getData(type: string) {
      return this.data.get(type) || "";
    },
  };
}

test("drag and drop moves into folders and the root, and refuses a folder's own descendants", async () => {
  await open(workspaceFiles, { expanded: ["Notes"] });
  const data = transfer();
  fireEvent.dragStart(row("a.md"), { dataTransfer: data });
  assert.equal(row("a.md").classList.contains("dragging"), true);
  const accepted = fireEvent.dragOver(row("Archive"), { dataTransfer: data });
  assert.equal(accepted, false, "A valid target accepts the drop");
  assert.equal(data.dropEffect, "move");
  assert.equal(row("Archive").classList.contains("drop-target"), true);
  fireEvent.drop(row("Archive"), { dataTransfer: data });
  await waitFor(() => assert.ok(row("Archive/a.md")));
  assert.deepEqual(sends("PATCH")[0], {
    method: "PATCH",
    path: "/api/docs/a-md",
    body: { path: "Archive/a.md" },
  });
  assert.equal(row("Archive").getAttribute("aria-expanded"), "true");

  const folder = transfer();
  fireEvent.dragStart(row("Notes"), { dataTransfer: folder });
  assert.equal(
    fireEvent.dragOver(row("Notes/Sub"), { dataTransfer: folder }),
    true,
    "A folder never drops into a folder inside it",
  );
  assert.equal(folder.dropEffect, "none");
  assert.equal(row("Notes/Sub").classList.contains("drop-target"), false);
  assert.equal(
    fireEvent.dragOver(row("Notes/Plan.md"), { dataTransfer: folder }),
    true,
    "A row inside the dragged folder is no target either",
  );
  fireEvent.drop(row("Notes/Sub"), { dataTransfer: folder });
  fireEvent.dragEnd(row("Notes"));
  assert.equal(sends("PATCH").length, 1);

  // Hovering a closed folder opens it.
  const deep = transfer();
  fireEvent.dragStart(row("b.txt"), { dataTransfer: deep });
  fireEvent.dragOver(row("Notes/Sub"), { dataTransfer: deep });
  assert.equal(row("Notes/Sub").getAttribute("aria-expanded"), "false");
  await act(() => new Promise((resolve) => setTimeout(resolve, 700)));
  assert.equal(row("Notes/Sub").getAttribute("aria-expanded"), "true");
  fireEvent.dragEnd(row("b.txt"));

  // The empty part of the tree is the root.
  const sub = transfer();
  fireEvent.dragStart(row("Notes/Sub"), { dataTransfer: sub });
  const body = document.querySelector(".file-tree-body")!;
  fireEvent.dragOver(body, { dataTransfer: sub });
  assert.equal(body.classList.contains("drop-root"), true);
  fireEvent.drop(body, { dataTransfer: sub });
  await waitFor(() => assert.ok(row("Sub")));
  assert.deepEqual(sends("PATCH")[1].body, { from: "Notes/Sub", to: "Sub" });

  // A name already taken at the target is refused without a request.
  await act(async () => {
    await api.fetch("/api/files", {
      method: "POST",
      body: JSON.stringify({ path: "Plan.md", kind: "file" }),
    });
    await workspace.loadTree();
  });
  const taken = transfer();
  fireEvent.dragStart(row("Notes/Plan.md"), { dataTransfer: taken });
  fireEvent.dragOver(body, { dataTransfer: taken });
  fireEvent.drop(body, { dataTransfer: taken });
  await waitFor(() =>
    assert.match(toast(), /Documents already has an item named Plan\.md\./),
  );
  assert.equal(sends("PATCH").length, 2);
  // Files dragged in from elsewhere are not Locdoc moves.
  assert.equal(fireEvent.dragOver(row("Archive"), { dataTransfer: transfer() }), true);
});

test("Move to lists folders, skips the folder itself and moves by keyboard", async () => {
  await open(workspaceFiles, { expanded: ["Notes"] });
  row("Notes/Sub").focus();
  key(row("Notes/Sub"), "F10", { shiftKey: true });
  fireEvent.click(screen.getByRole("menuitem", { name: /Move to/ }));
  const menu = screen.getByRole("menu", { name: "Move Sub to" });
  const choices = within(menu)
    .getAllByRole("menuitem")
    .map((item) => item.textContent);
  assert.deepEqual(choices, ["BackMove Sub to", "Documents", "Archive", "NotesCurrent"]);
  assert.equal(
    within(menu).getByRole("menuitem", { name: /Notes/ }).getAttribute("aria-disabled"),
    "true",
  );
  assert.equal(
    document.activeElement!.textContent,
    "Documents",
    "A nested list starts on its first enabled entry",
  );
  key(document.activeElement!, "ArrowLeft");
  const actions = screen.getByRole("menu", { name: "Actions for Sub" });
  within(actions).getByRole("menuitem", { name: /Move to/ }).focus();
  key(document.activeElement!, "ArrowRight");
  assert.ok(screen.getByRole("menu", { name: "Move Sub to" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
  await waitFor(() => assert.ok(row("Archive/Sub")));
  assert.deepEqual(sends("PATCH")[0].body, { from: "Notes/Sub", to: "Archive/Sub" });
  assert.equal(focused(), "Archive/Sub");
});

test("By date offers only document actions: rename, duplicate, copy paths and delete", async () => {
  await open(workspaceFiles, { view: "date" });
  assert.equal(tree().getAttribute("aria-label"), "Documents by date");
  assert.deepEqual(rows(), ["b.txt", "a.md", "Notes/Sub/Deep.fountain", "Notes/Plan.md"]);
  fireEvent.contextMenu(row("Notes/Plan.md"), { clientX: 20, clientY: 40 });
  assert.deepEqual(
    within(screen.getByRole("menu"))
      .getAllByRole("menuitem")
      .map((item) => item.querySelector(".context-menu-label")!.textContent),
    ["Rename…", "Duplicate", "Copy path", "Copy relative path", "Delete"],
  );
  fireEvent.click(screen.getByRole("menuitem", { name: /^Duplicate/ }));
  await waitFor(() => assert.ok(row("Notes/Plan copy.md")));
  assert.deepEqual(sends("POST")[0], {
    method: "POST",
    path: "/api/docs/notes-plan-md/duplicate",
    body: { path: "Notes/Plan copy.md" },
  });
  assert.equal(focused(), "Notes/Plan copy.md");
  assert.match(screen.getByTestId("announcement").textContent!, /Duplicated as Plan copy\.md/);
  fireEvent.contextMenu(row("Notes/Plan.md"), { clientX: 20, clientY: 40 });
  fireEvent.click(screen.getByRole("menuitem", { name: /^Copy path/ }));
  fireEvent.contextMenu(row("Notes/Plan.md"), { clientX: 20, clientY: 40 });
  fireEvent.click(screen.getByRole("menuitem", { name: /^Copy relative path/ }));
  await waitFor(() =>
    assert.deepEqual(copied, ["/srv/docs/Notes/Plan.md", "Notes/Plan.md"]),
  );
  assert.match(toast(), /Relative path copied\./);
  row("a.md").focus();
  key(row("a.md"), "F2");
  const field = screen.getByRole("textbox", { name: "Rename a.md" });
  fireEvent.change(field, { target: { value: "Alpha" } });
  assert.equal(document.querySelector(".tree-edit-message")!.textContent, "Saved as Alpha.md");
  key(field, "Enter");
  await waitFor(() => assert.ok(row("Alpha.md")));
  // New documents start at the top of By date; folders open the Folders view.
  act(() => workspace.files.startCreate("file"));
  assert.ok(
    document.querySelector("[role=treeitem].tree-create") ===
      tree().firstElementChild,
    "A new document's field opens at the top of By date",
  );
  key(screen.getByRole("textbox"), "Escape");
  act(() => workspace.files.startCreate("folder"));
  assert.equal(workspace.sidebarView, "folders");
  assert.ok(screen.getByRole("textbox", { name: "New folder name" }));
});

test("Recently deleted lists the trash newest first, restores, and keeps a conflict visible", async () => {
  await open(workspaceFiles);
  row("a.md").focus();
  key(row("a.md"), "Delete");
  await waitFor(() => assert.ok(row("a.md") === null, "The row is gone"));
  key(row("b.txt"), "Delete");
  await waitFor(() => assert.ok(row("b.txt") === null, "The row is gone"));
  await act(async () => {
    await api.fetch("/api/files", {
      method: "POST",
      body: JSON.stringify({ path: "a.md", kind: "file" }),
    });
  });
  fireEvent.click(screen.getByText("Recently deleted"));
  await waitFor(() => assert.ok(screen.getByRole("button", { name: "Restore b.txt" })));
  const names = Array.from(document.querySelectorAll(".trash-name strong"), (n) => n.textContent);
  assert.deepEqual(names, ["b.txt", "a.md"]);
  fireEvent.click(screen.getByRole("button", { name: "Restore a.md" }));
  await waitFor(() =>
    assert.match(screen.getByRole("alert").textContent!, /a\.md is taken/),
  );
  assert.ok(screen.getByRole("button", { name: "Restore a.md" }), "The conflict keeps its row");
  fireEvent.click(screen.getByRole("button", { name: "Restore b.txt" }));
  await waitFor(() => assert.ok(screen.queryByRole("button", { name: "Restore b.txt" }) === null, "No such element"));
  await waitFor(() => assert.ok(row("b.txt")));
  assert.match(document.querySelector(".recently-deleted [role=status]")!.textContent!, /Restored to b\.txt/);
});
