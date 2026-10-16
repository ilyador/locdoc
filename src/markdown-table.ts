export type TableCell = { text: string; from: number; to: number };
export type MarkdownTable = {
  rows: TableCell[][];
  align: ("left" | "center" | "right")[];
};

// Retain source offsets so a preview cell opens at the right Markdown position.
function cells(line: string, offset: number): TableCell[] {
  const boundaries = [-1];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\") {
      i++;
      continue;
    }
    if (line[i] === "|") boundaries.push(i);
  }
  boundaries.push(line.length);
  const result: TableCell[] = [];
  for (let i = 1; i < boundaries.length; i++) {
    const from = boundaries[i - 1] + 1;
    const to = boundaries[i];
    const raw = line.slice(from, to);
    if (!raw.trim() && (i === 1 || i === boundaries.length - 1)) continue;
    const leading = raw.length - raw.trimStart().length;
    result.push({
      text: raw.trim().replace(/\\\|/g, "|"),
      from: offset + from + leading,
      to: Math.max(
        offset + from + leading,
        offset + to - (raw.length - raw.trimEnd().length),
      ),
    });
  }
  return result;
}

export function parseMarkdownTable(
  source: string,
  offset = 0,
): MarkdownTable | null {
  const lines = source.split("\n");
  if (lines.length < 2) return null;
  const header = cells(lines[0], offset);
  const separator = cells(lines[1], offset + lines[0].length + 1);
  if (
    !header.length ||
    separator.length !== header.length ||
    !separator.every((cell) => /^:?-+:?$/.test(cell.text))
  )
    return null;
  const align = separator.map((cell): "left" | "center" | "right" =>
    cell.text.endsWith(":")
      ? cell.text.startsWith(":")
        ? "center"
        : "right"
      : "left",
  );
  const rows = [header];
  let start = offset + lines[0].length + lines[1].length + 2;
  for (const line of lines.slice(2)) {
    if (!line.trim()) break;
    const row = cells(line, start).slice(0, header.length);
    while (row.length < header.length)
      row.push({
        text: "",
        from: start + line.length,
        to: start + line.length,
      });
    rows.push(row);
    start += line.length + 1;
  }
  return { rows, align };
}

export function createMarkdownTable(rows: number, columns: number) {
  rows = Math.min(10, Math.max(1, Math.trunc(rows) || 1));
  columns = Math.min(8, Math.max(1, Math.trunc(columns) || 1));
  const row = (values: string[]) => `| ${values.join(" | ")} |`;
  return [
    row(Array.from({ length: columns }, (_, i) => `Column ${i + 1}`)),
    row(Array(columns).fill("---")),
    ...Array.from({ length: rows - 1 }, () => row(Array(columns).fill("   "))),
  ].join("\n");
}
