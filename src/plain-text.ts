import { EditorState, StateField, type ChangeSet } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  placeholder,
  type DecorationSet,
} from "@codemirror/view";
import { plainCommentRecords, sourceCommentRanges } from "./editor-comments";

type Range = { from: number; to: number };
const paragraphEnd = Decoration.line({ class: "text-block-end" });

// Every explicit line break ends a plain-text paragraph, as in Markdown prose;
// natural wrapping does not. Lines holding only hidden comment records stay
// tight, so a conversation adds no visible gap.
function paragraphEnds(state: EditorState, from: number, to: number) {
  const hidden = sourceCommentRanges(state);
  const ends: ReturnType<typeof paragraphEnd.range>[] = [];
  let next = 0;
  while (next < hidden.length && hidden[next].to <= from) next++;
  for (let pos = from; pos <= to;) {
    const line = state.doc.lineAt(pos);
    while (next < hidden.length && hidden[next].to <= line.from) next++;
    let start = line.from,
      visible = false;
    for (let i = next; i < hidden.length && hidden[i].from < line.to; i++) {
      if (
        hidden[i].from > start &&
        /\S/.test(state.sliceDoc(start, hidden[i].from))
      ) {
        visible = true;
        break;
      }
      start = Math.max(start, hidden[i].to);
    }
    if (
      visible ||
      (start < line.to && /\S/.test(state.sliceDoc(start, line.to)))
    )
      ends.push(paragraphEnd.range(line.from));
    pos = line.to + 1;
  }
  return ends;
}

function sameHidden(before: Range[], after: Range[], changes: ChangeSet) {
  return (
    before.length === after.length &&
    before.every(
      (range, i) =>
        changes.mapPos(range.from, 1) === after[i].from &&
        changes.mapPos(range.to, -1) === after[i].to,
    )
  );
}

const plainTextLayout = StateField.define<DecorationSet>({
  create: (state) =>
    Decoration.set(paragraphEnds(state, 0, state.doc.length), true),
  update(value, tr) {
    if (!tr.docChanged) return value;
    // A new, removed or reinterpreted comment can change which other lines
    // have visible text. Otherwise only the edited lines need measuring.
    if (
      !sameHidden(
        sourceCommentRanges(tr.startState),
        sourceCommentRanges(tr.state),
        tr.changes,
      )
    )
      return Decoration.set(
        paragraphEnds(tr.state, 0, tr.state.doc.length),
        true,
      );
    let next = value.map(tr.changes);
    tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
      const from = tr.state.doc.lineAt(fromB).from;
      const to = tr.state.doc.lineAt(toB).to;
      next = next.update({
        filterFrom: from,
        filterTo: to,
        filter: (at) => at < from || at > to,
        add: paragraphEnds(tr.state, from, to),
        sort: true,
      });
    });
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

// Plain text is edited as it is stored: no Markdown parser, preview widgets,
// media, link or formatting commands. Comments and permissions come from the
// shared editor extensions, reading records without Markdown rules.
export const plainTextSupport = [
  plainCommentRecords.of(true),
  plainTextLayout,
  EditorView.editorAttributes.of({ class: "text-editor" }),
  placeholder("Start writing."),
  EditorView.contentAttributes.of({
    "aria-label": "Plain text document",
    spellcheck: "true",
    "data-gramm": "false",
  }),
];
