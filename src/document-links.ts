import { digest } from "lib0/hash/sha256";
import { documentName, isDocumentPath } from "./document-format.ts";
import type { Entry } from "./model";

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
    if (
      a[i].path !== b[j].path ||
      a[i].url !== b[j].url ||
      a[i].workspacePathHash !== b[j].workspacePathHash
    )
      return false;
    i++;
    j++;
  }
}

function folderLinkEntry(entry: Entry) {
  // Old cached folder listings still have the folder capability in their URL.
  return !!entry.workspacePathHash || !!entry.url?.includes("?doc=");
}

function workspaceDestination(path: string) {
  return "/" + path.replace(/[&%<>|?#\r\n\t]/g, encodeURIComponent);
}

// A folder link lists paths from the shared folder, so a guest choosing
// a document can insert its shared URL without learning the owner's path.
export function documentDestination(entry: Entry) {
  return folderLinkEntry(entry) ? entry.url! : workspaceDestination(entry.path);
}

// The clipboard path shown in Share is relative to the documents folder.
// Prefer that exact file over a same-named file near the source document.
export function pastedDocumentPath(
  text: string,
  path: string,
  entries: Entry[],
) {
  const target = text.trim();
  const copiedPath = target.replace(/^\//, "");
  const entry =
    entries.find(
      (e) => e.kind === "file" && !folderLinkEntry(e) && e.path === copiedPath,
    ) ?? linkedDocument(target, path, entries);
  if (!entry || folderLinkEntry(entry)) return null;
  const href = workspaceDestination(entry.path);
  const written = /[\s()]/.test(href) ? `<${href}>` : href;
  return written === text ? null : written;
}

// A leading slash starts at the docs root. Older relative links start at
// the source document's folder and cannot climb above their own listing.
function linkedPath(raw: string, path: string) {
  try {
    const decoded = decodeURIComponent(raw.replace(/^<|>$/g, ""));
    if (
      !isDocumentPath(decoded) ||
      decoded.startsWith("//") ||
      decoded.includes("\\")
    )
      return null;
    const rooted = decoded.startsWith("/");
    const parts = rooted ? [] : path.split("/").slice(0, -1);
    for (const part of decoded.split("/")) {
      if (part === "..") {
        if (!parts.length) return null;
        parts.pop();
      } else if (part !== "." && part) parts.push(part);
    }
    return { path: parts.join("/"), rooted };
  } catch {
    return null;
  }
}

function linkedDocument(raw: string, path: string, entries: Entry[]) {
  const linked = linkedPath(raw, path);
  if (!linked) return;
  let hash: string | undefined;
  return entries.find((entry) => {
    if (entry.kind !== "file") return false;
    if (!linked.rooted || !folderLinkEntry(entry))
      return entry.path === linked.path;
    if (!entry.workspacePathHash) return false;
    hash ??= Array.from(digest(new TextEncoder().encode(linked.path)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return entry.workspacePathHash === hash;
  });
}

export function resolveDocumentLink(
  raw: string,
  path: string,
  entries: Entry[],
) {
  return webLink(raw) || linkedDocument(raw, path, entries)?.url || null;
}
