import { useEffect, useRef, useState } from "react";
import {
  CheckCircle,
  Clock,
  FileText,
  WarningCircle,
} from "@phosphor-icons/react";
import type * as Y from "yjs";
import { countDocumentWords } from "./word-count";
import { documentFormat } from "./document-format";
import { FormatReference } from "./format-reference";
import type { Document } from "./model";

// Counting words parses the whole document, which takes a phone tens of
// milliseconds for a long one. While the text changes, it is counted once
// typing pauses for WORDS_QUIET, or after WORDS_LONGEST of typing without a
// pause, when the browser is next idle. The count shown is always one
// countDocumentWords gave for the text.
export const WORDS_QUIET = 500;
export const WORDS_LONGEST = 2000;
function whenIdle(run: () => void) {
  if (typeof requestIdleCallback === "function") {
    const handle = requestIdleCallback(run, { timeout: 1000 });
    return () => cancelIdleCallback(handle);
  }
  const handle = setTimeout(run, 0);
  return () => clearTimeout(handle);
}

export function DocumentWordMetrics({
  text,
  initial,
  path,
}: {
  text?: Y.Text;
  initial: string;
  path: string;
}) {
  // The text last counted: the same text is never counted twice, as when the
  // collaborative text arrives holding the document's initial content.
  const counted = useRef<{ source: string; path: string; count: number }>(null);
  const countOf = (source: string, path: string) => {
    const last = counted.current;
    if (last?.source === source && last.path === path) return last.count;
    const count = countDocumentWords(source, path);
    counted.current = { source, path, count };
    return count;
  };
  const [count, setCount] = useState(() =>
    countOf(text?.toString() ?? initial, path),
  );
  useEffect(() => {
    let quiet: ReturnType<typeof setTimeout> | undefined;
    let longest: ReturnType<typeof setTimeout> | undefined;
    let idle: (() => void) | undefined;
    const settle = () => {
      clearTimeout(quiet);
      clearTimeout(longest);
      idle?.();
      quiet = longest = idle = undefined;
    };
    const snapshot = () => {
      settle();
      setCount(countOf(text?.toString() ?? initial, path));
    };
    const due = () => {
      idle ??= whenIdle(snapshot);
    };
    const changed = () => {
      clearTimeout(quiet);
      quiet = setTimeout(due, WORDS_QUIET);
      longest ??= setTimeout(due, WORDS_LONGEST);
    };
    snapshot();
    text?.observe(changed);
    return () => {
      settle();
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
          <FormatReference format={format} />
        </div>
      )}
    </footer>
  );
}
