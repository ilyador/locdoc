import { parentPath } from "./file-names";
import type { TreeRow } from "./file-tree";
import type { SidebarView } from "./workspace";

// A workspace lists a thousand sidebar rows, and laying all of them out at
// once held up the first paint. The tree lays its rows out in chunks; one
// away from the screen skips its layout (content-visibility, in style.css).
// A browser checks every such chunk for visibility on every frame, so there
// are a few dozen, not a thousand.
//
// A chunk starts at a row whose path picks it, about one row in AVERAGE, or
// after LONGEST rows. A row that moves, appears or goes so changes only the
// chunks it leaves and joins, and every other row keeps its element.
export const AVERAGE = 24;
export const LONGEST = 48;

export type Chunk = {
  key: string;
  // Its rows: rows.slice(start, start + size).
  start: number;
  size: number;
  // Its rows by the height they have: folders, documents on one line, and
  // documents with their folder on a line under the name, in By date.
  folders: number;
  files: number;
  paths: number;
  // The held row it holds, if any; a chunk holding one is never skipped.
  holds?: string;
};
const picked = new Map<string, boolean>();
function picks(path: string) {
  let value = picked.get(path);
  if (value === undefined) {
    // FNV-1a: the same path picks the same way in every listing.
    let hash = 0x811c9dc5;
    for (let index = 0; index < path.length; index++)
      hash = Math.imul(hash ^ path.charCodeAt(index), 0x01000193);
    value = (hash >>> 0) % AVERAGE === 0;
    if (picked.size >= 50_000) picked.clear();
    picked.set(path, value);
  }
  return value;
}

// Rows a chunk holds are kept as the elements they are: a new document's or
// a rename's name field, which holds the caret and grows with its message,
// and a dragged row, whose element the drag started from.
export const NEW_ROW = "\0new";

export function treeChunks(
  rows: TreeRow[],
  view: SidebarView,
  // The paths of held rows, beside a new document's field.
  held: (string | null | undefined)[] = [],
): Chunk[] {
  const chunks: (Chunk & { first?: string })[] = [];
  let chunk: (Chunk & { first?: string }) | undefined;
  rows.forEach((row, index) => {
    const path = row.type === "entry" ? row.entry.path : NEW_ROW;
    if (
      !chunk ||
      chunk.size >= LONGEST ||
      (row.type === "entry" && picks(path))
    ) {
      chunk = {
        key: "",
        start: index,
        size: 0,
        folders: 0,
        files: 0,
        paths: 0,
      };
      chunks.push(chunk);
    }
    chunk.size++;
    if (row.type === "create" || held.includes(path)) chunk.holds ??= path;
    if (row.type === "create") return;
    // A field opening at a chunk's top leaves it the chunk it was.
    chunk.first ??= path;
    if (row.entry.kind === "folder") chunk.folders++;
    else if (view === "date" && parentPath(path)) chunk.paths++;
    else chunk.files++;
  });
  // A chunk whose rows' heights change is a new element: a browser keeps
  // the height a skipped element last had on screen.
  return chunks.map(({ first, ...chunk }) => ({
    ...chunk,
    key: [view, first ?? NEW_ROW, chunk.folders, chunk.files, chunk.paths].join(
      "\n",
    ),
  }));
}

// The chunks with the keys to render them by. One holding a row keeps the
// key it had when it began to: it is never skipped meanwhile, so the rows
// that come and go around the held one need no new element.
export function keyedChunks(chunks: Chunk[], kept: Map<string, string>) {
  const keyed = chunks.map((chunk) => {
    if (!chunk.holds) return chunk;
    let key = kept.get(chunk.holds);
    if (key === undefined) kept.set(chunk.holds, (key = chunk.key));
    return key === chunk.key ? chunk : { ...chunk, key };
  });
  for (const path of kept.keys())
    if (!chunks.some((chunk) => chunk.holds === path)) kept.delete(path);
  // A kept key may meet a chunk that came to have it since.
  const used = new Set<string>();
  return keyed.map((chunk, index) => {
    if (!used.has(chunk.key)) {
      used.add(chunk.key);
      return chunk;
    }
    const key = `${chunk.key}\n${index}`;
    used.add(key);
    return { ...chunk, key };
  });
}
