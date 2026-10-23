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
import { Avatar, IconButton, PathText } from "./ui";
import { sharedToken, type Document } from "./model";

export function DocumentTopbar({
  doc,
  path,
  filename,
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
  return (
    <header className="topbar">
      <div className="breadcrumbs">
        {!sidebar && (
          <IconButton
            ref={sidebarTrigger}
            label="Open sidebar"
            onClick={openSidebar}
          >
            <SidebarSimple />
          </IconButton>
        )}
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
