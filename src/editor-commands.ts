import * as Y from "yjs";
import { startCompletion } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import {
  resolveCommentAnchor,
  sourceCommentRanges,
  visibleTextRanges,
} from "./editor-comments";
import { commentReadingText, sourceComments } from "./comment-syntax";
import { markdownLink } from "./document-links";
import { parseFountain, type FountainForce } from "./fountain";
import { createMarkdownTable } from "./markdown-table";
import type { Anchor, Selection } from "./editor-types";

// Toolbar commands. Callers check edit access first; every change edits visible
// runs only, so hidden comment records keep their CRDT identities.
export function formatFountainLine(v: EditorView, kind: FountainForce) {
  const current = v.state.doc.lineAt(v.state.selection.main.head);
  const line = parseFountain(v.state.doc.toString()).lines[current.number - 1];
  const prefix = {
    scene: ".",
    action: "!",
    character: "@",
    transition: "> ",
    centered: "> ",
    lyric: "~",
    parenthetical: "(",
  }[kind];
  const suffix =
    kind === "centered" ? " <" : kind === "parenthetical" ? ")" : "";
  const existingParenthetical = line.kind === "parenthetical";
  const contentStart = current.from + line.text.search(/\S|$/);
  const from =
    line.prefix?.from ?? (existingParenthetical ? contentStart : current.from);
  const to =
    line.prefix?.to ??
    (existingParenthetical ? contentStart + 1 : current.from);
  const end = existingParenthetical
    ? current.from + line.text.trimEnd().length
    : (visibleTextRanges(v.state, current.from, current.to).at(-1)?.to ??
      current.to);
  const tail =
    line.suffix?.from ??
    (existingParenthetical && v.state.sliceDoc(end - 1, end) === ")"
      ? end - 1
      : end);
  const head = visibleTextRanges(v.state, from, to);
  const foot = visibleTextRanges(v.state, tail, end);
  const changes = v.state.changes([
    ...head.map((part, i) => ({
      ...part,
      insert: i === 0 ? prefix : "",
    })),
    ...foot.map((part, i) => ({
      ...part,
      insert: i === 0 ? suffix : "",
    })),
  ]);
  v.dispatch({
    changes,
    selection: { anchor: changes.mapPos(from, -1) + prefix.length },
    scrollIntoView: true,
  });
  v.focus();
  if (kind === "character") startCompletion(v);
}

export function insertDocumentLink(
  v: EditorView,
  ydoc: Y.Doc,
  url: string,
  label: string,
  anchor: Anchor,
) {
  const range = resolveCommentAnchor(ydoc, anchor);
  if (!range) return;
  const text = markdownLink(label, url);
  const visible = visibleTextRanges(v.state, range.from, range.to);
  if (!visible.length) return;
  v.dispatch({
    changes: visible.map((r, i) => ({
      ...r,
      insert: i === 0 ? text : "",
    })),
    selection: { anchor: visible[0].from + text.length },
    scrollIntoView: true,
  });
}

export function toggleTaskList(v: EditorView) {
  const range = v.state.selection.main;
  const first = v.state.doc.lineAt(range.from),
    last = v.state.doc.lineAt(range.to > range.from ? range.to - 1 : range.to);
  const hidden = sourceCommentRanges(v.state);
  const lines = [];
  for (let n = first.number; n <= last.number; n++) {
    const line = v.state.doc.line(n);
    if (!hidden.some((r) => r.from <= line.from && line.to <= r.to))
      lines.push(line);
  }
  const remove = lines.every((line) =>
    /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\] /.test(line.text),
  );
  const changes = v.state.changes(
    lines.flatMap((line) => {
      if (!remove && /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]/.test(line.text))
        return [];
      const prefix = (
        remove
          ? /^(\s*)(?:[-*+]|\d+[.)])\s+\[[ xX]\] /
          : /^(\s*)(?:(?:[-*+]|\d+[.)])\s+)?/
      ).exec(line.text)!;
      return [
        {
          from: line.from + prefix[1].length,
          to: line.from + prefix[0].length,
          insert: remove ? "" : "- [ ] ",
        },
      ];
    }),
  );
  v.dispatch({
    changes,
    selection: { anchor: changes.mapPos(last.to, 1) },
  });
  v.focus();
}

export function insertText(v: EditorView, text: string) {
  const { from, to } = v.state.selection.main;
  v.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
  });
  v.focus();
}

export function insertMarkdownTable(
  v: EditorView,
  rows: number,
  columns: number,
) {
  const { from, to } = v.state.selection.main;
  const before = v.state.sliceDoc(0, from);
  const prefix =
    before.endsWith("\n\n") || !before
      ? ""
      : before.endsWith("\n")
        ? "\n"
        : "\n\n";
  const text = prefix + createMarkdownTable(rows, columns) + "\n\n";
  v.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    scrollIntoView: true,
  });
  v.focus();
}

export function wrapSelection(v: EditorView, before: string, after = "") {
  const { from, to } = v.state.selection.main;
  const source = v.state.doc.toString();
  const segments = visibleTextRanges(v.state, from, to);
  const codeDelimiter =
    before === "`" && after === "`"
      ? "`".repeat(
          (source.match(/`+/g) || []).reduce(
            (max, run) => Math.max(max, run.length),
            0,
          ) + 1,
        )
      : null;
  const changes = v.state.changes(
    !after
      ? [{ from, insert: before }]
      : segments.flatMap((r) => {
          const value = source.slice(r.from, r.to);
          const pad =
            codeDelimiter &&
            (/^`|`$/.test(value) || (/^ .* $/.test(value) && /\S/.test(value)))
              ? " "
              : "";
          return [
            {
              from: r.from,
              insert: codeDelimiter ? codeDelimiter + pad : before,
            },
            {
              from: r.to,
              insert: codeDelimiter ? pad + codeDelimiter : after,
            },
          ];
        }),
  );
  // Insert format markers around visible runs. Replacing the selection
  // recreated CRDT identities and could wrap hidden records in code.
  v.dispatch({
    changes,
    selection:
      from === to
        ? { anchor: from + (codeDelimiter?.length || before.length) }
        : {
            anchor: changes.mapPos(from, 1),
            head: changes.mapPos(to, -1),
          },
  });
  v.focus();
}

export function selectionAnchor(
  v: EditorView,
  ydoc: Y.Doc,
  wholeLine: boolean,
): Selection {
  let { from, to } = v.state.selection.main;
  if (wholeLine && from === to) {
    const line = v.state.doc.lineAt(from);
    from = line.from;
    to =
      sourceComments(v.state.doc.toString()).find(
        (thread) => thread.from >= from && thread.from <= line.to,
      )?.from ?? line.to;
  }
  const text = ydoc.getText("content");
  return {
    quote: commentReadingText(v.state.sliceDoc(from, to)),
    anchor: {
      start: Y.relativePositionToJSON(
        Y.createRelativePositionFromTypeIndex(text, from),
      ),
      end: Y.relativePositionToJSON(
        Y.createRelativePositionFromTypeIndex(text, to, wholeLine ? -1 : 0),
      ),
    },
  };
}

export function locateAnchor(v: EditorView, ydoc: Y.Doc, anchor: Anchor) {
  try {
    const start = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(anchor.start),
      ydoc,
    );
    const end = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(anchor.end),
      ydoc,
    );
    if (start && end) {
      v.dispatch({
        selection: { anchor: start.index, head: end.index },
        effects: [EditorView.scrollIntoView(start.index, { y: "center" })],
      });
    }
  } catch {
    /* A malformed anonymous anchor must not break the editor. */
  }
}
