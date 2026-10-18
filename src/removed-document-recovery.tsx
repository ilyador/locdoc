import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { archiveOwnerDrafts, type DraftArchive } from "./drafts";
import { recoveredSource, type RemovedRecovery } from "./removed-recovery";
import { useRemote } from "./use-remote";

type RemovedDocument = { id: string; path: string; removed: number | null };

export function RemovedDocumentRecovery() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const remote = useRemote<RemovedDocument[]>(
    open ? "/api/recovery/removed" : null,
  );
  const download = async (entry: RemovedDocument, archive: boolean) => {
    if (request.current) return;
    const operation = new AbortController();
    request.current = operation;
    setBusy(entry.id);
    setError("");
    try {
      const bundle = await api<RemovedRecovery>(
        `/api/docs/${encodeURIComponent(entry.id)}/recovery?history=${archive}`,
        { signal: operation.signal },
      );
      if (bundle.document !== entry.id)
        throw new Error(
          "Recovery response did not match the requested document.",
        );
      let browserDrafts: DraftArchive[] = [];
      let browserDraftError = "";
      try {
        browserDrafts = await archiveOwnerDrafts(entry.id);
      } catch {
        browserDraftError =
          "Browser drafts could not be read. This archive contains the server copy only.";
      }
      if (operation.signal.aborted) return;
      const source =
        archive || browserDraftError
          ? null
          : recoveredSource(bundle, browserDrafts);
      if (!archive && source === null) {
        setError(
          browserDraftError ||
            "This document needs manual recovery. Choose Archive to download its original editing data, versions and local drafts.",
        );
        return;
      }
      const text = archive
        ? JSON.stringify(
            {
              ...bundle,
              browserDrafts,
              ...(browserDraftError ? { browserDraftError } : {}),
            },
            null,
            2,
          )
        : source!;
      const name = entry.path.split("/").at(-1) || entry.id;
      const url = URL.createObjectURL(
        new Blob([text], {
          type: archive ? "application/json" : "text/plain;charset=utf-8",
        }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = archive
        ? `${name}.recovery.json`
        : /\.(md|fountain)$/i.test(name)
          ? name
          : `${name}.txt`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      if (!operation.signal.aborted) setError((error as Error).message);
    } finally {
      if (!operation.signal.aborted) setBusy(null);
      if (request.current === operation) request.current = null;
    }
  };
  return (
    <details
      className="collaboration-recovery removed-document-recovery"
      onToggle={(event) => {
        const expanded = event.currentTarget.open;
        setOpen(expanded);
        if (!expanded) {
          request.current?.abort();
          request.current = null;
          setBusy(null);
        }
      }}
    >
      <summary>Removed document recovery</summary>
      <p className="field-help">
        Download previous edits and drafts after moving or removing a file.
        Files and sharing links stay unchanged.
      </p>
      {remote.loading && <p className="field-help">Loading…</p>}
      {(error || remote.error) && <p role="alert">{error || remote.error}</p>}
      {remote.data?.length === 0 && (
        <p className="field-help">No removed documents.</p>
      )}
      {remote.data?.map((entry) => (
        <div className="removed-recovery-row" key={entry.id}>
          <span title={entry.path}>{entry.path}</span>
          <button
            className="button small"
            disabled={busy !== null}
            onClick={() => void download(entry, false)}
          >
            {busy === entry.id ? "Preparing…" : "Text"}
          </button>
          <button
            className="button quiet small"
            aria-label={`Download recovery archive for ${entry.path}`}
            disabled={busy !== null}
            onClick={() => void download(entry, true)}
          >
            Archive
          </button>
        </div>
      ))}
    </details>
  );
}
