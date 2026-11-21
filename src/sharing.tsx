import { useId, useRef, useState } from "react";
import {
  ArrowCounterClockwise,
  CaretDown,
  Check,
  Copy,
  GlobeSimple,
  LinkSimple,
} from "@phosphor-icons/react";
import { api, send } from "./api";
import { Avatar, IconButton } from "./ui";
import { useRemote } from "./use-remote";

export type ShareAccess = { permission: string; shareUrl: string | null };
type McpAccess = {
  mcpAllowed: boolean;
  mcpDirect: boolean;
  mcpInherited: boolean;
};
type McpTarget =
  { kind: "document"; id: string } | { kind: "folder"; path: string };

export function McpAccessControl({ target }: { target: McpTarget }) {
  const url =
    target.kind === "document"
      ? `/api/docs/${encodeURIComponent(target.id)}/mcp`
      : `/api/folders/mcp?path=${encodeURIComponent(target.path)}`;
  return <McpAccessSetting key={url} target={target} url={url} />;
}

function McpAccessSetting({ target, url }: { target: McpTarget; url: string }) {
  const result = useRemote<McpAccess>(url);
  const [changed, setChanged] = useState<McpAccess>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const helpId = useId();
  const value = changed || result.data;
  const change = async (allowed: boolean) => {
    if (!value || value.mcpInherited || busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await api<McpAccess>(
        target.kind === "document" ? url : "/api/folders/mcp",
        send(
          "POST",
          target.kind === "document"
            ? { allowed }
            : { path: target.path, allowed },
        ),
      );
      setChanged(next);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mcp-access" aria-busy={busy || result.loading}>
      <label className="mcp-access-label">
        <span>Allow MCP</span>
        <input
          type="checkbox"
          role="switch"
          aria-describedby={helpId}
          checked={value?.mcpAllowed || false}
          disabled={!value || busy || value.mcpInherited}
          onChange={(event) => void change(event.target.checked)}
        />
      </label>
      <p id={helpId} className="field-help">
        {value?.mcpInherited
          ? value.mcpDirect
            ? "Allowed here and by a folder. Turn off folder access first."
            : "Allowed by folder. Change access in the folder that allows MCP."
          : `Let connected AI apps access this ${target.kind}.`}
      </p>
      {(error || result.error) && (
        <p role="alert" className="field-help">
          {error || result.error}
        </p>
      )}
    </div>
  );
}

export function ShareControls({
  value,
  name,
  onChange,
  mcpTarget,
}: {
  value: ShareAccess;
  name: string;
  onChange: (permission: string, rotate: boolean) => Promise<void>;
  mcpTarget?: McpTarget;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const change = async (permission: string, rotate = false) => {
    setBusy(true);
    setError("");
    setCopied(false);
    try {
      await onChange(permission, rotate);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    if (!value.shareUrl) return;
    try {
      await navigator.clipboard.writeText(value.shareUrl);
      setCopied(true);
    } catch {
      setError("Could not copy. Select the link and copy it manually.");
    }
  };
  return (
    <>
      <div className="owner-access">
        <Avatar name={name} />
        <span>
          <strong>
            <bdi>{name}</bdi>
          </strong>
          <small>Workspace owner</small>
        </span>
        <span>Always can edit</span>
      </div>
      <label className="field-label" htmlFor="share-permission">
        Link access
      </label>
      <div className="share-select select-field">
        <GlobeSimple />
        <select
          id="share-permission"
          value={value.permission}
          disabled={busy}
          onChange={(e) => void change(e.target.value)}
        >
          <option value="private">Private · link turned off</option>
          <option value="view">View & comment</option>
          <option value="edit">Edit & comment</option>
        </select>
        <CaretDown size={16} className="select-arrow" aria-hidden="true" />
      </div>
      <p className="field-help">
        {value.permission === "private"
          ? "This link is turned off."
          : "Anyone with this link can join. No account or email required."}
      </p>
      {error && (
        <p role="alert" className="field-help">
          {error}
        </p>
      )}
      {value.permission !== "private" && (
        <>
          <label className="field-label" htmlFor="share-link">
            Public URL
          </label>
          <div className="copy-field">
            <input
              id="share-link"
              readOnly
              value={value.shareUrl || ""}
              onFocus={(e) => e.currentTarget.select()}
            />
            <IconButton
              label="Copy sharing link"
              disabled={busy}
              onClick={() => void copy()}
            >
              {copied ? <Check /> : <Copy />}
            </IconButton>
          </div>
          <div className="dialog-actions">
            <button
              className="text-button"
              disabled={busy}
              onClick={() => void change(value.permission, true)}
            >
              <ArrowCounterClockwise size={14} />
              Replace link
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={() => void copy()}
            >
              {copied ? <Check size={15} /> : <LinkSimple size={15} />}
              {copied ? "Copied" : "Copy link"}
            </button>
          </div>
          <p className="field-help">
            Replacing the link immediately revokes the previous one.
          </p>
        </>
      )}
      {mcpTarget && <McpAccessControl target={mcpTarget} />}
    </>
  );
}

// The document's path in the workspace, to link it from another document.
// Pasted into a Markdown document elsewhere, the editor writes it from that
// document's folder (pastedDocumentPath).
export function DocumentPathCopy({ path }: { path: string }) {
  const field = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const helpId = useId();
  const copy = async () => {
    setError("");
    try {
      await navigator.clipboard.writeText(path);
    } catch {
      // Plain HTTP origins other than localhost have no asynchronous
      // clipboard. The field is inside the dialog, which a modal keeps
      // selectable.
      const input = field.current;
      input?.select();
      if (!input || !document.execCommand?.("copy")) {
        setCopied(false);
        setError("Could not copy. Select the path and copy it manually.");
        return;
      }
    }
    setCopied(true);
  };
  return (
    <>
      <label className="field-label" htmlFor="document-path">
        Link from another document
      </label>
      <div className="copy-field">
        <input
          id="document-path"
          ref={field}
          readOnly
          dir="auto"
          value={path}
          aria-describedby={helpId}
          onFocus={(e) => e.currentTarget.select()}
        />
        <IconButton label="Copy document path" onClick={() => void copy()}>
          {copied ? <Check /> : <Copy />}
        </IconButton>
      </div>
      <p id={helpId} className="field-help" role={error ? "alert" : undefined}>
        {error ||
          (copied
            ? "Path copied. Paste it into a link in another document."
            : "Paste it into a link in another document. Locdoc adjusts the path to that document’s folder.")}
      </p>
    </>
  );
}

export function FolderShare({
  path,
  name,
  onChanged,
}: {
  path: string;
  name: string;
  onChanged: () => Promise<void>;
}) {
  const result = useRemote<ShareAccess>(
    `/api/folders/share?path=${encodeURIComponent(path)}`,
  );
  const [changed, setChanged] = useState<ShareAccess>();
  const value = changed || result.data;
  return (
    <>
      <p className="dialog-description">
        Share “<bdi>{path.split("/").pop()}</bdi>” and every document inside,
        including nested folders and future additions.
      </p>
      {value ? (
        <ShareControls
          value={value}
          name={name}
          mcpTarget={{ kind: "folder", path }}
          onChange={async (permission, rotate) => {
            const next = await api<ShareAccess>(
              "/api/folders/share",
              send("POST", { path, permission, rotate }),
            );
            setChanged(next);
            await onChanged();
          }}
        />
      ) : (
        <p role={result.error ? "alert" : "status"} className="field-help">
          {result.error || "Loading folder access…"}
        </p>
      )}
      <p className="field-help">
        Individual document links keep their own access settings.
      </p>
    </>
  );
}
