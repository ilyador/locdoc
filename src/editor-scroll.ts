import type { EditorView } from "@codemirror/view";

// This is browser reading state, never document content or collaborative state.
export function rememberEditorScroll(view: EditorView, key: string) {
  const pane = view.dom.closest<HTMLElement>(".writing-pane");
  if (!pane) return;
  let saved: number | null = null;
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || "null");
    if (typeof value === "number" && Number.isFinite(value) && value >= 0)
      saved = value;
  } catch {
    // Storage can be unavailable or contain data from an older browser session.
  }
  let active = true;
  let restored = saved === null;
  let latest = 0;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!dirty) return;
    dirty = false;
    if (latest === saved) return;
    try {
      localStorage.setItem(key, String(latest));
      saved = latest;
    } catch {
      // Reading and editing must continue when storage is full or blocked.
    }
  };
  const record = () => {
    if (!restored) return;
    latest = Math.max(0, pane.scrollTop);
    dirty = true;
  };
  const scroll = () => {
    record();
    clearTimeout(timer);
    timer = setTimeout(flush, 500);
  };
  const leaving = () => {
    record();
    flush();
  };
  const visibility = () => {
    if (document.visibilityState === "hidden") leaving();
  };
  const inputs = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
  const stopRestoring = () => {
    restored = true;
    for (const event of inputs) pane.removeEventListener(event, stopRestoring);
  };
  if (saved !== null) {
    for (const event of inputs)
      pane.addEventListener(event, stopRestoring, { passive: true });
    // Wait for CodeMirror's initial layout, including its virtual document
    // height. Never keep correcting scroll after the reader takes control.
    view.requestMeasure({
      read: () => Math.max(0, pane.scrollHeight - pane.clientHeight),
      write: (limit) => {
        if (!active || restored) return;
        pane.scrollTop = Math.min(saved!, limit);
        stopRestoring();
      },
    });
  }
  pane.addEventListener("scroll", scroll, { passive: true });
  window.addEventListener("pagehide", leaving);
  document.addEventListener("visibilitychange", visibility);
  return () => {
    active = false;
    flush();
    stopRestoring();
    pane.removeEventListener("scroll", scroll);
    window.removeEventListener("pagehide", leaving);
    document.removeEventListener("visibilitychange", visibility);
  };
}
