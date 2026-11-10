import type { SyntaxNode } from "@lezer/common";
import { resolveDocumentLink } from "./document-links";
import { decodeMarkdownText } from "./markdown-media";
import type { Entry } from "./model";

const inlineStyles: Record<string, readonly [string, string, string]> = {
  StrongEmphasis: ["strong", "md-strong", "EmphasisMark"],
  Emphasis: ["em", "md-em", "EmphasisMark"],
  Strikethrough: ["s", "md-strike", "StrikethroughMark"],
  InlineCode: ["code", "md-inline-code", "CodeMark"],
};

// Both the live text and table cells resolve exactly these destinations. An
// unsupported URL stays literal, never an executable anchor.
export function inlineLink(
  read: (from: number, to: number) => string,
  node: SyntaxNode,
  path: string,
  entries: Entry[],
) {
  if (!/^(Link|Autolink|URL)$/.test(node.name)) return null;
  if (
    node.name === "URL" &&
    /^(Link|Autolink|Image)$/.test(node.parent?.name || "")
  )
    return null;
  const destination = node.name === "URL" ? node : node.getChild("URL");
  if (!destination) return null;
  const href = resolveDocumentLink(
    decodeMarkdownText(
      read(destination.from, destination.to).replace(/^<|>$/g, ""),
    ),
    path,
    entries,
  );
  if (!href) return null;
  const marks = node.getChildren("LinkMark");
  const from =
    node.name === "Link" ? marks[0]?.to || node.from : destination.from;
  const to =
    node.name === "Link" ? marks[1]?.from || destination.from : destination.to;
  return { href, from, to, label: decodeMarkdownText(read(from, to)) };
}

// Render only known inline nodes, through DOM properties. In particular images,
// raw HTML and unsupported links remain text, as in the main editor's tables.
export function renderInline(
  read: (from: number, to: number) => string,
  node: SyntaxNode,
  target: HTMLElement,
  path: string,
  entries: Entry[],
) {
  const doc = target.ownerDocument;
  function range(
    parent: HTMLElement,
    node: SyntaxNode,
    from: number,
    to: number,
  ) {
    let pos = from;
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.from < from || child.to > to) continue;
      if (child.from > pos)
        parent.append(
          doc.createTextNode(decodeMarkdownText(read(pos, child.from))),
        );
      append(parent, child);
      pos = child.to;
    }
    if (pos < to)
      parent.append(doc.createTextNode(decodeMarkdownText(read(pos, to))));
  }
  function append(parent: HTMLElement, node: SyntaxNode) {
    const link = inlineLink(read, node, path, entries);
    if (link) {
      const a = doc.createElement("a");
      a.className = "md-link";
      a.href = link.href;
      a.dataset.linkUrl = link.href;
      a.dataset.linkLabel = link.label;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      range(a, node, link.from, link.to);
      parent.append(a);
      return;
    }
    const style = inlineStyles[node.name];
    if (style) {
      const el = doc.createElement(style[0]);
      el.className = style[1];
      const marks = node.getChildren(style[2]);
      const from = marks[0]?.to ?? node.from;
      const to = marks.at(-1)?.from ?? node.to;
      if (node.name === "InlineCode") {
        const text = read(from, to).replace(/\n/g, " ");
        el.textContent =
          text.startsWith(" ") && text.endsWith(" ") && /\S/.test(text)
            ? text.slice(1, -1)
            : text;
      } else range(el, node, from, to);
      parent.append(el);
    } else {
      parent.append(
        doc.createTextNode(decodeMarkdownText(read(node.from, node.to))),
      );
    }
  }
  range(target, node, node.from, node.to);
}
