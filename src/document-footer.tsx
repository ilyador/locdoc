import { useEffect, useState } from "react";
import {
  CheckCircle,
  Clock,
  FileText,
  WarningCircle,
} from "@phosphor-icons/react";
import type * as Y from "yjs";
import { countDocumentWords } from "./word-count";
import { documentFormat, formatLabel } from "./document-format";
import type { Document } from "./model";

export function DocumentWordMetrics({
  text,
  initial,
  path,
}: {
  text?: Y.Text;
  initial: string;
  path: string;
}) {
  const [count, setCount] = useState(() =>
    countDocumentWords(text?.toString() ?? initial, path),
  );
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const snapshot = () => {
      timer = undefined;
      setCount(countDocumentWords(text?.toString() ?? initial, path));
    };
    const changed = () => {
      timer ??= setTimeout(snapshot, 100);
    };
    snapshot();
    text?.observe(changed);
    return () => {
      clearTimeout(timer);
      text?.unobserve(changed);
    };
  }, [text, initial, path]);
  return (
    <>
      <span>
        {count.toLocaleString()} {count === 1 ? "word" : "words"}
      </span>
      <span className="reading-time">
        {Math.max(1, Math.ceil(count / 220))} min read
      </span>
    </>
  );
}

export function DocumentFooter({
  status,
  doc,
  id,
  text,
}: {
  status: string;
  doc: Document | null;
  id: string | null;
  text?: Y.Text;
}) {
  const currentFooterStatus = doc || id ? status : "Local workspace";
  const [footerStatus, setFooterStatus] = useState(currentFooterStatus);
  useEffect(() => {
    if (currentFooterStatus === footerStatus) return;
    // Brief local or remote projection cycles should not animate the footer.
    // Completion and warnings are authoritative and must never wait on this
    // presentation-only delay.
    if (
      currentFooterStatus !== "Saving…" &&
      currentFooterStatus !== "Saving draft…" &&
      currentFooterStatus !== "Waiting for desktop file"
    ) {
      setFooterStatus(currentFooterStatus);
      return;
    }
    const timer = setTimeout(() => setFooterStatus(currentFooterStatus), 2000);
    return () => clearTimeout(timer);
  }, [currentFooterStatus, footerStatus]);
  const statusWarning =
    footerStatus.startsWith("Offline") ||
    footerStatus === "Recovery needed" ||
    footerStatus === "Unable to open document";
  const format = documentFormat(doc?.path);
  return (
    <footer className="statusbar">
      <div
        className={`document-status ${statusWarning ? "has-warning" : ""}`}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label={footerStatus}
        title={footerStatus}
      >
        {statusWarning ? (
          <WarningCircle size={15} aria-hidden="true" />
        ) : footerStatus === "Saved to disk" ? (
          <CheckCircle size={15} aria-hidden="true" />
        ) : !doc && !id ? (
          <FileText size={15} aria-hidden="true" />
        ) : (
          <Clock size={15} aria-hidden="true" />
        )}
        <span>{footerStatus}</span>
      </div>
      {doc && (
        <div className="footer-metrics">
          <DocumentWordMetrics
            text={text}
            initial={doc.content}
            path={doc.path}
          />
          {format !== "text" && (
            <span
              className="attachment-usage"
              title="Attachment storage, including uploaded files awaiting insertion"
            >
              {(doc.usage / 1e6).toFixed(1)} / 50 MB
            </span>
          )}
          <span className="markdown-tag">{formatLabel(format)}</span>
        </div>
      )}
    </footer>
  );
}
