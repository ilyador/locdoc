import { ChangeSet, EditorState, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ySyncAnnotation } from "y-codemirror.next";

export const lineEndingError =
  "This document has incompatible line endings. Editing is paused until it reconnects with the server.";

// Remote text containing CR keeps its exact CRDT offsets. Editing pauses until
// the session reconnects instead of rewriting it locally.
export function lineEndingAccess(invalid: boolean) {
  return invalid
    ? [
        Prec.highest(EditorState.readOnly.of(true)),
        Prec.highest(EditorView.editable.of(false)),
      ]
    : [];
}

// Pasted CRLF/lone CR becomes canonical LF before yCollab sees it.
// Remote data keeps exact offsets and is guarded by lineEndingAccess instead.
export const canonicalLineEndings = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.annotation(ySyncAnnotation)) return tr;
  const corrections: { from: number; to: number; insert: string }[] = [];
  tr.changes.iterChanges((_from, _to, fromB, _toB, inserted) => {
    for (const match of inserted.toString().matchAll(/\r\n?/g))
      corrections.push({
        from: fromB + match.index,
        to: fromB + match.index + match[0].length,
        insert: "\n",
      });
  });
  if (!corrections.length) return tr;
  const changes = ChangeSet.of(corrections, tr.newDoc.length, "\n");
  return [
    tr,
    {
      changes,
      selection: tr.newSelection.map(changes),
      sequential: true,
    },
  ];
});
