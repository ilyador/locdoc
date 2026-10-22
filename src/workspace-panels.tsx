import {
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  ArrowCounterClockwise,
  CaretRight,
  DownloadSimple,
  Folder,
  Image,
  LockSimple,
  TextAa,
} from "@phosphor-icons/react";
import { ShareControls } from "./sharing";
import { HiddenMediaSection } from "./hidden-media";
import { CollaborationRecovery } from "./collaboration-recovery";
import { RemovedDocumentRecovery } from "./removed-document-recovery";
import { McpConnections } from "./mcp-authorization";
import { RenameDocument } from "./rename-document";
import {
  documentFormat,
  formatLabel,
  type DocumentFormat,
} from "./document-format";
import type { DocumentSession } from "./document-session";
import type { FileActions } from "./file-actions";
import type { Config, Document } from "./model";
import { normalizePresence } from "./presence";
import { RecentlyDeleted } from "./trash";

export function panelTitle(panel: string | null) {
  return {
    share: "Share document",
    "folder-share": "Share folder",
    login: "Open your workspace",
    settings: "Your workspace",
    document: "Document options",
    history: "Version history",
    link: "Insert link",
  }[panel || ""];
}

export function DocumentSharePanel({
  doc,
  filename,
  name,
  onChange,
  onShareFolder,
}: {
  doc: Document;
  filename: string;
  name: string;
  onChange: (permission: string, rotate: boolean) => Promise<void>;
  onShareFolder: (path: string) => void;
}) {
  return (
    <>
      <p className="dialog-description">Share “{filename}” with a link.</p>
      <ShareControls
        value={doc}
        name={name}
        onChange={onChange}
        mcpTarget={doc.owner ? { kind: "document", id: doc.id } : undefined}
      />
      {doc.owner && documentFormat(doc.path) === "markdown" && (
        <HiddenMediaSection key={doc.id} doc={doc} />
      )}
      {doc.owner && doc.path.includes("/") && (
        <button
          className="text-button"
          onClick={() =>
            onShareFolder(doc.path.split("/").slice(0, -1).join("/"))
          }
        >
          <Folder size={16} />
          Share containing folder
        </button>
      )}
      {doc.path.includes("/") && (
        <p className="field-help">Folder links grant access separately.</p>
      )}
    </>
  );
}

export function OwnerLoginForm({
  apiKey,
  setApiKey,
  busy,
  onSubmit,
}: {
  apiKey: string;
  setApiKey: Dispatch<SetStateAction<string>>;
  busy: boolean;
  onSubmit: () => void;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <p className="dialog-description">
        Use the API key from this computer’s <code>.locdoc/owner.key</code>. Run{" "}
        <code>npm run owner</code> in the Locdoc folder to open it
        automatically.
      </p>
      <label className="field-label" htmlFor="owner-key">
        Owner API key
      </label>
      <input
        id="owner-key"
        type="password"
        autoComplete="off"
        className="text-input"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        autoFocus
        required
      />
      <p className="field-help">
        This browser will remember your owner session.
      </p>
      <div className="dialog-actions">
        <button className="button primary" disabled={busy || !apiKey.trim()}>
          {busy ? "Opening…" : "Open workspace"}
        </button>
      </div>
    </form>
  );
}

// Flush local drafts, then wait briefly for the socket to close before an owner
// resets collaboration state.
async function disconnectSession(session: DocumentSession | null) {
  await session?.drafts.flush();
  const provider = session?.provider;
  if (!provider?.wsconnected) return;
  await new Promise<void>((resolve) => {
    const closed = () => {
      clearTimeout(timer);
      provider.off("connection-close", closed);
      resolve();
    };
    const timer = setTimeout(closed, 500);
    provider.on("connection-close", closed);
    provider.disconnect();
  });
}

// The field shows the current name, which another tab or device may change,
// until something is typed, and keeps what was typed until it is saved.
function DisplayName({
  name,
  save,
}: {
  name: string;
  save: (name: string) => Promise<string>;
}) {
  const [typed, setTyped] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const draft = typed ?? name;
  const chosen = normalizePresence({ name: draft })?.name;
  const blocked = pending || !chosen || chosen === name;
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        if (blocked) return;
        setPending(true);
        setError("");
        try {
          await save(draft);
          setTyped(null);
        } catch (error) {
          setError((error as Error).message);
        } finally {
          setPending(false);
        }
      }}
    >
      <label className="field-label" htmlFor="your-name">
        Your display name
      </label>
      {/* Never disabled: a disabled field or button would drop keyboard
          focus out of the dialog while the name saves, or once it has. */}
      <div className="inline-form">
        <input
          id="your-name"
          className="text-input"
          maxLength={60}
          value={draft}
          readOnly={pending}
          onChange={(e) => setTyped(e.target.value)}
        />
        <button className="button quiet" aria-disabled={blocked || undefined}>
          {pending ? "Saving…" : "Save"}
        </button>
      </div>
      <p className="field-help">Shown beside your cursor and comments.</p>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

export function WorkspaceSettings({
  config,
  id,
  doc,
  session,
  endpoint,
  name,
  saveName,
  files,
  toggleAppearance,
  lock,
}: {
  config: Config | null;
  id: string | null;
  doc: Document | null;
  session: DocumentSession | null;
  endpoint: (suffix?: string) => string;
  name: string;
  saveName: (name: string) => Promise<string>;
  files: FileActions;
  toggleAppearance: () => void;
  lock: () => void;
}) {
  return (
    <>
      <DisplayName name={name} save={saveName} />
      {config?.owner && (
        <div className="settings-folder">
          <Folder />
          <span>
            <strong>Documents folder</strong>
            <code>{config.root}</code>
          </span>
        </div>
      )}
      <button className="menu-action" onClick={toggleAppearance}>
        <TextAa />
        Fonts and appearance
        <CaretRight size={14} />
      </button>
      {config?.owner && id && (
        <CollaborationRecovery
          key={id}
          endpoint={endpoint}
          available={!!doc}
          disconnect={() => disconnectSession(session)}
          reconnect={() => session?.provider.connect()}
        />
      )}
      {config?.owner && <RecentlyDeleted files={files} />}
      {config?.owner && <RemovedDocumentRecovery />}
      {config?.owner && <McpConnections publicUrl={config.publicUrl} />}
      {config?.owner && (
        <button className="menu-action" onClick={lock}>
          <LockSimple />
          Lock this browser
        </button>
      )}
    </>
  );
}

export function downloadDocument(
  doc: Document,
  session: DocumentSession | null,
) {
  const blob = new Blob(
    [session?.ydoc.getText("content").toString() ?? doc.content ?? ""],
    {
      type:
        documentFormat(doc.path) === "markdown"
          ? "text/markdown;charset=utf-8"
          : "text/plain;charset=utf-8",
    },
  );
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = doc.path.split("/").pop() || "document.md";
  a.click();
  URL.revokeObjectURL(a.href);
}

export function DocumentOptions({
  doc,
  format,
  endpoint,
  formatting,
  onDownload,
  onHistory,
  onRename,
}: {
  doc: Document;
  format: DocumentFormat;
  endpoint: string;
  formatting: ReactNode;
  onDownload: () => void;
  onHistory: () => void;
  onRename: (path: string) => void;
}) {
  return (
    <>
      <p className="dialog-description">{doc.path}</p>
      {doc.edit && format === "markdown" && (
        <div className="formatting-menu" role="group" aria-label="Formatting">
          {formatting}
        </div>
      )}
      <button className="menu-action" onClick={onDownload}>
        <DownloadSimple />
        Download {format === "text" ? "plain text" : formatLabel(format)}
      </button>
      {doc.owner && (
        <button className="menu-action" onClick={onHistory}>
          <ArrowCounterClockwise />
          Version history
        </button>
      )}
      {doc.owner && (
        <RenameDocument
          path={doc.path}
          endpoint={endpoint}
          onRename={onRename}
        />
      )}
      {format !== "text" && (
        <div className="attachment-info">
          <Image />
          <span>
            <strong>{(doc.usage / 1e6).toFixed(1)} MB of 50 MB used</strong>
            <small>Images up to 5 MB · Videos up to 20 MB</small>
          </span>
        </div>
      )}
    </>
  );
}
