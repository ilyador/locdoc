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

export function resolveDocumentLink(
  raw: string,
  path: string,
  entries: Entry[],
) {
  const url = webLink(raw);
  if (url) return url;
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
    return (
      entries.find((e) => e.kind === "file" && e.path === parts.join("/"))
        ?.url || null
    );
  } catch {
    return null;
  }
}
