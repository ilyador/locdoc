import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React from "react";

let dom, render, renderHook, fireEvent, screen, waitFor, cleanup, act;
let useWorkspace, DocumentSidebar, SidebarResize, FolderShare, WorkspaceSidebar;
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
  window.PointerEvent = window.MouseEvent;
  globalThis.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
    }
    observe(target) {
      this.callback([{ target }]);
    }
    disconnect() {}
  };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  ({ render, renderHook, fireEvent, screen, waitFor, cleanup, act } =
    await import("@testing-library/react"));
  ({ useWorkspace } = await import("../src/workspace.ts"));
  ({ DocumentSidebar } = await import("../src/document-sidebar.tsx"));
  ({ SidebarResize } = await import("../src/sidebar-resize.tsx"));
  ({ FolderShare } = await import("../src/sharing.tsx"));
  ({ WorkspaceSidebar } = await import("../src/workspace-sidebar.tsx"));
});
afterEach(() => {
  cleanup();
  localStorage.removeItem("locdoc.sidebarView");
  localStorage.removeItem("locdoc.sidebarWidth");
  localStorage.removeItem("locdoc.sidebar");
});
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
  assert.equal(hook.result.current.sidebarView, "folders");
  assert.equal(hook.result.current.entries.length, 3);
  assert.equal(hook.result.current.expanded.size, 0);
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

test("the selected sidebar view survives navigation and a new workspace mount", async () => {
  globalThis.fetch = async () =>
    response({
      owner: false,
      root: "",
      guest: "guest",
      publicUrl: location.origin,
      folder: { name: "Notes", permission: "view" },
      entries,
      document: { id: "b" },
    });
  const first = renderHook(() => useWorkspace());
  await waitFor(() => assert.equal(first.result.current.id, "b"));
  act(() => first.result.current.setSidebarView("date"));
  act(() => first.result.current.setSidebarWidth(390));
  await act(() => first.result.current.navigate("b", "a", async () => {}));
  assert.equal(first.result.current.sidebarView, "date");
  assert.equal(localStorage.getItem("locdoc.sidebarView"), "date");
  first.unmount();
  const second = renderHook(() => useWorkspace());
  await waitFor(() =>
    assert.equal(second.result.current.config?.folder.name, "Notes"),
  );
  assert.equal(second.result.current.sidebarView, "date");
  assert.equal(second.result.current.sidebarWidth, 390);
  act(() => second.result.current.setSidebarWidth(null));
  assert.equal(localStorage.getItem("locdoc.sidebarWidth"), null);
});

test("folders and their descendants start closed", () => {
  const props = {
    id: "a",
    query: "",
    view: "folders",
    setView() {},
    expanded: new Set<string>(),
    toggleFolder() {},
    choose() {},
  };
  const tree = render(<DocumentSidebar {...props} entries={nestedEntries} />);
  assert.deepEqual(visiblePaths(), ["Design", "Empty", "root.md"]);
  assert.equal(
    document.querySelector('[title="Design"]').getAttribute("aria-expanded"),
    "false",
  );
  tree.rerender(
    <DocumentSidebar
      {...props}
      entries={nestedEntries}
      expanded={new Set(["Design"])}
    />,
  );
  assert.deepEqual(visiblePaths(), [
    "Design",
    "Design/Nested",
    "Design/z.md",
    "Empty",
    "root.md",
  ]);
  assert.equal(
    document
      .querySelector('[title="Design/Nested"]')
      .getAttribute("aria-expanded"),
    "false",
  );
});

test("sidebar resizing previews without committing each move, clamps, cancels and resets", () => {
  const app = document.createElement("div");
  app.className = "app";
  const sidebar = document.createElement("aside");
  app.append(sidebar);
  document.body.append(app);
  sidebar.getBoundingClientRect = () => ({ width: 280 });
  const widths = [];
  render(<SidebarResize onResize={(value) => widths.push(value)} />, {
    container: sidebar,
  });
  const handle = screen.getByRole("separator", { name: "Resize sidebar" });
  handle.setPointerCapture = () => {};
  handle.releasePointerCapture = () => {};
  fireEvent.pointerDown(handle, { button: 0, clientX: 280 });
  fireEvent.pointerMove(handle, { clientX: 390 });
  assert.equal(app.style.getPropertyValue("--sidebar-custom-width"), "390px");
  assert.deepEqual(widths, []);
  fireEvent.pointerUp(handle);
  assert.deepEqual(widths, [390]);
  assert.equal(app.classList.contains("sidebar-resizing"), false);
  fireEvent.pointerDown(handle, { button: 0, clientX: 390 });
  fireEvent.pointerMove(handle, { clientX: 2000 });
  assert.equal(app.style.getPropertyValue("--sidebar-custom-width"), "600px");
  fireEvent.pointerCancel(handle);
  assert.equal(app.style.getPropertyValue("--sidebar-custom-width"), "390px");
  assert.deepEqual(widths, [390]);
  fireEvent.pointerDown(handle, { button: 0, clientX: 390 });
  fireEvent.pointerMove(handle, { clientX: -1000 });
  assert.equal(app.style.getPropertyValue("--sidebar-custom-width"), "220px");
  fireEvent.keyDown(handle, { key: "Escape" });
  assert.equal(app.style.getPropertyValue("--sidebar-custom-width"), "390px");
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  fireEvent.keyDown(handle, { key: "Home" });
  fireEvent.keyDown(handle, { key: "End" });
  fireEvent.doubleClick(handle);
  assert.deepEqual(widths, [390, 290, 220, 600, null]);
  assert.equal(app.style.getPropertyValue("--sidebar-custom-width"), "");
  app.remove();
});

const nestedEntries = [
  { kind: "file", path: "root.md", id: "root", shared: false, modified: 100 },
  { kind: "file", path: "Design/z.md", id: "z", shared: false, modified: 300 },
  { kind: "folder", path: "Design/Nested", id: null, shared: false },
  {
    kind: "file",
    path: "Design/Nested/a.fountain",
    id: "a",
    shared: true,
    modified: 200,
  },
  { kind: "folder", path: "Empty", id: null, shared: false },
  { kind: "folder", path: "Design", id: null, shared: false },
];

function SidebarFixture() {
  const [view, setView] = React.useState("date");
  const [expanded, setExpanded] = React.useState(
    new Set(["Design", "Design/Nested", "Empty"]),
  );
  const [query, setQuery] = React.useState("");
  const [chosen, setChosen] = React.useState("");
  return (
    <>
      <input
        aria-label="Search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <output aria-label="Chosen file">{chosen}</output>
      <DocumentSidebar
        entries={nestedEntries}
        id="a"
        query={query}
        view={view}
        setView={setView}
        expanded={expanded}
        toggleFolder={(path) => {
          const next = new Set(expanded);
          if (next.has(path)) next.delete(path);
          else next.add(path);
          setExpanded(next);
        }}
        choose={(entry) => setChosen(entry.id)}
      />
    </>
  );
}

const visiblePaths = () =>
  Array.from(document.querySelectorAll(".file-tree .tree-item"), (button) =>
    button.getAttribute("title"),
  );

test("date and folder tabs show each file once with distinct ordering and keyboard selection", () => {
  render(<SidebarFixture />);
  assert.deepEqual(visiblePaths(), [
    "Design/z.md",
    "Design/Nested/a.fountain",
    "root.md",
  ]);
  const dateTab = screen.getByRole("tab", { name: "By date" });
  const folderTab = screen.getByRole("tab", { name: "Folders" });
  fireEvent.keyDown(dateTab, { key: "ArrowRight" });
  assert.equal(folderTab.getAttribute("aria-selected"), "true");
  assert.ok(
    document.activeElement === folderTab,
    "Arrow navigation focuses the selected tab.",
  );
  assert.equal(
    screen.getByRole("tabpanel").getAttribute("aria-labelledby"),
    folderTab.id,
  );
  assert.deepEqual(visiblePaths(), [
    "Design",
    "Design/Nested",
    "Design/Nested/a.fountain",
    "Design/z.md",
    "Empty",
    "root.md",
  ]);
  fireEvent.click(document.querySelector('[title="Design/Nested/a.fountain"]'));
  assert.equal(screen.getByLabelText("Chosen file").textContent, "a");
  fireEvent.keyDown(folderTab, { key: "Home" });
  assert.equal(dateTab.getAttribute("aria-selected"), "true");
  assert.deepEqual(visiblePaths(), [
    "Design/z.md",
    "Design/Nested/a.fountain",
    "root.md",
  ]);
  assert.equal(screen.queryByText("All documents"), null);
  assert.equal(screen.queryByText("Shared with others"), null);
});

test("folder search reveals matching ancestors, supports collapse, and preserves the normal tree", () => {
  render(<SidebarFixture />);
  fireEvent.click(screen.getByRole("tab", { name: "Folders" }));
  fireEvent.click(document.querySelector('[title="Design"]'));
  assert.deepEqual(visiblePaths(), ["Design", "Empty", "root.md"]);
  fireEvent.change(screen.getByLabelText("Search"), {
    target: { value: "a.fountain" },
  });
  assert.deepEqual(visiblePaths(), [
    "Design",
    "Design/Nested",
    "Design/Nested/a.fountain",
  ]);
  fireEvent.click(document.querySelector('[title="Design/Nested"]'));
  assert.deepEqual(visiblePaths(), ["Design", "Design/Nested"]);
  fireEvent.change(screen.getByLabelText("Search"), {
    target: { value: "z.md" },
  });
  assert.deepEqual(visiblePaths(), ["Design", "Design/z.md"]);
  fireEvent.click(screen.getByRole("tab", { name: "By date" }));
  assert.deepEqual(visiblePaths(), ["Design/z.md"]);
  fireEvent.change(screen.getByLabelText("Search"), {
    target: { value: "missing" },
  });
  assert.ok(screen.getByText("No matching documents."));
  fireEvent.click(screen.getByRole("tab", { name: "Folders" }));
  assert.ok(screen.getByText("No matching documents."));
  fireEvent.change(screen.getByLabelText("Search"), { target: { value: "" } });
  assert.deepEqual(visiblePaths(), ["Design", "Empty", "root.md"]);
});

test("folder sharing has a separate accessible target and does not toggle the folder", () => {
  let toggled = 0,
    shared = "";
  render(
    <DocumentSidebar
      entries={entries}
      id="b"
      query=""
      view="folders"
      setView={() => {}}
      expanded={new Set()}
      toggleFolder={() => toggled++}
      choose={() => {}}
      shareFolder={(path) => (shared = path)}
    />,
  );
  const button = screen.getByRole("button", { name: "Share folder Design" });
  assert.ok(
    button.parentElement.closest("button") === null,
    "Folder sharing must not nest buttons.",
  );
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

test("a folder link visitor's tree keeps its place and keyboard focus as the next document opens", async () => {
  const shared = Array.from({ length: 30 }, (_, n) => ({
    kind: "file",
    path: `Shared ${String(n).padStart(2, "0")}.md`,
    id: `shared-${n}`,
    shared: true,
    modified: 1000 + n,
  }));
  globalThis.fetch = async (input) =>
    String(input).startsWith("/api/open/")
      ? response({
          owner: false,
          root: "",
          guest: "guest",
          publicUrl: location.origin,
          folder: { name: "Notes", permission: "view" },
          entries: shared,
          document: { id: "shared-29" },
        })
      : response({ entries: shared });
  localStorage.setItem("locdoc.sidebarView", "date");
  let workspace;
  // Like WorkspaceView, which mounts a new DocumentWorkspace, and with it the
  // sidebar, for every document.
  function Visitor() {
    workspace = useWorkspace();
    return (
      <WorkspaceSidebar
        key={workspace.id || "empty"}
        workspace={workspace}
        doc={null}
        filename=""
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
  render(<Visitor />);
  const row = (path) =>
    document.querySelector(`[role="treeitem"][data-path="${path}"]`);
  const list = () => document.querySelector(".file-tree");
  await waitFor(() => assert.ok(row("Shared 10.md")));
  assert.equal(document.querySelectorAll(".tree-more").length, 0, "No file actions");
  row("Shared 10.md").focus();
  list().scrollTop = 420;
  fireEvent.keyDown(row("Shared 10.md"), { key: "Enter" });
  await waitFor(() => assert.equal(workspace.id, "shared-10"));
  await waitFor(() =>
    assert.equal(row("Shared 10.md").getAttribute("aria-current"), "page"),
  );
  assert.ok(
    document.activeElement === row("Shared 10.md"),
    "The opened row keeps keyboard focus",
  );
  assert.equal(list().scrollTop, 420, "The list stays where it was");
  fireEvent.keyDown(row("Shared 10.md"), { key: "ArrowDown" });
  assert.ok(
    document.activeElement === row("Shared 09.md"),
    "The arrow keys go on from there",
  );
});
