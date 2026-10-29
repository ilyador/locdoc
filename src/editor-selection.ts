import {
  Direction,
  drawSelection,
  EditorView,
  layer,
  RectangleMarker,
} from "@codemirror/view";

function selectionMarkers(view: EditorView) {
  const ranges: { from: number; to: number }[] = [];
  for (const range of view.state.selection.ranges) {
    if (range.empty) continue;
    for (const visible of view.visibleRanges) {
      const from = Math.max(range.from, visible.from);
      const to = Math.min(range.to, visible.to);
      if (from < to) ranges.push({ from, to });
    }
  }
  if (!ranges.length) return [];
  const bounds = view.scrollDOM.getBoundingClientRect();
  const left =
    (view.textDirection === Direction.LTR
      ? bounds.left
      : bounds.right - view.scrollDOM.clientWidth * view.scaleX) -
    view.scrollDOM.scrollLeft * view.scaleX;
  const top = bounds.top - view.scrollDOM.scrollTop * view.scaleY;
  const selection = view.dom.ownerDocument.createRange();
  const markers: RectangleMarker[] = [];
  // Measure rendered line fragments, never the whole document. Native range
  // geometry already handles wrapping, mixed directions and inline fonts.
  // Keeping each range inside a line also excludes intervening comment widgets.
  for (const line of view.contentDOM.querySelectorAll(".cm-line")) {
    if (line.closest(".cm-content") !== view.contentDOM) continue;
    const start = view.posAtDOM(line, 0);
    const end = view.posAtDOM(line, line.childNodes.length);
    for (const range of ranges) {
      const from = Math.max(start, range.from);
      const to = Math.min(end, range.to);
      if (from < to) {
        const first =
          from === start ? { node: line, offset: 0 } : view.domAtPos(from, 1);
        const last =
          to === end
            ? { node: line, offset: line.childNodes.length }
            : view.domAtPos(to, -1);
        selection.setStart(first.node, first.offset);
        selection.setEnd(last.node, last.offset);
        for (const rect of selection.getClientRects())
          if (rect.width > 0 && rect.height > 0)
            markers.push(
              new RectangleMarker(
                "cm-selectionBackground",
                rect.left - left,
                rect.top - top,
                rect.width,
                rect.height,
              ),
            );
      }
      // A selected newline has no glyph box. Give it one character's width,
      // including on blank lines, without painting paragraph padding or widgets.
      if (
        range.from <= end &&
        range.to > end &&
        view.state.doc.lineAt(end).to === end
      ) {
        const caret = view.coordsAtPos(end, -1);
        if (caret) {
          const width = view.defaultCharacterWidth * view.scaleX;
          markers.push(
            new RectangleMarker(
              "cm-selectionBackground",
              caret.left -
                left -
                (view.textDirectionAt(end) === Direction.RTL ? width : 0),
              caret.top - top,
              width,
              caret.bottom - caret.top,
            ),
          );
        }
      }
    }
  }
  return markers;
}

// Own the selection background independently of focus: iOS can hide its native
// highlight for a context menu without blurring the editor. Keep CodeMirror's
// caret and iOS handles, and leave the native selection and text DOM untouched.
export const documentSelection = [
  drawSelection(),
  layer({
    above: false,
    class: "cm-documentSelectionLayer",
    markers: selectionMarkers,
    update: (update) =>
      update.docChanged || update.selectionSet || update.viewportChanged,
  }),
  EditorView.baseTheme({
    // One painter for backgrounds; the built-in layer still owns iOS handles.
    ".cm-selectionLayer .cm-selectionBackground": { visibility: "hidden" },
    ".cm-line::selection, .cm-line ::selection": {
      backgroundColor: "transparent !important",
    },
    // Inputs embedded in widgets retain their own native selection styling.
    ".cm-content :focus::selection, .cm-content :focus ::selection": {
      backgroundColor: "Highlight !important",
    },
  }),
];
