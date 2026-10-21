import {
  ChangeSet,
  EditorState,
  type TransactionSpec,
} from "@codemirror/state";
import { commentParser } from "./comment-syntax";
import { sourceCommentRanges, visibleTextRanges } from "./editor-comments";
import { fountainInlineParser } from "./fountain-preview";

type TextRange = { from: number; to: number };
function mergeRanges(ranges: TextRange[]) {
  const merged: TextRange[] = [];
  for (const range of ranges.sort((a, b) => a.from - b.from || a.to - b.to)) {
    const previous = merged.at(-1);
    if (previous && range.from <= previous.to)
      previous.to = Math.max(previous.to, range.to);
    else if (range.to > range.from) merged.push({ ...range });
  }
  return merged;
}
function subtractRanges(ranges: TextRange[], cuts: TextRange[]) {
  return ranges.flatMap((range) => {
    const parts: TextRange[] = [];
    let from = range.from;
    for (const cut of cuts) {
      if (cut.to <= from || cut.from >= range.to) continue;
      if (cut.from > from) parts.push({ from, to: cut.from });
      from = Math.max(from, cut.to);
    }
    if (from < range.to) parts.push({ from, to: range.to });
    return parts;
  });
}

// Change delimiters only: selected characters and hidden comment records retain
// their CRDT identities, including when removing part of an existing emphasis.
export function toggleInlineFormat(
  state: EditorState,
  marker: "*" | "**" | "_",
  fountain = false,
  onUnsafe?: (message: string) => void,
): TransactionSpec {
  const main = state.selection.main;
  const { from, to } = main;
  const source = state.doc.toString();
  if (from === to) {
    const paired =
      source.slice(Math.max(0, from - marker.length), from) === marker &&
      source.slice(from, from + marker.length) === marker &&
      source[from - marker.length - 1] !== "\\";
    return {
      changes: paired
        ? { from: from - marker.length, to: from + marker.length }
        : { from, insert: marker + marker },
      selection: { anchor: from + (paired ? -marker.length : marker.length) },
    };
  }
  let selected = visibleTextRanges(state, from, to);
  type FormatPair = {
    from: number;
    to: number;
    open: TextRange;
    close: TextRange;
    wanted: boolean;
    kind: "bold" | "italic" | "underline";
  };
  const kind =
    marker === "**"
      ? "bold"
      : marker === "_" && fountain
        ? "underline"
        : "italic";
  const readSyntax = (source: string) => {
    const pairs: FormatPair[] = [];
    const syntaxMarks: TextRange[] = [];
    const parse = (text: string, offset: number, prefix = "") => {
      (fountain ? fountainInlineParser : commentParser)
        .parse(prefix + text)
        .iterate({
          enter(node) {
            if (node.name === "LocdocComment") return false;
            if (node.name === "EmphasisMark")
              syntaxMarks.push({
                from: node.from + offset - prefix.length,
                to: node.to + offset - prefix.length,
              });
            if (node.name !== "StrongEmphasis" && node.name !== "Emphasis")
              return;
            const marks = node.node.getChildren("EmphasisMark");
            if (marks.length !== 2) return;
            const convert = (range: TextRange) => ({
              from: range.from + offset - prefix.length,
              to: range.to + offset - prefix.length,
            });
            const open = convert(marks[0]),
              close = convert(marks[1]);
            if (open.from < offset || close.to > offset + text.length) return;
            const delimiter = source.slice(open.from, open.to);
            const style =
              fountain && delimiter.includes("_")
                ? "underline"
                : node.name === "StrongEmphasis"
                  ? "bold"
                  : "italic";
            pairs.push({
              from: open.from,
              to: close.to,
              open,
              close,
              wanted: style === kind,
              kind: style,
            });
          },
        });
    };
    if (fountain) {
      let offset = 0,
        number = 1;
      const first = state.doc.lineAt(from).number,
        last = state.doc.lineAt(to).number;
      for (const line of source.split("\n")) {
        if (number >= first && number <= last) parse(line, offset, "x ");
        if (number++ >= last) break;
        offset += line.length + 1;
      }
    } else parse(source, 0);
    return { pairs, syntaxMarks };
  };
  const { pairs, syntaxMarks } = readSyntax(source);
  const hiddenSource = sourceCommentRanges(state);
  const inert = mergeRanges([...syntaxMarks, ...hiddenSource]);
  const touchesFormat = pairs.some(
    (pair) =>
      pair.wanted &&
      selected.some((range) => range.from < pair.to && range.to > pair.from),
  );
  // A fully selected nested style travels with its content. Closing bold before
  // an italic opener (rather than inside it) avoids crossing Markdown pairs.
  for (let pass = 0; pass < pairs.length; pass++) {
    let expanded = false;
    for (const pair of pairs) {
      const content = subtractRanges(
        [{ from: pair.open.to, to: pair.close.from }],
        inert,
      ).filter((part) => /\S/.test(source.slice(part.from, part.to)));
      const first = content[0],
        last = content.at(-1);
      if (!first || !last) continue;
      for (const range of selected)
        if (
          (pair.wanted ||
            touchesFormat ||
            range.from < pair.from ||
            range.to > pair.to) &&
          range.from <= first.from &&
          range.to >= last.to &&
          (range.from > pair.from || range.to < pair.to)
        ) {
          range.from = Math.min(range.from, pair.from);
          range.to = Math.max(range.to, pair.to);
          expanded = true;
        }
    }
    if (!expanded) break;
    selected = mergeRanges(selected);
  }
  const relevant = pairs.filter(
    (pair) =>
      pair.wanted &&
      selected.some((range) => range.from < pair.to && range.to > pair.from),
  );
  const removed = state.changes(
    mergeRanges(relevant.flatMap((pair) => [pair.open, pair.close])),
  );
  const doc = removed.apply(state.doc);
  const map = (range: TextRange) => ({
    from: removed.mapPos(range.from, 1),
    to: removed.mapPos(range.to, -1),
  });
  const hidden = hiddenSource.map(map);
  const marks = mergeRanges(syntaxMarks.map(map));
  // Delimiters cannot cross physical lines or hidden records. Trimming each run
  // keeps split emphasis valid: **hello world** -> hello **world**.
  const runs = (ranges: TextRange[]) =>
    mergeRanges(
      subtractRanges(ranges, hidden).flatMap((range) => {
        const result: TextRange[] = [];
        for (let start = range.from; start < range.to;) {
          const line = doc.lineAt(start);
          const end = Math.min(range.to, line.to);
          const value = doc.sliceString(start, end);
          const leading = value.match(/^\s*/)?.[0].length ?? 0;
          const trailing = value.match(/\s*$/)?.[0].length ?? 0;
          if (
            leading + trailing < value.length &&
            subtractRanges([{ from: start, to: end }], marks).some((part) =>
              /\S/.test(doc.sliceString(part.from, part.to)),
            )
          )
            result.push({ from: start + leading, to: end - trailing });
          start = line.to + 1;
        }
        return result;
      }),
    );
  const selection = runs(selected.map(map));
  if (!selection.length) return {};
  const existing = mergeRanges(
    relevant.map((pair) => map({ from: pair.open.to, to: pair.close.from })),
  );
  const remove = !subtractRanges(
    subtractRanges(selection, marks),
    existing,
  ).some((part) => /\S/.test(doc.sliceString(part.from, part.to)));
  const desired = runs(
    remove
      ? subtractRanges(existing, selection)
      : mergeRanges([...existing, ...selection]),
  );
  const added = ChangeSet.of(
    desired.flatMap((range) => [
      { from: range.from, insert: marker },
      { from: range.to, insert: marker },
    ]),
    doc.length,
  );
  const candidate = added.apply(doc).toString();
  const parsed = readSyntax(candidate);
  const reverse = (range: TextRange) => ({
    from: added.invertedDesc.mapPos(range.from, 1),
    to: added.invertedDesc.mapPos(range.to, -1),
  });
  const parsedMarks = mergeRanges(parsed.syntaxMarks);
  let invalid = false;
  added.iterChanges((_from, _to, fromB, toB) => {
    if (subtractRanges([{ from: fromB, to: toB }], parsedMarks).length)
      invalid = true;
  });
  const differs = (a: TextRange[], b: TextRange[]) =>
    subtractRanges(
      subtractRanges(a, b),
      [...marks, ...hidden].sort((a, b) => a.from - b.from),
    ).some((part) => /\S/.test(doc.sliceString(part.from, part.to)));
  for (const style of ["bold", "italic", "underline"] as const) {
    const expected = mergeRanges([
      ...(style === kind ? desired : []),
      ...pairs
        .filter(
          (pair) =>
            pair.kind === style && (style !== kind || !relevant.includes(pair)),
        )
        .map((pair) => map({ from: pair.open.to, to: pair.close.from })),
    ]);
    const actual = mergeRanges(
      parsed.pairs
        .filter((pair) => pair.kind === style)
        .map((pair) => reverse({ from: pair.open.to, to: pair.close.from })),
    );
    if (differs(expected, actual) || differs(actual, expected)) invalid = true;
  }
  const survivingMarks = mergeRanges(parsed.syntaxMarks.map(reverse));
  if (
    subtractRanges(survivingMarks, marks).length ||
    subtractRanges(marks, survivingMarks).length
  )
    invalid = true;
  if (invalid) {
    onUnsafe?.(
      "This selection would break nested formatting. Select the complete word or phrase and try again.",
    );
    return {};
  }
  const changes = removed.compose(added);
  return {
    changes,
    selection: {
      anchor: changes.mapPos(main.anchor, main.anchor < main.head ? 1 : -1),
      head: changes.mapPos(main.head, main.anchor < main.head ? -1 : 1),
    },
    userEvent: "input.format",
  };
}
