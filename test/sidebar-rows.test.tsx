import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import React from "react";

// jsdom applies no layout and only matches screen media, so these tests read
// the cascade the app stylesheet gives each part of a row: as written for a
// desktop with a fine pointer, and with the touch and narrow rules applied.
const stylesheet = readFileSync(
  new URL("../src/style.css", import.meta.url),
  "utf8",
);
const touch = stylesheet.replace(/@media ([^{]+)\{/g, (rule, query) =>
  /pointer: coarse|max-width: 760px/.test(query) && !/min-width/.test(query)
    ? "@media screen {"
    : rule,
);

let render, cleanup;
let DocumentSidebar, useFileActions;
let style: HTMLStyleElement;
before(async () => {
  const dom = new JSDOM(
    "<!doctype html><html><head><style></style></head><body></body></html>",
    { url: "http://localhost/", pretendToBeVisual: true },
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
  style = document.querySelector("style")!;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  ({ render, cleanup } = await import("@testing-library/react"));
  ({ DocumentSidebar } = await import("../src/document-sidebar.tsx"));
  ({ useFileActions } = await import("../src/file-actions.ts"));
});
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-keyboard-open");
});
after(() => window.close());

const entries = [
  { id: null, path: "Notes", kind: "folder", shared: false },
  {
    id: "trip",
    path: "Notes/Renamed outline for the trip.md",
    kind: "file",
    shared: true,
    modified: 1_700_000_000,
  },
  {
    id: "list",
    path: "Shopping list.txt",
    kind: "file",
    shared: false,
    modified: 1_700_000_100,
  },
];

function Sidebar({ view }: { view: "date" | "folders" }) {
  const files = useFileActions({
    owner: true,
    root: "/tmp/fixture",
    entries,
    patchEntries() {},
    async loadTree() {},
    currentId: () => "trip",
    navigate: async () => true,
    setExpanded() {},
    view,
    setView() {},
    setQuery() {},
    setSidebar() {},
  });
  return (
    <aside className="sidebar">
      <DocumentSidebar
        entries={entries}
        id="trip"
        query=""
        view={view}
        setView={() => {}}
        expanded={new Set(["Notes"])}
        toggleFolder={() => {}}
        choose={() => {}}
        shareFolder={() => {}}
        fileActions={files}
        prepare={async () => {}}
      />
      <button className="new-doc">New document</button>
      <div className="sidebar-bottom">Workspace information</div>
    </aside>
  );
}

function rowStyles(view: "date" | "folders", path: string) {
  const page = render(<Sidebar view={view} />);
  const row = page.container.querySelector(`[data-path="${path}"]`)!;
  // Folder rows have no time, and only By date rows show a folder.
  const css = (selector: string) => {
    const element = row.querySelector(selector);
    return element ? getComputedStyle(element) : null;
  };
  return {
    row: getComputedStyle(row),
    name: css(".doc-name")!,
    label: css(".doc-label")!,
    meta: css(".doc-meta")!,
    actions: css(".tree-actions")!,
    more: row.querySelector(".tree-more"),
    path: css("small"),
  };
}

test("on touch and narrow layouts a file title keeps the first line to itself, with every action at hand", () => {
  style.textContent = touch;
  for (const view of ["date", "folders"] as const) {
    const file = rowStyles(view, "Notes/Renamed outline for the trip.md");
    assert.equal(file.row.display, "grid", view);
    assert.equal(
      file.row.gridTemplateAreas.replace(/\s+/g, " "),
      '"icon title title actions" "icon meta path actions"',
      `${view}: the title spans the line beside the icon and More`,
    );
    assert.equal(file.name.display, "contents", view);
    assert.equal(file.label.gridArea, "title", view);
    assert.equal(file.meta.gridArea, "meta", `${view}: time moves under it`);
    if (view === "date")
      assert.equal(file.path!.gridArea, "path", "the folder follows the time");
    assert.ok(file.more, `${view}: the row keeps its More button`);
    assert.equal(file.actions.gridArea, "actions", view);
    assert.equal(file.actions.opacity, "1", `${view}: More stays visible`);
    assert.equal(file.actions.pointerEvents, "auto", view);
    cleanup();
  }
  // Folder rows have no time to move and keep their single line.
  const folder = rowStyles("folders", "Notes");
  assert.equal(folder.row.display, "flex");
  assert.equal(folder.actions.opacity, "1");
});

test("the keyboard gives the sidebar's footer space to its scrolling files", () => {
  style.textContent = touch;
  const page = render(<Sidebar view="folders" />);
  const list = page.container.querySelector<HTMLElement>(".file-tree")!;
  const footer = page.container.querySelector<HTMLElement>(".sidebar-bottom")!;
  const create = page.container.querySelector<HTMLElement>(".new-doc")!;
  assert.notEqual(getComputedStyle(footer).display, "none");
  assert.notEqual(getComputedStyle(create).display, "none");
  document.documentElement.setAttribute("data-keyboard-open", "");
  assert.equal(getComputedStyle(footer).display, "none");
  assert.equal(getComputedStyle(create).display, "none");
  assert.equal(getComputedStyle(list).display, "flex");
  assert.equal(getComputedStyle(list).overflowY, "auto");
  document.documentElement.removeAttribute("data-keyboard-open");
  assert.notEqual(getComputedStyle(footer).display, "none", "closing restores the footer");
  assert.notEqual(getComputedStyle(create).display, "none");
});

test("the list keeps its scroll offset when an edited document moves to the top of By date", () => {
  // React keeps the moved row's element and moves the rows above it after it;
  // the browser's scroll anchoring would then follow that row to the top.
  for (const css of [stylesheet, touch]) {
    style.textContent = css;
    for (const view of ["date", "folders"] as const) {
      const page = render(<Sidebar view={view} />);
      const list = page.container.querySelector(".file-tree")!;
      assert.equal(getComputedStyle(list).overflowY, "auto", view);
      assert.equal(getComputedStyle(list).overflowAnchor, "none", view);
      cleanup();
    }
  }
});

test("desktop rows with a fine pointer keep the time beside the title and reveal actions on hover", () => {
  style.textContent = stylesheet;
  for (const view of ["date", "folders"] as const) {
    const file = rowStyles(view, "Notes/Renamed outline for the trip.md");
    assert.equal(file.row.display, "flex", view);
    assert.equal(file.name.display, "inline", view);
    assert.equal(file.meta.marginLeft, "auto", view);
    assert.equal(file.actions.position, "absolute", view);
    assert.equal(file.actions.opacity, "0", view);
    cleanup();
  }
});
