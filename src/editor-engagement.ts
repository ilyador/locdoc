import {
  StateEffect,
  StateField,
  Transaction,
  type EditorState,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";

// A new editor starts with its caret at the start of the document, where
// nobody placed it. That selection reveals no source: until the user first
// engages with the editor, by focusing it or with a transaction that carries
// a user event (a click, arrow keys, typing, find stepping through matches),
// every line renders as if no selection touched it. Remote edits, draft
// recovery, scroll restore and comment navigation carry no user event.
const engage = StateEffect.define<null>();

export const engagement = StateField.define<boolean>({
  create: () => false,
  update: (engaged, tr) =>
    engaged ||
    tr.annotation(Transaction.userEvent) !== undefined ||
    tr.effects.some((effect) => effect.is(engage)),
});

// One shared instance, so reconfiguring the preview keeps its value.
export const userEngagement = [
  engagement,
  EditorView.focusChangeEffect.of((state, focusing) =>
    focusing && !state.field(engagement, false) ? engage.of(null) : null,
  ),
];

// Whether the preview reveals the source that the selection touches.
export function selectionReveals(state: EditorState) {
  return !state.readOnly && state.field(engagement, false) === true;
}
