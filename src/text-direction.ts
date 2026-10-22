import {
  Facet,
  RangeSetBuilder,
  type EditorState,
  type Extension,
  type Line,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { textDirection, type TextDirection } from "./bidi";
import { sourceCommentRanges, visibleTextRanges } from "./editor-comments";

type Range = { from: number; to: number };

// Source that a format never shows as text, such as a task's checkbox syntax
// or a link's destination. It decides no line's direction.
export const directionSyntax =
  Facet.define<(state: EditorState, line: Line) => Range[]>();

const markdownTask =
  /^[ \t]*(?:>[ \t]?)*[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+\[[ xX]\](?=[ \t]|$)/;
// An image is shown as media, not its description; a link shows its label but
// not its destination or title. Balanced parentheses stay inside a destination.
const markdownMedia =
  /!\[(?:[^\]\\\n]|\\.)*\]\((?:[^()\\\n]|\\.|\((?:[^()\\\n]|\\.)*\))*\)|\]\((?:[^()\\\n]|\\.|\((?:[^()\\\n]|\\.)*\))*\)/g;

export function markdownDirectionSyntax(_state: EditorState, line: Line) {
  const ranges: Range[] = [];
  const task = markdownTask.exec(line.text);
  if (task)
    ranges.push({
      from: line.from + task[0].length - 3,
      to: line.from + task[0].length,
    });
  for (const match of line.text.matchAll(markdownMedia)) {
    const start = match[0].startsWith("!") ? match.index : match.index + 1;
    ranges.push({
      from: line.from + start,
      to: line.from + match.index + match[0].length,
    });
  }
  return ranges;
}

// The direction a line takes from its own visible text, or null when it shows
// no strong character.
function ownDirection(state: EditorState, line: Line): TextDirection | null {
  const hidden = state
    .facet(directionSyntax)
    .flatMap((syntax) => syntax(state, line))
    .sort((a, b) => a.from - b.from);
  for (const range of visibleTextRanges(state, line.from, line.to)) {
    let start = range.from;
    for (const skip of hidden) {
      if (skip.to <= start || skip.from >= range.to) continue;
      if (skip.from > start) {
        const found = textDirection(state.sliceDoc(start, skip.from));
        if (found) return found;
      }
      start = skip.to;
    }
    if (start < range.to) {
      const found = textDirection(state.sliceDoc(start, range.to));
      if (found) return found;
    }
  }
  return null;
}

// How far back a line without a strong character looks for one to follow.
const lookBack = 500;

// Each line reads in the direction of its first strong character. A line
// without one, such as a blank line under a paragraph, continues the line
// before it, so writing on a new line under Hebrew starts at its right edge.
export function lineDirections(state: EditorState, from: number, to: number) {
  const directions: { from: number; direction: TextDirection }[] = [];
  // A comment record that starts its line hides it with its line break. The
  // text of the line where the record ends then shows in the line where the
  // record starts (editor-comments.ts).
  const merged = new Map<number, number>();
  const hidden = new Set<number>();
  for (const range of sourceCommentRanges(state)) {
    if (range.to <= range.from || range.from > to || range.to < from) continue;
    const first = state.doc.lineAt(range.from);
    if (first.from !== range.from) continue;
    const next = state.doc.lineAt(range.to);
    if (next.number === first.number) continue;
    merged.set(next.from, range.from);
    for (let n = first.number; n < next.number; n++) hidden.add(n);
  }
  let line = state.doc.lineAt(from);
  let previous: TextDirection = "ltr";
  for (
    let number = line.number - 1;
    number >= 1 && number >= line.number - lookBack;
    number--
  ) {
    const found = ownDirection(state, state.doc.line(number));
    if (found) {
      previous = found;
      break;
    }
  }
  for (;;) {
    if (!hidden.has(line.number)) {
      const direction = ownDirection(state, line) ?? previous;
      previous = direction;
      const start = merged.get(line.from);
      if (start !== undefined) directions.push({ from: start, direction });
      directions.push({ from: line.from, direction });
    }
    if (line.to >= to || line.number === state.doc.lines) break;
    line = state.doc.line(line.number + 1);
  }
  return directions.sort((a, b) => a.from - b.from);
}

const rightToLeftLine = Decoration.line({ attributes: { dir: "rtl" } });

function decorate(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const line of lineDirections(
    view.state,
    view.viewport.from,
    view.viewport.to,
  ))
    if (line.direction === "rtl")
      builder.add(line.from, line.from, rightToLeftLine);
  return builder.finish();
}

// Lines whose first strong character is Hebrew read right to left, with their
// own caret movement, selection, Home and End; the others stay left to right.
export const perLineDirection: Extension = [
  EditorView.perLineTextDirection.of(true),
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = decorate(view);
      }
      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.startState.facet(directionSyntax) !==
            update.state.facet(directionSyntax)
        )
          this.decorations = decorate(update.view);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  ),
];
