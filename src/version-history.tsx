import { useState } from "react";
import { api, send } from "./api";
import { useRemote } from "./use-remote";

type Version = { id: string; created: number; bytes: number };
export function VersionHistory({
  endpoint,
  onRestore,
}: {
  endpoint: (suffix: string) => string;
  onRestore: () => void;
}) {
  const versions = useRemote<{ versions: Version[] }>(endpoint("/versions"));
  const [id, setId] = useState("");
  const preview = useRemote<{ content: string }>(
    id ? endpoint(`/versions/${id}`) : null,
  );
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState("");
  const restore = async () => {
    if (!id || !preview.data || preview.loading) return;
    setRestoring(true);
    setError("");
    try {
      await api(endpoint(`/versions/${id}/restore`), send("POST"));
      onRestore();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setRestoring(false);
    }
  };
  return (
    <>
      <p className="dialog-description">
        Automatic local snapshots protect against accidental or unwanted edits.
        Up to 50 automatic snapshots and 20 recovery versions are kept.
      </p>
      {versions.loading && <p role="status">Loading versions…</p>}
      {(versions.error || preview.error || error) && (
        <p role="alert">{versions.error || preview.error || error}</p>
      )}
      <select
        className="text-input"
        aria-label="Saved version"
        value={id}
        disabled={restoring}
        onChange={(e) => setId(e.target.value)}
      >
        <option value="">Choose a version…</option>
        {versions.data?.versions.map((v) => (
          <option key={v.id} value={v.id}>
            {new Date(v.created * 1000).toLocaleString()} ·{" "}
            {v.bytes.toLocaleString()} bytes
          </option>
        ))}
      </select>
      {versions.data?.versions.length === 0 && (
        <p className="field-help">
          A snapshot is created when you open a document. More appear as you
          edit.
        </p>
      )}
      {id && (
        <>
          <pre className="version-preview">
            {preview.loading
              ? "Loading version…"
              : preview.data?.content || "Empty document"}
          </pre>
          <div className="dialog-actions">
            <button
              className="button primary"
              disabled={restoring || preview.loading || !preview.data}
              onClick={() => void restore()}
            >
              {restoring ? "Restoring…" : "Restore this version"}
            </button>
          </div>
        </>
      )}
    </>
  );
}
