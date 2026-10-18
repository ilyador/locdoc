import { DownloadSimple, X } from "@phosphor-icons/react";
import type { DraftRecovery } from "./drafts";
import { IconButton } from "./ui";

export function DraftRecoveryNotice({
  records,
  dismiss,
  onError,
}: {
  records: DraftRecovery[];
  dismiss: (id: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  if (!records.length) return null;
  const download = (record: DraftRecovery) => {
    const data = JSON.stringify(
      {
        format: "locdoc-recovery-v1",
        reason: record.reason,
        text: record.text,
        update: Array.from(record.update),
        formatVersion: record.formatVersion,
        collaborationEpoch: record.collaborationEpoch,
        rawState: record.rawState,
        originalUpdates: record.originalUpdates?.map((original) => ({
          ...original,
          update: Array.from(original.update),
        })),
      },
      null,
      2,
    );
    const url = URL.createObjectURL(
      new Blob([data], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "locdoc-draft-recovery.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <details className="draft-recovery">
      <summary>
        Previous draft kept for recovery
        {records.length > 1 ? ` · ${records.length}` : ""}
      </summary>
      {records.map((record) => (
        <div className="draft-recovery-row" key={record.id}>
          <p>{record.reason}</p>
          <button className="button small" onClick={() => download(record)}>
            <DownloadSimple size={16} />
            Download
          </button>
          <IconButton
            label="Dismiss this recovery draft"
            onClick={() => {
              void dismiss(record.id).catch(() =>
                onError("Could not dismiss the recovery draft. Try again."),
              );
            }}
          >
            <X size={16} />
          </IconButton>
        </div>
      ))}
    </details>
  );
}
