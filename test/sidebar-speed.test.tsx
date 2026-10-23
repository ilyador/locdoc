import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React from "react";

// A workspace of hundreds of documents, as the owner's sidebar lists it. The
// sidebar renders again for every change to the workspace, so its work must
// not grow with every row it lists on each render.
let render, cleanup, act;
let DocumentSidebar, useFileActions;
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
  ({ render, cleanup, act } = await import("@testing-library/react"));
  ({ DocumentSidebar } = await import("../src/document-sidebar.tsx"));
  ({ useFileActions } = await import("../src/file-actions.ts"));
});
afterEach(() => cleanup());
after(() => window.close());

const now = Math.floor(Date.now() / 1000);
const names = ["Draft", "draft", "Écrit", "ecrit", "שלום", "Notes", "Plan"];
// Folders of documents whose names sort by number, case and accent, edited
// from a few seconds to a few years ago.
function workspace(count: number) {
  const entries: any[] = [];
  for (let folder = 0; folder < 10; folder++)
    entries.push({
      kind: "folder",
      path: `Folder ${folder}`,
      id: null,
      shared: false,
      title: `Folder ${folder}`,
    });
  for (let n = 0; n < count; n++) {
    const name = `${names[n % names.length]} ${n % 23}`;
    const path =
      n % 4 ? `Folder ${n % 10}/${name} (${n}).md` : `${name} (${n}).md`;
    entries.push({
      kind: "file",
      path,
      id: `doc-${n}`,
      shared: n % 9 === 0,
      modified: now - Math.floor((n * n * 97) % (3 * 365 * 86400)),
      title: path.split("/").pop()!.replace(/\.md$/, ""),
      format: "markdown",
    });
  }
  return entries;
}

function Sidebar({
  entries,
  view,
  id = "doc-3",
}: {
  entries: any[];
  view: "date" | "folders";
  id?: string;
}) {
  const files = useFileActions({
    owner: true,
    root: "/tmp/fixture",
    entries,
    patchEntries() {},
    async loadTree() {},
    currentId: () => "doc-3",
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
        id={id}
        query=""
        view={view}
        setView={() => {}}
        expanded={
          new Set(entries.filter((e) => e.kind === "folder").map((e) => e.path))
        }
        toggleFolder={() => {}}
        choose={() => {}}
        fileActions={files}
        prepare={async () => {}}
      />
    </aside>
  );
}

// Calls of the String and Date methods that build a collator or a date
// format for each call they answer.
function countLocaleCalls() {
  const methods = [
    [String.prototype, "localeCompare"],
    [Date.prototype, "toLocaleDateString"],
    [Date.prototype, "toLocaleString"],
  ] as const;
  const counts: Record<string, number> = {};
  const originals = methods.map(([target, name]) => {
    const original = (target as any)[name];
    counts[name] = 0;
    (target as any)[name] = function (...args: unknown[]) {
      counts[name]++;
      return original.apply(this, args);
    };
    return () => ((target as any)[name] = original);
  });
  return { counts, restore: () => originals.forEach((restore) => restore()) };
}

test("a long workspace lists its rows without building a collator or date format per row", () => {
  const entries = workspace(600);
  for (const view of ["date", "folders"] as const) {
    const calls = countLocaleCalls();
    let page;
    try {
      page = render(<Sidebar entries={entries} view={view} />);
    } finally {
      calls.restore();
    }
    assert.deepEqual(
      calls.counts,
      { localeCompare: 0, toLocaleDateString: 0, toLocaleString: 0 },
      `${view}: formatters are made once and shared by every row`,
    );
    // The labels, titles and order are the ones those methods give.
    const rows = [
      ...page.container.querySelectorAll('[role="treeitem"]'),
    ] as HTMLElement[];
    const listed = rows.map((row) => row.dataset.path);
    const files = entries.filter((e) => e.kind === "file");
    if (view === "date") {
      const expected = [...files]
        .sort((a, b) => b.modified - a.modified || a.path.localeCompare(b.path))
        .map((e) => e.path);
      assert.equal(listed.join("\n"), expected.join("\n"), "newest first");
    } else {
      const title = (e: any) => e.title;
      const order = (list: any[]) =>
        [...list].sort(
          (a, b) =>
            Number(b.kind === "folder") - Number(a.kind === "folder") ||
            title(a).localeCompare(title(b), undefined, {
              numeric: true,
              sensitivity: "base",
            }) ||
            a.path.localeCompare(b.path),
        );
      const parent = (path: string) => path.split("/").slice(0, -1).join("/");
      const expected: string[] = [];
      for (const top of order(entries.filter((e) => !parent(e.path)))) {
        expected.push(top.path);
        if (top.kind === "folder")
          for (const child of order(
            entries.filter((e) => parent(e.path) === top.path),
          ))
            expected.push(child.path);
      }
      assert.equal(
        listed.join("\n"),
        expected.join("\n"),
        "folders first, by name",
      );
    }
    for (const row of rows.filter((row) => row.classList.contains("file"))) {
      const entry = files.find((e) => e.path === row.dataset.path)!;
      const date = new Date(entry.modified * 1000);
      const time = row.querySelector("time")!;
      const age = now - entry.modified;
      const label =
        age < 3600
          ? null
          : age >= 30 * 86400
            ? date.toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                ...(date.getFullYear() !== new Date().getFullYear()
                  ? { year: "numeric" }
                  : {}),
              })
            : null;
      if (label) assert.equal(time.textContent, label, entry.path);
      assert.equal(
        time.getAttribute("title"),
        date.toLocaleString(),
        entry.path,
      );
      assert.equal(
        time.getAttribute("datetime"),
        date.toISOString(),
        entry.path,
      );
    }
    cleanup();
  }
});

// An entry whose row counts how often it renders: only a row reads whether
// its document is shared. React's development build compares the enumerable
// fields of changed props, so this one is not enumerable.
function counted(entry: any, renders: { count: number }) {
  const { shared, ...rest } = entry;
  return Object.defineProperty(rest, "shared", {
    enumerable: false,
    get() {
      renders.count++;
      return shared;
    },
  });
}

test("the sidebar renders again only the rows whose document or place changed", () => {
  for (const view of ["date", "folders"] as const) {
    const renders = { count: 0 };
    const entries = workspace(300).map((entry) => counted(entry, renders));
    const documents = entries.filter((e) => e.kind === "file");
    const page = render(<Sidebar entries={entries} view={view} />);
    assert.equal(renders.count, documents.length, `${view}: each row renders`);
    renders.count = 0;
    // The open document's workspace renders as its status or people change.
    page.rerender(<Sidebar entries={entries} view={view} />);
    assert.equal(renders.count, 0, `${view}: no row renders for it`);
    // A listing in which the newest document was saved again keeps the
    // other entries, as the workspace keeps them.
    const newest = documents.reduce((a, b) =>
      b.modified > a.modified ? b : a,
    );
    const saved = counted(
      { ...newest, shared: false, modified: newest.modified + 5 },
      renders,
    );
    renders.count = 0;
    const next = entries.map((entry) => (entry === newest ? saved : entry));
    page.rerender(<Sidebar entries={next} view={view} />);
    assert.equal(renders.count, 1, `${view}: only the saved document's row`);
    const row = [...page.container.querySelectorAll('[role="treeitem"]')].find(
      (item) => item.dataset.path === saved.path,
    );
    assert.equal(
      row.querySelector("time").getAttribute("datetime"),
      new Date(saved.modified * 1000).toISOString(),
    );
    renders.count = 0;
    page.rerender(<Sidebar entries={next} view={view} id="doc-5" />);
    assert.equal(
      renders.count,
      2,
      `${view}: opening a document renders the row it leaves and the one it opens`,
    );
    assert.equal(
      page.container.querySelector('[aria-current="page"]').dataset.path,
      documents.find((e) => e.id === "doc-5").path,
    );
    cleanup();
  }
});

test("a document's time moves on as time passes, without another change", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const second = Math.floor(Date.now() / 1000);
  const entries = [
    {
      kind: "file",
      path: "Fresh.md",
      id: "fresh",
      shared: false,
      modified: second - 30,
      title: "Fresh",
    },
    {
      kind: "file",
      path: "Older.md",
      id: "older",
      shared: false,
      modified: second - 3570,
      title: "Older",
    },
  ];
  render(<Sidebar entries={entries} view="date" id="fresh" />);
  const time = (path: string) =>
    document.querySelector(`[data-path="${path}"] time`)!.textContent;
  assert.equal(time("Fresh.md"), "now");
  assert.equal(time("Older.md"), "59m ago");
  act(() => t.mock.timers.tick(31_000));
  assert.equal(time("Fresh.md"), "1m ago", "the minute is shown as it passes");
  act(() => t.mock.timers.tick(60_000));
  assert.equal(time("Fresh.md"), "2m ago");
  assert.equal(time("Older.md"), "1h ago");
});
