import type { SyntaxNodeRef } from "@lezer/common";

export function emphasisContentRange(node: SyntaxNodeRef) {
  const open = node.node.firstChild,
    close = node.node.lastChild;
  // Delimiters get their own DOM nodes so revealing source does not replace
  // the text node that a native spelling annotation may refer to.
  return open?.name === "EmphasisMark" &&
    close?.name === "EmphasisMark" &&
    open.from === node.from &&
    close.to === node.to &&
    open.to < close.from
    ? { from: open.to, to: close.from }
    : { from: node.from, to: node.to };
}
