import type { Document, Entry } from "./model";
import { inkIncludes, inkPath, inkSource, prepareInk } from "./ink-source";

export async function loadInkProject(
  path: string,
  source: string,
  entries: Entry[],
  read: (id: string) => Promise<Pick<Document, "content">>,
) {
  const files: Record<string, string> = Object.create(null);
  let bytes = 0;
  async function visit(path: string, source: string) {
    if (Object.hasOwn(files, path)) return;
    bytes += source.length;
    if (Object.keys(files).length >= 64 || bytes > 2_000_000)
      throw new Error(
        "This preview supports up to 64 Ink files and 2 MB of source.",
      );
    files[path] = prepareInk(source, path);
    for (const include of inkIncludes(inkSource(source))) {
      const target = inkPath(path, include.name);
      if (Object.hasOwn(files, target)) continue;
      // Only listed documents are candidates; the API still checks current
      // permission. Never turn an INCLUDE into an arbitrary URL or disk read.
      const entry = entries.find(
        (entry) => entry.kind === "file" && entry.path === target && entry.id,
      );
      if (!entry?.id)
        throw new Error(
          `Cannot preview INCLUDE ${include.name}: open a workspace or folder link that contains this file.`,
        );
      await visit(target, (await read(entry.id)).content);
    }
  }
  await visit(path, source);
  return files;
}
