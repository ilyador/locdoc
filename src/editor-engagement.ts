import {
  StateEffect,
  StateField,
  Transaction,
  type EditorState,
  type SelectionRange,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";

// A new editor starts with its caret at the start of the document, where
// nobody placed it. That selection reveals no source: until the user first
// engages with the editor, by focusing it or with a transaction that carries
// a user event (a click, arrow keys, typing, find stepping through matches),
// every line renders as if no selection touched it. Remote edits, draft
// recovery, scroll restore and comment navigation carry no user event.
const engage = StateEffect.define<null>();
const nativeSelection = StateEffect.define<readonly SelectionRange[] | null>();

export const engagement = StateField.define<boolean>({
  create: () => false,
  update: (engaged, tr) =>
    engaged ||
    tr.annotation(Transaction.userEvent) !== undefined ||
    tr.effects.some((effect) => effect.is(engage)),
});

// A native touch selection owns its geometry until the next actual edit or
// keyboard navigation. Revealing Markdown while iOS is choosing a word moves
// that word under its fingers and invalidates the native copy/paste callout.
const heldPreview = StateField.define<readonly SelectionRange[] | null>({
  create: () => null,
  update(held, tr) {
    for (const effect of tr.effects)
      if (effect.is(nativeSelection))
        return effect.value === null ? null : (held ?? effect.value);
    if (
      tr.docChanged &&
      tr.state.selection.main.empty &&
      tr.annotation(Transaction.userEvent) !== undefined
    )
      return null;
    return held && tr.docChanged
      ? held.map((range) => range.map(tr.changes))
      : held;
  },
});

// One shared instance, so reconfiguring the preview keeps its value.
export const userEngagement = [
  engagement,
  heldPreview,
  EditorView.domEventObservers({
    pointerdown(event, view) {
      if (event.pointerType === "touch" || event.pointerType === "pen")
        view.dispatch({
          effects: nativeSelection.of(
            previewSelection(view.state, view.hasFocus),
          ),
        });
      else if (
        event.pointerType === "mouse" &&
        view.state.field(heldPreview) !== null
      )
        view.dispatch({ effects: nativeSelection.of(null) });
    },
    keydown(event, view) {
      if (/^(Arrow|Home$|End$|PageUp$|PageDown$)/.test(event.key))
        view.dispatch({ effects: nativeSelection.of(null) });
    },
  }),
  EditorView.focusChangeEffect.of((state, focusing) =>
    focusing && !state.field(engagement, false) ? engage.of(null) : null,
  ),
];

export function previewSelection(
  state: EditorState,
  focused = true,
): readonly SelectionRange[] {
  if (state.readOnly) return [];
  const held = state.field(heldPreview, false);
  if (held) return held;
  return focused && state.field(engagement, false) !== false
    ? state.selection.ranges
    : [];
}
