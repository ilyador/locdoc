import {
  Facet,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type RangeSet,
  type Transaction,
} from "@codemirror/state";
import {
  BlockWrapper,
  Decoration,
  EditorView,
  type DecorationSet,
} from "@codemirror/view";
import { commentParser } from "./comment-syntax";
import {
  sameSourceComments,
  shownLines,
  sourceCommentRanges,
  visibleTextRanges,
} from "./editor-comments";
import {
  editFountain,
  moveEditingLine,
  parseFountain,
  type FountainKind,
  type FountainScript,
} from "./fountain";
import { emphasisContentRange } from "./emphasis-range";
import { directionSyntax } from "./text-direction";
import { previewSelection } from "./editor-engagement";
import { FountainSpeakerColors } from "./fountain-speaker-colors";

// Reuse the established delimiter parser, with Fountain's underscore semantics.
// Prefixing each isolated line prevents Markdown block rules from reclassifying it.
export const fountainInlineParser = commentParser.configure({
  remove: ["InlineCode", "HTMLTag", "Autolink", "Link", "Image"],
});
export const fountainScript = Facet.define<
  FountainScript,
  FountainScript | null
>({ combine: (values) => values[0] ?? null });
const speakerColorKey = Facet.define<string, string>({
  combine: (values) => values[0] ?? "",
});

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
const editingLine = (state: EditorState, focused: boolean) => {
  const ranges = previewSelection(state, focused);
  return ranges.length === 1 && ranges[0].empty
    ? state.doc.lineAt(ranges[0].head).number - 1
    : undefined;
};
// The lines whose markers show: those a selection touches, while the view
// has focus and accepts edits.
const revealedLines = (state: EditorState, focused: boolean) =>
  previewSelection(state, focused)
    .map(
      (range) =>
        `${state.doc.lineAt(range.from).number}:${state.doc.lineAt(range.to).number}`,
    )
    .join(",");

// The decorations and block wrappers of the script's lines at `indices`, or
// of every line and the ink of its notes and omissions.
function decorate(
  state: EditorState,
  script: FountainScript,
  focused: boolean,
  colors: FountainSpeakerColors,
  indices?: number[],
) {
  const marks: ReturnType<Decoration["range"]>[] = [];
  const blocks: ReturnType<BlockWrapper["range"]>[] = [];
  const active = previewSelection(state, focused).map((r) => ({
    from: state.doc.lineAt(r.from).from,
    to: state.doc.lineAt(r.to).to,
  }));
  const editing = editingLine(state, focused);
  // A line whose text shows in a record's line reveals its markers as
  // that one displayed line.
  const visibleLineStarts = shownLines(state).at;
  const inactive = (from: number, to: number) => {
    const start = visibleLineStarts.get(from) ?? from;
    return !active.some((r) => r.from <= to && r.to >= start);
  };
  // Register complete cues before drawing any of them: a pasted cast may
  // include the active cue again later. Draft prefixes do not fill storage.
  for (const index of indices ?? script.lines.keys()) {
    const line = script.lines[index];
    if (line.kind === "character" && index !== editing)
      colors.wrapper(line.text);
  }
  for (const index of indices ?? script.lines.keys()) {
    const line = script.lines[index];
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
    blocks.push(
      (line.kind === "character"
        ? colors.wrapper(line.text, false)
        : wrapper(line.kind)
      ).range(from, line.to),
    );
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
  if (!indices) {
    for (const range of script.notes)
      marks.push(noteInk.range(range.from, range.to));
    for (const range of script.omissions)
      marks.push(omittedInk.range(range.from, range.to));
  }
  colors.flush();
  return { marks, blocks };
}

type Preview = {
  colors: FountainSpeakerColors;
  script: FountainScript;
  focused: boolean;
  editingLine: number | undefined;
  revealed: string;
  records: ReturnType<typeof sourceCommentRanges>;
  decorations: DecorationSet;
  wrappers: RangeSet<BlockWrapper>;
};

function build(
  state: EditorState,
  script: FountainScript,
  focused: boolean,
  colors: FountainSpeakerColors,
): Preview {
  const { marks, blocks } = decorate(state, script, focused, colors);
  return {
    colors,
    script,
    focused,
    editingLine: editingLine(state, focused),
    revealed: revealedLines(state, focused),
    records: sourceCommentRanges(state),
    decorations: Decoration.set(marks, true),
    wrappers: BlockWrapper.set(blocks, true),
  };
}

// The preview after a transaction that changed only some lines: the lines
// that read otherwise, and those whose markers show or hide, are laid out
// again, and every other line keeps its layout, moved with the edit.
function relayout(
  value: Preview,
  tr: Transaction,
  script: FountainScript,
  changed: number[],
  focused: boolean,
): Preview {
  const state = tr.state;
  const revealed = revealedLines(state, focused);
  const lines = new Set(changed);
  if (revealed !== value.revealed)
    for (const [ranges, map] of [
      [previewSelection(tr.startState, value.focused), tr.docChanged],
      [previewSelection(state, focused), false],
    ] as const)
      for (const range of ranges) {
        const from = map ? tr.changes.mapPos(range.from, -1) : range.from;
        const to = map ? tr.changes.mapPos(range.to, 1) : range.to;
        for (
          let n = state.doc.lineAt(from).number;
          n <= state.doc.lineAt(to).number;
          n++
        )
          lines.add(n - 1);
      }
  // A record's own line shows the line after it, which lays out there.
  const shown = shownLines(state);
  for (const index of [...lines]) {
    const at = shown.of.get(script.lines[index].from);
    if (at !== undefined) lines.add(state.doc.lineAt(at).number - 1);
  }
  let decorations = value.decorations,
    wrappers = value.wrappers;
  if (tr.docChanged) {
    decorations = decorations.map(tr.changes);
    wrappers = wrappers.map(tr.changes);
  }
  const indices = [...lines].sort((a, b) => a - b);
  // Each run of adjacent lines laid out again goes as one.
  const clear = (from: number, to: number) => {
    decorations = decorations.update({
      filterFrom: from,
      filterTo: to,
      // Notes and omissions keep their ink, moved with the edit.
      filter: (a, b, mark) =>
        mark === noteInk || mark === omittedInk || b < from || a > to,
    });
    wrappers = wrappers.update({
      filterFrom: from,
      filterTo: to,
      filter: (a, b) => b < from || a > to,
    });
  };
  let run: { from: number; to: number } | null = null;
  for (const index of indices) {
    const line = script.lines[index];
    const from = shown.at.get(line.from) ?? line.from;
    if (run && from <= run.to + 1) run.to = Math.max(run.to, line.to);
    else {
      if (run) clear(run.from, run.to);
      run = { from, to: line.to };
    }
  }
  if (run) clear(run.from, run.to);
  const fresh = decorate(state, script, focused, value.colors, indices);
  return {
    colors: value.colors,
    script,
    focused,
    editingLine: editingLine(state, focused),
    revealed,
    records: sourceCommentRanges(state),
    decorations: decorations.update({ add: fresh.marks, sort: true }),
    wrappers: wrappers.update({ add: fresh.blocks, sort: true }),
  };
}

const field = StateField.define<Preview>({
  create(state) {
    const script = parseFountain(state.doc.toString());
    const colors = new FountainSpeakerColors(state.facet(speakerColorKey));
    colors.prime(
      script.lines
        .filter((line) => line.kind === "character")
        .map((line) => line.text),
    );
    return build(state, script, false, colors);
  },
  update(value, tr) {
    const focused =
      tr.effects.find((effect) => effect.is(focus))?.value ?? value.focused;
    const context = editingLine(tr.state, focused);
    const records = sourceCommentRanges(tr.state);
    if (tr.docChanged) {
      // An edit of ordinary text reads again only the lines it changes, and
      // lays out only those.
      const edited = sameSourceComments(
        sourceCommentRanges(tr.startState),
        records,
        tr.changes,
      )
        ? editFountain(
            value.script,
            tr.changes,
            tr.startState.doc,
            tr.state.doc,
            value.editingLine,
            context,
          )
        : null;
      return edited
        ? relayout(value, tr, edited.script, edited.lines, focused)
        : build(
            tr.state,
            parseFountain(tr.state.doc.toString(), context),
            focused,
            value.colors,
          );
    }
    // The records that hide text decide what every line shows.
    if (records !== value.records)
      return build(
        tr.state,
        context === value.editingLine
          ? value.script
          : parseFountain(tr.state.doc.toString(), context),
        focused,
        value.colors,
      );
    // A caret on another line reads again only the lines that its old and
    // new lines change; a selection elsewhere, focus in a read-only view or
    // a new configuration keeps the layout.
    let script = value.script,
      changed: number[] = [];
    if (context !== value.editingLine) {
      const moved = moveEditingLine(value.script, value.editingLine, context);
      if (!moved)
        return build(
          tr.state,
          parseFountain(tr.state.doc.toString(), context),
          focused,
          value.colors,
        );
      ({ script, lines: changed } = moved);
    }
    if (changed.length || revealedLines(tr.state, focused) !== value.revealed)
      return relayout(value, tr, script, changed, focused);
    return focused === value.focused && context === value.editingLine
      ? value
      : { ...value, focused, editingLine: context };
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

export function fountainPreview(id?: string) {
  return id ? [preview, speakerColorKey.of(id)] : preview;
}
