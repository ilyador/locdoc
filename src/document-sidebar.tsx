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
import { recentDocuments } from "./recent-documents";

const views = [
  { value: "date", label: "By date" },
  { value: "folders", label: "Folders" },
] as const;

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
  // Where each view's list was scrolled, kept by the workspace while this
  // sidebar mounts again for each document.
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
  const panel = useRef<HTMLDivElement>(null);
  const own = useRef<SidebarScroll>({ date: 0, folders: 0 }).current;
  const places = scroll ?? own;
  // The view the list shows, whose position it keeps.
  const shown = useRef(view);
  // Each view returns to its own position. A row or name field that has
  // focus, such as a new folder's name, stays in sight.
  useLayoutEffect(() => {
    if (shown.current === view) return;
    shown.current = view;
    const list = panel.current!;
    list.scrollTop = places[view];
    const focused = document.activeElement;
    if (focused && focused !== list && list.contains(focused))
      focused.scrollIntoView?.({ block: "nearest" });
  }, [view]);
  // Each document's workspace mounts this sidebar again. The list takes its
  // position back before it paints and keeps it as it goes, so opening a
  // document leaves the list where it was.
  useLayoutEffect(() => {
    const list = panel.current!;
    list.scrollTop = places[shown.current];
    return () => {
      places[shown.current] = list.scrollTop;
    };
  }, []);
  // Search reveals matches inside closed folders without changing the normal tree.
  const [search, setSearch] = useState({ query, collapsed: new Set<string>() });
  if (search.query !== query) setSearch({ query, collapsed: new Set() });
  const needle = query.trim().toLocaleLowerCase();
  const isOpen = (path: string) =>
    needle ? !search.collapsed.has(path) : expanded.has(path);
  const toggle = (path: string) => {
    if (!needle) return toggleFolder(path);
    const next = new Set(search.collapsed);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setSearch({ query, collapsed: next });
  };
  const matches = (entry: Entry) =>
    `${documentTitle(entry)} ${entry.path}`
      .toLocaleLowerCase()
      .includes(needle);
  const documents = entries.filter((e) => e.kind === "file" && matches(e));
  const visible = new Set<string>();
  for (const entry of entries) {
    if (!matches(entry)) continue;
    let path = entry.path;
    while (path) {
      visible.add(path);
      path = parentPath(path);
    }
  }
  const children = new Map<string, Entry[]>();
  for (const entry of entries) {
    if (!visible.has(entry.path)) continue;
    const parent = parentPath(entry.path);
    const siblings = children.get(parent) || [];
    siblings.push(entry);
    children.set(parent, siblings);
  }
  for (const siblings of children.values())
    siblings.sort(
      (a, b) =>
        Number(b.kind === "folder") - Number(a.kind === "folder") ||
        documentTitle(a).localeCompare(documentTitle(b), undefined, {
          numeric: true,
          sensitivity: "base",
        }) ||
        a.path.localeCompare(b.path),
    );
  // A new entry's name field opens first inside its folder, or at the top of
  // By date, where new documents appear once they exist.
  const edit = fileActions?.edit;
  const creating =
    edit?.mode === "create" && edit.view === view ? edit.parent : null;
  const rows: TreeRow[] = [];
  if (view === "date") {
    if (creating !== null) rows.push({ type: "create", depth: 0, parent: "" });
    const recent = recentDocuments(documents);
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
  const empty = view === "date" ? !documents.length : !children.size;
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
        <div className="sidebar-folder-name" title={label}>
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
          places[shown.current] = event.currentTarget.scrollTop;
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
