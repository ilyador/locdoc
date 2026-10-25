import { StateEffect } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import * as Y from "yjs";

// Keep the caret clear of the keyboard using CodeMirror's own scrolling.
// WebKit rounds scrollTop: once the caret is within one pixel of its target,
// consume the request instead of retrying that fraction on every keystroke.
const keyboardMargins = { top: 24, bottom: 24 };
export const keyboardCaretScroll = [
  ViewPlugin.define((view) => {
    const pane = view.dom.closest<HTMLElement>(".writing-pane");
    const win = view.dom.ownerDocument.defaultView;
    if (!pane || !win) return {};
    let height = pane.clientHeight;
    let frame: number | undefined;
    const resize = new ResizeObserver(() => {
      const next = pane.clientHeight;
      const shrank = next < height - 1;
      height = next;
      if (!shrank) return;
      if (frame !== undefined) win.cancelAnimationFrame(frame);
      // The keyboard resizes the pane after Safari's initial caret reveal.
      // Ask the editor to reveal it again in the final, smaller viewport.
      frame = win.requestAnimationFrame(() => {
        frame = undefined;
        if (
          view.hasFocus &&
          view.state.selection.main.empty &&
          pane.ownerDocument.documentElement.hasAttribute("data-keyboard-open")
        )
          view.dispatch({
            effects: EditorView.scrollIntoView(view.state.selection.main),
          });
      });
    });
    resize.observe(pane);
    return {
      destroy() {
        resize.disconnect();
        if (frame !== undefined) win.cancelAnimationFrame(frame);
      },
    };
  }),
  EditorView.scrollMargins.of((view) =>
    view.dom.ownerDocument.documentElement.hasAttribute("data-keyboard-open")
      ? keyboardMargins
      : null,
  ),
  EditorView.scrollHandler.of((view, range, options) => {
    const doc = view.dom.ownerDocument;
    if (
      !doc.documentElement.hasAttribute("data-keyboard-open") ||
      !view.hasFocus ||
      !range.empty ||
      range.head !== view.state.selection.main.head ||
      options.y !== "nearest" ||
      options.x !== "nearest"
    )
      return false;
    const pane = view.dom.closest<HTMLElement>(".writing-pane");
    if (!pane) return false;
    // Scroll handlers run during a view update, when coordsAtPos cannot be
    // called. Its already-drawn DOM position is safe to measure here.
    const { node, offset } = view.domAtPos(range.head, range.assoc || 1);
    const native = doc.createRange();
    native.setStart(node, offset);
    native.collapse(true);
    const caret = native.getBoundingClientRect();
    if (!caret.height) return false;
    const bounds = pane.getBoundingClientRect();
    const margins = { top: 0, bottom: 0, left: 0, right: 0 };
    for (const source of view.state.facet(EditorView.scrollMargins)) {
      const margin = source(view);
      if (margin)
        for (const side of ["top", "bottom", "left", "right"] as const)
          margins[side] = Math.max(margins[side], margin[side] || 0);
    }
    return (
      caret.top >= bounds.top + margins.top + options.yMargin - 1 &&
      caret.bottom <= bounds.bottom - margins.bottom - options.yMargin + 1 &&
      caret.left >= bounds.left + margins.left + options.xMargin - 1 &&
      caret.right <= bounds.right - margins.right - options.xMargin + 1
    );
  }),
];

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
    if (!active || !readerControlled) return;
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
      view.requestMeasure({
        key: recording,
        read: () => (active ? position() : null),
        write: (value) => {
          if (value !== null) keep(value);
        },
      });
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
  // Only the document pane may scroll. CodeMirror's default scrolling also
  // walks page ancestors and can invoke native viewport scrolling on iOS.
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
      const alignment = {};
      const align = () =>
        view.requestMeasure({
          key: alignment,
          read: () => {
            if (!active || readerControlled) return 0;
            const pos = target();
            const top = canvas
              ? view.documentTop
              : (view.coordsAtPos(pos, 1)?.top ??
                view.documentTop + view.lineBlockAt(pos).top);
            return top + saved.offset - pane.getBoundingClientRect().top;
          },
          write: (delta) => {
            // Virtualized text can resize as it is measured. Once aligned,
            // leave the scroll layer alone instead of reissuing a scroll.
            if (active && !readerControlled && Math.abs(delta) >= 1)
              pane.scrollTop += delta;
          },
        });
      // Text CodeMirror has not drawn has only an estimated place, and WebKit
      // can move a pane that jumped there back up while CodeMirror draws the
      // new lines. So CodeMirror's own scroll request draws the text first.
      // This handler ends each request the restore made, after reader input
      // too, so CodeMirror never scrolls page ancestors for it. Like
      // CodeMirror's own scrolling, it moves the pane now, so CodeMirror
      // draws around the new position in the same pass. Only the line's
      // block can be read during an update: the alignment within the line
      // follows in this pass, and once more after the drawn lines settle.
      let request: unknown = null;
      let handling = false;
      const scrolled = (_: EditorView, __: unknown, options: unknown) => {
        if (options !== request) return false;
        request = null;
        if (active && !readerControlled)
          pane.scrollTop +=
            view.documentTop +
            view.lineBlockAt(target()).top +
            saved.offset -
            pane.getBoundingClientRect().top;
        align();
        realign();
        return true;
      };
      const restore = () => {
        if (!active || readerControlled) return;
        const pos = target();
        if (!canvas && (pos < view.viewport.from || pos > view.viewport.to)) {
          const scroll = EditorView.scrollIntoView(pos, { y: "start" });
          request = scroll.value;
          view.dispatch({
            effects: handling
              ? scroll
              : [
                  StateEffect.appendConfig.of(
                    EditorView.scrollHandler.of(scrolled),
                  ),
                  scroll,
                ],
          });
          handling = true;
          return;
        }
        align();
      };
      const realign = () => {
        if (!active || readerControlled || frame !== undefined) return;
        frame = window.requestAnimationFrame(() => {
          frame = undefined;
          restore();
        });
      };
      if (typeof ResizeObserver !== "undefined") {
        resize = new ResizeObserver(realign);
        resize.observe(pane);
        resize.observe(view.contentDOM);
      }
      fontChanged = realign;
      document.fonts?.addEventListener("loadingdone", fontChanged);
      void document.fonts?.ready.then(realign);
      restore();
    }
  }
  pane.addEventListener("scroll", scroll, { passive: true });
  pane.addEventListener("scrollend", leaving);
  window.addEventListener("pagehide", leaving);
  document.addEventListener("visibilitychange", visibility);
  return () => {
    if (!active) return;
    leaving();
    active = false;
    stopRestoring();
    pane.removeEventListener("scroll", scroll);
    pane.removeEventListener("scrollend", leaving);
    window.removeEventListener("pagehide", leaving);
    document.removeEventListener("visibilitychange", visibility);
  };
}
