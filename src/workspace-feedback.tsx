import { useCallback, useEffect, useState } from "react";
import { CheckCircle, X } from "@phosphor-icons/react";
import { IconButton } from "./ui";

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
