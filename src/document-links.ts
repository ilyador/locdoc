import type { Entry } from "./model";

export function documentTitle(entry: Entry) {
  return entry.title || entry.path.split("/").pop()!.replace(/\.md$/i, "");
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
      !decoded.endsWith(".md") ||
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
