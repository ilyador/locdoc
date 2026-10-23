import type { ChangeSet, Text } from "@codemirror/state";
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

export function hasSpeakerPrefix(text: string) {
  return /^\p{Lu}{2}/u.test(text);
}

// Whether a line, without a dual dialogue ^ or an extension such as (V.O.),
// reads as a name in capitals.
function speakerName(text: string) {
  const name = text.replace(/\s*\^$/, "").replace(/\s*\([^)]*\)\s*$/, "");
  return (
    hasSpeakerPrefix(name) &&
    name === name.toUpperCase() &&
    !/[.!?:;]$/.test(name)
  );
}

// A scene heading after a blank line starts with one of Fountain's prefixes,
// or Hebrew's פנים. (interior) or חוץ. (exterior), alone or combined as
// פנים/חוץ. Hebrew has no capitals: its character cues are forced with @.
const scenePrefix = /^(?:INT\.?\/EXT|INT\/EXT|I\/E|INT|EXT|EST)[. ]/i;
const hebrewScenePrefix = /^(?:פנים|חוץ)(?:\.?\/(?:פנים|חוץ))?\./;

// Layout never rewrites the source. Ranges are UTF-16 offsets, like CodeMirror
// and Y.Text. Comments/notes are masked in place so their contents cannot become
// character cues or move collaborative anchors.
// A focused editing line may preview an unfinished cue before dialogue exists.
export function parseFountain(
  source: string,
  editingLine?: number,
): FountainScript {
  const records = sourceComments(source).map(({ from, to }) => ({ from, to }));
  let visible = "",
    start = 0;
  for (const range of records) {
    visible +=
      source.slice(start, range.from) +
      source.slice(range.from, range.to).replace(/[^\r\n]/g, " ");
    start = range.to;
  }
  visible += source.slice(start);
  const notes: FountainRange[] = [],
    omissions: FountainRange[] = [];
  // Fountain never looks past a blank line for a closing ]]: a note ends
  // there, unless the line holds two spaces. A boneyard spans any number of
  // lines to its */, and an /* without one is text.
  const special = /\\[^\r\n]|\/\*|\[\[/g;
  const blank = /\n[ \t]?\r?(?=\n|$)/g;
  let closed = true;
  for (let match; (match = special.exec(visible));) {
    if (match[0].startsWith("\\")) continue;
    const from = match.index;
    let to: number;
    if (match[0] === "/*") {
      const end = closed ? visible.indexOf("*/", from + 2) : -1;
      // No later /* finds a */ either.
      if (end < 0) {
        closed = false;
        continue;
      }
      to = end + 2;
      omissions.push({ from, to });
    } else {
      blank.lastIndex = from;
      const paragraph = blank.exec(visible)?.index ?? visible.length;
      const end = visible.slice(from + 2, paragraph).indexOf("]]");
      to = end < 0 ? paragraph : from + end + 4;
      notes.push({ from, to });
    }
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
  const raw = chunks.join("").split("\n");
  const reading: Reading = {
    raw,
    records,
    text: raw.findIndex((line) => line.trim()),
  };
  const script: FountainScript = { lines: [], notes, omissions };
  read(script, reading, 0, editingLine);
  readings.set(script, reading);
  return script;
}

// What a parse read besides the script: each line as its kind is read, with
// comment records, notes and omissions blanked; the records it blanked; and
// the first line with text, or -1.
type Reading = { raw: string[]; records: FountainRange[]; text: number };
const readings = new WeakMap<FountainScript, Reading>();

// Reads the kinds of a script's lines into `script.lines` from line `first`
// on, the first line or one after a blank line, until `done` says the line
// just read is a blank line after which each line reads as before. Returns
// the index after the last line read.
function read(
  script: FountainScript,
  { raw, records, text: firstText }: Reading,
  first: number,
  editingLine: number | undefined,
  done?: (index: number) => boolean,
) {
  const { lines, notes, omissions } = script;
  let offset = first ? lines[first - 1].from + raw[first - 1].length + 1 : 0,
    dialogue = false,
    boundary = true;
  let titlePage = false,
    titleField = "",
    titlePossible = firstText < 0 || first <= firstText;
  // Each list of ranges, from the first that ends after where reading starts.
  const cursors = new Map<FountainRange[], number>();
  for (const ranges of [notes, omissions, records]) {
    let low = 0,
      high = ranges.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (ranges[middle].to <= offset) low = middle + 1;
      else high = middle;
    }
    cursors.set(ranges, low);
  }
  const covered = (ranges: FountainRange[], line: FountainRange) => {
    let index = cursors.get(ranges) || 0;
    while (index < ranges.length && ranges[index].to <= line.from) index++;
    cursors.set(ranges, index);
    return index < ranges.length && ranges[index].from < line.to;
  };
  const readLine = (i: number) => {
    const value = raw[i].endsWith("\r") ? raw[i].slice(0, -1) : raw[i];
    const text = value.trim();
    const line: FountainLine = {
      from: offset,
      to: offset + value.length,
      text: value,
      kind: "action",
      markers: [],
    };
    offset += raw[i].length + 1;
    lines[i] = line;
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
        covered(records, line))
    ) {
      line.kind = covered(omissions, line) ? "omitted" : "note";
      return;
    }
    if (!text) {
      line.kind =
        dialogue &&
        (value.length >= 2 ||
          i === raw.length - 1 ||
          (editingLine === i && lines[i - 1]?.kind === "character"))
          ? "dialogue"
          : "blank";
      if (line.kind === "blank") {
        dialogue = false;
        boundary = true;
        titlePage = false;
      }
      return;
    }
    // Only the top of a script can hold its title page.
    const field =
      titlePossible || titlePage
        ? /^([A-Za-z][A-Za-z ]*):[ \t]*/.exec(value)
        : null;
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
      return;
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
        text.endsWith("TO:") &&
        text === text.toUpperCase() &&
        !raw[i + 1]?.trim())
    ) {
      line.kind = "transition";
      if (text.startsWith(">"))
        line.prefix = marker(lead, lead + text.match(/^>\s*/)![0].length);
    } else if (
      /^\.[\p{L}\p{N}]/u.test(text) ||
      (boundary && (scenePrefix.test(text) || hebrewScenePrefix.test(text)))
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
      const cue =
        text.startsWith("@") ||
        (boundary &&
          hasSpeakerPrefix(text) &&
          speakerName(text) &&
          (raw[i + 1]?.trim() ||
            i >= raw.length - 2 ||
            editingLine === i ||
            (editingLine === i + 1 && !raw[i + 1]?.trim())));
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
  };
  for (let i = first; i < raw.length; i++) {
    readLine(i);
    if (done?.(i)) return i + 1;
  }
  return raw.length;
}

// A script whose parse changed, and the lines that read otherwise.
export type FountainUpdate = { script: FountainScript; lines: number[] };

// The lines an editing line changes how they read: itself, as an unfinished
// cue or the dialogue it starts, and the cue it can follow.
const editingLines = (line: number | undefined) =>
  line === undefined ? [] : [line - 1, line];

// The script read with the caret's editing line moved from `before` to
// `after`, as parseFountain would read it, reading again only the lines
// either one changes. The same script when every line reads as before.
export function moveEditingLine(
  script: FountainScript,
  before: number | undefined,
  after: number | undefined,
): FountainUpdate | null {
  const reading = readings.get(script);
  if (!reading) return null;
  const next: FountainScript = { ...script, lines: script.lines.slice() };
  const lines = reread(
    next,
    reading,
    script.lines,
    [...editingLines(before), ...editingLines(after)],
    after,
  );
  if (!lines.length) return { script, lines };
  readings.set(next, reading);
  return { script: next, lines };
}

// The script after `changes`, which turn `before` into `doc`, as
// parseFountain would read `doc`, reading again only the lines they change:
// for one edit of ordinary text, which keeps every note, omission and
// comment record whole. Otherwise null, as an edit that changes one of them
// can change how the rest of the script reads.
export function editFountain(
  script: FountainScript,
  changes: ChangeSet,
  before: Text,
  doc: Text,
  editingBefore: number | undefined,
  editingLine: number | undefined,
): FountainUpdate | null {
  const reading = readings.get(script);
  if (!reading) return null;
  const edits: { from: number; to: number; inserted: string }[] = [];
  changes.iterChanges((from, to, _fromB, _toB, inserted) =>
    edits.push({ from, to, inserted: inserted.toString() }),
  );
  if (edits.length !== 1) return null;
  const [{ from, to, inserted }] = edits;
  const first = before.lineAt(from),
    last = before.lineAt(to);
  // The characters that start or end a note, omission or record, or escape
  // one, around the edit and in what it inserts or deletes.
  const around = before.sliceString(
    Math.max(first.from, from - 1),
    Math.min(last.to, to + 1),
  );
  if (
    /[\\/*[\]\r]/.test(inserted) ||
    /[\\/*[\]\r]/.test(around) ||
    reading.records.some((range) => from <= range.to && to >= range.from)
  )
    return null;
  const map = (range: FountainRange) =>
    range.to < from
      ? range
      : {
          from: changes.mapPos(range.from, 1),
          to: changes.mapPos(range.to, 1),
        };
  const notes = script.notes.map(map),
    omissions = script.omissions.map(map),
    records = reading.records.map(map);
  // The edited lines as their kinds are read.
  const index = first.number - 1,
    removed = last.number - first.number + 1;
  const added = doc.lineAt(changes.mapPos(to, 1)).number - first.number + 1;
  const values: string[] = [];
  for (let n = first.number; n < first.number + added; n++) {
    const line = doc.line(n);
    let value = line.text;
    for (const range of [...records, ...notes, ...omissions])
      if (range.from < line.to && range.to > line.from) {
        const start = Math.max(range.from, line.from) - line.from,
          end = Math.min(range.to, line.to) - line.from;
        value =
          value.slice(0, start) + " ".repeat(end - start) + value.slice(end);
      }
    values.push(value);
  }
  // A blank line ends a note, unless it holds two spaces: a line break, or a
  // line that turns blank or stops being blank, can end a note or let it go
  // on, unless no note or omission reaches the edited lines.
  const blankness = (value: string) =>
    value.trim() ? 2 : /^[ \t]?$/.test(value) ? 0 : 1;
  if (
    (removed !== 1 ||
      added !== 1 ||
      blankness(reading.raw[index]) !== blankness(values[0])) &&
    [...script.notes, ...script.omissions].some(
      (range) => range.from <= last.to + 1 && range.to >= first.from - 1,
    )
  )
    return null;
  const raw = [
    ...reading.raw.slice(0, index),
    ...values,
    ...reading.raw.slice(index + removed),
  ];
  // The lines before the edit as they were, the edited ones to read, and
  // those after it moved.
  const delta = inserted.length - (to - from);
  const edited: FountainLine = {
    from: -1,
    to: -1,
    kind: "action",
    text: "",
    markers: [],
  };
  const old = [
    ...script.lines.slice(0, index),
    ...values.map(() => edited),
    ...script.lines.slice(index + removed).map((line) => shifted(line, delta)),
  ];
  // The first line with text, which ends where a title page can start.
  let text = reading.text;
  if (text < 0 || text >= index) {
    text = -1;
    for (let i = index; i < raw.length && text < 0; i++)
      if (raw[i].trim()) text = i;
  }
  const next: FountainScript = { lines: old.slice(), notes, omissions };
  const nextReading: Reading = { raw, records, text };
  // The editing line before the edit, where the edit left it.
  const moved =
    editingBefore === undefined || editingBefore < index
      ? editingBefore
      : editingBefore < index + removed
        ? index
        : editingBefore + added - removed;
  const lines = reread(
    next,
    nextReading,
    old,
    [
      index - 1,
      ...values.map((_, i) => index + i),
      ...editingLines(moved),
      ...editingLines(editingLine),
      // The last lines of a script read as its end: a script that gains or
      // loses lines moves its end away from or onto the lines before it.
      ...(added === removed ? [] : [raw.length - 3, raw.length - 2]),
    ],
    editingLine,
  );
  readings.set(next, nextReading);
  return { script: next, lines };
}

// Reads again the lines at `affected` and those whose reading they change,
// into `script`, from after the last blank line before each, until a blank
// line after which the lines of `old` read as before. Returns the lines that
// read otherwise than in `old`; the others keep their line from `old`.
function reread(
  script: FountainScript,
  reading: Reading,
  old: FountainLine[],
  affected: number[],
  editingLine: number | undefined,
) {
  const lines: number[] = [];
  let next = 0;
  for (const index of [...new Set(affected)].sort((a, b) => a - b)) {
    if (index < next || index < 0 || index >= old.length) continue;
    // A line reads the line after it, so reading starts before the line
    // before it, after a blank line that both readings share.
    let first = Math.max(index - 1, next);
    while (first > next && old[first - 1].kind !== "blank") first--;
    next = read(
      script,
      reading,
      first,
      editingLine,
      (i) =>
        i >= index &&
        script.lines[i].kind === "blank" &&
        old[i].kind === "blank",
    );
    for (let i = first; i < next; i++)
      if (sameLine(script.lines[i], old[i])) script.lines[i] = old[i];
      else lines.push(i);
  }
  return lines;
}

function sameLine(a: FountainLine, b: FountainLine) {
  return (
    a.kind === b.kind &&
    a.from === b.from &&
    a.to === b.to &&
    a.text === b.text &&
    a.markers.length === b.markers.length &&
    a.markers.every(
      (range, i) =>
        range.from === b.markers[i].from && range.to === b.markers[i].to,
    ) &&
    a.markers.indexOf(a.prefix!) === b.markers.indexOf(b.prefix!) &&
    a.markers.indexOf(a.suffix!) === b.markers.indexOf(b.suffix!)
  );
}

// A line moved by `delta`, with its markers.
function shifted(line: FountainLine, delta: number): FountainLine {
  if (!delta) return line;
  const markers = line.markers.map((range) => ({
    from: range.from + delta,
    to: range.to + delta,
  }));
  const moved: FountainLine = {
    ...line,
    from: line.from + delta,
    to: line.to + delta,
    markers,
  };
  if (line.prefix) moved.prefix = markers[line.markers.indexOf(line.prefix)];
  if (line.suffix) moved.suffix = markers[line.markers.indexOf(line.suffix)];
  return moved;
}
