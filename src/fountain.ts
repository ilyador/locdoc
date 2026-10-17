import { sourceComments } from "./comment-syntax";

export type FountainKind =
  | "blank"
  | "action"
  | "scene"
  | "character"
  | "dialogue"
  | "parenthetical"
  | "transition"
  | "centered"
  | "lyric"
  | "title"
  | "credit"
  | "metadata"
  | "section"
  | "synopsis"
  | "note"
  | "omitted"
  | "break";
export type FountainForce =
  | "scene"
  | "action"
  | "character"
  | "transition"
  | "centered"
  | "lyric"
  | "parenthetical";
export type FountainRange = { from: number; to: number };
export type FountainLine = FountainRange & {
  kind: FountainKind;
  text: string;
  markers: FountainRange[];
  prefix?: FountainRange;
  suffix?: FountainRange;
};
export type FountainScript = {
  lines: FountainLine[];
  notes: FountainRange[];
  omissions: FountainRange[];
};

// Layout never rewrites the source. Ranges are UTF-16 offsets, like CodeMirror
// and Y.Text. Comments/notes are masked in place so their contents cannot become
// character cues or move collaborative anchors.
export function parseFountain(source: string): FountainScript {
  const hidden = sourceComments(source);
  let visible = "",
    start = 0;
  for (const range of hidden) {
    visible +=
      source.slice(start, range.from) +
      source.slice(range.from, range.to).replace(/[^\r\n]/g, " ");
    start = range.to;
  }
  visible += source.slice(start);
  const notes: FountainRange[] = [],
    omissions: FountainRange[] = [];
  const special = /\\[^\r\n]|\/\*|\[\[/g;
  for (let match; (match = special.exec(visible));) {
    if (match[0].startsWith("\\")) continue;
    const close = match[0] === "/*" ? "*/" : "]]";
    const end = visible.indexOf(close, match.index + 2);
    const to = end < 0 ? visible.length : end + 2;
    (close === "*/" ? omissions : notes).push({ from: match.index, to });
    special.lastIndex = to;
  }
  const chunks: string[] = [];
  start = 0;
  for (const range of [...notes, ...omissions].sort(
    (a, b) => a.from - b.from,
  )) {
    chunks.push(
      visible.slice(start, range.from),
      visible.slice(range.from, range.to).replace(/[^\r\n]/g, " "),
    );
    start = range.to;
  }
  chunks.push(visible.slice(start));
  visible = chunks.join("");

  const raw = visible.split("\n");
  const lines: FountainLine[] = [];
  let offset = 0,
    dialogue = false,
    boundary = true;
  let titlePage = false,
    titleField = "",
    titlePossible = true;
  const cursors = new Map<FountainRange[], number>();
  const covered = (ranges: FountainRange[], line: FountainRange) => {
    let index = cursors.get(ranges) || 0;
    while (index < ranges.length && ranges[index].to <= line.from) index++;
    cursors.set(ranges, index);
    return index < ranges.length && ranges[index].from < line.to;
  };
  for (let i = 0; i < raw.length; i++) {
    const value = raw[i].replace(/\r$/, "");
    const text = value.trim();
    const line: FountainLine = {
      from: offset,
      to: offset + value.length,
      text: value,
      kind: "action",
      markers: [],
    };
    offset += raw[i].length + 1;
    lines.push(line);
    const marker = (from: number, to: number) => {
      const range = { from: line.from + from, to: line.from + to };
      line.markers.push(range);
      return range;
    };
    const lead = value.length - value.trimStart().length;
    if (
      !text &&
      (covered(omissions, line) ||
        covered(notes, line) ||
        covered(hidden, line))
    ) {
      line.kind = covered(omissions, line) ? "omitted" : "note";
      continue;
    }
    if (!text) {
      line.kind =
        dialogue && (value.length >= 2 || i === raw.length - 1)
          ? "dialogue"
          : "blank";
      if (line.kind === "blank") {
        dialogue = false;
        boundary = true;
        titlePage = false;
      }
      continue;
    }
    const field = /^([A-Za-z][A-Za-z ]*):[ \t]*/.exec(value);
    if (
      titlePossible &&
      field &&
      /^(title|credit|authors?|source|draft date|contact|copyright|notes)$/i.test(
        field[1],
      )
    )
      titlePage = true;
    if (titlePage && (field || /^ {3,}|^\t/.test(value))) {
      if (field) titleField = field[1].toLowerCase();
      line.kind =
        titleField === "title"
          ? "title"
          : /^(credit|authors?|source)$/.test(titleField)
            ? "credit"
            : "metadata";
      line.prefix = marker(0, field ? field[0].length : lead);
      line.text = value.slice(line.prefix.to - line.from);
      titlePossible = false;
      continue;
    }
    titlePage = false;
    titlePossible = false;
    if (/^={3,}$/.test(text)) {
      line.kind = "break";
    } else if (/^#+\s/.test(text)) {
      line.kind = "section";
      line.prefix = marker(lead, lead + text.match(/^#+\s*/)![0].length);
    } else if (/^=(?!=)/.test(text)) {
      line.kind = "synopsis";
      line.prefix = marker(lead, lead + text.match(/^=\s*/)![0].length);
    } else if (/^>.*<\s*$/.test(text)) {
      line.kind = "centered";
      line.prefix = marker(lead, lead + text.match(/^>\s*/)![0].length);
      line.suffix = marker(value.lastIndexOf("<"), value.trimEnd().length);
    } else if (
      /^>/.test(text) ||
      (boundary &&
        text === text.toUpperCase() &&
        /TO:$/.test(text) &&
        !raw[i + 1]?.trim())
    ) {
      line.kind = "transition";
      if (text.startsWith(">"))
        line.prefix = marker(lead, lead + text.match(/^>\s*/)![0].length);
    } else if (
      /^\.[\p{L}\p{N}]/u.test(text) ||
      (boundary && /^(?:INT\.?\/EXT|INT\/EXT|I\/E|INT|EXT|EST)[. ]/i.test(text))
    ) {
      line.kind = "scene";
      if (text.startsWith(".")) line.prefix = marker(lead, lead + 1);
      const number = /#[\w.-]+#\s*$/.exec(value);
      if (number) {
        marker(number.index, number.index + 1);
        marker(value.trimEnd().length - 1, value.trimEnd().length);
      }
    } else if (text.startsWith("!")) {
      line.kind = "action";
      line.prefix = marker(lead, lead + 1);
    } else if (text.startsWith("~")) {
      line.kind = "lyric";
      line.prefix = marker(lead, lead + 1);
    } else {
      const name = text.replace(/\s*\^$/, "").replace(/\s*\([^)]*\)\s*$/, "");
      const cue =
        text.startsWith("@") ||
        (boundary &&
          /\p{L}/u.test(name) &&
          name === name.toUpperCase() &&
          !/[.!?:;]$/.test(name) &&
          (raw[i + 1]?.trim() || i >= raw.length - 2));
      if (cue) {
        line.kind = "character";
        if (text.startsWith("@")) line.prefix = marker(lead, lead + 1);
        const caret = /\s*\^\s*$/.exec(value);
        if (caret) {
          line.suffix = marker(caret.index, value.length);
        }
        dialogue = true;
      } else if (dialogue) {
        line.kind =
          /^\(.*\)\s*$/.test(text) || text.startsWith("(")
            ? "parenthetical"
            : "dialogue";
      }
    }
    if (!(
      line.kind === "character" ||
      line.kind === "dialogue" ||
      line.kind === "parenthetical" ||
      (line.kind === "lyric" && dialogue)
    )) {
      dialogue = false;
    }
    boundary = false;
    if (line.prefix)
      line.text = value.slice(
        line.prefix.to - line.from,
        line.suffix ? line.suffix.from - line.from : undefined,
      );
    if (line.kind === "centered") line.text = line.text.trim();
  }
  return { lines, notes, omissions };
}
