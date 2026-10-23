import {
  CaretRight,
  ChatCircle,
  LockSimple,
  PencilSimple,
  ShareNetwork,
  SidebarSimple,
} from "@phosphor-icons/react";
import type { RefObject } from "react";
import { documentExtension } from "./document-format";
import { headerTimestamp } from "./recent-documents";
import { Avatar, IconButton, PathText } from "./ui";
import { sharedToken, type Document } from "./model";

export function DocumentTopbar({
  doc,
  path,
  filename,
  modified,
  people,
  sidebar,
  openSidebar,
  sidebarTrigger,
  commentsOpen,
  toggleComments,
  share,
}: {
  doc: Document | null;
  // The document's current path, which follows renames.
  path: string | null;
  filename: string;
  // When the document's file last changed, in seconds, as the sidebar lists
  // it. A link to a single document lists none, so it shows no time.
  modified?: number;
  people: { name: string; color: string }[];
  sidebar: boolean;
  openSidebar: () => void;
  // Open sidebar, which takes focus back as the sidebar closes.
  sidebarTrigger?: RefObject<HTMLButtonElement | null>;
  commentsOpen: boolean;
  toggleComments: () => void;
  // Absent while the document is in the trash: its links are suspended.
  share?: () => void;
}) {
  const changed = headerTimestamp(modified);
  return (
    <header className="topbar">
      <div className="topbar-heading">
        {!sidebar && (
          <IconButton
            ref={sidebarTrigger}
            label="Open sidebar"
            onClick={openSidebar}
          >
            <SidebarSimple />
          </IconButton>
        )}
        <div className="topbar-titles">
          <div className="breadcrumbs">
            <span className="crumb-home">
              {sharedToken ? "Shared" : "Documents"}
            </span>
            <CaretRight size={12} />
            {path?.includes("/") && (
              <>
                <span className="crumb-folder">
                  <PathText path={path.split("/").slice(0, -1).join("/")} />
                </span>
                <CaretRight size={12} />
              </>
            )}
            <span className="crumb-current doc-label">
              <span className="doc-title" dir="auto">
                {filename}
              </span>{" "}
              {path && (
                <span className="doc-extension">{documentExtension(path)}</span>
              )}
            </span>
          </div>
        </div>
      </div>
      {changed && (
        <p className="document-modified">
          <span className="document-modified-label">Modified </span>
          <time dateTime={changed.dateTime} dir="auto">
            {changed.label}
          </time>
        </p>
      )}
      <div className="top-actions">
        {doc && (
          <>
            <div className="presence">
              {people.slice(0, 4).map((p, i) => (
                <Avatar key={`${p.name}-${i}`} {...p} small />
              ))}
              {people.length > 4 && (
                <span className="presence-more">+{people.length - 4}</span>
              )}
            </div>
            <button
              className={`button quiet comments-toggle ${commentsOpen ? "pressed" : ""}`}
              aria-label="Toggle comments"
              aria-expanded={commentsOpen}
              data-comment-control=""
              onClick={toggleComments}
            >
              <ChatCircle size={17} />
              <span>Comments</span>
            </button>
            {doc.owner ? (
              share && (
                <button
                  className="button primary share-button"
                  onClick={share}
                >
                  <ShareNetwork size={17} />
                  <span>Share</span>
                </button>
              )
            ) : (
              <span className="access-badge">
                {doc.edit ? (
                  <PencilSimple size={14} />
                ) : (
                  <LockSimple size={14} />
                )}
                {doc.edit ? "Can edit" : "View & comment"}
              </span>
            )}
          </>
        )}
      </div>
    </header>
  );
}
