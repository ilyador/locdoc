import { EditorState, StateField, countColumn } from "@codemirror/state";
import {
  EditorView,
  Decoration,
  BlockWrapper,
  placeholder,
  type DecorationSet,
} from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  syntaxTree,
  syntaxHighlighting,
  HighlightStyle,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { commentMarkdown } from "./comment-syntax";
import { visibleTextRanges } from "./editor-comments";
import { resolveDocumentLink } from "./document-links";
import { documentFormat } from "./document-format";
import { previewRanges, type PreviewRange } from "./preview-ranges";
import { fountainPreview } from "./fountain-preview";
import { fountainSpeakerCompletion } from "./fountain-completion";
import { emphasisContentRange } from "./emphasis-range";
import { parseMarkdownTable } from "./markdown-table";
import {
  InlineMediaWidget,
  MediaWidget,
  TableWidget,
  TaskWidget,
  mediaUrl,
} from "./markdown-widgets";
import { imageReference, mediaPreview } from "./markdown-media";
import { plainTextSupport } from "./plain-text";
import type { Entry } from "./model";

// Solarized II, from the owner's Ulysses theme. Dark variants keep its hues
// while meeting contrast on Locdoc's existing charcoal writing surface.
const writingHighlight = HighlightStyle.define([
  {
    tag: tags.heading,
    color: "var(--syntax-heading)",
    textDecoration: "none",
  },
  { tag: tags.strong, color: "var(--text)", fontWeight: "700" },
  { tag: tags.emphasis, color: "var(--secondary)", fontStyle: "italic" },
  { tag: [tags.monospace, tags.string], color: "var(--syntax-code)" },
  { tag: [tags.link, tags.url, tags.quote], color: "var(--syntax-teal)" },
  { tag: [tags.processingInstruction, tags.comment], color: "var(--muted)" },
  {
    tag: tags.strikethrough,
    color: "var(--syntax-delete)",
    textDecoration: "line-through",
  },
  { tag: tags.keyword, color: "var(--syntax-violet)" },
  { tag: [tags.number, tags.bool], color: "var(--syntax-amber)" },
  { tag: tags.meta, color: "var(--syntax-mark)" },
]);

export function livePreview(
  id: string,
  token?: string,
  path = "",
  entries: Entry[] = [],
) {
  function build(state: EditorState, ranges: PreviewRange[]) {
    const decorations: ReturnType<Decoration["range"]>[] = [];
    const wrappers: ReturnType<BlockWrapper["range"]>[] = [];
    const images: ReturnType<Decoration["range"]>[] = [];
    const active = (state.readOnly ? [] : state.selection.ranges).map((r) => ({
      from: state.doc.lineAt(r.from).from,
      to: state.doc.lineAt(r.to).to,
    }));
    const inactive = (from: number, to = from) =>
      !active.some((r) => from <= r.to && to >= r.from);
    // Inline media reveals its source only when a selection touches it, so
    // writing elsewhere on a long line keeps the picture in place.
    const touched = (from: number, to: number) =>
      !state.readOnly &&
      state.selection.ranges.some((r) => r.from <= to && r.to >= from);
    const codeLines = new Set<number>();
    const tableLines = new Set<number>();
    const blockEnds = new Set<number>();
    const listPrefixes = new Map<number, { content: number; indent: string }>();
    for (const range of ranges)
      syntaxTree(state).iterate({
        from: range.from,
        to: range.to,
        enter(n) {
          const { name, from, to } = n;
          if (name === "LocdocComment") return false;
          if (name === "Image") {
            const image = imageReference(
              (a, b) => state.sliceDoc(a, b),
              n.node,
            );
            let cell = n.node.parent;
            while (cell && cell.name !== "Table") cell = cell.parent;
            if (!image || cell) return;
            const line = state.doc.lineAt(from);
            const src = mediaUrl(id, image.path, token);
            if (
              from === line.from &&
              to <= line.to &&
              !state.sliceDoc(to, line.to).trim()
            ) {
              if (!inactive(line.from, line.to)) return;
              decorations.push(
                Decoration.replace({
                  widget: new MediaWidget(src, image.alt, image.title),
                  block: true,
                }).range(line.from, line.to),
              );
              return false;
            }
            images.push(inlineImage.range(from, to));
            if (touched(from, to)) return;
            decorations.push(
              Decoration.replace({
                widget: new InlineMediaWidget(src, image.alt, image.title),
              }).range(from, to),
            );
            return false;
          }
          if (name === "Table" && inactive(from, to)) {
            const source = state.sliceDoc(from, to);
            if (parseMarkdownTable(source, from)) {
              for (
                let line = state.doc.lineAt(from).number;
                line <= state.doc.lineAt(to).number;
                line++
              )
                tableLines.add(line);
              decorations.push(
                Decoration.replace({
                  widget: new TableWidget(source, !state.readOnly),
                  block: true,
                }).range(from, to),
              );
              return false;
            }
          }
          if (/^(FencedCode|CodeBlock)$/.test(name)) {
            for (let pos = from; pos <= to;) {
              const line = state.doc.lineAt(pos);
              codeLines.add(line.number);
              decorations.push(
                Decoration.line({ class: "md-code-line" }).range(line.from),
              );
              if (line.to >= to) break;
              pos = line.to + 1;
            }
          }
          if (name === "ListItem" || name === "Task")
            blockEnds.add(state.doc.lineAt(Math.max(from, to - 1)).from);
          if (name === "Paragraph") {
            let list = n.node.parent;
            while (list && list.name !== "ListItem") list = list.parent;
            // Enter creates a visible text block even without a blank Markdown
            // line. Keep list continuations together and natural wrapping intact.
            for (let pos = list ? Math.max(from, to - 1) : from; pos < to;) {
              const line = state.doc.lineAt(pos);
              if (
                visibleTextRanges(state, line.from, line.to).some((range) =>
                  state.sliceDoc(range.from, range.to).trim(),
                )
              )
                blockEnds.add(line.from);
              pos = line.to + 1;
            }
          }
          const heading = name.match(/^ATXHeading(\d)$/);
          if (heading)
            decorations.push(
              Decoration.line({ class: `md-h${heading[1]}` }).range(
                state.doc.lineAt(from).from,
              ),
            );
          if (name === "StrongEmphasis" || name === "Emphasis") {
            const content = emphasisContentRange(n);
            decorations.push(
              Decoration.mark({
                class: name === "StrongEmphasis" ? "md-strong" : "md-em",
              }).range(content.from, content.to),
            );
          }
          if (name === "InlineCode")
            decorations.push(
              Decoration.mark({ class: "md-inline-code" }).range(from, to),
            );
          if (name === "Strikethrough")
            decorations.push(
              Decoration.mark({ class: "md-strike" }).range(from, to),
            );
          if (name === "Blockquote") {
            const line = state.doc.lineAt(from);
            decorations.push(
              Decoration.line({ class: "md-quote" }).range(line.from),
            );
          }
          if (name === "ListItem") {
            const mark = n.node.getChild("ListMark");
            if (mark) {
              const line = state.doc.lineAt(from);
              const task = n.node.getChild("Task")?.getChild("TaskMarker");
              const end = task?.to ?? mark.to;
              const spaces =
                state.sliceDoc(end, line.to).match(/^[\t ]*/)?.[0] ?? "";
              const content = end + spaces.length;
              const indent = task
                ? `calc(${countColumn(state.sliceDoc(line.from, mark.from) + spaces, state.tabSize)}ch + 28px)`
                : `${countColumn(state.sliceDoc(line.from, content), state.tabSize)}ch`;
              listPrefixes.set(line.from, { content, indent });
            }
          }
          if (
            [
              "HeaderMark",
              "EmphasisMark",
              "CodeMark",
              "StrikethroughMark",
              "QuoteMark",
            ].includes(name) &&
            inactive(from, to) &&
            !codeLines.has(state.doc.lineAt(from).number)
          ) {
            const end =
              name === "HeaderMark" && state.sliceDoc(to, to + 1) === " "
                ? to + 1
                : to;
            decorations.push(Decoration.replace({}).range(from, end));
          }
          if (name === "TaskMarker") {
            const line = state.doc.lineAt(from);
            const marker = n.node.parent?.parent?.getChild("ListMark");
            const checked =
              state.sliceDoc(from + 1, from + 2).toLowerCase() === "x";
            decorations.push(
              Decoration.line({
                class: checked ? "md-task done" : "md-task",
              }).range(line.from),
            );
            if (marker)
              decorations.push(Decoration.replace({}).range(marker.from, from));
            decorations.push(
              Decoration.replace({
                widget: new TaskWidget(
                  checked,
                  !state.readOnly,
                  state.sliceDoc(to, line.to).trim(),
                ),
              }).range(from, to),
            );
          }
          if (name === "Link" || name === "Autolink" || name === "URL") {
            if (
              name === "URL" &&
              /^(Link|Autolink|Image)$/.test(n.node.parent?.name || "")
            )
              return;
            const destination =
              name === "URL" ? n.node : n.node.getChild("URL");
            if (!destination) {
              // Markdown parses the inner [text] of [[text]] as a shortcut
              // link. Keep this literal bracketed prose in one consistent ink.
              if (
                name === "Link" &&
                state.sliceDoc(Math.max(0, from - 1), from) === "[" &&
                state.sliceDoc(to, to + 1) === "]"
              )
                decorations.push(
                  Decoration.mark({ class: "md-literal-brackets" }).range(
                    from - 1,
                    to + 1,
                  ),
                );
              return;
            }
            const raw = state
              .sliceDoc(destination.from, destination.to)
              .replace(/^<|>$/g, "");
            const href = resolveDocumentLink(raw, path, entries);
            if (!href) return;
            const mark = n.node.getChild("LinkMark");
            const labelFrom =
              name === "Link" ? mark?.to || from : destination.from;
            const labelTo =
              name === "Link"
                ? n.node.getChildren("LinkMark")[1]?.from || destination.from
                : destination.to;
            if (labelTo > labelFrom)
              decorations.push(
                Decoration.mark({
                  tagName: "a",
                  class: "md-link",
                  attributes: {
                    href,
                    "data-link-url": href,
                    "data-link-label": state.sliceDoc(labelFrom, labelTo),
                  },
                }).range(labelFrom, labelTo),
              );
            if (inactive(from, to) && name !== "URL") {
              if (from < labelFrom)
                decorations.push(Decoration.replace({}).range(from, labelFrom));
              if (labelTo < to)
                decorations.push(Decoration.replace({}).range(labelTo, to));
            }
            if (name !== "URL") return false;
          }
        },
      });
    for (const from of blockEnds)
      decorations.push(Decoration.line({ class: "md-block-end" }).range(from));
    for (const [from, { content, indent }] of listPrefixes) {
      // A conversation can split one source line into several display blocks.
      // Share its indent across text fragments while leaving the host full-width.
      wrappers.push(
        BlockWrapper.create({
          tagName: "div",
          attributes: { class: "md-list", style: `--list-indent: ${indent}` },
        }).range(from, state.doc.lineAt(from).to),
      );
      decorations.push(
        Decoration.mark({ class: "md-list-prefix" }).range(from, content),
      );
    }
    for (const range of ranges)
      for (
        let i = state.doc.lineAt(range.from).number;
        i <= state.doc.lineAt(range.to).number;
        i++
      ) {
        const line = state.doc.line(i);
        if (codeLines.has(i) || tableLines.has(i)) continue;
        if (/^\s*[-*_]{3,}\s*$/.test(line.text) && inactive(line.from, line.to))
          decorations.push(
            Decoration.line({ class: "md-rule" }).range(line.from),
          );
      }
    return {
      decorations,
      wrappers,
      images,
    };
  }
  function create(state: EditorState) {
    const value = build(state, [{ from: 0, to: state.doc.length }]);
    return {
      decorations: Decoration.set(value.decorations, true),
      wrappers: BlockWrapper.set(value.wrappers, true),
      images: Decoration.set(value.images, true),
    };
  }
  const field = StateField.define<ReturnType<typeof create>>({
    create,
    update(value, tr) {
      if (tr.reconfigured) return create(tr.state);
      if (
        !tr.docChanged &&
        !(
          tr.selection &&
          (previewLines(tr.state) !== previewLines(tr.startState) ||
            touchedImages(tr.state, value.images) !==
              touchedImages(tr.startState, value.images))
        ) &&
        syntaxTree(tr.state) === syntaxTree(tr.startState)
      )
        return value;
      let decorations = value.decorations.map(tr.changes);
      let wrappers = value.wrappers.map(tr.changes);
      let images = value.images.map(tr.changes);
      const ranges = previewRanges(tr);
      // Range-limited filtering keeps untouched branches and block widgets,
      // including those outside the viewport, intact during editing/scrolling.
      for (const { from, to } of ranges) {
        const keep = (a: number, b: number) => b < from || a > to;
        decorations = decorations.update({
          filterFrom: from,
          filterTo: to,
          filter: keep,
        });
        wrappers = wrappers.update({
          filterFrom: from,
          filterTo: to,
          filter: keep,
        });
        images = images.update({
          filterFrom: from,
          filterTo: to,
          filter: keep,
        });
      }
      const fresh = build(tr.state, ranges);
      return {
        decorations: decorations.update({ add: fresh.decorations, sort: true }),
        wrappers: wrappers.update({ add: fresh.wrappers, sort: true }),
        images: images.update({ add: fresh.images, sort: true }),
      };
    },
    provide: (f) => [
      EditorView.decorations.from(f, (value) => value.decorations),
      EditorView.blockWrappers.from(f, (value) => value.wrappers),
    ],
  });
  return [field, mediaPreview.of(true)];
}

// The extent of every rendered-inline image, kept to notice when a selection
// starts or stops touching one without moving to another line.
const inlineImage = Decoration.mark({});

function touchedImages(state: EditorState, images: DecorationSet) {
  if (state.readOnly) return "";
  const touched: number[] = [];
  for (const range of state.selection.ranges)
    images.between(range.from, range.to, (from) => {
      touched.push(from);
    });
  return touched.join(",");
}

function previewLines(state: EditorState) {
  return state.readOnly
    ? ""
    : state.selection.ranges
        .map(
          (range) =>
            `${state.doc.lineAt(range.from).number}:${state.doc.lineAt(range.to).number}`,
        )
        .join(",");
}

// Sidebar metadata refreshes must not replace the parser and discard its tree.
const markdownSupport = [
  markdown({ base: markdownLanguage, extensions: [commentMarkdown] }),
  syntaxHighlighting(writingHighlight),
];

export function documentPreview(
  id: string,
  token?: string,
  path = "",
  entries: Entry[] = [],
) {
  const format = documentFormat(path);
  if (format === "text") return plainTextSupport;
  const fountain = format === "fountain";
  return [
    fountain
      ? [fountainPreview(), fountainSpeakerCompletion()]
      : [markdownSupport, livePreview(id, token, path, entries)],
    EditorView.editorAttributes.of({
      class: fountain ? "fountain-editor" : "",
    }),
    placeholder(
      fountain
        ? "INT. A NEW SCENE - DAY"
        : "Start writing. Use Markdown to make it yours.",
    ),
    EditorView.contentAttributes.of({
      "aria-label": fountain ? "Fountain screenplay" : "Markdown document",
      spellcheck: "true",
      "data-gramm": "false",
    }),
  ];
}
