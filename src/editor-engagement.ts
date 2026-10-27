import {
  StateEffect,
  StateField,
  Transaction,
  type EditorState,
  type SelectionRange,
} from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

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

// Hold the preview while a touch places the caret or selects text. A completed
// tap can reveal source at a caret; a text range keeps its geometry until an
// edit or keyboard navigation so native copy/paste callouts stay anchored.
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

// A click may arrive before CodeMirror reads the native selection. Keep that
// pending gesture outside editor state: dispatching early could interfere with
// an unread native change. A range never releases the hold; a settled caret does.
const touchTaps = ViewPlugin.fromClass(
  class {
    pending = false;
    frame: number | undefined;
    constructor(readonly view: EditorView) {}
    update(update: ViewUpdate) {
      if (this.pending && (update.selectionSet || update.focusChanged))
        this.schedule();
    }
    schedule() {
      // Finish after CodeMirror's queued focus and selection effects, not
      // during its update. Coalesce into one pending frame, without polling.
      this.frame ??=
        this.view.dom.ownerDocument.defaultView!.requestAnimationFrame(() => {
          this.frame = undefined;
          this.finish();
        });
    }
    finish() {
      if (!this.pending) return;
      const view = this.view;
      const selection = view.contentDOM.ownerDocument.getSelection();
      if (
        !view.hasFocus ||
        !view.state.field(heldPreview) ||
        !selection?.isCollapsed ||
        !selection.anchorNode ||
        !view.contentDOM.contains(selection.anchorNode)
      ) {
        this.pending = false;
        return;
      }
      if (
        !view.state.selection.main.empty ||
        view.posAtDOM(selection.anchorNode, selection.anchorOffset) !==
          view.state.selection.main.head
      )
        return;
      this.pending = false;
      view.dispatch({ effects: [nativeSelection.of(null), engage.of(null)] });
    }
    cancel() {
      this.pending = false;
      if (this.frame !== undefined) {
        this.view.dom.ownerDocument.defaultView!.cancelAnimationFrame(
          this.frame,
        );
        this.frame = undefined;
      }
    }
    destroy() {
      this.cancel();
    }
  },
  {
    eventObservers: {
      pointerdown() {
        this.cancel();
      },
      click(_event, view) {
        if (!view.state.field(heldPreview)) return;
        this.pending = true;
        this.schedule();
      },
    },
  },
);

// One shared instance, so reconfiguring the preview keeps its value.
export const userEngagement = [
  engagement,
  heldPreview,
  touchTaps,
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
