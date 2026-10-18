import type { EditorView } from "@codemirror/view";
import * as Y from "yjs";

// This is browser reading state, never document content or collaborative state.
// Pixels are not a reading position: CodeMirror estimates the height of text it
// has not drawn yet, and wrapping follows the window width. Remember the text at
// the top of the pane instead, relative to the CRDT so edits above it cannot
// move the reader, plus how far that line was scrolled past the pane's top.
type Reading = { at: unknown; pos: number; offset: number };

function load(key: string): Reading | number | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || "null");
    // Earlier versions remembered a pixel offset. Restore it once, then
    // replace it with a text position on the next scroll.
    if (typeof value === "number")
      return Number.isFinite(value) && value >= 0 ? value : null;
    if (!value || typeof value !== "object") return null;
    const { at, pos, offset } = value as Record<string, unknown>;
    if (
      Number.isInteger(pos) &&
      (pos as number) >= 0 &&
      typeof offset === "number" &&
      Number.isFinite(offset)
    )
      return { at, pos: pos as number, offset };
  } catch {
    // Storage can be unavailable or contain data from an older browser session.
  }
  return null;
}

export function rememberEditorScroll(
  view: EditorView,
  key: string,
  text: Y.Text,
) {
  const pane = view.dom.closest<HTMLElement>(".writing-pane");
  if (!pane) return;
  const saved = load(key);
  let active = true;
  let restored = saved === null;
  let latest: string | null = null;
  let stored: string | null = null;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!dirty || latest === null) return;
    dirty = false;
    if (latest === stored) return;
    try {
      localStorage.setItem(key, latest);
      stored = latest;
    } catch {
      // Reading and editing must continue when storage is full or blocked.
    }
  };
  // Read only drawn lines: the visible top is measured, nothing above it.
  const position = () => {
    const top = pane.getBoundingClientRect().top;
    let pos = 0;
    let offset = top - view.documentTop;
    if (offset > 0) {
      const left = view.contentDOM.getBoundingClientRect().left + 1;
      pos = view.posAtCoords({ x: left, y: top + 1 }, false);
      const line = view.coordsAtPos(pos, 1);
      offset = line ? top - line.top : 0;
    }
    return JSON.stringify({
      at: Y.relativePositionToJSON(
        Y.createRelativePositionFromTypeIndex(text, pos),
      ),
      pos,
      offset: Math.round(offset),
    });
  };
  const keep = (value: string) => {
    if (!restored) return;
    latest = value;
    dirty = true;
  };
  const record = () => {
    try {
      keep(position());
    } catch {
      // Layout can be unavailable while the editor is detached or closing.
    }
  };
  // A scroll event can arrive before CodeMirror draws the newly visible text.
  // Its measure phase runs after that layout, so read the position there.
  const recording = {};
  const scroll = () => {
    if (restored)
      view.requestMeasure({ key: recording, read: position, write: keep });
    clearTimeout(timer);
    timer = setTimeout(flush, 500);
  };
  const leaving = () => {
    if (restored) record();
    flush();
  };
  const visibility = () => {
    if (document.visibilityState === "hidden") leaving();
  };
  // Any reader input, including a sidebar click that jumps to a comment,
  // hands scrolling back to the reader.
  const inputs = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
  const stopRestoring = () => {
    restored = true;
    for (const event of inputs)
      window.removeEventListener(event, stopRestoring, true);
  };
  // The pane, not CodeMirror's own scroller, scrolls. Lines above the target
  // keep changing height while CodeMirror measures them, so keep aligning the
  // saved line until it holds still or the reader takes control.
  const align = (target: number, offset: number, frame = 0, still = 0) => {
    view.requestMeasure({
      read: () => {
        const line =
          view.coordsAtPos(target, 1)?.top ??
          view.documentTop + view.lineBlockAt(target).top;
        return line + offset - pane.getBoundingClientRect().top;
      },
      write: (delta) => {
        if (!active || restored) return;
        const before = pane.scrollTop;
        if (Math.abs(delta) >= 1) pane.scrollTop = before + delta;
        const settled = Math.abs(pane.scrollTop - before) < 1 ? still + 1 : 0;
        if (settled >= 10 || frame >= 120) stopRestoring();
        else align(target, offset, frame + 1, settled);
      },
    });
  };
  if (saved !== null) {
    for (const event of inputs)
      window.addEventListener(event, stopRestoring, {
        capture: true,
        passive: true,
      });
    if (typeof saved === "number") {
      view.requestMeasure({
        read: () => Math.max(0, pane.scrollHeight - pane.clientHeight),
        write: (limit) => {
          if (!active || restored) return;
          pane.scrollTop = Math.min(saved, limit);
          stopRestoring();
        },
      });
    } else {
      let pos = saved.pos;
      try {
        const absolute = Y.createAbsolutePositionFromRelativePosition(
          Y.createRelativePositionFromJSON(saved.at),
          text.doc!,
        );
        if (absolute?.type === text) pos = absolute.index;
      } catch {
        // A position from an older collaboration generation keeps its index.
      }
      align(Math.min(pos, view.state.doc.length), saved.offset);
    }
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
