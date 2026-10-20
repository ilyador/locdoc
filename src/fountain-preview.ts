import {
  Facet,
  StateEffect,
  StateField,
  type EditorState,
} from "@codemirror/state";
import { BlockWrapper, Decoration, EditorView } from "@codemirror/view";
import { commentParser } from "./comment-syntax";
import { sourceCommentRanges, visibleTextRanges } from "./editor-comments";
import { parseFountain, type FountainScript } from "./fountain";
import { emphasisContentRange } from "./emphasis-range";

// Reuse the established delimiter parser, with Fountain's underscore semantics.
// Prefixing each isolated line prevents Markdown block rules from reclassifying it.
export const fountainInlineParser = commentParser.configure({
  remove: ["InlineCode", "HTMLTag", "Autolink", "Link", "Image"],
});
export const fountainScript = Facet.define<
  FountainScript,
  FountainScript | null
>({ combine: (values) => values[0] ?? null });

export function fountainPreview() {
  const focus = StateEffect.define<boolean>();
  const editingLine = (state: EditorState, focused: boolean) =>
    focused &&
    !state.readOnly &&
    state.selection.ranges.length === 1 &&
    state.selection.main.empty
      ? state.doc.lineAt(state.selection.main.head).number - 1
      : undefined;
  const activeLines = (state: EditorState) =>
    state.readOnly
      ? ""
      : state.selection.ranges
          .map(
            (range) =>
              `${state.doc.lineAt(range.from).number}:${state.doc.lineAt(range.to).number}`,
          )
          .join(",");
  function build(state: EditorState, script: FountainScript, focused: boolean) {
    const marks: ReturnType<Decoration["range"]>[] = [];
    const wrappers: ReturnType<BlockWrapper["range"]>[] = [];
    const active =
      state.readOnly || !focused
        ? []
        : state.selection.ranges.map((r) => ({
            from: state.doc.lineAt(r.from).from,
            to: state.doc.lineAt(r.to).to,
          }));
    const inactive = (from: number, to: number) =>
      !active.some((r) => r.from <= to && r.to >= from);
    const visibleLineStarts = new Map<number, number>();
    for (const hidden of sourceCommentRanges(state))
      if (
        state.doc.lineAt(hidden.from).from === hidden.from &&
        state.doc.lineAt(hidden.to).from === hidden.to
      )
        visibleLineStarts.set(hidden.to, hidden.from);
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
        marks.push(
          Decoration.line({ class: "fountain-block-end" }).range(from),
        );
      wrappers.push(
        BlockWrapper.create({
          tagName: "div",
          attributes: {
            class: `fountain-line fountain-${line.kind}`,
          },
        }).range(from, line.to),
      );
      if (inactive(line.from, line.to))
        for (const range of line.markers.filter(
          (range) => !(line.kind === "character" && range === line.suffix),
        ))
          for (const part of visibleTextRanges(state, range.from, range.to))
            if (part.to > part.from)
              marks.push(Decoration.replace({}).range(part.from, part.to));
      if (line.kind === "character" && line.suffix)
        for (const part of visibleTextRanges(
          state,
          line.suffix.from,
          line.suffix.to,
        ))
          if (part.to > part.from)
            marks.push(
              Decoration.mark({
                class: "fountain-dual-marker",
                attributes: { title: "Simultaneous dialogue" },
              }).range(part.from, part.to),
            );
      if (line.kind === "break") {
        marks.push(
          (inactive(line.from, line.to)
            ? Decoration.replace({})
            : Decoration.mark({ class: "fountain-break-source" })
          ).range(line.from, line.to),
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
              Decoration.mark({
                class:
                  state.sliceDoc(from, from + 1) === "_"
                    ? "fountain-underline"
                    : node.name === "StrongEmphasis"
                      ? "md-strong"
                      : "md-em",
              }).range(
                line.from + content.from - 2,
                line.from + content.to - 2,
              ),
            );
          }
          if (
            (node.name === "EmphasisMark" || node.name === "Escape") &&
            inactive(line.from, line.to)
          )
            marks.push(
              Decoration.replace({}).range(
                from,
                node.name === "Escape" ? from + 1 : to,
              ),
            );
        },
      });
    }
    for (const range of script.notes)
      marks.push(
        Decoration.mark({ class: "fountain-note-ink" }).range(
          range.from,
          range.to,
        ),
      );
    for (const range of script.omissions)
      marks.push(
        Decoration.mark({ class: "fountain-omitted-ink" }).range(
          range.from,
          range.to,
        ),
      );
    return {
      script,
      focused,
      editingLine: editingLine(state, focused),
      decorations: Decoration.set(marks, true),
      wrappers: BlockWrapper.set(wrappers, true),
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
      return (tr.selection &&
        activeLines(tr.state) !== activeLines(tr.startState)) ||
        tr.reconfigured ||
        focused !== value.focused
        ? build(tr.state, value.script, focused)
        : value;
    },
    provide: (field) => [
      fountainScript.from(field, (value) => value.script),
      EditorView.decorations.from(field, (value) => value.decorations),
      EditorView.blockWrappers.from(field, (value) => value.wrappers),
    ],
  });
  return [
    field,
    EditorView.focusChangeEffect.of((_state, focused) => focus.of(focused)),
  ];
}
