import type { Entry } from "./model";
import { documentName, isDocumentPath } from "./document-format.ts";

export function documentTitle(entry: Entry) {
  return entry.title || documentName(entry.path);
}

export function webLink(raw: string): string | null {
  try {
    const text = raw.trim().replace(/^<|>$/g, "");
    const url = new URL(text.startsWith("www.") ? `https://${text}` : text);
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function markdownLink(label: string, href: string) {
  const title = label.replace(/[\\\[\]]/g, "\\$&").replace(/[\r\n]+/g, " ");
  return `[${title}](<${href.replace(/</g, "%3C").replace(/>/g, "%3E")}>)`;
}

// A document link resolves to the address of the file at its path, so two
// listings with the same files at the same addresses resolve every link
// alike, whatever else about their documents differs, such as their times.
export function sameLinkTargets(a: Entry[], b: Entry[]) {
  if (a === b) return true;
  let i = 0;
  let j = 0;
  for (;;) {
    while (i < a.length && a[i].kind !== "file") i++;
    while (j < b.length && b[j].kind !== "file") j++;
    if (i === a.length || j === b.length)
      return i === a.length && j === b.length;
    if (a[i].path !== b[j].path || a[i].url !== b[j].url) return false;
    i++;
    j++;
  }
}

// A document's path in the workspace, as Copy path gives it, pasted into a
// Markdown document: the path from the folder of that document, so a link
// with it opens the same document. A path that already names a document from
// there is kept. In a link's destination, the path is written as a link
// reads it back. Null to paste the text as it is.
export function pastedDocumentPath(
  text: string,
  path: string,
  entries: Entry[],
  destination: boolean,
) {
  const target = text.trim();
  const isFile = (path: string | null) =>
    entries.some((entry) => entry.kind === "file" && entry.path === path);
  if (!isFile(target)) return null;
  let relative = target;
  if (!isFile(linkedPath(target, path))) {
    const from = path.split("/").slice(0, -1);
    const to = target.split("/");
    let shared = 0;
    while (
      shared < from.length &&
      shared < to.length - 1 &&
      from[shared] === to[shared]
    )
      shared++;
    relative = [
      ...from.slice(shared).map(() => ".."),
      ...to.slice(shared),
    ].join("/");
  }
  const written = destination ? linkDestination(relative) : relative;
  return written === text ? null : written;
}
// A link reads its destination decoded, and between angle brackets when it
// holds spaces or parentheses.
function linkDestination(path: string) {
  const encoded = path.replace(/%/g, "%25");
  return /[\s()<>]/.test(encoded)
    ? `<${encoded.replace(/</g, "%3C").replace(/>/g, "%3E")}>`
    : encoded;
}

// The workspace path a relative link from the document at `path` names.
function linkedPath(raw: string, path: string) {
  try {
    const decoded = decodeURIComponent(raw.replace(/^<|>$/g, ""));
    if (
      !isDocumentPath(decoded) ||
      decoded.startsWith("/") ||
      decoded.includes("\\")
    )
      return null;
    const parts = path.split("/").slice(0, -1);
    for (const part of decoded.split("/")) {
      if (part === "..") {
        if (!parts.length) return null;
        parts.pop();
      } else if (part !== "." && part) parts.push(part);
    }
    return parts.join("/");
  } catch {
    return null;
  }
}

export function resolveDocumentLink(
  raw: string,
  path: string,
  entries: Entry[],
) {
  const url = webLink(raw);
  if (url) return url;
  const linked = linkedPath(raw, path);
  if (linked === null) return null;
  return (
    entries.find((e) => e.kind === "file" && e.path === linked)?.url || null
  );
}
