import { Facet } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { commentParser } from "./comment-syntax";

export type ImageReference = {
  from: number;
  to: number;
  path: string;
  alt: string;
  title: string;
};

// Present only in formats whose preview renders local media. Plain text and
// Fountain keep every ![x](y) as literal source.
export const mediaPreview = Facet.define<boolean, boolean>({
  combine: (values) => values.some(Boolean),
});

const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};
// CommonMark processes backslash escapes and character references inside
// destinations and titles; the server's parser hands it the decoded value.
export function decodeMarkdownText(text: string) {
  return text.replace(
    /\\([!-/:-@[-`{-~])|&(#\d{1,7}|#[xX][\da-fA-F]{1,6}|[a-z]+);/g,
    (match, escaped: string | undefined, entity: string | undefined) => {
      if (escaped) return escaped;
      if (!entity) return match;
      if (entity[0] !== "#") return entities[entity] ?? match;
      const code =
        entity[1] === "x" || entity[1] === "X"
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code < 0xe000)
        ? String.fromCodePoint(code)
        : "�";
    },
  );
}

// Only relative paths inside the document's folder tree can be media. URLs,
// absolute paths and fragments are never requested from the media endpoint.
export function isLocalMediaPath(path: string) {
  return !!path && !/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(path);
}

// An inline image: ![alt](destination "title"). Reference-style images and
// unfinished syntax have no destination and stay source text.
export function imageReference(
  source: (from: number, to: number) => string,
  node: SyntaxNode,
): ImageReference | null {
  if (node.name !== "Image") return null;
  const url = node.getChild("URL");
  const marks = node.getChildren("LinkMark");
  if (
    !url ||
    marks.length < 4 ||
    source(marks[0].from, marks[0].to) !== "![" ||
    source(marks[marks.length - 1].from, node.to) !== ")"
  )
    return null;
  const raw = source(url.from, url.to);
  const path = decodeMarkdownText(
    raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw,
  );
  if (!isLocalMediaPath(path)) return null;
  const title = node.getChild("LinkTitle");
  return {
    from: node.from,
    to: node.to,
    path,
    alt: decodeMarkdownText(source(marks[0].to, marks[1].from)),
    title: title
      ? decodeMarkdownText(source(title.from + 1, title.to - 1))
      : "",
  };
}

// A line that is exactly one local image (optionally followed by spaces) is
// shown as a block figure. Comment placement uses this line-local rule so a
// conversation never splits a figure, whether or not the figure is revealed.
export function wholeLineImage(text: string): ImageReference | null {
  if (!text.startsWith("![")) return null;
  const tree = commentParser.parse(text);
  const paragraph = tree.topNode.firstChild;
  const image = paragraph?.name === "Paragraph" ? paragraph.firstChild : null;
  if (!image || image.from !== 0 || text.slice(image.to).trim()) return null;
  return imageReference((from, to) => text.slice(from, to), image);
}
