import {
  drawSelection,
  EditorView,
  layer,
  RectangleMarker,
} from "@codemirror/view";

// Own the selection background independently of focus: iOS can hide its native
// highlight for a context menu without blurring the editor. Keep CodeMirror's
// caret and iOS handles, and leave the native selection and text DOM untouched.
export const documentSelection = [
  drawSelection(),
  layer({
    above: false,
    class: "cm-documentSelectionLayer",
    markers(view) {
      return view.state.selection.ranges.flatMap((range) =>
        range.empty
          ? []
          : RectangleMarker.forRange(view, "cm-selectionBackground", range),
      );
    },
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
