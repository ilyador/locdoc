import { useLayoutEffect, useRef, useState } from "react";
import {
  ArrowCounterClockwise,
  FileText,
  Folder,
  Trash,
} from "@phosphor-icons/react";
import { trashItem, type FileActions } from "./file-actions";
import { baseName, parentPath } from "./file-names";
import type { TrashItem } from "./model";
import { sidebarTimestamp } from "./recent-documents";
import { useRemote } from "./use-remote";

const deletedAgo = (item: TrashItem) => sidebarTimestamp(item.deleted);
// "deleted 5m ago", "deleted just now" or "deleted on Mar 4".
const deletedWhen = (label: string) =>
  label === "now"
    ? "deleted just now"
    : label.endsWith("ago")
      ? `deleted ${label}`
      : `deleted on ${label}`;
const contents = (item: TrashItem) =>
  item.kind === "folder"
    ? `Folder · ${item.documents} ${item.documents === 1 ? "document" : "documents"}`
    : parentPath(item.path) || "Documents";

// Settings › Recently deleted. Restoring puts an item back at its original
// path, or explains why that path is taken; nothing is deleted for good here.
export function RecentlyDeleted({ files }: { files: FileActions }) {
  const [open, setOpen] = useState(false);
  const remote = useRemote<{ items?: unknown[] }>(open ? "/api/trash" : null);
  const [restored, setRestored] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const working = useRef(false);
  const list = useRef<HTMLUListElement>(null);
  const summary = useRef<HTMLElement>(null);
  // A restored row leaves the list; the keyboard stays where that row was.
  const refocus = useRef<number | null>(null);
  useLayoutEffect(() => {
    const index = refocus.current;
    if (index === null) return;
    refocus.current = null;
    const buttons = Array.from(
      list.current?.querySelectorAll<HTMLButtonElement>(".trash-row button") ||
        [],
    );
    (buttons[Math.min(index, buttons.length - 1)] || summary.current)?.focus();
  });
  const items = (remote.data?.items || [])
    .map(trashItem)
    .filter((item): item is TrashItem => !!item && !(item.id in restored))
    .sort((a, b) => b.deleted - a.deleted);
  const restore = async (item: TrashItem, index: number) => {
    if (working.current) return;
    working.current = true;
    setBusy(item.id);
    setErrors(({ [item.id]: _, ...rest }) => rest);
    setStatus("");
    const result = await files.restore(item, { quiet: true });
    working.current = false;
    setBusy(null);
    if (result.ok) {
      if (list.current?.contains(document.activeElement))
        refocus.current = index;
      setRestored((value) => ({ ...value, [item.id]: result.path }));
      setStatus(`Restored to ${result.path}.`);
    } else setErrors((value) => ({ ...value, [item.id]: result.error }));
  };
  return (
    <details
      className="collaboration-recovery recently-deleted"
      onToggle={(event) => {
        const expanded = event.currentTarget.open;
        setOpen(expanded);
        if (!expanded) {
          setRestored({});
          setErrors({});
          setStatus("");
        }
      }}
    >
      <summary ref={summary}>Recently deleted</summary>
      <p className="field-help">
        Deleted documents and folders keep their comments, history and links
        here. Restoring puts them back where they were.
      </p>
      {remote.loading && <p className="field-help">Loading…</p>}
      {remote.error && <p role="alert">{remote.error}</p>}
      {remote.data && !items.length && (
        <p className="field-help">Nothing has been deleted.</p>
      )}
      {items.length > 0 && (
        <ul className="trash-list" ref={list}>
          {items.map((item, index) => {
            const stamp = deletedAgo(item);
            const Glyph = item.kind === "folder" ? Folder : FileText;
            return (
              <li className="trash-row" key={item.id}>
                <Glyph size={17} aria-hidden="true" />
                <span className="trash-name">
                  <strong title={item.path}>{baseName(item.path)}</strong>
                  <small>
                    {contents(item)}
                    {stamp && (
                      <>
                        {" · "}
                        <time dateTime={stamp.dateTime} title={stamp.title}>
                          {deletedWhen(stamp.label)}
                        </time>
                      </>
                    )}
                  </small>
                  {errors[item.id] && (
                    <span role="alert" className="trash-error">
                      {errors[item.id]}
                    </span>
                  )}
                </span>
                {/* Never disabled while a restore runs: a disabled button
                    would drop keyboard focus out of the dialog. */}
                <button
                  className="button quiet small-button"
                  aria-label={`Restore ${item.path}`}
                  aria-disabled={busy !== null || undefined}
                  onClick={() => void restore(item, index)}
                >
                  <ArrowCounterClockwise size={15} aria-hidden="true" />
                  {busy === item.id ? "Restoring…" : "Restore"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="visually-hidden" role="status">
        {status}
      </p>
    </details>
  );
}

function useRestore(files: FileActions, item: TrashItem) {
  const [busy, setBusy] = useState(false);
  return {
    busy,
    restore: async () => {
      setBusy(true);
      const result = await files.restore(item, { focus: false });
      // On success the document reopens and this view goes away.
      if (!result.ok) setBusy(false);
    },
  };
}

// The open document's content stays readable while it is in the trash. A
// document deleted with its folder comes back when the folder does.
export function TrashedNotice({
  files,
  item,
}: {
  files: FileActions;
  item: TrashItem;
}) {
  const { busy, restore } = useRestore(files, item);
  const folder = item.kind === "folder";
  return (
    <div className="trash-notice" role="status">
      <Trash size={16} aria-hidden="true" />
      <span>
        {folder
          ? `This document is in Recently deleted with the folder ${baseName(item.path)}.`
          : "This document is in Recently deleted."}{" "}
        Links and MCP access are paused until you restore it.
      </span>
      {item.id && (
        <button
          className="button quiet small-button"
          disabled={busy}
          onClick={() => void restore()}
        >
          <ArrowCounterClockwise size={15} aria-hidden="true" />
          {busy ? "Restoring…" : folder ? "Restore folder" : "Restore"}
        </button>
      )}
    </div>
  );
}

// Opening a trashed document shows where it went instead of an error.
// `path` is the document's own former path; a folder item names the folder.
export function TrashedDocument({
  files,
  item,
  path,
}: {
  files: FileActions;
  item: TrashItem;
  path: string;
}) {
  const { busy, restore } = useRestore(files, item);
  const stamp = deletedAgo(item);
  const when = stamp ? deletedWhen(stamp.label) : "deleted";
  const folder = item.kind === "folder";
  return (
    <div className="welcome trashed-document">
      <span className="welcome-symbol">
        <Trash size={32} />
      </span>
      <h1>This document is in Recently deleted.</h1>
      <p>
        {folder
          ? `${baseName(path)} was ${when} with the folder ${baseName(item.path)}. Restoring the folder brings back its documents with their comments, history and links.`
          : `${baseName(path)} was ${when}. Restoring it brings back its comments, history and links.`}
      </p>
      {item.id ? (
        <button
          className="button primary"
          disabled={busy}
          onClick={() => void restore()}
        >
          <ArrowCounterClockwise size={17} aria-hidden="true" />
          {busy
            ? "Restoring…"
            : folder
              ? "Restore folder"
              : "Restore document"}
        </button>
      ) : (
        <p>Restore it from Recently deleted in your workspace settings.</p>
      )}
    </div>
  );
}
