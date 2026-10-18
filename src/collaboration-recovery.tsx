import { useState } from "react";
import { api, send } from "./api";

export function CollaborationRecovery({
  endpoint,
  available,
  disconnect,
  reconnect,
}: {
  endpoint: (suffix: string) => string;
  available: boolean;
  disconnect: () => Promise<void>;
  reconnect: () => void;
}) {
  const [source, setSource] = useState(available ? "durable" : "disk");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const download = async () => {
    setBusy(true);
    setError("");
    try {
      const bundle = await api<unknown>(endpoint("/recovery"));
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(bundle, null, 2)], {
          type: "application/json",
        }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = "locdoc-document-recovery.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const rebuild = async () => {
    setBusy(true);
    setError("");
    try {
      await disconnect();
      await api(endpoint("/rebuild"), send("POST", { source }));
      location.reload();
    } catch (e) {
      setError((e as Error).message);
      reconnect();
      setBusy(false);
    }
  };
  return (
    <details className="collaboration-recovery">
      <summary>Collaboration recovery</summary>
      <p className="field-help">
        For damaged or oversized editing history. Close this document in other
        tabs first. Rebuilding keeps a complete local archive; older offline
        drafts will be offered for download.
      </p>
      <label className="field-label" htmlFor="recovery-source">
        Rebuild from
      </label>
      <select
        id="recovery-source"
        className="text-input"
        value={source}
        disabled={busy}
        onChange={(e) => setSource(e.target.value)}
      >
        <option value="durable" disabled={!available}>
          Accepted document
        </option>
        <option value="disk">File on disk</option>
      </select>
      {source === "disk" && (
        <p className="field-help">
          The file becomes the document. Unsaved collaboration state stays in
          the recovery archive.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="dialog-actions">
        <button
          className="button quiet"
          disabled={busy}
          onClick={() => void download()}
        >
          Download recovery copy
        </button>
        <button
          className="button"
          disabled={busy}
          onClick={() => void rebuild()}
        >
          {busy ? "Working…" : "Archive and rebuild"}
        </button>
      </div>
    </details>
  );
}
