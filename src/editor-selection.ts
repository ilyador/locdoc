import {
  drawSelection,
  EditorView,
  layer,
  RectangleMarker,
} from "@codemirror/view";

// iOS draws the primary selection natively, so its color vanishes when a menu
// takes focus. Draw the editor's retained ranges behind its text while unfocused,
// without changing native selection, moving focus or decorating the text DOM.
export const documentSelection = [
  drawSelection(),
  layer({
    above: false,
    class: "cm-inactiveSelectionLayer",
    markers(view) {
      return view.hasFocus
        ? []
        : view.state.selection.ranges.flatMap((range) =>
            range.empty
              ? []
              : RectangleMarker.forRange(view, "cm-selectionBackground", range),
          );
    },
    update: (update) =>
      update.docChanged ||
      update.selectionSet ||
      update.viewportChanged ||
      update.focusChanged,
  }),
  EditorView.baseTheme({
    // One selection background per range on desktop as well as iOS.
    "&:not(.cm-focused) > .cm-scroller > .cm-selectionLayer .cm-selectionBackground":
      {
        visibility: "hidden",
      },
  }),
];
