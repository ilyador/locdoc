import {
  Facet,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from "@codemirror/state";
import { BlockWrapper, Decoration, EditorView } from "@codemirror/view";
import { commentParser } from "./comment-syntax";
import {
  shownLines,
  sourceCommentRanges,
  visibleTextRanges,
} from "./editor-comments";
import {
  parseFountain,
  type FountainKind,
  type FountainScript,
} from "./fountain";
import { emphasisContentRange } from "./emphasis-range";
import { directionSyntax } from "./text-direction";

// Reuse the established delimiter parser, with Fountain's underscore semantics.
// Prefixing each isolated line prevents Markdown block rules from reclassifying it.
export const fountainInlineParser = commentParser.configure({
  remove: ["InlineCode", "HTMLTag", "Autolink", "Link", "Image"],
});
export const fountainScript = Facet.define<
  FountainScript,
  FountainScript | null
>({ combine: (values) => values[0] ?? null });

// One value for each kind of decoration, which every line of that kind
// shares: a long script allocates and compares a few values, not one or more
// for each of its lines.
const blockEnd = Decoration.line({ class: "fountain-block-end" });
const hide = Decoration.replace({});
const breakSource = Decoration.mark({ class: "fountain-break-source" });
const dualMarker = Decoration.mark({
  class: "fountain-dual-marker",
  attributes: { title: "Simultaneous dialogue" },
});
const underline = Decoration.mark({ class: "fountain-underline" });
const strong = Decoration.mark({ class: "md-strong" });
const italic = Decoration.mark({ class: "md-em" });
const noteInk = Decoration.mark({ class: "fountain-note-ink" });
const omittedInk = Decoration.mark({ class: "fountain-omitted-ink" });
const wrappers = new Map<FountainKind, BlockWrapper>();
function wrapper(kind: FountainKind) {
  let value = wrappers.get(kind);
  if (!value) {
    value = BlockWrapper.create({
      tagName: "div",
      attributes: { class: `fountain-line fountain-${kind}` },
    });
    wrappers.set(kind, value);
  }
  return value;
}

const focus = StateEffect.define<boolean>();
const editingLine = (state: EditorState, focused: boolean) =>
  focused &&
  !state.readOnly &&
  state.selection.ranges.length === 1 &&
  state.selection.main.empty
    ? state.doc.lineAt(state.selection.main.head).number - 1
    : undefined;
// The lines whose markers show: those a selection touches, while the view
// has focus and accepts edits.
const revealedLines = (state: EditorState, focused: boolean) =>
  state.readOnly || !focused
    ? ""
    : state.selection.ranges
        .map(
          (range) =>
            `${state.doc.lineAt(range.from).number}:${state.doc.lineAt(range.to).number}`,
        )
        .join(",");

function build(state: EditorState, script: FountainScript, focused: boolean) {
  const marks: ReturnType<Decoration["range"]>[] = [];
  const blocks: ReturnType<BlockWrapper["range"]>[] = [];
  const active =
    state.readOnly || !focused
      ? []
      : state.selection.ranges.map((r) => ({
          from: state.doc.lineAt(r.from).from,
          to: state.doc.lineAt(r.to).to,
        }));
  // A line whose text shows in a record's line reveals its markers as
  // that one displayed line.
  const visibleLineStarts = shownLines(state).at;
  const inactive = (from: number, to: number) => {
    const start = visibleLineStarts.get(from) ?? from;
    return !active.some((r) => r.from <= to && r.to >= start);
  };
  for (const line of script.lines) {
    // Standalone comments hide their trailing newline. An empty wrapper at
    // that position would take the following visible line's formatting.
    if (
      line.kind === "note" &&
      !visibleTextRanges(state, line.from, line.to).some((part) =>
        state.sliceDoc(part.from, part.to).trim(),
      )
    )
      continue;
    const from = visibleLineStarts.get(line.from) ?? line.from;
    // Explicit source lines get breathing room; wrapping remains within the
    // same measured line. Keep cues, parentheticals and blank rows attached.
    if (
      (line.kind === "action" ||
        line.kind === "dialogue" ||
        line.kind === "lyric" ||
        line.kind === "centered") &&
      line.text.trim()
    )
      marks.push(blockEnd.range(from));
    blocks.push(wrapper(line.kind).range(from, line.to));
    if (line.markers.length && inactive(line.from, line.to))
      for (const range of line.markers)
        if (!(line.kind === "character" && range === line.suffix))
          for (const part of visibleTextRanges(state, range.from, range.to))
            if (part.to > part.from) marks.push(hide.range(part.from, part.to));
    if (line.kind === "character" && line.suffix)
      for (const part of visibleTextRanges(
        state,
        line.suffix.from,
        line.suffix.to,
      ))
        if (part.to > part.from)
          marks.push(dualMarker.range(part.from, part.to));
    if (line.kind === "break") {
      marks.push(
        (inactive(line.from, line.to) ? hide : breakSource).range(
          line.from,
          line.to,
        ),
      );
      continue;
    }
    const source = state.sliceDoc(line.from, line.to);
    if (!/[*_\\]/.test(source) || line.kind === "omitted") continue;
    fountainInlineParser.parse("x " + source).iterate({
      enter(node) {
        const from = line.from + node.from - 2,
          to = line.from + node.to - 2;
        if (from < line.from || to > line.to) return;
        if (node.name === "Emphasis" || node.name === "StrongEmphasis") {
          const content = emphasisContentRange(node);
          marks.push(
            (state.sliceDoc(from, from + 1) === "_"
              ? underline
              : node.name === "StrongEmphasis"
                ? strong
                : italic
            ).range(line.from + content.from - 2, line.from + content.to - 2),
          );
        }
        if (
          (node.name === "EmphasisMark" || node.name === "Escape") &&
          inactive(line.from, line.to)
        )
          marks.push(hide.range(from, node.name === "Escape" ? from + 1 : to));
      },
    });
  }
  for (const range of script.notes)
    marks.push(noteInk.range(range.from, range.to));
  for (const range of script.omissions)
    marks.push(omittedInk.range(range.from, range.to));
  return {
    script,
    focused,
    editingLine: editingLine(state, focused),
    revealed: revealedLines(state, focused),
    records: sourceCommentRanges(state),
    decorations: Decoration.set(marks, true),
    wrappers: BlockWrapper.set(blocks, true),
  };
}
const field = StateField.define<ReturnType<typeof build>>({
  create: (state) => build(state, parseFountain(state.doc.toString()), false),
  update(value, tr) {
    const focused =
      tr.effects.find((effect) => effect.is(focus))?.value ?? value.focused;
    const context = editingLine(tr.state, focused);
    if (tr.docChanged || context !== value.editingLine)
      return build(
        tr.state,
        parseFountain(tr.state.doc.toString(), context),
        focused,
      );
    // Without an edit, the layout changes only with the lines that show
    // their markers and the records that hide text: a selection elsewhere,
    // focus in a read-only view or a new configuration keeps it.
    if (
      revealedLines(tr.state, focused) !== value.revealed ||
      sourceCommentRanges(tr.state) !== value.records
    )
      return build(tr.state, value.script, focused);
    return focused === value.focused ? value : { ...value, focused };
  },
  provide: (field) => [
    fountainScript.from(field, (value) => value.script),
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.blockWrappers.from(field, (value) => value.wrappers),
  ],
});

// Every editor shares one preview, so a reconfigured compartment keeps it,
// with its parsed script and layout, rather than parsing the script again.
const preview: Extension = [
  field,
  EditorView.focusChangeEffect.of((_state, focused) => focus.of(focused)),
  // A title page key, such as Title:, is hidden like the other markers.
  directionSyntax.of(
    (state, line) =>
      state.facet(fountainScript)?.lines[line.number - 1]?.markers ?? [],
  ),
];

export function fountainPreview() {
  return preview;
}
