import { ArrowUpRight, FileText, Files, Plus } from "@phosphor-icons/react";
import { sharedToken, type Config } from "./model";

export function OpeningDocument() {
  return (
    <div
      className="loading-surface"
      role="status"
      aria-label="Opening document"
    >
      <div className="loading-line" />
      <div className="loading-line" />
      <div className="loading-line" />
    </div>
  );
}

export function OwnerWelcome({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="welcome">
      <span className="welcome-symbol">
        <Files size={32} weight="duotone" />
      </span>
      <h1>
        Your words.
        <br />
        Your own space.
      </h1>
      <p>
        Open your local workspace with the owner API key stored on this
        computer.
      </p>
      <button className="button primary" onClick={onOpen}>
        Open workspace
        <ArrowUpRight size={17} />
      </button>
      <code>npm run owner</code>
    </div>
  );
}

export function EmptyWorkspace({
  config,
  error,
  onCreate,
}: {
  config: Config;
  error: string;
  onCreate: () => void;
}) {
  return (
    <div className="welcome">
      <span className="welcome-symbol">
        <FileText size={32} />
      </span>
      <h1>
        {error
          ? "This document is unavailable."
          : config.folder
            ? "This folder is empty."
            : "A little room for your ideas."}
      </h1>
      <p>
        {config.folder && !error
          ? "Documents added here will appear automatically."
          : sharedToken
            ? "Ask the owner for a current sharing link."
            : "Create a document or open a Markdown, Fountain or text file from the sidebar. Your words stay on your computer."}
      </p>
      {config.owner && (
        <button className="button primary" onClick={onCreate}>
          <Plus />
          Create a document
        </button>
      )}
    </div>
  );
}
