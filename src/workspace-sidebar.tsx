import type { RefObject } from "react";
import {
  DotsThree,
  FileText,
  Folder,
  GlobeSimple,
  MagnifyingGlass,
  Plus,
  SidebarSimple,
} from "@phosphor-icons/react";
import { DocumentSidebar } from "./document-sidebar";
import { SidebarResize } from "./sidebar-resize";
import { SearchField } from "./search-field";
import { documentExtension } from "./document-format";
import { Avatar, IconButton, PathText } from "./ui";
import { sharedToken, type Document, type Entry } from "./model";
import type { Workspace } from "./workspace";

// What a shared document's link lets its visitor do, in the sidebar of a
// link to a single document. The document's own workspace shows it, through
// the sidebar's `note`.
export function SharedDocumentNote({
  doc,
  filename,
}: {
  doc: Document;
  filename: string;
}) {
  return (
    <div className="shared-sidebar">
      <FileText />
      <strong className="doc-label">
        <span className="doc-title" dir="auto">
          {filename}
        </span>{" "}
        <span className="doc-extension">{documentExtension(doc.path)}</span>
      </strong>
      <p>
        {doc.edit
          ? "You can edit this document and leave comments."
          : "You can read this document and leave comments."}
      </p>
      <span className="subtle-label">
        <GlobeSimple size={14} />
        Anyone with this link
      </span>
    </div>
  );
}

export function WorkspaceSidebar({
  workspace,
  panel,
  note,
  searchInput,
  choose,
  prepare,
  onCreate,
  onShareFolder,
  onSettings,
}: {
  workspace: Workspace;
  panel?: RefObject<HTMLElement | null>;
  // Where the open document's workspace shows its note, if it has one.
  note?: (element: HTMLElement | null) => void;
  searchInput: RefObject<HTMLInputElement | null>;
  choose: (entry: Entry) => void;
  prepare: () => Promise<void>;
  onCreate: (kind: "file" | "folder") => void;
  onShareFolder: (path: string) => void;
  onSettings: () => void;
}) {
  const {
    config,
    entries,
    id,
    name,
    sidebar,
    setSidebar,
    setSidebarWidth,
    query,
    setQuery,
    expanded,
    setExpanded,
    sidebarView,
    setSidebarView,
    sidebarScroll,
  } = workspace;
  const toggleFolder = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  return (
    <aside
      ref={panel}
      id="workspace-sidebar"
      className={`sidebar ${sidebar ? "is-open" : ""}`}
      inert={!sidebar}
    >
      <SidebarResize onResize={setSidebarWidth} />
      <div className="brand-row">
        <a
          className="brand"
          href={sharedToken ? `/s/${encodeURIComponent(sharedToken)}` : "/"}
          aria-label="Locdoc home"
        >
          <span className="brand-mark">
            <img src="/icons/locdoc-v5.png" width="28" height="28" alt="" />
          </span>
          locdoc<span className="brand-dot">.</span>
        </a>
        <IconButton
          label="Close sidebar"
          data-sidebar-close=""
          onClick={() => setSidebar(false)}
        >
          <SidebarSimple />
        </IconButton>
      </div>
      {(config?.folder || (config?.owner && !sharedToken)) && (
        <>
          <SearchField
            className="search-box"
            inputRef={searchInput}
            start={<MagnifyingGlass size={16} />}
            hint={<kbd>Ctrl K</kbd>}
            placeholder="Find a document…"
            value={query}
            onValueChange={setQuery}
            onKeyDown={(event) => {
              // Down moves from search into the first visible row.
              if (event.key !== "ArrowDown") return;
              const row = event.currentTarget
                .closest(".sidebar")
                ?.querySelector<HTMLElement>(
                  '.file-tree [role="treeitem"][tabindex]',
                );
              if (!row) return;
              event.preventDefault();
              row.focus();
            }}
            aria-label="Find a document"
          />
          <DocumentSidebar
            entries={entries}
            id={id}
            query={query}
            view={sidebarView}
            setView={setSidebarView}
            scroll={sidebarScroll}
            expanded={expanded}
            toggleFolder={toggleFolder}
            choose={choose}
            prepare={prepare}
            // Only the owner's tree offers file actions, but every tree
            // keeps its focused row through them as documents open.
            fileActions={workspace.files}
            label={config.folder?.name}
            actions={
              config.owner &&
              !sharedToken && (
                <>
                  <IconButton
                    label="New folder"
                    onClick={() => onCreate("folder")}
                  >
                    <Folder size={16} />
                  </IconButton>
                  <IconButton
                    label="New document"
                    onClick={() => onCreate("file")}
                  >
                    <Plus size={16} />
                  </IconButton>
                </>
              )
            }
            shareFolder={
              config.owner && !sharedToken ? onShareFolder : undefined
            }
          />
          {config.owner && !sharedToken && (
            <button className="new-doc" onClick={() => onCreate("file")}>
              <Plus size={16} />
              New document
            </button>
          )}
        </>
      )}
      {note && sharedToken && !config?.folder && (
        <div ref={note} style={{ display: "contents" }} />
      )}
      <div className="sidebar-bottom">
        <div className="local-note">
          <span className="status-dot" />
          <span>
            {sharedToken
              ? "Shared from a local workspace"
              : "Stored on your computer"}
          </span>
        </div>
        {config?.owner && (
          <span className="root-path" title={config.root}>
            <PathText path={config.root} separator="/" />
          </span>
        )}
        <button className="profile" onClick={onSettings}>
          <Avatar name={name} color="#39795e" />
          <span>
            <strong>
              <bdi>{name}</bdi>
            </strong>
            <small>
              {config?.owner ? "Workspace owner" : "Guest collaborator"}
            </small>
          </span>
          <DotsThree size={22} />
        </button>
      </div>
    </aside>
  );
}
