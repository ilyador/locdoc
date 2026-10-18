import type { EditorView } from "@codemirror/view";
import * as Y from "yjs";

// This is browser reading state, never document content or collaborative state.
// Pixels are not a reading position: CodeMirror estimates the height of text it
// has not drawn yet, and wrapping follows the window width. Remember the text at
// the top of the pane instead, relative to the CRDT so edits above it cannot
// move the reader, plus how far that line was scrolled past the pane's top.
type Reading = { at: unknown; pos: number; offset: number; canvas?: boolean };

function load(key: string): Reading | number | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || "null");
    // Earlier versions remembered a pixel offset. Restore it once, then
    // replace it with a text position on the next scroll.
    if (typeof value === "number")
      return Number.isFinite(value) && value >= 0 ? value : null;
    if (!value || typeof value !== "object") return null;
    const { at, pos, offset, canvas } = value as Record<string, unknown>;
    if (
      Number.isInteger(pos) &&
      (pos as number) >= 0 &&
      typeof offset === "number" &&
      Number.isFinite(offset)
    )
      return {
        at,
        pos: pos as number,
        offset,
        ...(typeof canvas === "boolean" ? { canvas } : {}),
      };
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
  let readerControlled = saved === null;
  let latest: string | null = null;
  let stored: string | null = null;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let frame: number | undefined;
  let resize: ResizeObserver | undefined;
  let fontChanged: (() => void) | undefined;
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
    const canvas = offset <= 0;
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
      canvas,
    });
  };
  const keep = (value: string) => {
    if (!readerControlled) return;
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
    if (readerControlled)
      view.requestMeasure({ key: recording, read: position, write: keep });
    clearTimeout(timer);
    timer = setTimeout(flush, 500);
  };
  const leaving = () => {
    if (readerControlled) record();
    flush();
  };
  const visibility = () => {
    if (document.visibilityState === "hidden") leaving();
  };
  // Any reader input, including a sidebar click that jumps to a comment,
  // hands scrolling back to the reader.
  const inputs = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
  const stopRestoring = () => {
    readerControlled = true;
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    frame = undefined;
    resize?.disconnect();
    if (fontChanged)
      document.fonts?.removeEventListener("loadingdone", fontChanged);
    for (const event of inputs)
      window.removeEventListener(event, stopRestoring, true);
  };
  // The pane, not CodeMirror's own scroller, scrolls. Lines above the target
  // keep changing height while CodeMirror measures them. Wait for actual
  // animation frames: requestMeasure calls made inside its write callback can
  // otherwise run repeatedly in the same CodeMirror measurement loop.
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
          if (!active || readerControlled) return;
          pane.scrollTop = Math.min(saved, limit);
          stopRestoring();
        },
      });
    } else {
      let measured = false;
      let frames = 0;
      let still = 0;
      const alignment = {};
      // Canvas offsets were measured from the line box, not its glyphs. Their
      // tops can differ by a few pixels, which otherwise accumulates on reload.
      // Earlier records did not identify the canvas case explicitly.
      const canvas = saved.canvas ?? (saved.pos === 0 && saved.offset <= 0);
      const target = () => {
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
        return Math.min(pos, view.state.doc.length);
      };
      const align = () => {
        if (!active || readerControlled || frame !== undefined || measured)
          return;
        measured = true;
        view.requestMeasure({
          key: alignment,
          read: () => {
            if (!active || readerControlled) return 0;
            const pos = target();
            const line =
              (!canvas ? view.coordsAtPos(pos, 1)?.top : undefined) ??
              view.documentTop + view.lineBlockAt(pos).top;
            return line + saved.offset - pane.getBoundingClientRect().top;
          },
          write: (delta) => {
            measured = false;
            if (!active || readerControlled) return;
            const before = pane.scrollTop;
            if (Math.abs(delta) >= 1) pane.scrollTop = before + delta;
            still = Math.abs(pane.scrollTop - before) < 1 ? still + 1 : 0;
            if (++frames < 120 && still < 10) schedule();
          },
        });
      };
      const schedule = () => {
        if (!active || readerControlled || frame !== undefined || measured)
          return;
        frame = window.requestAnimationFrame(() => {
          frame = undefined;
          align();
        });
      };
      // Once settled, do no work until layout changes. Fonts, lazy media and
      // newly measured wrapped text may arrive later than the first frames.
      // Retain the anchor until reader input, so those changes cannot replace
      // it with an intermediate scroll position or move the page after reload.
      const realign = () => {
        frames = still = 0;
        align();
      };
      if (typeof ResizeObserver !== "undefined") {
        resize = new ResizeObserver(realign);
        resize.observe(pane);
        resize.observe(view.contentDOM);
      }
      fontChanged = realign;
      document.fonts?.addEventListener("loadingdone", fontChanged);
      void document.fonts?.ready.then(realign);
      align();
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
