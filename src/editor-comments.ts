import * as Y from "yjs";
import {
  ChangeSet,
  EditorSelection,
  EditorState,
  StateEffect,
  StateField,
  type Line,
  type Transaction,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { Anchor } from "./editor-types";
import { sourceComments } from "./comment-syntax";
import { mediaPreview, wholeLineImage } from "./markdown-media";

// Source records stay editable on disk, while the writing surface shows only
// their passage marker and conversation. Atomic ranges keep cursors out of them.
type SourceCommentState = { ranges: Range[]; decorations: DecorationSet };
export const sourceCommentLayer: StateField<SourceCommentState> =
  StateField.define({
    create: buildSourceComments,
    update(value, tr) {
      if (!tr.docChanged) return value;
      if (!mapsSourceComments(tr, value.ranges))
        return buildSourceComments(tr.state);
      const ranges = value.ranges.map(({ from, to }) => ({
        from: tr.changes.mapPos(from, 1),
        to: tr.changes.mapPos(to, -1),
      }));
      hiddenSources.set(tr.newDoc, ranges);
      return { ranges, decorations: value.decorations.map(tr.changes) };
    },
    provide: (field) => [
      EditorView.decorations.from(field, (value) => value.decorations),
      EditorView.atomicRanges.of((view) => view.state.field(field).decorations),
      EditorState.transactionFilter.of((tr) => {
        if (
          !tr.docChanged ||
          !tr.isUserEvent("input") ||
          !tr.startState.selection.ranges.every((r) => r.empty)
        )
          return tr;
        const hidden = sourceCommentRanges(tr.startState);
        const moves: {
          from: number;
          fromB: number;
          toB: number;
          target: number;
          insert: string;
        }[] = [];
        tr.changes.iterChanges((from, to, fromB, toB, inserted) => {
          const range = hidden.find((r) => r.from === from);
          if (range && from === to && inserted.length)
            moves.push({
              from,
              fromB,
              toB,
              target: tr.changes.mapPos(range.to, 1),
              insert: inserted.toString(),
            });
        });
        if (!moves.length) return tr;
        // Both sides of an invisible record occupy the same visible text position.
        // Type on its trailing side so a backslash cannot escape the delimiter.
        const correction = ChangeSet.of(
          moves.flatMap((m) => [
            { from: m.fromB, to: m.toB },
            { from: m.target, insert: m.insert },
          ]),
          tr.newDoc.length,
        );
        return [
          tr,
          {
            changes: correction,
            selection: EditorSelection.create(
              tr.newSelection.ranges.map((r, i) => {
                const move = moves.find(
                  (m) => m.from === tr.startState.selection.ranges[i].head,
                );
                return move
                  ? EditorSelection.cursor(correction.mapPos(move.target, 1))
                  : r.map(correction);
              }),
              tr.newSelection.mainIndex,
            ),
            sequential: true,
          },
        ];
      }),
      EditorState.changeFilter.of((tr) => {
        if (
          !tr.docChanged ||
          !tr.startState.selection.ranges.every((r) => r.empty) ||
          !(tr.isUserEvent("delete") || tr.isUserEvent("input"))
        )
          return true;
        let deleting = false;
        tr.changes.iterChanges((from, to) => {
          if (to > from) deleting = true;
        });
        // Atomic cursor movement must not turn an invisible conversation into a
        // deletable character. Applies to key, word and native mobile deletion;
        // explicit range deletion and remote/raw-file edits retain their meaning.
        return deleting
          ? sourceCommentRanges(tr.startState).flatMap((r) => [r.from, r.to])
          : true;
      }),
    ],
  });
const hiddenSources = new WeakMap<EditorState["doc"], Range[]>();
export function sourceCommentRanges(state: EditorState): Range[] {
  return (
    state.field(sourceCommentLayer, false)?.ranges ?? parseSourceComments(state)
  );
}
function parseSourceComments(state: EditorState) {
  const cached = hiddenSources.get(state.doc);
  if (cached) return cached;
  const source = state.doc.toString();
  const hidden: { from: number; to: number }[] = [];
  for (const thread of sourceComments(source)) {
    const first = state.doc.lineAt(thread.from),
      last = state.doc.lineAt(thread.to);
    const standalone =
      !source.slice(first.from, thread.from).trim() &&
      !source.slice(thread.to, last.to).trim();
    const from = standalone ? first.from : thread.from;
    const to = standalone && last.to < source.length ? last.to + 1 : thread.to;
    const previous = hidden.at(-1);
    if (previous && !source.slice(previous.to, from).trim()) previous.to = to;
    else hidden.push({ from, to });
  }
  hiddenSources.set(state.doc, hidden);
  return hidden;
}

// Most typing cannot change which source records are annotations. Keep their
// positions mapped instead of serializing and parsing the entire document.
// Bracket syntax can span physical lines (including reference-link labels), so
// inspect the containing paragraph, not just the edited line. Structural edits
// keep the exact parser path below; no second comment grammar is maintained.
function mapsSourceComments(tr: Transaction, hidden: Range[]) {
  const inspected = new Set<number>();
  let safe = true;
  tr.changes.iterChanges((from, to, fromB, toB, inserted) => {
    if (!safe) return;
    const before = tr.startState.doc.lineAt(from),
      after = tr.newDoc.lineAt(fromB);
    const ordinary = /^[\p{L}\p{M}\p{N} .,!?;:'"()/%&=+\-—–…’]*$/u;
    if (
      to > before.to ||
      toB > after.to ||
      !ordinary.test(inserted.toString()) ||
      !ordinary.test(tr.startState.sliceDoc(from, to)) ||
      hidden.some((range) => from <= range.to && to >= range.from) ||
      !before.text.trim() ||
      !after.text.trim() ||
      /^[ \t]*(?:(?:[-*_][ \t]*){3,}|[=-]+[ \t]*)$/.test(before.text) ||
      /^[ \t]*(?:(?:[-*_][ \t]*){3,}|[=-]+[ \t]*)$/.test(after.text)
    ) {
      safe = false;
      return;
    }
    const prefix = /^[ \t]*(?:(?:[-+*]|\d+[.)]|#{1,6})(?:[ \t]+|$))?/;
    if (prefix.exec(before.text)![0] !== prefix.exec(after.text)![0]) {
      safe = false;
      return;
    }
    if (inspected.has(before.number)) return;
    for (const direction of [-1, 1]) {
      for (
        let number = before.number + (direction === 1 ? 1 : 0);
        number >= 1 && number <= tr.startState.doc.lines;
        number += direction
      ) {
        if (inspected.has(number)) break;
        const line = tr.startState.doc.line(number);
        if (!line.text.trim()) break;
        inspected.add(number);
        if (hasVisibleSourceSyntax(line, hidden)) {
          safe = false;
          return;
        }
      }
    }
  });
  return safe;
}

function hasVisibleSourceSyntax(line: Line, hidden: Range[]) {
  let low = 0,
    high = hidden.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (hidden[middle].to <= line.from) low = middle + 1;
    else high = middle;
  }
  for (const marker of line.text.matchAll(/[\\[\]<>`~]/g)) {
    const position = line.from + marker.index;
    while (low < hidden.length && hidden[low].to <= position) low++;
    if (low === hidden.length || position < hidden[low].from) return true;
  }
  return false;
}
export function visibleTextRanges(
  state: EditorState,
  from: number,
  to: number,
) {
  const ranges: Range[] = [];
  let start = from;
  for (const hidden of sourceCommentRanges(state)) {
    if (hidden.to <= start || hidden.from >= to) continue;
    if (hidden.from > start) ranges.push({ from: start, to: hidden.from });
    start = Math.min(to, hidden.to);
  }
  if (start < to || from === to) ranges.push({ from: start, to });
  return ranges;
}
function buildSourceComments(state: EditorState) {
  const ranges = parseSourceComments(state);
  return {
    ranges,
    decorations: Decoration.set(
      ranges.map(({ from, to }) => Decoration.replace({}).range(from, to)),
      true,
    ),
  };
}

type Range = { from: number; to: number };
export type CommentPosition = Range & { id: string; resolved: boolean };
export type CommentLayout = {
  items: CommentPosition[];
  active: string | null;
  draft: Range | null;
};
export const setCommentLayout = StateEffect.define<CommentLayout>();

export function resolveCommentAnchor(
  ydoc: Y.Doc,
  anchor: Anchor | null,
): Range | null {
  try {
    if (!anchor) return null;
    const text = ydoc.getText("content");
    const start = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(anchor.start),
      ydoc,
    );
    const end = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(anchor.end),
      ydoc,
    );
    if (!start || !end || start.type !== text || end.type !== text) return null;
    return {
      from: Math.min(start.index, end.index),
      to: Math.max(start.index, end.index),
    };
  } catch {
    return null;
  }
}

// Split the displayed text at its anchor, without inserting Markdown newlines.
// A rendered table is indivisible, so conversations belong after its preview.
function commentPosition(state: EditorState, offset: number) {
  const pos = Math.max(0, Math.min(state.doc.length, offset));
  for (
    let node = syntaxTree(state).resolveInner(pos, -1);
    node;
    node = node.parent!
  ) {
    if (node.name === "Table")
      return { pos: state.doc.lineAt(node.to).to, block: true };
  }
  const line = state.doc.lineAt(pos);
  if (state.facet(mediaPreview) && wholeLineImage(line.text))
    return { pos: line.to, block: true };
  return { pos, block: false };
}

class CommentMarker extends WidgetType {
  constructor(
    readonly id: string,
    readonly active: boolean,
    readonly open: (id: string) => void,
    readonly block: boolean,
  ) {
    super();
  }
  eq(other: CommentMarker) {
    return (
      this.active === other.active &&
      this.id === other.id &&
      this.block === other.block
    );
  }
  toDOM() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "comment-marker";
    button.contentEditable = "false";
    button.dataset.commentId = this.id;
    const label = this.active ? "Close comment" : "Open comment";
    button.setAttribute("aria-label", label);
    button.title = label;
    button.setAttribute("aria-expanded", String(this.active));
    // Same regular ChatCircle geometry as the app's Phosphor icon controls.
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 256 256");
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute(
      "d",
      "M128,24A104,104,0,0,0,36.18,176.88L24.83,210.93a16,16,0,0,0,20.24,20.24l34.05-11.35A104,104,0,1,0,128,24Zm0,192a87.87,87.87,0,0,1-44.06-11.81,8,8,0,0,0-6.54-.67L40,216,52.47,178.6a8,8,0,0,0-.66-6.54A88,88,0,1,1,128,216Z",
    );
    path.setAttribute("fill", "currentColor");
    svg.append(path);
    button.append(svg);
    button.addEventListener("click", () => this.open(this.id));
    if (this.block) {
      const wrap = document.createElement("div");
      wrap.className = "comment-marker-block";
      wrap.contentEditable = "false";
      wrap.append(button);
      return wrap;
    }
    return button;
  }
  ignoreEvent() {
    return true;
  }
}
class ConversationWidget extends WidgetType {
  constructor(readonly host: HTMLElement) {
    super();
  }
  eq(other: ConversationWidget) {
    return this.host === other.host;
  }
  toDOM() {
    return this.host;
  }
  ignoreEvent() {
    return true;
  }
}

export function commentLayer(host: HTMLElement, open: (id: string) => void) {
  host.className = "inline-comment-host";
  host.contentEditable = "false";
  const field = StateField.define<{
    layout: CommentLayout;
    decorations: DecorationSet;
  }>({
    create: () => ({
      layout: { items: [], active: null, draft: null },
      decorations: Decoration.none,
    }),
    update(value, tr) {
      let layout = value.layout;
      let changed = tr.docChanged;
      if (tr.docChanged) {
        const map = (r: Range) => ({
          from: tr.changes.mapPos(r.from),
          to: tr.changes.mapPos(r.to),
        });
        layout = {
          ...layout,
          items: layout.items.map((item) => ({ ...item, ...map(item) })),
          draft: layout.draft ? map(layout.draft) : null,
        };
      }
      for (const effect of tr.effects)
        if (effect.is(setCommentLayout)) {
          layout = effect.value;
          changed = true;
        }
      if (!changed && !tr.reconfigured) return value;
      const ranges: ReturnType<Decoration["range"]>[] = [];
      for (const item of layout.items) {
        if (item.from < 0 || item.to > tr.state.doc.length) continue;
        if (item.resolved && item.id !== layout.active) continue;
        const placement = commentPosition(tr.state, item.to);
        ranges.push(
          Decoration.widget({
            block: placement.block,
            side: 1,
            widget: new CommentMarker(
              item.id,
              item.id === layout.active,
              open,
              placement.block,
            ),
          }).range(placement.pos),
        );
        if (item.to > item.from)
          ranges.push(
            Decoration.mark({
              class: "comment-selection",
            }).range(item.from, item.to),
          );
      }
      const active =
        layout.draft || layout.items.find((item) => item.id === layout.active);
      if (active) {
        if (layout.draft && active.to > active.from)
          ranges.push(
            Decoration.mark({ class: "comment-selection" }).range(
              active.from,
              active.to,
            ),
          );
        const placement = commentPosition(tr.state, active.to);
        const hidden = sourceCommentRanges(tr.state);
        let position =
          hidden.find(
            (range) => range.from <= placement.pos && placement.pos < range.to,
          )?.to ?? placement.pos;
        if (
          !placement.block &&
          position === tr.state.doc.lineAt(position).to &&
          position < tr.state.doc.length
        )
          position++;
        position =
          hidden.find((range) => range.from <= position && position < range.to)
            ?.to ?? position;
        ranges.push(
          Decoration.widget({
            block: true,
            side: position === tr.state.doc.lineAt(position).from ? -1 : 2,
            widget: new ConversationWidget(host),
          }).range(position),
        );
      }
      return { layout, decorations: Decoration.set(ranges, true) };
    },
    provide: (f) =>
      EditorView.decorations.from(f, (value) => value.decorations),
  });
  return {
    extension: field,
    reveal(view: EditorView, id?: string) {
      const layout = view.state.field(field).layout;
      const item = id ? layout.items.find((c) => c.id === id) : layout.draft;
      if (item)
        view.dispatch({
          effects: EditorView.scrollIntoView(item.to, { y: "center" }),
        });
    },
  };
}
