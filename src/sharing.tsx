import { useState } from "react";
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
export function ShareControls({
  value,
  name,
  onChange,
}: {
  value: ShareAccess;
  name: string;
  onChange: (permission: string, rotate: boolean) => Promise<void>;
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
          <strong>{name}</strong>
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
        Share “{path.split("/").pop()}” and every document inside, including
        nested folders and future additions.
      </p>
      {value ? (
        <ShareControls
          value={value}
          name={name}
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
