import * as Y from "yjs";
import {
  ChangeSet,
  EditorSelection,
  EditorState,
  Facet,
  StateEffect,
  StateField,
  Text,
  Transaction,
  type ChangeDesc,
  type Line,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  type Command,
  type DecorationSet,
  type KeyBinding,
} from "@codemirror/view";
import {
  deleteCharBackward,
  deleteCharBackwardStrict,
  deleteCharForward,
  deleteGroupBackward,
  deleteGroupForward,
  deleteGroupForwardWin,
} from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import type { Anchor } from "./editor-types";
import type { SyntaxNode, Tree } from "@lezer/common";
import {
  commentParser,
  sourceCommentTree,
  type SourceThread,
} from "./comment-syntax";
import { mediaPreview, wholeLineImage } from "./markdown-media";
import { textDirection, type TextDirection } from "./bidi";

// Plain text documents read their records without Markdown rules.
export const plainCommentRecords = Facet.define<boolean, boolean>({
  combine: (values) => values.some(Boolean),
});

// Source records stay editable on disk, while the writing surface shows only
// their passage marker and conversation. Atomic ranges keep cursors out of them.
type SourceCommentState = { ranges: Range[]; decorations: DecorationSet };
export const sourceCommentLayer: StateField<SourceCommentState> =
  StateField.define({
    create: buildSourceComments,
    update(value, tr) {
      if (
        tr.startState.facet(plainCommentRecords) !==
        tr.state.facet(plainCommentRecords)
      )
        return buildSourceComments(tr.state);
      if (!tr.docChanged) return value;
      if (!mapsSourceComments(tr, value.ranges))
        return buildSourceComments(tr.state);
      const ranges = value.ranges.map(({ from, to }) => ({
        from: tr.changes.mapPos(from, 1),
        to: tr.changes.mapPos(to, -1),
      }));
      hiddenSources(tr.state).set(tr.newDoc, ranges);
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
        const doc = tr.startState.doc;
        const moves: {
          from: number;
          changes: { from: number; to?: number; insert: string }[];
          cursor: number;
        }[] = [];
        tr.changes.iterChanges((from, to, fromB, toB, inserted) => {
          const range = hidden.find((r) => r.from === from || r.to === from);
          if (!range || from !== to || !inserted.length) return;
          // Both sides of an invisible record occupy the same visible text
          // position. Type on its trailing side so a backslash cannot escape
          // the delimiter. Records that follow text on its line and hide
          // later line breaks show at the end of that text, so its line
          // keeps what is typed up to a line break, unless that ends in an
          // odd run of backslashes right before a record.
          const insert = inserted.toString();
          let lead = "";
          if (
            doc.lineAt(range.from).from < range.from &&
            doc.lineAt(range.to).from > range.from
          ) {
            const line = insert.split("\n", 1)[0];
            if (
              doc.sliceString(range.from, range.from + 1) !== "[" ||
              (line.length - line.replace(/\\+$/, "").length) % 2 === 0
            )
              lead = line;
          }
          const trail = insert.slice(lead.length);
          if (from === range.from ? !trail : !lead) return;
          const start = tr.changes.mapPos(range.from, 1),
            end = tr.changes.mapPos(range.to, 1);
          moves.push(
            from === range.from
              ? {
                  from,
                  changes: [
                    { from: fromB, to: toB, insert: lead },
                    { from: end, insert: trail },
                  ],
                  cursor: end,
                }
              : {
                  from,
                  changes: [
                    { from: start, insert: lead },
                    { from: fromB, to: toB, insert: trail },
                  ],
                  cursor: trail ? toB : start,
                },
          );
        });
        if (!moves.length) return tr;
        const correction = ChangeSet.of(
          moves.flatMap((m) => m.changes),
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
                  ? EditorSelection.cursor(correction.mapPos(move.cursor, 1))
                  : r.map(correction);
              }),
              tr.newSelection.mainIndex,
            ),
            sequential: true,
          },
        ];
      }),
      EditorState.transactionFilter.of(joinAfterRecords),
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

// Deleting a line break that a reader sees joins the next line onto the text
// before it. Records hidden where the lines join move to where a new comment
// about the joined text would be written (server/comments.rs), rather than
// staying inside that text, where a desktop editor would show them: records
// that end the text before the line break, or a record that starts the next
// line and shows the line after it in its place (see shownLines), whose
// hidden line break goes with it. In plain text they end the joined line's
// text; in Markdown and Fountain, the text of the paragraph, heading or list
// item the joined line is in. Records behind the blank line that a table or
// HTML block needs go after the block the line joins, where that blank line
// stays hidden instead of showing. A move that would change a conversation,
// what a reader sees or how Markdown reads it leaves the plain deletion.
function joinAfterRecords(tr: Transaction) {
  if (
    !tr.docChanged ||
    !(tr.isUserEvent("delete.backward") || tr.isUserEvent("delete.forward")) ||
    !tr.startState.selection.ranges.every((r) => r.empty)
  )
    return tr;
  const state = tr.startState;
  const joints: Joint[] = [];
  tr.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
    if (inserted.length || to !== from + 1 || state.sliceDoc(from, to) !== "\n")
      return;
    const joint = jointAt(state, from);
    if (joint) joints.push(joint);
  });
  if (joints.length !== 1) return tr;
  const [joint] = joints;
  const doc = state.doc;
  const shown = visibleTextRanges(state, joint.from, joint.end).filter(
    (range) => doc.sliceString(range.from, range.to).trim(),
  );
  if (!shown.length) {
    // Joining a line that shows nothing removes it instead: the record on
    // the line above keeps that line, and shows the line after it there.
    if (
      joint.records.from !== joint.at + 1 ||
      doc.sliceString(joint.end, joint.end + 1) !== "\n"
    )
      return tr;
    return {
      changes: { from: joint.end, to: joint.end + 1 },
      selection: { anchor: joint.at },
      scrollIntoView: true,
      userEvent: tr.annotation(Transaction.userEvent),
    };
  }
  const candidates = joinsAt(state, joint, shown);
  if (!candidates.length) return tr;
  const plain = state.facet(plainCommentRecords);
  const source = state.doc.toString();
  const conversations = (threads: SourceThread[]) =>
    threads
      .map((thread) => JSON.stringify(thread.messages))
      .sort()
      .join("\n");
  const before = conversations(sourceCommentTree(source, plain).threads);
  for (const join of candidates) {
    const correction = ChangeSet.of(
      [
        ...join.remove.map((range) => ({
          from: tr.changes.mapPos(range.from, 1),
          to: tr.changes.mapPos(range.to, -1),
        })),
        { from: tr.changes.mapPos(join.at, 1), insert: join.insert },
      ],
      tr.newDoc.length,
    );
    const result = parseSource(correction.apply(tr.newDoc).toString(), plain);
    // What a reader sees joins as without the records that move.
    const reference =
      join.reference ??
      parseSource(
        withoutRanges(source, [
          ...join.remove,
          { from: joint.at, to: joint.at + 1 },
        ]),
        plain,
      );
    if (
      conversations(result.threads) === before &&
      readerText(result) === readerText(reference) &&
      (!join.structure || readerShape(result) === readerShape(reference))
    )
      return [tr, { changes: correction, sequential: true }];
  }
  return tr;
}

// Deleting the line break at `at` joins the text of the next line, which
// starts at `from` and shows up to `end`, onto the text before `at`;
// `records`, the hidden range at `index`, is where they meet.
type Joint = {
  at: number;
  records: Range;
  index: number;
  from: number;
  end: number;
};

function jointAt(state: EditorState, at: number): Joint | null {
  const doc = state.doc;
  if (at + 1 >= doc.length) return null;
  const hidden = sourceCommentRanges(state);
  let index = hidden.length - 1;
  while (index >= 0 && hidden[index].to > at) index--;
  const before = hidden[index],
    after = hidden[index + 1];
  let from: number;
  if (
    before &&
    !/[^ \t]/.test(doc.sliceString(before.to, at)) &&
    shownText(state, doc.lineAt(before.from).from, before.from).trim()
  )
    // Records that end the text of the line.
    from = at + 1;
  else if (
    after?.from === at + 1 &&
    doc.lineAt(after.to).number > doc.lineAt(after.from).number &&
    shownText(state, doc.lineAt(at).from, at).trim()
  ) {
    // A record that starts the next line, showing the line after it there.
    index++;
    from = after.to;
  } else return null;
  // The line that joins, as a reader sees it: up to the first line break
  // that no record hides.
  let end = doc.lineAt(from).to;
  for (let i = index + 1; i < hidden.length && hidden[i].from <= end; i++)
    if (hidden[i].to > end) end = doc.lineAt(hidden[i].to).to;
  return { at, records: hidden[index], index, from, end };
}

// Records to take out of their place and what to write where. A join that
// places records by Markdown's blocks also keeps how Markdown reads the
// joined text: `reference`, that text without the records it moves.
type Join = {
  remove: Range[];
  at: number;
  insert: string;
  structure?: boolean;
  reference?: ParsedSource;
};

// Where the records of a joint go, best first, given the parts of the
// joined line that show text: after the joined line's text and the
// conversations that end it, as plain-text placement writes them; after the
// table or HTML block that the line joins; or at the end of the joined
// Markdown block's text.
function joinsAt(state: EditorState, joint: Joint, shown: Range[]): Join[] {
  const doc = state.doc;
  const hidden = sourceCommentRanges(state);
  const { records, index, from, end } = joint;
  const next = doc.lineAt(from);
  const insert = doc.sliceString(records.from, records.to).trim();
  if (!state.facet(plainCommentRecords)) {
    if (doc.sliceString(records.from, records.from + 1) !== "\n")
      return markdownJoins(state, joint, insert);
    // In Markdown, records behind the blank line that a table or HTML block
    // needs. The line joins the block, where records would be a table
    // cell's text or literal HTML: its own records go after it as well, each
    // behind a blank line, unless the line under them would underline them.
    const below = doc.lineAt(end).number + 1;
    if (
      below <= doc.lines &&
      /^ {0,3}(?:=+|-+)[ \t]*$/.test(doc.line(below).text)
    )
      return [];
    const moved = [
      records,
      ...hidden.filter((range) => range.from >= next.from && range.to <= end),
    ];
    return [
      {
        remove: moved,
        at: end,
        insert: moved
          .map((range) => "\n\n" + doc.sliceString(range.from, range.to).trim())
          .join(""),
      },
    ];
  }
  const last = shown[shown.length - 1];
  const lastShown =
    last.from + doc.sliceString(last.from, last.to).trimEnd().length;
  // Conversations that end the joined line's text, or follow it with nothing
  // else between, would take records right after the text as replies: the
  // records go after them, behind a blank line.
  let point = end;
  let prefix = "";
  for (let i = index + 1; i < hidden.length; i++) {
    const range = hidden[i];
    if (range.to <= lastShown) continue;
    const ends =
      range.from < point
        ? range.to >= point || !doc.sliceString(range.to, point).trim()
        : !doc.sliceString(point, range.from).trim();
    if (ends) {
      point =
        range.from + doc.sliceString(range.from, range.to).trimEnd().length;
      prefix = "\n\n";
    } else if (range.from >= point) break;
  }
  // A record right after an odd run of backslashes would be escaped. Before
  // the last one it is not, unless only space separates it from other
  // records, which would take it as a reply: then it gets a line.
  if (!prefix && /\\*$/.exec(doc.sliceString(from, point))![0].length % 2) {
    if (
      hidden.some(
        (range) =>
          range !== records &&
          range.to > from &&
          range.to <= point - 1 &&
          !doc.sliceString(range.to, point - 1).trim(),
      )
    )
      prefix = "\n";
    else point--;
  }
  return [{ remove: [records], at: point, insert: prefix + insert }];
}

// In Markdown and Fountain, a record about text goes at the end of the text
// of the paragraph, heading or list item that holds it, or else of the last
// one in its top-level block (server/comments.rs). Once the line joins, the
// records of a joint are about the joined block's text.
function markdownJoins(
  state: EditorState,
  { at, records, from }: Joint,
  insert: string,
): Join[] {
  const joined = parseSource(
    withoutRanges(state.doc.toString(), [records, { from: at, to: at + 1 }]),
    false,
  );
  // How far the text after the joint moved, and where the joined line's
  // text starts in it.
  const shift = records.to - records.from + 1;
  const start = from - shift;
  // The last character a reader sees of the text before the joint.
  const last = visibleBefore(
    joined.text,
    joined.threads,
    Math.min(at, records.from),
  );
  if (last === null) return [];
  return markdownTextEnds(joined, last)
    .flatMap((end) => {
      const before = visibleBefore(joined.text, joined.threads, end);
      return before === null
        ? []
        : [textEnd(joined.text, joined.threads, before, end)];
    })
    .filter((place) => place.at >= start)
    .map((place) => ({
      remove: [records],
      at: place.at + shift,
      insert: place.prefix + insert,
      structure: true,
      reference: joined,
    }));
}

// A source with its conversations and Markdown structure.
type ParsedSource = {
  text: string;
  doc: Text;
  threads: SourceThread[];
  tree: Tree | null;
};
function parseSource(text: string, plain: boolean): ParsedSource {
  return {
    text,
    doc: Text.of(text.split("\n")),
    ...sourceCommentTree(text, plain),
  };
}

// A text without the given ranges, which do not overlap.
function withoutRanges(text: string, ranges: Range[]) {
  let out = "",
    from = 0;
  for (const range of [...ranges].sort((a, b) => a.from - b.from)) {
    out += text.slice(from, range.from);
    from = Math.max(from, range.to);
  }
  return out + text.slice(from);
}

// The text a reader sees: the source without what its records hide.
function readerText(source: ParsedSource) {
  return withoutRanges(
    source.text,
    hiddenRanges(source.doc, source.text, source),
  );
}

const textBlocks = /^(?:Paragraph|ATXHeading\d|SetextHeading\d)$/;

// Where the text ends of the paragraph or heading that holds `last`, the
// last character a reader sees of a passage, and of the last one in its
// top-level block, when that is another.
function markdownTextEnds(source: ParsedSource, last: number) {
  const tree = source.tree ?? commentParser.parse(source.text);
  let block: SyntaxNode | null = tree.resolveInner(last, 1);
  while (block && !textBlocks.test(block.name)) block = block.parent;
  if (!block) return [];
  const ends = [blockTextEnd(source.text, block)];
  let top: SyntaxNode = block;
  while (top.parent?.parent) top = top.parent;
  let latest = ends[0];
  const visit = (node: SyntaxNode) => {
    if (textBlocks.test(node.name))
      latest = Math.max(latest, blockTextEnd(source.text, node));
    else
      for (let child = node.firstChild; child; child = child.nextSibling)
        visit(child);
  };
  visit(top);
  if (latest !== ends[0]) ends.push(latest);
  return ends;
}

// The end of a paragraph's or heading's text: before a heading's closing
// marks or underline, and the space before them.
function blockTextEnd(text: string, node: SyntaxNode) {
  let end = node.to;
  if (node.name.startsWith("ATXHeading")) {
    const marks = node.getChildren("HeaderMark");
    if (marks.length > 1) end = marks[marks.length - 1].from;
  } else if (node.name.startsWith("SetextHeading")) {
    const mark = node.getChild("HeaderMark");
    if (mark) end = Math.max(node.from, text.lastIndexOf("\n", mark.from - 1));
  }
  while (end > node.from && /[ \t]/.test(text[end - 1])) end--;
  return end;
}

// The nearest character before `at` that a reader sees: neither space nor
// part of a record.
function visibleBefore(text: string, threads: SourceThread[], at: number) {
  for (let end = at; ;) {
    let index = end - 1;
    while (index >= 0 && /\s/.test(text[index])) index--;
    if (index < 0) return null;
    const thread = threads.find((t) => t.from <= index && index < t.to);
    if (!thread) return index;
    end = thread.from;
  }
}

// Where a record goes to end the text that ends at `point`, and its prefix,
// as server/comments.rs writes it. `last` is the last character a reader
// sees there. Conversations that end that text, or follow it with nothing
// else between, would take a record right after the text as a reply: it
// goes after them, behind a blank line. A record right after an odd run of
// backslashes would be escaped. Before the last one it is not, unless only
// space separates it from another conversation, which would take it as a
// reply: then it gets a line.
function textEnd(
  text: string,
  threads: SourceThread[],
  last: number,
  point: number,
) {
  let end: number | null = null;
  for (const thread of threads) {
    if (thread.to <= last) continue;
    const ends =
      thread.from < point &&
      (thread.to >= point || !text.slice(thread.to, point).trim());
    if (
      ends ||
      (thread.from >= point && !text.slice(point, thread.from).trim())
    ) {
      point = thread.to;
      end = point;
    } else if (thread.from >= point) break;
  }
  if (end !== null) return { at: end, prefix: "\n\n" };
  let slashes = 0;
  while (text[point - 1 - slashes] === "\\") slashes++;
  if (slashes % 2) {
    const before = point - 1;
    let previous = threads.length - 1;
    while (previous >= 0 && threads[previous].to > before) previous--;
    return previous >= 0 && !text.slice(threads[previous].to, before).trim()
      ? { at: point, prefix: "\n" }
      : { at: before, prefix: "" };
  }
  return { at: point, prefix: "" };
}

// The structure Markdown reads in a source: every block and inline node but
// the records, with the words each holds. A paragraph that holds only
// records shows nothing.
function readerShape(source: ParsedSource) {
  const tree = source.tree ?? commentParser.parse(source.text);
  const text = source.text;
  const out: string[] = [];
  const opened: number[] = [];
  let pos = 0,
    pending = "";
  const flush = () => {
    const words = pending.replace(/\s+/g, " ").trim();
    if (words) out.push(JSON.stringify(words));
    pending = "";
  };
  tree.iterate({
    enter(node) {
      if (node.name === "Document") return;
      pending += text.slice(pos, node.from);
      pos = Math.max(pos, node.from);
      if (node.name === "LocdocComment") {
        pos = node.to;
        return false;
      }
      flush();
      opened.push(out.length);
      out.push(node.name);
    },
    leave(node) {
      if (node.name === "Document") return;
      pending += text.slice(pos, node.to);
      pos = Math.max(pos, node.to);
      flush();
      const start = opened.pop()!;
      if (node.name === "Paragraph" && out.length === start + 1)
        out.length = start;
      else out.push("/");
    },
  });
  return out.join(" ");
}

// The text a reader sees from `from` to `to`.
function shownText(state: EditorState, from: number, to: number) {
  return visibleTextRanges(state, from, to)
    .map((range) => state.sliceDoc(range.from, range.to))
    .join("");
}
const markdownSources = new WeakMap<EditorState["doc"], Range[]>();
const plainSources = new WeakMap<EditorState["doc"], Range[]>();
const hiddenSources = (state: EditorState) =>
  state.facet(plainCommentRecords) ? plainSources : markdownSources;
export function sourceCommentRanges(state: EditorState): Range[] {
  return (
    state.field(sourceCommentLayer, false)?.ranges ?? parseSourceComments(state)
  );
}
function parseSourceComments(state: EditorState) {
  const cache = hiddenSources(state);
  const cached = cache.get(state.doc);
  if (cached) return cached;
  const source = state.doc.toString();
  const hidden = hiddenRanges(
    state.doc,
    source,
    sourceCommentTree(source, state.facet(plainCommentRecords)),
  );
  cache.set(state.doc, hidden);
  return hidden;
}

// What the records of a source hide: each conversation, with its line when
// it has one of its own, and conversations that only space separates as one.
function hiddenRanges(
  doc: Text,
  source: string,
  { threads, tree }: { threads: SourceThread[]; tree: Tree | null },
) {
  const hidden: Range[] = [];
  for (const thread of threads) {
    const first = doc.lineAt(thread.from),
      last = doc.lineAt(thread.to);
    const standalone =
      !source.slice(first.from, thread.from).trim() &&
      !source.slice(thread.to, last.to).trim();
    const from = standalone ? first.from : thread.from;
    const to = standalone && last.to < source.length ? last.to + 1 : thread.to;
    const previous = hidden.at(-1);
    if (previous && !source.slice(previous.to, from).trim())
      // Records that follow text on its line keep the line break after the
      // last of them, so the next line still shows as a line of its own.
      previous.to = source
        .slice(doc.lineAt(previous.from).from, previous.from)
        .trim()
        ? Math.min(to, last.to)
        : to;
    else hidden.push({ from, to });
  }
  // Records on lines of their own at the end of the document, or after the
  // blank line that Markdown needs between a table or HTML block and them,
  // also hide the line breaks before them, so they never show as an empty
  // line. They keep the line break after them: the next line stays its own.
  const text = source.trimEnd().length;
  for (const range of hidden) {
    const line = doc.lineAt(range.from);
    if (line.from !== range.from || line.number === 1) continue;
    const end = range.to >= text;
    if (!end && source[range.to - 1] !== "\n") continue;
    let above = doc.line(line.number - 1);
    let blank = false;
    while (!above.text.trim() && above.number > 1) {
      blank = true;
      above = doc.line(above.number - 1);
    }
    if (
      !above.text.trim() ||
      (!end && !(blank && separatedBlock(tree, above.to)))
    )
      continue;
    range.from = above.to;
    if (source[range.to - 1] === "\n") range.to--;
  }
  return hidden;
}

// Whether a table or HTML block ends at `end`: a record on the next line
// would join it, so it needs a blank line before the record.
function separatedBlock(tree: Tree | null, end: number) {
  for (let node = tree?.resolveInner(end, -1) ?? null; node; node = node.parent)
    if (
      node.to === end &&
      /^(?:Table|HTMLBlock|CommentBlock|ProcessingInstructionBlock)$/.test(
        node.name,
      )
    )
      return true;
  return false;
}

// Whether a transaction only moved the hidden records, so every one of them
// still hides the same source.
export function sameSourceComments(
  before: Range[],
  after: Range[],
  changes: ChangeDesc,
) {
  return (
    before.length === after.length &&
    before.every(
      (range, i) =>
        changes.mapPos(range.from, 1) === after[i].from &&
        changes.mapPos(range.to, -1) === after[i].to,
    )
  );
}

// A record that starts its line and hides the line break after it, alone or
// with replies, makes the text of the line where it ends show in the line
// where it starts: one displayed line, which takes that text's styling.
// `at` maps the start of each line whose text shows elsewhere to the start
// of the record's line, and `of` maps back. Both follow document order.
export type ShownLines = {
  at: Map<number, number>;
  of: Map<number, number>;
};
const shownLineCache = new WeakMap<Range[], ShownLines>();
export function shownLines(state: EditorState): ShownLines {
  const hidden = sourceCommentRanges(state);
  let lines = shownLineCache.get(hidden);
  if (lines) return lines;
  lines = { at: new Map(), of: new Map() };
  for (const range of hidden) {
    const first = state.doc.lineAt(range.from);
    if (first.from !== range.from) continue;
    const last = state.doc.lineAt(range.to);
    if (last.number === first.number) continue;
    lines.at.set(last.from, range.from);
    lines.of.set(range.from, last.from);
  }
  shownLineCache.set(hidden, lines);
  return lines;
}

// Most typing cannot change which source records are annotations. Keep their
// positions mapped instead of serializing and parsing the entire document.
// Bracket syntax can span physical lines (including reference-link labels), so
// inspect the containing paragraph, not just the edited line. A table or HTML
// block decides what records after it hide, so edits in one are reparsed too.
// Structural edits keep the exact parser path below; no second comment
// grammar is maintained.
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
  for (const marker of line.text.matchAll(/[\\[\]<>`~|]/g)) {
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

// The first hidden range that ends after `pos`, which holds it if it starts
// before it.
function hiddenRangeAfter(state: EditorState, pos: number): Range | undefined {
  const hidden = sourceCommentRanges(state);
  let low = 0,
    high = hidden.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (hidden[middle].to <= pos) low = middle + 1;
    else high = middle;
  }
  return hidden[low];
}

// Both sides of hidden records show at one position. A deletion from there
// toward them deletes what a reader sees past them: from `pos`, the side of
// records that the deletion leaves them on, it starts at their other side.
export function pastRecords(state: EditorState, pos: number, forward: boolean) {
  const range = hiddenRangeAfter(state, forward ? pos : pos - 1);
  if (forward) return range?.from === pos ? range.to : pos;
  return range?.to === pos ? range.from : pos;
}

// Bindings that delete a character or a word, run from past the records
// beside the caret. CodeMirror takes hidden records as one atomic character
// to delete, which the change filter keeps, so the key did nothing there.
// Put before the keymap they come from, whose bindings run otherwise.
export function deletionPastRecords(
  bindings: readonly KeyBinding[],
): KeyBinding[] {
  const forward = new Set<Command>([
    deleteCharForward,
    deleteGroupForward,
    deleteGroupForwardWin,
  ]);
  const backward = new Set<Command>([
    deleteCharBackward,
    deleteCharBackwardStrict,
    deleteGroupBackward,
  ]);
  const wrap = (command?: Command): Command | undefined =>
    command && (forward.has(command) || backward.has(command))
      ? (view) => {
          const { state } = view;
          if (state.readOnly) return false;
          let moved = false;
          const ranges = state.selection.ranges.map((range) => {
            const pos = range.empty
              ? pastRecords(state, range.head, forward.has(command))
              : range.head;
            if (pos === range.head) return range;
            moved = true;
            return EditorSelection.cursor(pos);
          });
          if (!moved) return false;
          view.dispatch({
            selection: EditorSelection.create(
              ranges,
              state.selection.mainIndex,
            ),
          });
          command(view);
          return true;
        }
      : undefined;
  return bindings.flatMap((binding) => {
    const run = wrap(binding.run),
      shift = wrap(binding.shift);
    return run || shift ? [{ ...binding, run, shift }] : [];
  });
}

// Records hidden right after a table or figure, with the line break before
// them, belong to its block: a line of their own would show as empty.
export function hiddenAfter(state: EditorState, end: number) {
  const range = hiddenRangeAfter(state, end);
  return range?.from === end ? range.to : end;
}

// The text of a line that a reader sees.
function visibleLine(state: EditorState, line: Line) {
  return visibleTextRanges(state, line.from, line.to)
    .map((range) => state.sliceDoc(range.from, range.to))
    .join("");
}

// Split the displayed text at its anchor, without inserting Markdown newlines.
// A rendered table is indivisible, so conversations belong after its preview.
// Its marker sits at the end edge of the table or figure, which is the left
// edge when that block reads right to left.
function commentPosition(
  state: EditorState,
  offset: number,
): { pos: number; block: boolean; direction?: TextDirection | null } {
  const pos = Math.max(0, Math.min(state.doc.length, offset));
  for (
    let node = syntaxTree(state).resolveInner(pos, -1);
    node;
    node = node.parent!
  ) {
    if (node.name === "Table")
      return {
        pos: hiddenAfter(state, state.doc.lineAt(node.to).to),
        block: true,
        direction: textDirection(state.sliceDoc(node.from, node.to)),
      };
  }
  const line = state.doc.lineAt(pos);
  const image =
    state.facet(mediaPreview) && wholeLineImage(visibleLine(state, line));
  if (image)
    return {
      pos: hiddenAfter(state, line.to),
      block: true,
      direction: textDirection(image.alt),
    };
  // A passage selected up to the end of its line can end among the records
  // hidden there, where nothing shows: its marker shows where they start.
  const hidden = hiddenRangeAfter(state, pos);
  return { pos: hidden && hidden.from < pos ? hidden.from : pos, block: false };
}

class CommentMarker extends WidgetType {
  constructor(
    readonly id: string,
    readonly active: boolean,
    readonly open: (id: string) => void,
    readonly block: boolean,
    readonly direction: TextDirection | null = null,
  ) {
    super();
  }
  eq(other: CommentMarker) {
    return (
      this.active === other.active &&
      this.id === other.id &&
      this.block === other.block &&
      this.direction === other.direction
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
      if (this.direction) wrap.dir = this.direction;
      wrap.append(button);
      return wrap;
    }
    return button;
  }
  ignoreEvent() {
    return true;
  }
}
// A conversation that opens inside a line splits it in two. CodeMirror keeps
// the line's attributes, such as its direction, on the part before it; the
// stylesheet gives the part after it that line's direction.
class ConversationWidget extends WidgetType {
  constructor(
    readonly host: HTMLElement,
    readonly splitsLine: boolean,
  ) {
    super();
  }
  eq(other: ConversationWidget) {
    return this.host === other.host && this.splitsLine === other.splitsLine;
  }
  toDOM() {
    this.host.toggleAttribute("data-splits-line", this.splitsLine);
    return this.host;
  }
  updateDOM(dom: HTMLElement) {
    if (dom !== this.host) return false;
    this.host.toggleAttribute("data-splits-line", this.splitsLine);
    return true;
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
              placement.direction,
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
        // A record that starts its line shows the next line's text in that
        // line: the conversation opens before that line, not inside it.
        const start = shownLines(tr.state).at.get(
          tr.state.doc.lineAt(position).from,
        );
        if (
          start !== undefined &&
          hidden.some((range) => range.from === start && range.to >= position)
        )
          position = start;
        const line = tr.state.doc.lineAt(position);
        ranges.push(
          Decoration.widget({
            block: true,
            side: position === line.from ? -1 : 2,
            widget: new ConversationWidget(
              host,
              position > line.from && position < line.to,
            ),
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
