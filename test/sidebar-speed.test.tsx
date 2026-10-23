import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import React from "react";

// A workspace of hundreds of documents, as the owner's sidebar lists it. The
// sidebar renders again for every change to the workspace, so its work must
// not grow with every row it lists on each render.
let render, cleanup, act, fireEvent;
let DocumentSidebar, useFileActions;
let treeChunks, keyedChunks, AVERAGE, LONGEST, NEW_ROW;
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
  ({ render, cleanup, act, fireEvent } =
    await import("@testing-library/react"));
  ({ DocumentSidebar } = await import("../src/document-sidebar.tsx"));
  ({ useFileActions } = await import("../src/file-actions.ts"));
  ({ treeChunks, keyedChunks, AVERAGE, LONGEST, NEW_ROW } =
    await import("../src/tree-chunks.ts"));
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
  query = "",
}: {
  entries: any[];
  view: "date" | "folders";
  id?: string;
  query?: string;
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
        query={query}
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
      // A folder is as new as its newest document; a document as itself.
      const latest = (e: any) =>
        e.kind === "folder"
          ? Math.max(
              ...files
                .filter((file) => file.path.startsWith(`${e.path}/`))
                .map((file) => file.modified),
            )
          : e.modified;
      const order = (list: any[]) =>
        [...list].sort(
          (a, b) =>
            Number(b.kind === "folder") - Number(a.kind === "folder") ||
            latest(b) - latest(a) ||
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
        "folders first, then documents, each newest first",
      );
    }
    for (const row of rows.filter((row) => row.classList.contains("file"))) {
      const entry = files.find((e) => e.path === row.dataset.path)!;
      const date = new Date(entry.modified * 1000);
      const time = row.querySelector("time")!;
      // A compact age, which screen readers hear in words.
      const label = time.querySelector('[aria-hidden="true"]')!.textContent!;
      const phrase = time.querySelector(".visually-hidden")!.textContent;
      const [, count, unit] = /^(\d+)(m|h|d|w|mo|y)$/.exec(label) || [];
      const units: Record<string, string> = {
        m: "minute",
        h: "hour",
        d: "day",
        w: "week",
        mo: "month",
        y: "year",
      };
      assert.equal(
        phrase,
        label === "now"
          ? "just now"
          : `${count} ${units[unit]}${count === "1" ? "" : "s"} ago`,
        `${entry.path}: ${label}`,
      );
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
    {
      kind: "file",
      path: "Fortnight.md",
      id: "fortnight",
      shared: false,
      modified: second - 14 * 86400 + 20,
      title: "Fortnight",
    },
    {
      kind: "file",
      path: "Season.md",
      id: "season",
      shared: false,
      modified: second - 63 * 86400 + 20,
      title: "Season",
    },
  ];
  render(<Sidebar entries={entries} view="date" id="fresh" />);
  // The age shown, and the one screen readers hear.
  const time = (path: string) => {
    const element = document.querySelector(`[data-path="${path}"] time`)!;
    return [
      element.querySelector('[aria-hidden="true"]')!.textContent,
      element.querySelector(".visually-hidden")!.textContent,
    ].join(" | ");
  };
  assert.equal(time("Fresh.md"), "now | just now");
  assert.equal(time("Older.md"), "59m | 59 minutes ago");
  assert.equal(time("Fortnight.md"), "13d | 13 days ago");
  assert.equal(time("Season.md"), "8w | 8 weeks ago");
  act(() => t.mock.timers.tick(31_000));
  assert.equal(
    time("Fresh.md"),
    "1m | 1 minute ago",
    "the minute is shown as it passes",
  );
  assert.equal(
    time("Older.md"),
    "1h | 1 hour ago",
    "minutes give way to hours",
  );
  assert.equal(time("Fortnight.md"), "2w | 2 weeks ago", "days to weeks");
  assert.equal(time("Season.md"), "2mo | 2 months ago", "weeks to months");
  act(() => t.mock.timers.tick(60_000));
  assert.equal(time("Fresh.md"), "2m | 2 minutes ago");
  assert.equal(time("Older.md"), "1h | 1 hour ago");
});

// The tree lays its rows out in chunks; a chunk away from the screen skips
// its layout (content-visibility: auto). A browser checks each such chunk on
// every frame and keeps the height a skipped one last had on screen.
const rowsOf = (entries: any[], view: "date" | "folders") =>
  (view === "date"
    ? entries.filter((entry) => entry.kind === "file")
    : entries
  ).map((entry, index, list) => ({
    type: "entry" as const,
    entry,
    depth: 0,
    setsize: list.length,
    posinset: index + 1,
  }));

test("rows are laid out in a few dozen chunks that stay as they were when a row moves", () => {
  const entries = workspace(1100);
  const files = entries.filter((entry) => entry.kind === "file");
  const chunks = treeChunks(rowsOf(entries, "date"), "date");
  assert.ok(
    chunks.length >= files.length / (AVERAGE * 2) &&
      chunks.length <= (files.length / AVERAGE) * 2,
    `${chunks.length} chunks of ${files.length} rows`,
  );
  let next = 0;
  for (const chunk of chunks) {
    assert.equal(chunk.start, next, "every row is in one chunk, in order");
    assert.ok(chunk.size >= 1 && chunk.size <= LONGEST);
    const listed = files.slice(chunk.start, chunk.start + chunk.size);
    assert.equal(chunk.folders, 0);
    assert.equal(
      chunk.paths,
      listed.filter((entry) => entry.path.includes("/")).length,
      "By date counts the rows with a folder line",
    );
    assert.equal(chunk.files + chunk.paths, chunk.size);
    next += chunk.size;
  }
  assert.equal(next, files.length);
  // The document saved last moves from far down to the top: only the chunk
  // it leaves and the one it joins are new; every other keeps its rows.
  const moved = files.splice(700, 1)[0];
  files.unshift(moved);
  const after = treeChunks(rowsOf(files, "date"), "date");
  const rowsIn = (list: typeof chunks, list2: any[]) =>
    new Map(
      list.map((chunk) => [
        chunk.key,
        list2
          .slice(chunk.start, chunk.start + chunk.size)
          .map((entry) => entry.path)
          .join("|"),
      ]),
    );
  const before = rowsIn(
    chunks,
    entries.filter((entry) => entry.kind === "file"),
  );
  const now = rowsIn(after, files);
  const changed = [...now.keys()].filter(
    (key) => before.get(key) !== now.get(key),
  );
  assert.ok(changed.length <= 2, `${changed.length} chunks changed`);
  // Folders counts folders apart from documents, and a view's chunks are its own.
  const folders = treeChunks(rowsOf(entries, "folders"), "folders");
  assert.equal(
    folders.reduce((sum, chunk) => sum + chunk.folders, 0),
    10,
  );
  assert.equal(
    folders.reduce((sum, chunk) => sum + chunk.paths, 0),
    0,
    "Folders shows no folder lines",
  );
  const dateKeys = new Set(chunks.map((chunk) => chunk.key));
  assert.ok(folders.every((chunk) => !dateKeys.has(chunk.key)));
});

test("a chunk is a new element when its rows' heights change, and stays the one it is while it holds a name field or a drag", () => {
  const entries = workspace(200).filter((entry) => entry.kind === "file");
  const rows = rowsOf(entries, "date");
  const chunks = treeChunks(rows, "date");
  // A rename holds its chunk, which is laid out while the field is open.
  const renamed = entries[30].path;
  const renaming = treeChunks(rows, "date", [renamed]);
  const holder = renaming.find((chunk) => chunk.holds)!;
  assert.equal(holder.holds, renamed);
  assert.equal(renaming.filter((chunk) => chunk.holds).length, 1);
  assert.ok(holder.start <= 30 && 30 < holder.start + holder.size);
  assert.deepEqual(
    renaming.map((chunk) => chunk.key),
    chunks.map((chunk) => chunk.key),
    "opening the field changes no element",
  );
  // Listings that change the held chunk's rows keep its element, so the
  // field keeps its caret; a chunk no longer held is keyed by its rows.
  const kept = new Map<string, string>();
  const key = keyedChunks(renaming, kept).find((chunk) => chunk.holds)!.key;
  const shorter = rows.filter((_, index) => index !== holder.start + 1);
  const later = keyedChunks(treeChunks(shorter, "date", [renamed]), kept);
  assert.equal(later.find((chunk) => chunk.holds)!.key, key);
  assert.equal(new Set(later.map((chunk) => chunk.key)).size, later.length);
  const done = keyedChunks(treeChunks(shorter, "date"), kept);
  assert.equal(kept.size, 0);
  assert.notEqual(
    done.find((chunk) => chunk.start === holder.start)!.key,
    key,
    "once the field closes, the chunk's new rows make it new",
  );
  // A drag holds the chunk of the row it started from.
  const dragged = treeChunks(rows, "date", [entries[100].path]);
  assert.equal(dragged.filter((chunk) => chunk.holds).length, 1);
  // A new document's field opens at the top of By date, in the chunk that
  // was there.
  const creating = treeChunks(
    [{ type: "create", depth: 0, parent: "" }, ...rows],
    "date",
  );
  assert.equal(creating[0].holds, NEW_ROW);
  assert.equal(creating[0].key, chunks[0].key);
  assert.equal(creating[0].size, chunks[0].size + 1);
  // A document that gains a folder line changes its chunk's height.
  const nested = entries.map((entry, index) =>
    index === 1 && !entry.path.includes("/")
      ? { ...entry, path: `Moved/${entry.path}` }
      : index === 1
        ? { ...entry, path: entry.path.split("/").pop() }
        : entry,
  );
  const moved = treeChunks(rowsOf(nested, "date"), "date");
  assert.notEqual(moved[0].key, chunks[0].key);
});

test("the tree keeps every row in the page, in chunks that hold their rows' counts", () => {
  const entries = workspace(300);
  const page = render(<Sidebar entries={entries} view="date" />);
  const tree = page.container.querySelector('[role="tree"]')!;
  const chunks = [...tree.children] as HTMLElement[];
  assert.ok(chunks.length > 3 && chunks.length < 300);
  const rows = [...tree.querySelectorAll('[role="treeitem"]')] as HTMLElement[];
  assert.equal(rows.length, 300, "every document has its row");
  for (const chunk of chunks) {
    assert.equal(chunk.getAttribute("role"), "none");
    assert.equal(chunk.firstElementChild!.getAttribute("role"), "none");
    const held = [
      ...chunk.querySelectorAll('[role="treeitem"]'),
    ] as HTMLElement[];
    const paths = held.filter((row) => row.dataset.path!.includes("/")).length;
    assert.equal(chunk.style.getPropertyValue("--paths"), String(paths));
    assert.equal(
      chunk.style.getPropertyValue("--files"),
      String(held.length - paths),
    );
  }
});

// A browser leaves rows in skipped chunks out of its accessibility tree
// until they come near the screen, so no row can count on its neighbours
// for its place: each tells its level, its place among its siblings and
// how many they are.
test("every row in every chunk tells its place and its set's size, wherever the chunk is", () => {
  const entries = workspace(300);
  // A row's set: the rows of its level, and in Folders of its folder too.
  const setOf = (row: HTMLElement) => {
    const level = row.getAttribute("aria-level");
    const path = row.dataset.path!;
    return level === "1"
      ? "1"
      : `${level} ${path.slice(0, path.lastIndexOf("/"))}`;
  };
  const sets = (rows: HTMLElement[]) => {
    const counted = new Map<string, HTMLElement[]>();
    for (const row of rows) {
      assert.ok(
        row.getAttribute("aria-level"),
        `${row.dataset.path} has a level`,
      );
      const set = setOf(row);
      if (!counted.has(set)) counted.set(set, []);
      counted.get(set)!.push(row);
    }
    for (const [set, members] of counted) {
      assert.deepEqual(
        members.map((row) => Number(row.getAttribute("aria-posinset"))),
        members.map((_, index) => index + 1),
        `${set}: places count from 1, in order`,
      );
      assert.ok(
        members.every(
          (row) => Number(row.getAttribute("aria-setsize")) === members.length,
        ),
        `${set}: every row knows its set's size`,
      );
    }
    return counted;
  };
  for (const [view, query, size] of [
    ["date", "", 300],
    ["date", "draft", 86],
    ["folders", "", 0],
    ["folders", "plan", 0],
  ] as const) {
    const page = render(
      <Sidebar entries={entries} view={view} query={query} />,
    );
    const tree = page.container.querySelector('[role="tree"]')!;
    const chunks = [...tree.children] as HTMLElement[];
    assert.ok(chunks.length > 3, `${view} ${query}: the rows are in chunks`);
    // Every row of every chunk, as a browser that skipped all but one
    // chunk would still expose the rows it does.
    const rows = chunks.flatMap(
      (chunk) =>
        [...chunk.querySelectorAll('[role="treeitem"]')] as HTMLElement[],
    );
    const counted = sets(rows);
    if (size)
      assert.deepEqual(
        [...counted.values()].map((members) => members.length),
        [size],
        `${view} ${query}: one set of every listed document`,
      );
    else assert.ok(counted.size > 1, `${view} ${query}: a set per folder`);
    cleanup();
  }
});

test("a focused row that moves into another chunk keeps the focus", () => {
  const entries = workspace(300);
  const page = render(<Sidebar entries={entries} view="date" />);
  const row = (path: string) =>
    [...page.container.querySelectorAll<HTMLElement>('[role="treeitem"]')].find(
      (element) => element.dataset.path === path,
    )!;
  const files = entries.filter((entry) => entry.kind === "file");
  const listed = [
    ...page.container.querySelectorAll<HTMLElement>('[role="treeitem"]'),
  ].map((element) => element.dataset.path!);
  // The row far down the list, saved again, moves to the top of By date.
  const path = listed[250];
  const element = row(path);
  act(() => element.focus());
  assert.ok(document.activeElement === element);
  const saved = files.map((entry) =>
    entry.path === path ? { ...entry, modified: now + 60 } : entry,
  );
  page.rerender(
    <Sidebar
      entries={entries.map(
        (entry) => saved.find((other) => other.path === entry.path) || entry,
      )}
      view="date"
    />,
  );
  const moved = row(path);
  assert.equal(
    page.container
      .querySelector('[role="treeitem"]')!
      .getAttribute("data-path"),
    path,
    "the saved document is listed first",
  );
  assert.ok(moved !== element, "its row is in another chunk now");
  assert.ok(document.activeElement === moved, "and it has the focus");
});

test("a dragged row stays the element the drag started from while listings change around it", () => {
  const entries = workspace(300);
  const page = render(<Sidebar entries={entries} view="folders" />);
  const row = (path: string) =>
    [...page.container.querySelectorAll<HTMLElement>('[role="treeitem"]')].find(
      (element) => element.dataset.path === path,
    )!;
  const listed = [
    ...page.container.querySelectorAll<HTMLElement>('[role="treeitem"]'),
  ].map((element) => element.dataset.path!);
  const path = listed[120];
  const element = row(path);
  const data = {
    effectAllowed: "",
    dropEffect: "",
    setData() {},
    getData: () => "",
    types: [],
  };
  fireEvent.dragStart(element, { dataTransfer: data });
  assert.ok(row(path) === element, "the drag keeps its row");
  assert.ok(element.closest(".tree-chunk")!.classList.contains("live"));
  // Another document of its chunk goes, which changes the chunk's rows.
  const siblings = [
    ...element
      .closest(".tree-chunk")!
      .querySelectorAll<HTMLElement>('[role="treeitem"].file'),
  ].map((other) => other.dataset.path!);
  const gone = siblings.find((other, index) => index > 0 && other !== path)!;
  assert.ok(gone, "the chunk holds another document");
  page.rerender(
    <Sidebar
      entries={entries.filter((entry) => entry.path !== gone)}
      view="folders"
    />,
  );
  assert.equal(row(gone), undefined, "the document is gone");
  assert.ok(row(path) === element, "and the dragged row is the same element");
  // Once the drag ends, the chunk is keyed by its rows again.
  fireEvent.dragEnd(element);
  assert.equal(row(path).classList.contains("dragging"), false);
});

test("a skipped chunk is held at the height of its rows, from the sizes the rows use", () => {
  const css = readFileSync(
    new URL("../src/style.css", import.meta.url),
    "utf8",
  );
  const rule = (selector: string, within = css) => {
    const at = within.indexOf(`\n${selector} {`);
    assert.ok(at >= 0, `${selector} is styled`);
    return within.slice(at, within.indexOf("}", at));
  };
  const value = (block: string, property: string) =>
    new RegExp(`\\s${property}:\\s*([^;]+);`)
      .exec(block)?.[1]
      .replace(/\s+/g, " ")
      .replace(/\( /g, "(")
      .replace(/ \)/g, ")")
      .trim();
  // The lines a row shows: its name, the folder under it in By date, and the
  // time under it on phones, each in its own size at the body's line height.
  const line = value(rule("body"), "line-height");
  assert.equal(line, "1.5");
  const name = value(rule(".tree-item"), "font-size");
  const small = rule(".file-tree .tree-item small");
  assert.equal(value(small, "line-height"), line);
  const caption = value(small, "font-size");
  const time = value(rule(".doc-time"), "font-size");
  // Rows by date are padded, folder rows have a set height, and phone rows
  // are padded around their two lines.
  const dated = rule(".date-list .tree-item.file");
  assert.equal(value(dated, "padding"), "8px 12px");
  const least = value(dated, "min-height");
  const folderRow = value(rule(".folder-tree .tree-item"), "height");
  const phone = css.slice(
    css.indexOf(
      "@media (pointer: coarse), (max-width: 760px) {\n  .tree-item .tree-actions",
    ),
  );
  assert.equal(
    value(
      rule("  .file-tree .tree-item.file:not(.editing)", phone),
      "padding-block",
    ),
    "8px",
  );
  // A chunk adds up the rows it holds by those heights.
  const chunk = rule(".tree-chunk");
  assert.equal(value(chunk, "--title-line"), `calc(${name} * ${line})`);
  assert.equal(value(chunk, "--folder-row"), folderRow);
  assert.equal(value(chunk, "--file-row"), folderRow);
  assert.equal(
    value(chunk, "--path-row"),
    `calc(16px + var(--title-line) + ${caption} * ${line})`,
  );
  assert.equal(
    value(rule(".date-list .tree-chunk"), "--file-row"),
    `max(${least}, calc(16px + var(--title-line)))`,
  );
  const phones = css.slice(
    css.indexOf(
      "@media (pointer: coarse), (max-width: 760px) {\n  .file-tree .tree-chunk",
    ),
  );
  assert.equal(
    value(rule("  .file-tree .tree-chunk", phones), "--file-row"),
    `calc(16px + var(--title-line) + ${time} * ${line})`,
  );
  // Only engines with content-visibility skip chunks, and never one holding
  // a name field, whose height follows its message.
  const start = css.indexOf(
    "@supports (content-visibility: auto) {\n  .tree-chunk",
  );
  assert.ok(start >= 0, "chunks skip their layout where the engine can");
  const skipped = rule("  .tree-chunk:not(.live)", css.slice(start));
  assert.equal(value(skipped, "content-visibility"), "auto");
  assert.equal(
    value(skipped, "contain-intrinsic-height"),
    "calc(var(--folders, 0) * var(--folder-row) + var(--files, 0) * var(--file-row) + var(--paths, 0) * var(--path-row))",
  );
});
