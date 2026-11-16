import {
  StreamLanguage,
  HighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags, Tag } from "@lezer/highlight";
import { EditorView, placeholder } from "@codemirror/view";
import {
  autocompletion,
  type CompletionContext,
} from "@codemirror/autocomplete";
import { plainCommentRecords } from "./editor-comments";
import { inkSource, withoutInkComments } from "./ink-source";

const knot = Tag.define(),
  stitch = Tag.define(),
  choice = Tag.define(),
  divert = Tag.define();
// A streaming grammar keeps edits to a long script incremental. Ink is not
// Markdown: asterisks and brackets describe choices, and # introduces a tag.
export const inkLanguage = StreamLanguage.define({
  name: "ink",
  startState: () => ({
    comment: false,
    record: false,
    expression: 0,
    logic: false,
  }),
  token(stream, state) {
    if (stream.sol()) state.logic = false;
    if (state.record || stream.match("[[comment(")) {
      state.record = true;
      while (!stream.eol()) {
        if (stream.match(/\\./)) continue;
        if (stream.match("]]")) {
          state.record = false;
          break;
        }
        stream.next();
      }
      return null;
    }
    if (state.comment) {
      if (stream.skipTo("*/")) {
        stream.match("*/");
        state.comment = false;
      } else stream.skipToEnd();
      return "comment";
    }
    if (stream.eatSpace()) return null;
    if (stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match("/*")) {
      state.comment = true;
      return "comment";
    }
    if (stream.match(/\\./)) return "escape";
    const start = /^\s*$/.test(stream.string.slice(0, stream.start));
    if (start && stream.match(/={2,}[^/\n]*/)) return "knot";
    if (start && stream.match(/=[^/\n]*/)) return "stitch";
    if (start && stream.match(/TODO:.*/)) return "meta";
    if (start && stream.match(/(?:VAR|CONST|LIST|INCLUDE|EXTERNAL)\b/)) {
      state.logic = true;
      return "keyword";
    }
    if (start && stream.match("~")) {
      state.logic = true;
      return "keyword";
    }
    if (start && stream.match(/(?:[*+]\s*)+/)) return "choice";
    if (start && stream.match(/-(?!>)(?:\s*-(?!>))*/)) return "choice";
    if (stream.match(/(?:->->|->|<-)[\t ]*[\p{L}\p{N}_.]*/u)) return "divert";
    if (stream.match("<>")) return "operator";
    if (stream.match("#")) {
      stream.skipToEnd();
      return "meta";
    }
    if (stream.match("{")) {
      state.expression++;
      return "bracket";
    }
    if (stream.match("}")) {
      state.expression = Math.max(0, state.expression - 1);
      return "bracket";
    }
    if (stream.match(/[\[\]|]/)) return "bracket";
    if (state.logic || state.expression) {
      if (stream.match(/"(?:[^"\\]|\\.)*"/)) return "string";
      if (
        stream.match(
          /\b(?:true|false|not|and|or|mod|temp|return|else|function)\b/,
        )
      )
        return "keyword";
      if (stream.match(/\b\d+(?:\.\d+)?\b/)) return "number";
      if (stream.match(/[=!?+*/%<>:&()-]+/)) return "operator";
      if (stream.match(/[\p{L}_][\p{L}\p{N}_.]*/u)) return "variableName";
    }
    stream.next();
    return null;
  },
  tokenTable: { knot, stitch, choice, divert },
  languageData: {
    commentTokens: { line: "//", block: { open: "/*", close: "*/" } },
  },
});

export function completeInk(context: CompletionContext) {
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);
  const target = /(?:->|<-)\s*([\p{L}\p{N}_.]*)$/u.exec(before);
  if (!target || context.state.readOnly) return null;
  const source = withoutInkComments(inkSource(context.state.doc.toString()));
  if (
    !/(?:->|<-)\s*[\p{L}\p{N}_.]*$/u.test(source.slice(line.from, context.pos))
  )
    return null;
  const names = new Set(["END", "DONE"]);
  let parent = "";
  for (const match of source.matchAll(
    /^\s*(=+)\s*(?:function\s+)?([\p{L}_][\p{L}\p{N}_]*)/gmu,
  )) {
    if (match[1].length > 1) {
      parent = match[2];
      names.add(parent);
    } else if (parent) names.add(`${parent}.${match[2]}`);
  }
  return {
    from: context.pos - target[1].length,
    options: [...names].map((label) => ({ label, type: "label" })),
    validFor: /^[\p{L}\p{N}_.]*$/u,
  };
}

export const inkSupport = [
  plainCommentRecords.of(true),
  inkLanguage,
  syntaxHighlighting(
    HighlightStyle.define([
      { tag: knot, class: "ink-knot" },
      { tag: stitch, class: "ink-stitch" },
      { tag: choice, class: "ink-choice-mark" },
      { tag: divert, class: "ink-divert" },
      { tag: tags.comment, class: "ink-comment" },
      { tag: tags.meta, class: "ink-tag" },
      { tag: tags.keyword, class: "ink-keyword" },
      { tag: [tags.bracket, tags.operator], class: "ink-operator" },
      { tag: [tags.string, tags.number], class: "ink-value" },
      { tag: tags.variableName, class: "ink-variable" },
      { tag: tags.escape, class: "ink-operator" },
    ]),
  ),
  autocompletion({ override: [completeInk] }),
  EditorView.editorAttributes.of({ class: "ink-editor" }),
  EditorView.contentAttributes.of({
    "aria-label": "Ink story",
    autocapitalize: "off",
    autocorrect: "off",
  }),
  placeholder("Your story begins here.\n* [A choice to make]\n-> END"),
];
