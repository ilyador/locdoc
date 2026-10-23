import { markdownLanguage } from "@codemirror/lang-markdown";
import type { Tree } from "@lezer/common";
import type { MarkdownConfig, MarkdownParser } from "@lezer/markdown";

// One physical line per message. Escapes keep multiline text and delimiters
// round-trippable without introducing another syntax or hidden file metadata.
const messagePattern =
  /^\[\[comment\(((?:\\[^\r\n]|[^\\)\r\n])*)\):[ \t]*((?:\\[^\r\n]|[^\\\r\n])*?)\]\]/;
export const decodeCommentText = (value: string) =>
  value.replace(/\\([\\\])nr])/g, (_, c: string) =>
    c === "n" ? "\n" : c === "r" ? "\r" : c,
  );

function messageAt(source: string) {
  const match = messagePattern.exec(source);
  if (!match) return null;
  const name = decodeCommentText(match[1]).trim();
  const body = decodeCommentText(match[2]).trim();
  if (
    !name ||
    [...name].length > 60 ||
    /[\u0000-\u001f\u007f-\u009f]/.test(name) ||
    !body ||
    [...body].length > 4000
  )
    return null;
  return { name, body, length: match[0].length };
}

export const commentMarkdown: MarkdownConfig = {
  defineNodes: ["LocdocComment"],
  parseInline: [
    {
      name: "LocdocComment",
      before: "Link",
      parse(cx, next, pos) {
        if (next !== 91 || cx.slice(pos, pos + 10) !== "[[comment(") return -1;
        const message = messageAt(cx.slice(pos, Math.min(cx.end, pos + 17000)));
        return message
          ? cx.addElement(cx.elt("LocdocComment", pos, pos + message.length))
          : -1;
      },
    },
  ],
};
export const commentParser = (
  markdownLanguage.parser as MarkdownParser
).configure(commentMarkdown);
export type SourceThread = {
  from: number;
  to: number;
  messages: { name: string; body: string }[];
};

const literalNodes = new Set([
  "InlineCode",
  "FencedCode",
  "CodeBlock",
  "HTMLBlock",
  "HTMLTag",
  "CommentBlock",
  "Comment",
  "ProcessingInstruction",
  "Autolink",
]);
const allMessages = new RegExp(messagePattern.source.slice(1), "g");
export function sourceComments(source: string, plain = false): SourceThread[] {
  return sourceCommentTree(source, plain).threads;
}
// The conversations of a source, and the Markdown structure that decided
// which records are literal. Plain text has none.
export function sourceCommentTree(
  source: string,
  plain = false,
): { threads: SourceThread[]; tree: Tree | null } {
  if (!source.includes("[[comment(")) return { threads: [], tree: null };
  const literals: { from: number; to: number }[] = [];
  // Markdown leaves records in code, HTML and links literal. Plain text has
  // no such syntax: only an escape keeps a record literal there.
  const tree = plain ? null : commentParser.parse(source);
  const labels = new Set<string>();
  const labelKey = (value: string) =>
    value.trim().replace(/\s+/g, " ").toUpperCase().toLowerCase();
  tree?.iterate({
    enter(node) {
      if (node.name !== "LinkReference") return;
      const label = node.node.getChild("LinkLabel");
      if (label)
        labels.add(labelKey(source.slice(label.from + 1, label.to - 1)));
      return false;
    },
  });
  tree?.iterate({
    enter(node) {
      if (node.name === "Link" || node.name === "Image") {
        const marks = node.node.getChildren("LinkMark");
        const label = node.node.getChild("LinkLabel");
        const reference =
          label && label.to > label.from + 2
            ? source.slice(label.from + 1, label.to - 1)
            : source.slice(marks[0].to, marks[1].from);
        // Lezer retains unresolved shortcut/reference links in its syntax tree.
        // CommonMark leaves them as prose, so they cannot hide raw comments.
        if (
          !marks.some((m) => source.slice(m.from, m.to) === "(") &&
          !labels.has(labelKey(reference))
        )
          return;
      } else if (!literalNodes.has(node.name)) return;
      literals.push({ from: node.from, to: node.to });
      return false;
    },
  });
  const threads: SourceThread[] = [];
  // Candidate records are independent of Markdown tokenization: an unfinished
  // bracket or a permissive bare-URL token must not consume the annotation.
  for (const match of source.matchAll(allMessages)) {
    const from = match.index;
    let slash = from;
    while (source[slash - 1] === "\\") slash--;
    if (
      (from - slash) % 2 ||
      literals.some(
        (r) =>
          r.from <= from &&
          from < r.to &&
          !threads.some((t) => t.from <= r.from && r.from < t.to),
      )
    )
      continue;
    const message = messageAt(match[0]);
    if (!message) continue;
    const to = from + message.length;
    const previous = threads.at(-1);
    const gap = previous ? source.slice(previous.to, from) : "";
    if (
      previous &&
      /^[ \t\r\n]*$/.test(gap) &&
      (gap.match(/\r\n|\r|\n/g)?.length || 0) <= 1
    ) {
      previous.to = to;
      previous.messages.push({ name: message.name, body: message.body });
    } else
      threads.push({
        from,
        to,
        messages: [{ name: message.name, body: message.body }],
      });
  }
  return { threads, tree };
}

export function commentReadingText(source: string, plain = false) {
  const ranges: { from: number; to: number }[] = [];
  for (const thread of sourceComments(source, plain)) {
    const previous = ranges.at(-1);
    if (previous && !source.slice(previous.to, thread.from).trim())
      previous.to = thread.to;
    else ranges.push({ from: thread.from, to: thread.to });
  }
  const visible: string[] = [];
  let from = 0;
  for (const range of ranges) {
    visible.push(source.slice(from, range.from));
    from = range.to;
  }
  visible.push(source.slice(from));
  return visible.join("");
}
