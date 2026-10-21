import { Prec, type Extension, type Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ySyncAnnotation } from "y-codemirror.next";

// Mobile contenteditable can report deleting the preceding line's first letter
// instead of its break. Capture the caret intent from beforeinput and apply it
// through normal transactions, including comment/permission guards.
export function lineBackspaceIntent(): Extension {
  let lineBackspace: { doc: Text; head: number } | null = null;
  return [
    Prec.highest(
      EditorView.domEventHandlers({
        beforeinput(event, view) {
          const { state } = view;
          const caret = state.selection.main;
          lineBackspace =
            event.inputType === "deleteContentBackward" &&
            !event.isComposing &&
            !view.composing &&
            !state.readOnly &&
            state.selection.ranges.length === 1 &&
            caret.empty &&
            caret.head > 0 &&
            state.doc.lineAt(caret.head).from === caret.head
              ? { doc: state.doc, head: caret.head }
              : null;
          return false;
        },
      }),
    ),
    EditorView.inputHandler.of((view) => {
      const intended = lineBackspace;
      lineBackspace = null;
      if (
        !intended ||
        view.state.readOnly ||
        view.composing ||
        view.state.doc !== intended.doc
      )
        return false;
      view.dispatch({
        changes: { from: intended.head - 1, to: intended.head },
        selection: { anchor: intended.head - 1 },
        userEvent: "delete.backward",
        scrollIntoView: true,
      });
      return true;
    }),
    EditorView.updateListener.of((u) => {
      if (!u.docChanged) return;
      // Remote edits between beforeinput and input move the captured caret.
      if (
        lineBackspace &&
        u.transactions.every((tr) => tr.annotation(ySyncAnnotation))
      ) {
        const head = u.changes.mapPos(lineBackspace.head, -1);
        lineBackspace =
          head > 0 && u.state.sliceDoc(head - 1, head) === "\n"
            ? { doc: u.state.doc, head }
            : null;
      } else lineBackspace = null;
    }),
  ];
}
