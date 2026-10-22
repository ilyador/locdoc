import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle, WarningCircle, X } from "@phosphor-icons/react";
import { IconButton } from "./ui";
import type { FileActions } from "./file-actions";
import { shortcuts } from "./shortcuts";

// One transient notification per document workspace.
export function useToast() {
  const [toast, setToast] = useState("");
  const tell = useCallback((message: string) => setToast(message), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(t);
  }, [toast]);
  return { toast, tell, dismiss: () => setToast("") };
}

export function Toast({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  if (!message) return null;
  return (
    <div className="toast" role="status">
      <CheckCircle size={18} />
      {message}
      <IconButton label="Dismiss notification" onClick={onDismiss}>
        <X size={14} />
      </IconButton>
    </div>
  );
}

// Sidebar file actions report here. The region stays mounted so screen
// readers announce each message; hovering or focusing the toast holds it, and
// Undo restores what the toast's deletion moved to the trash.
export function FileActionToast({ files }: { files: FileActions }) {
  const toast = files.toast;
  const box = useRef<HTMLDivElement>(null);
  // Leaving the toast by closing it returns focus to the file tree.
  const close = () => {
    const focused = box.current?.contains(document.activeElement);
    files.dismissToast();
    if (focused) files.focusPath(files.cursor(), true);
  };
  return (
    <div className="toast-slot" role="status" aria-live="polite">
      {toast && (
        <div
          ref={box}
          className={`toast ${toast.tone === "error" ? "is-error" : ""}`}
          onPointerEnter={() => files.holdToast(true)}
          onPointerLeave={() => files.holdToast(false)}
          onFocus={() => files.holdToast(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget))
              files.holdToast(false);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            close();
          }}
        >
          {toast.tone === "error" ? (
            <WarningCircle size={18} aria-hidden="true" />
          ) : (
            <CheckCircle size={18} aria-hidden="true" />
          )}
          <span className="toast-message">{toast.message}</span>
          {toast.undo && (
            <button
              type="button"
              className="toast-action"
              disabled={toast.restoring}
              aria-keyshortcuts={shortcuts.undo[1]}
              title={`Undo (${shortcuts.undo[0]} in the sidebar)`}
              onClick={() =>
                files.undo({
                  focus: !!box.current?.contains(document.activeElement),
                })
              }
            >
              {toast.restoring ? "Restoring…" : "Undo"}
            </button>
          )}
          <IconButton label="Dismiss notification" onClick={close}>
            <X size={14} />
          </IconButton>
        </div>
      )}
    </div>
  );
}

// Forms stay busy while any request runs. A failed request reports its error
// and leaves the form text in place for retry.
export function useAction(tell: (message: string) => void) {
  const [pending, setPending] = useState(0);
  const action = async (fn: () => Promise<void>) => {
    setPending((count) => count + 1);
    try {
      await fn();
      return true;
    } catch (e) {
      tell((e as Error).message);
      return false;
    } finally {
      setPending((count) => count - 1);
    }
  };
  return { busy: pending > 0, action };
}
