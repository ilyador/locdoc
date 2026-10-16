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
import { documentTitle } from "./document-links";
import { recentDocuments, sidebarTimestamp } from "./recent-documents";

export function DocumentSidebar({
  entries,
  id,
  query,
  scope,
  collapsed,
  toggleFolder,
  choose,
  foldersOpen,
  setFoldersOpen,
  shareFolder,
}: {
  entries: Entry[];
  id: string | null;
  query: string;
  scope: string;
  collapsed: Set<string>;
  toggleFolder: (path: string) => void;
  choose: (entry: Entry) => void;
  foldersOpen: boolean;
  setFoldersOpen: (value: boolean) => void;
  shareFolder?: (path: string) => void;
}) {
  const files = entries.filter(
    (e) =>
      e.kind === "file" &&
      (scope !== "shared" || e.shared) &&
      (!query ||
        `${documentTitle(e)} ${e.path}`
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase())),
  );
  const tree = entries.filter(
    (e) =>
      !Array.from(collapsed).some((folder) => e.path.startsWith(folder + "/")),
  );
  const item = (e: Entry, nested = false) => {
    const stamp = e.kind === "file" ? sidebarTimestamp(e.modified) : null;
    const row = (
      <button
        key={e.path}
        className={`tree-item ${e.id === id ? "active" : ""} ${e.kind}`}
        {...(nested
          ? {
              role: "treeitem",
              "aria-expanded":
                e.kind === "folder" ? !collapsed.has(e.path) : undefined,
            }
          : {})}
        aria-current={e.id === id ? "page" : undefined}
        title={e.path}
        style={
          nested
            ? { paddingLeft: 12 + (e.path.split("/").length - 1) * 16 }
            : undefined
        }
        onClick={() => (e.kind === "folder" ? toggleFolder(e.path) : choose(e))}
      >
        {e.kind === "folder" ? (
          <>
            {collapsed.has(e.path) ? (
              <CaretRight size={12} />
            ) : (
              <CaretDown size={12} />
            )}{" "}
            {collapsed.has(e.path) ? (
              <Folder size={17} />
            ) : (
              <FolderOpen size={17} />
            )}
          </>
        ) : (
          <FileText size={16} />
        )}
        <span className="doc-name">
          {documentTitle(e)}
          {!nested && e.path.includes("/") && (
            <small>{e.path.split("/").slice(0, -1).join(" / ")}</small>
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
      <div className="folder-row" key={e.path}>
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
  return (
    <div className="file-tree">
      {!query &&
        scope === "all" &&
        entries.some((e) => e.kind === "folder") && (
          <>
            <button
              className="folder-toggle"
              aria-expanded={!!foldersOpen}
              onClick={() => setFoldersOpen(!foldersOpen)}
            >
              <Folder size={14} />
              <span>Folders</span>
              {foldersOpen ? <CaretDown size={12} /> : <CaretRight size={12} />}
            </button>
            {foldersOpen && (
              <div
                role="tree"
                aria-label="Document folders"
                className="folder-tree"
              >
                {tree.map((e) => item(e, true))}
              </div>
            )}
          </>
        )}
      <nav aria-label="Recent documents">
        {recentDocuments(files).map((entry) => item(entry))}
      </nav>
      {!files.length && (
        <div className="tree-empty">
          {query
            ? "No matching documents."
            : scope === "shared"
              ? "Shared documents will appear here."
              : "Create a document, or add a .md file to your docs folder."}
        </div>
      )}
    </div>
  );
}
