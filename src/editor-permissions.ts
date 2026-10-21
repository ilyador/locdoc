import { EditorState, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { yUndoManagerKeymap } from "y-codemirror.next";

export function editorAccess(editable: boolean) {
  return [EditorState.readOnly.of(!editable), EditorView.editable.of(editable)];
}

// yCollab handles native historyUndo/historyRedo independently of its keymap.
// Intercept before that plugin after a permission change.
export const readOnlyInputGuard = Prec.highest(
  EditorView.domEventHandlers({
    beforeinput(event, view) {
      if (!view.state.readOnly) return false;
      event.preventDefault();
      return true;
    },
  }),
);

// Third-party undo bindings do not check read-only state themselves.
export const guardedUndoKeymap = yUndoManagerKeymap.map((binding) => ({
  ...binding,
  run: (view: EditorView) => !view.state.readOnly && !!binding.run?.(view),
  shift: binding.shift
    ? (view: EditorView) => !view.state.readOnly && binding.shift!(view)
    : undefined,
}));
