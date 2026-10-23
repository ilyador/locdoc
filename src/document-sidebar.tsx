import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Entry } from "./model";
import type { SidebarScroll, SidebarView } from "./workspace";
import { documentTitle } from "./document-links";
import type { FileActions } from "./file-actions";
import { FileTree, type TreeRow } from "./file-tree";
import { parentPath } from "./file-names";
import {
  folderSortKey,
  latestChangeFirst,
  latestChanges,
  recentDocuments,
} from "./recent-documents";

const views = [
  { value: "date", label: "By date" },
  { value: "folders", label: "Folders" },
] as const;

// What the sidebar lists for a tree and a search: the matching documents,
// and every entry a match makes visible, by folder. The tree stays the same
// object until it changes, so this is worked out once for it, however often
// the sidebar renders.
type Listing = {
  entries: Entry[];
  needle: string;
  documents: Entry[];
  visible: Set<string> | null;
  recent?: Entry[];
  children?: Map<string, Entry[]>;
};
const listings = new WeakMap<Entry[], Listing>();
function listingOf(entries: Entry[], needle: string): Listing {
  const known = listings.get(entries);
  if (known?.needle === needle) return known;
  const matches = (entry: Entry) =>
    !needle ||
    `${documentTitle(entry)} ${entry.path}`
      .toLocaleLowerCase()
      .includes(needle);
  const documents: Entry[] = [];
  // Without a search every entry is visible.
  let visible: Set<string> | null = null;
  if (needle) visible = new Set();
  for (const entry of entries) {
    if (!matches(entry)) continue;
    if (entry.kind === "file") documents.push(entry);
    // A path already visible has its folders visible too.
    for (
      let path = entry.path;
      visible && path && !visible.has(path);
      path = parentPath(path)
    )
      visible.add(path);
  }
  const listing = { entries, needle, documents, visible };
  listings.set(entries, listing);
  return listing;
}
// The visible entries of each folder, in the order latestChangeFirst gives.
function folders(listing: Listing) {
  if (listing.children) return listing.children;
  const children = new Map<string, Entry[]>();
  for (const entry of listing.entries) {
    if (listing.visible && !listing.visible.has(entry.path)) continue;
    const parent = parentPath(entry.path);
    const siblings = children.get(parent) || [];
    siblings.push(entry);
    children.set(parent, siblings);
  }
  // A folder's latest change counts every document in it, matching a search
  // or not, so a search hides rows without reordering the rest.
  const latest = latestChanges(listing.entries);
  for (const siblings of children.values()) {
    const sorted = siblings
      .map((entry) => folderSortKey(entry, latest))
      .sort(latestChangeFirst);
    sorted.forEach((item, index) => (siblings[index] = item.entry));
  }
  return (listing.children = children);
}

export function DocumentSidebar({
  entries,
  id,
  query,
  view,
  setView,
  scroll,
  expanded,
  toggleFolder,
  choose,
  shareFolder,
  actions,
  label,
  fileActions,
  prepare,
}: {
  entries: Entry[];
  id: string | null;
  query: string;
  view: SidebarView;
  setView: (value: SidebarView) => void;
  // Where the list was scrolled, kept by the workspace for a sidebar that
  // mounts again.
  scroll?: SidebarScroll;
  expanded: Set<string>;
  toggleFolder: (path: string) => void;
  choose: (entry: Entry) => void;
  shareFolder?: (path: string) => void;
  actions?: ReactNode;
  label?: string;
  // The workspace's file actions, offered only when it is the owner's own.
  // The tree also keeps its focused row through them as documents open.
  fileActions?: FileActions;
  // Stores the open document's drafts before a new document opens.
  prepare?: () => Promise<void>;
}) {
  const tabId = useId();
  // Search reveals matches inside closed folders without changing the normal tree.
  const [search, setSearch] = useState({ query, collapsed: new Set<string>() });
  if (search.query !== query) setSearch({ query, collapsed: new Set() });
  const needle = query.trim().toLocaleLowerCase();
  const panel = useRef<HTMLDivElement>(null);
  const own = useRef<SidebarScroll>({ date: 0, folders: 0, search: 0 }).current;
  const places = scroll ?? own;
  // What the list shows: a view's documents or a search's results, and the
  // position it keeps for them.
  const showing = needle ? `${view}:${needle}` : view;
  const slot: keyof SidebarScroll = needle ? "search" : view;
  const shown = useRef({ showing, slot });
  // Each view returns to its own position, and each search starts at the
  // top of its results. A row or name field that has focus, such as a new
  // folder's name, stays in sight.
  useLayoutEffect(() => {
    if (shown.current.showing === showing) return;
    shown.current = { showing, slot };
    if (slot === "search") places.search = 0;
    const list = panel.current!;
    list.scrollTop = places[slot];
    const focused = document.activeElement;
    if (focused && focused !== list && list.contains(focused))
      focused.scrollIntoView?.({ block: "nearest" });
  }, [showing]);
  // A list that mounts again takes its position back before it paints and
  // keeps it as it goes.
  useLayoutEffect(() => {
    const list = panel.current!;
    list.scrollTop = places[shown.current.slot];
    return () => {
      places[shown.current.slot] = list.scrollTop;
    };
  }, []);
  const isOpen = (path: string) =>
    needle ? !search.collapsed.has(path) : expanded.has(path);
  const toggle = (path: string) => {
    if (!needle) return toggleFolder(path);
    const next = new Set(search.collapsed);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setSearch({ query, collapsed: next });
  };
  const listing = listingOf(entries, needle);
  // A new entry's name field opens first inside its folder, or at the top of
  // By date, where new documents appear once they exist.
  const edit = fileActions?.edit;
  const creating =
    edit?.mode === "create" && edit.view === view ? edit.parent : null;
  const rows: TreeRow[] = [];
  if (view === "date") {
    if (creating !== null) rows.push({ type: "create", depth: 0, parent: "" });
    const recent = (listing.recent ??= recentDocuments(listing.documents));
    recent.forEach((entry, index) =>
      rows.push({
        type: "entry",
        entry,
        depth: 0,
        setsize: recent.length,
        posinset: index + 1,
      }),
    );
  } else {
    const children = folders(listing);
    const walk = (parent: string, depth: number) => {
      if (creating === parent) rows.push({ type: "create", depth, parent });
      const list = children.get(parent) || [];
      list.forEach((entry, index) => {
        rows.push({
          type: "entry",
          entry,
          depth,
          setsize: list.length,
          posinset: index + 1,
        });
        if (entry.kind === "folder" && isOpen(entry.path))
          walk(entry.path, depth + 1);
      });
    };
    walk("", 0);
  }
  const empty =
    view === "date" ? !listing.documents.length : !folders(listing).size;
  return (
    <>
      <div className="sidebar-views">
        <div
          role="tablist"
          aria-label="Document views"
          className="sidebar-tabs"
        >
          {views.map((tab, index) => (
            <button
              key={tab.value}
              role="tab"
              id={`${tabId}-${tab.value}`}
              aria-selected={view === tab.value}
              aria-controls={`${tabId}-panel`}
              tabIndex={view === tab.value ? 0 : -1}
              onClick={() => setView(tab.value)}
              onKeyDown={(event) => {
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? 1
                      : event.key === "ArrowRight"
                        ? (index + 1) % views.length
                        : event.key === "ArrowLeft"
                          ? (index + views.length - 1) % views.length
                          : null;
                if (next === null) return;
                event.preventDefault();
                setView(views[next].value);
                const tabs =
                  event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                    '[role="tab"]',
                  );
                tabs?.[next].focus();
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {actions && <div className="sidebar-actions">{actions}</div>}
      </div>
      {label && (
        <div className="sidebar-folder-name" title={label} dir="auto">
          {label}
        </div>
      )}
      <div
        ref={panel}
        className={`file-tree ${view === "date" ? "date-list" : "folder-tree"}`}
        role="tabpanel"
        id={`${tabId}-panel`}
        aria-labelledby={`${tabId}-${view}`}
        tabIndex={rows.length ? undefined : 0}
        onScroll={(event) => {
          places[shown.current.slot] = event.currentTarget.scrollTop;
        }}
      >
        <nav
          aria-label={view === "date" ? "Recent documents" : "Document folders"}
        >
          <FileTree
            view={view}
            rows={rows}
            entries={entries}
            id={id}
            label={view === "date" ? "Documents by date" : "Folders"}
            files={fileActions}
            isOpen={isOpen}
            toggle={toggle}
            choose={choose}
            shareFolder={shareFolder}
            prepare={prepare}
            empty={
              empty && (
                <div className="tree-empty">
                  {needle
                    ? "No matching documents."
                    : "Create a document, or add a .md, .fountain or .txt file to your docs folder."}
                </div>
              )
            }
          />
        </nav>
      </div>
    </>
  );
}
