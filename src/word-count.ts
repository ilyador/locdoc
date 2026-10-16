import { commentParser, commentReadingText } from "./comment-syntax";

const hidden = new Set([
  "LocdocComment",
  "Image",
  "LinkReference",
  "LinkLabel",
  "LinkTitle",
  "TaskMarker",
  "HeaderMark",
  "ListMark",
  "QuoteMark",
  "EmphasisMark",
  "LinkMark",
  "CodeMark",
  "CodeInfo",
]);
const words = new Intl.Segmenter(undefined, { granularity: "word" });

// Count reading content, not Markdown punctuation, destinations or media paths.
export function countMarkdownWords(markdown: string) {
  markdown = commentReadingText(markdown);
  const visible: string[] = [];
  let from = 0;
  commentParser.parse(markdown).iterate({
    enter(node) {
      if (
        !hidden.has(node.name) &&
        !(node.name === "URL" && node.node.parent?.name !== "Autolink")
      )
        return;
      visible.push(markdown.slice(from, node.from));
      from = node.to;
      return false;
    },
  });
  visible.push(markdown.slice(from));
  let count = 0;
  for (const word of words.segment(visible.join("")))
    if (word.isWordLike) count++;
  return count;
}
