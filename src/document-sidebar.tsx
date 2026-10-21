import { useId, useState, type ReactNode } from "react";
import {
  CaretDown,
  CaretRight,
  FileText,
  Folder,
  FolderOpen,
  LinkSimple,
  ShareNetwork,
} from "@phosphor-icons/react";
import { IconButton } from "./ui";
import type { Entry } from "./model";
import type { SidebarView } from "./workspace";
import { documentTitle } from "./document-links";
import { documentExtension } from "./document-format";
import { recentDocuments, sidebarTimestamp } from "./recent-documents";

const views = [
  { value: "date", label: "By date" },
  { value: "folders", label: "Folders" },
] as const;
const parentPath = (path: string) => path.split("/").slice(0, -1).join("/");

export function DocumentSidebar({
  entries,
  id,
  query,
  view,
  setView,
  collapsed,
  toggleFolder,
  choose,
  shareFolder,
  actions,
  label,
}: {
  entries: Entry[];
  id: string | null;
  query: string;
  view: SidebarView;
  setView: (value: SidebarView) => void;
  collapsed: Set<string>;
  toggleFolder: (path: string) => void;
  choose: (entry: Entry) => void;
  shareFolder?: (path: string) => void;
  actions?: ReactNode;
  label?: string;
}) {
  const tabId = useId();
  // Search reveals matches inside closed folders without changing the normal tree.
  const [search, setSearch] = useState({ query, collapsed: new Set<string>() });
  if (search.query !== query) setSearch({ query, collapsed: new Set() });
  const needle = query.trim().toLocaleLowerCase();
  const closed = needle ? search.collapsed : collapsed;
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
  const files = entries.filter((e) => e.kind === "file" && matches(e));
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

  const item = (e: Entry, depth?: number) => {
    const nested = depth !== undefined;
    const stamp = e.kind === "file" ? sidebarTimestamp(e.modified) : null;
    const row = (
      <button
        className={`tree-item ${e.id === id && e.kind === "file" ? "active" : ""} ${e.kind}`}
        aria-expanded={e.kind === "folder" ? !closed.has(e.path) : undefined}
        aria-current={e.id === id && e.kind === "file" ? "page" : undefined}
        title={e.path}
        style={
          nested
            ? { paddingLeft: 12 + depth * 16 + (e.kind === "file" ? 18 : 0) }
            : undefined
        }
        onClick={() => (e.kind === "folder" ? toggle(e.path) : choose(e))}
      >
        {e.kind === "folder" ? (
          <>
            {closed.has(e.path) ? (
              <CaretRight size={12} />
            ) : (
              <CaretDown size={12} />
            )}
            {closed.has(e.path) ? (
              <Folder size={17} />
            ) : (
              <FolderOpen size={17} />
            )}
          </>
        ) : (
          <FileText size={16} />
        )}
        <span className="doc-name">
          <span className="doc-label">
            <span className="doc-title">{documentTitle(e)}</span>{" "}
            {e.kind === "file" && (
              <span className="doc-extension">{documentExtension(e.path)}</span>
            )}
          </span>
          {!nested && parentPath(e.path) && (
            <small>{parentPath(e.path).replaceAll("/", " / ")}</small>
          )}
        </span>
        {e.kind === "file" && (
          <span className="doc-meta">
            {e.shared && <LinkSimple size={12} className="shared-indicator" />}
            {stamp && (
              <time
                className="doc-time"
                dateTime={stamp.dateTime}
                title={stamp.title}
              >
                {stamp.label}
              </time>
            )}
          </span>
        )}
      </button>
    );
    return e.kind === "folder" && shareFolder ? (
      <div className="folder-row">
        {row}
        <IconButton
          label={`Share folder ${e.path}`}
          onClick={() => shareFolder(e.path)}
        >
          <ShareNetwork size={16} />
        </IconButton>
      </div>
    ) : (
      row
    );
  };
  const branch = (parent = "", depth = 0): ReactNode => (
    <ul>
      {(children.get(parent) || []).map((entry) => (
        <li key={entry.path}>
          {item(entry, depth)}
          {entry.kind === "folder" &&
            !closed.has(entry.path) &&
            branch(entry.path, depth + 1)}
        </li>
      ))}
    </ul>
  );
  const empty = view === "date" ? !files.length : !children.size;
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
        className={`file-tree ${view === "date" ? "date-list" : "folder-tree"}`}
        role="tabpanel"
        id={`${tabId}-panel`}
        aria-labelledby={`${tabId}-${view}`}
        tabIndex={0}
      >
        <nav
          aria-label={view === "date" ? "Recent documents" : "Document folders"}
        >
          {view === "date" ? (
            <ul>
              {recentDocuments(files).map((entry) => (
                <li key={entry.path}>{item(entry)}</li>
              ))}
            </ul>
          ) : (
            branch()
          )}
        </nav>
        {empty && (
          <div className="tree-empty">
            {needle
              ? "No matching documents."
              : "Create a document, or add a .md or .fountain file to your docs folder."}
          </div>
        )}
      </div>
    </>
  );
}
