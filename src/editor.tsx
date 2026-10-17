import {
  useEffect,
  useLayoutEffect,
  useRef,
  useImperativeHandle,
  forwardRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  commentLayer,
  resolveCommentAnchor,
  setCommentLayout,
  sourceCommentLayer,
  sourceCommentRanges,
  visibleTextRanges,
} from "./editor-comments";
import {
  commentMarkdown,
  commentReadingText,
  sourceComments,
} from "./comment-syntax";
import { markdownLink, resolveDocumentLink } from "./document-links";
import { documentFormat } from "./document-format";
import { fountainPreview } from "./fountain-preview";
import { parseFountain, type FountainForce } from "./fountain";
import type { Entry } from "./model";
import type { Comment } from "./model";
import {
  EditorState,
  StateField,
  Compartment,
  Prec,
  countColumn,
} from "@codemirror/state";
import {
  EditorView,
  keymap,
  Decoration,
  BlockWrapper,
  WidgetType,
  drawSelection,
  placeholder,
} from "@codemirror/view";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  syntaxTree,
  syntaxHighlighting,
  HighlightStyle,
  bracketMatching,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { createMarkdownTable, parseMarkdownTable } from "./markdown-table";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";
import type { WebsocketProvider } from "y-websocket";

export type Anchor = {
  start: ReturnType<typeof Y.relativePositionToJSON>;
  end: ReturnType<typeof Y.relativePositionToJSON>;
};
export type Selection = { quote: string; anchor: Anchor | null };
export type LinkTarget = {
  url: string;
  label: string;
  rect: { left: number; bottom: number };
};
export type EditorHandle = {
  formatFountain: (kind: FountainForce) => void;
  insertLink: (url: string, label: string, anchor: Anchor | null) => void;
  toggleTasks: () => void;
  insert: (text: string) => void;
  insertTable: (rows: number, columns: number) => void;
  wrap: (before: string, after?: string) => void;
  selection: (wholeLine?: boolean) => Selection;
  locate: (anchor: Anchor) => void;
  revealComment: (id?: string) => void;
  focus: () => void;
};
export function mediaUrl(id: string, path: string, token?: string) {
  return `/api/docs/${id}/media?${new URLSearchParams({ path, ...(token ? { token } : {}) })}`;
}
export function isVideo(path: string) {
  return /\.(mp4|webm|mov)(?:[?&]|$)/i.test(decodeURIComponent(path));
}

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

class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly from: number,
    readonly editable: boolean,
  ) {
    super();
  }
  eq(other: TableWidget) {
    return (
      this.source === other.source &&
      this.from === other.from &&
      this.editable === other.editable
    );
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "md-table-preview";
    const data = parseMarkdownTable(this.source, this.from);
    if (!data) return wrap;
    const table = document.createElement("table");
    table.setAttribute("aria-label", "Document table");
    const head = document.createElement("thead");
    const body = document.createElement("tbody");
    data.rows.forEach((row, rowIndex) => {
      const tr = document.createElement("tr");
      row.forEach((cell, columnIndex) => {
        const td = document.createElement(rowIndex === 0 ? "th" : "td");
        td.style.textAlign = data.align[columnIndex];
        if (this.editable) {
          const edit = document.createElement("button");
          edit.type = "button";
          edit.className = "md-table-cell";
          edit.textContent = cell.text || "\u00a0";
          edit.setAttribute(
            "aria-label",
            `Edit row ${rowIndex + 1}, column ${columnIndex + 1}${cell.text ? `: ${cell.text}` : ""}`,
          );
          edit.onclick = () => {
            view.dispatch({
              selection: { anchor: cell.from },
              scrollIntoView: true,
            });
            view.focus();
          };
          td.appendChild(edit);
        } else {
          td.textContent = cell.text || "\u00a0";
        }
        tr.appendChild(td);
      });
      (rowIndex === 0 ? head : body).appendChild(tr);
    });
    table.append(head, body);
    wrap.appendChild(table);
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

class MediaWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly pos: number,
  ) {
    super();
  }
  eq(other: MediaWidget) {
    return (
      other.src === this.src && other.pos === this.pos && other.alt === this.alt
    );
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("figure");
    wrap.className = "embed";
    const el = document.createElement(isVideo(this.src) ? "video" : "img");
    if (el instanceof HTMLVideoElement) {
      el.controls = true;
      el.preload = "metadata";
    } else {
      el.alt = this.alt;
      el.loading = "lazy";
    }
    el.src = this.src;
    wrap.appendChild(el);
    const edit = document.createElement("button");
    edit.textContent = "Edit Markdown";
    edit.className = "embed-edit";
    edit.type = "button";
    edit.onclick = () => {
      view.dispatch({ selection: { anchor: this.pos } });
      view.focus();
    };
    wrap.appendChild(edit);
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

class TaskWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly checked: boolean,
    readonly editable: boolean,
    readonly label: string,
  ) {
    super();
  }
  eq(other: TaskWidget) {
    return (
      this.from === other.from &&
      this.checked === other.checked &&
      this.editable === other.editable &&
      this.label === other.label
    );
  }
  toDOM(view: EditorView) {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "md-task-checkbox";
    input.checked = this.checked;
    input.disabled = !this.editable;
    input.setAttribute("aria-label", this.label || "Task");
    input.onchange = () => {
      if (
        view.state.readOnly ||
        !/^\[[ xX]\]$/.test(view.state.sliceDoc(this.from, this.from + 3))
      )
        return;
      view.dispatch({
        changes: {
          from: this.from + 1,
          to: this.from + 2,
          insert: input.checked ? "x" : " ",
        },
      });
    };
    const target = document.createElement("label");
    target.className = "md-task-toggle";
    target.appendChild(input);
    return target;
  }
  ignoreEvent() {
    return true;
  }
}

function livePreview(
  id: string,
  token?: string,
  path = "",
  entries: Entry[] = [],
) {
  function build(state: EditorState) {
    const decorations: ReturnType<Decoration["range"]>[] = [];
    const wrappers: ReturnType<BlockWrapper["range"]>[] = [];
    const active = (state.readOnly ? [] : state.selection.ranges).map((r) => ({
      from: state.doc.lineAt(r.from).from,
      to: state.doc.lineAt(r.to).to,
    }));
    const inactive = (from: number, to = from) =>
      !active.some((r) => from <= r.to && to >= r.from);
    const codeLines = new Set<number>();
    const tableLines = new Set<number>();
    const blockEnds = new Set<number>();
    const listPrefixes = new Map<number, { content: number; indent: string }>();
    syntaxTree(state).iterate({
      enter(n) {
        const { name, from, to } = n;
        if (name === "LocdocComment") return false;
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
                widget: new TableWidget(source, from, !state.readOnly),
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
        if (name === "ListItem" || name === "Paragraph" || name === "Task")
          blockEnds.add(state.doc.lineAt(Math.max(from, to - 1)).from);
        const heading = name.match(/^ATXHeading(\d)$/);
        if (heading)
          decorations.push(
            Decoration.line({ class: `md-h${heading[1]}` }).range(
              state.doc.lineAt(from).from,
            ),
          );
        if (name === "StrongEmphasis")
          decorations.push(
            Decoration.mark({ class: "md-strong" }).range(from, to),
          );
        if (name === "Emphasis")
          decorations.push(Decoration.mark({ class: "md-em" }).range(from, to));
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
                from,
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
          const destination = name === "URL" ? n.node : n.node.getChild("URL");
          if (!destination) return;
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
    for (let i = 1; i <= state.doc.lines; i++) {
      const line = state.doc.line(i);
      if (codeLines.has(i) || tableLines.has(i)) continue;
      const m = line.text.match(
        /^!\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))\)\s*$/,
      );
      if (m && inactive(line.from, line.to)) {
        const path = m[2] || m[3];
        if (!/^(?:https?:|data:|\/)/.test(path))
          decorations.push(
            Decoration.replace({
              widget: new MediaWidget(
                mediaUrl(id, path, token),
                m[1],
                line.from,
              ),
              block: true,
            }).range(line.from, line.to),
          );
      }
      if (/^\s*[-*_]{3,}\s*$/.test(line.text) && inactive(line.from, line.to))
        decorations.push(
          Decoration.line({ class: "md-rule" }).range(line.from),
        );
    }
    return {
      decorations: Decoration.set(decorations, true),
      wrappers: BlockWrapper.set(wrappers, true),
    };
  }
  return StateField.define<ReturnType<typeof build>>({
    create: build,
    update(value, tr) {
      return tr.docChanged ||
        tr.selection ||
        tr.reconfigured ||
        syntaxTree(tr.state) !== syntaxTree(tr.startState)
        ? build(tr.state)
        : value;
    },
    provide: (f) => [
      EditorView.decorations.from(f, (value) => value.decorations),
      EditorView.blockWrappers.from(f, (value) => value.wrappers),
    ],
  });
}

// Sidebar metadata refreshes must not replace the parser and discard its tree.
const markdownSupport = [
  markdown({ base: markdownLanguage, extensions: [commentMarkdown] }),
  syntaxHighlighting(writingHighlight),
];

function documentPreview(
  id: string,
  token?: string,
  path = "",
  entries: Entry[] = [],
) {
  const fountain = documentFormat(path) === "fountain";
  return [
    fountain
      ? fountainPreview()
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

export const MarkdownEditor = forwardRef<
  EditorHandle,
  {
    ydoc: Y.Doc;
    provider: WebsocketProvider;
    editable: boolean;
    id: string;
    token?: string;
    onChange: (text: string) => void;
    onComment: () => void;
    onUpload: (file: File) => void;
    comments?: Comment[];
    activeComment?: string | null;
    commentDraft?: Selection | null;
    onOpenComment?: (id: string) => void;
    conversation?: ReactNode;
    path?: string;
    entries?: Entry[];
    onLink?: (target: LinkTarget) => void;
    onInsertLink?: () => void;
  }
>(function MarkdownEditor(
  {
    ydoc,
    provider,
    editable,
    id,
    token,
    onChange,
    onComment,
    onUpload,
    comments,
    activeComment,
    commentDraft,
    onOpenComment,
    conversation,
    path,
    entries,
    onLink,
    onInsertLink,
  },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const [commentHost] = useState(() => document.createElement("div"));
  const commentExtension = useRef<ReturnType<typeof commentLayer> | null>(null);
  const preview = useRef(new Compartment());
  const access = useRef(new Compartment());
  const callbacks = useRef({
    onChange,
    onComment,
    onUpload,
    onOpenComment,
    onLink,
    onInsertLink,
  });
  callbacks.current = {
    onChange,
    onComment,
    onUpload,
    onOpenComment,
    onLink,
    onInsertLink,
  };
  useImperativeHandle(
    ref,
    () => ({
      formatFountain(kind) {
        const v = view.current;
        if (!v || !editable || documentFormat(path) !== "fountain") return;
        const current = v.state.doc.lineAt(v.state.selection.main.head);
        const line = parseFountain(v.state.doc.toString()).lines[
          current.number - 1
        ];
        const prefix = {
          scene: ".",
          action: "!",
          character: "@",
          transition: "> ",
          centered: "> ",
          lyric: "~",
          parenthetical: "(",
        }[kind];
        const suffix =
          kind === "centered" ? " <" : kind === "parenthetical" ? ")" : "";
        const existingParenthetical = line.kind === "parenthetical";
        const contentStart = current.from + line.text.search(/\S|$/);
        const from =
          line.prefix?.from ??
          (existingParenthetical ? contentStart : current.from);
        const to =
          line.prefix?.to ??
          (existingParenthetical ? contentStart + 1 : current.from);
        const end = existingParenthetical
          ? current.from + line.text.trimEnd().length
          : (visibleTextRanges(v.state, current.from, current.to).at(-1)?.to ??
            current.to);
        const tail =
          line.suffix?.from ??
          (existingParenthetical && v.state.sliceDoc(end - 1, end) === ")"
            ? end - 1
            : end);
        const head = visibleTextRanges(v.state, from, to);
        const foot = visibleTextRanges(v.state, tail, end);
        const changes = v.state.changes([
          ...head.map((part, i) => ({
            ...part,
            insert: i === 0 ? prefix : "",
          })),
          ...foot.map((part, i) => ({
            ...part,
            insert: i === 0 ? suffix : "",
          })),
        ]);
        v.dispatch({
          changes,
          selection: { anchor: changes.mapPos(from, -1) + prefix.length },
          scrollIntoView: true,
        });
        v.focus();
      },
      insertLink(url, label, anchor) {
        const v = view.current;
        if (!v || !editable || !anchor) return;
        const range = resolveCommentAnchor(ydoc, anchor);
        if (!range) return;
        const text = markdownLink(label, url);
        const visible = visibleTextRanges(v.state, range.from, range.to);
        if (!visible.length) return;
        v.dispatch({
          changes: visible.map((r, i) => ({
            ...r,
            insert: i === 0 ? text : "",
          })),
          selection: { anchor: visible[0].from + text.length },
          scrollIntoView: true,
        });
      },
      toggleTasks() {
        const v = view.current;
        if (!v || !editable) return;
        const range = v.state.selection.main;
        const first = v.state.doc.lineAt(range.from),
          last = v.state.doc.lineAt(
            range.to > range.from ? range.to - 1 : range.to,
          );
        const hidden = sourceCommentRanges(v.state);
        const lines = [];
        for (let n = first.number; n <= last.number; n++) {
          const line = v.state.doc.line(n);
          if (!hidden.some((r) => r.from <= line.from && line.to <= r.to))
            lines.push(line);
        }
        const remove = lines.every((line) =>
          /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\] /.test(line.text),
        );
        const changes = v.state.changes(
          lines.flatMap((line) => {
            if (!remove && /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]/.test(line.text))
              return [];
            const prefix = (
              remove
                ? /^(\s*)(?:[-*+]|\d+[.)])\s+\[[ xX]\] /
                : /^(\s*)(?:(?:[-*+]|\d+[.)])\s+)?/
            ).exec(line.text)!;
            return [
              {
                from: line.from + prefix[1].length,
                to: line.from + prefix[0].length,
                insert: remove ? "" : "- [ ] ",
              },
            ];
          }),
        );
        v.dispatch({
          changes,
          selection: { anchor: changes.mapPos(last.to, 1) },
        });
        v.focus();
      },
      insert(text) {
        const v = view.current;
        if (!v || !editable) return;
        const { from, to } = v.state.selection.main;
        v.dispatch({
          changes: { from, to, insert: text },
          selection: { anchor: from + text.length },
        });
        v.focus();
      },
      insertTable(rows, columns) {
        const v = view.current;
        if (!v || !editable) return;
        const { from, to } = v.state.selection.main;
        const before = v.state.sliceDoc(0, from);
        const prefix =
          before.endsWith("\n\n") || !before
            ? ""
            : before.endsWith("\n")
              ? "\n"
              : "\n\n";
        const text = prefix + createMarkdownTable(rows, columns) + "\n\n";
        v.dispatch({
          changes: { from, to, insert: text },
          selection: { anchor: from + text.length },
          scrollIntoView: true,
        });
        v.focus();
      },
      wrap(before, after = "") {
        const v = view.current;
        if (!v || !editable) return;
        const { from, to } = v.state.selection.main;
        const source = v.state.doc.toString();
        const segments = visibleTextRanges(v.state, from, to);
        const codeDelimiter =
          before === "`" && after === "`"
            ? "`".repeat(
                (source.match(/`+/g) || []).reduce(
                  (max, run) => Math.max(max, run.length),
                  0,
                ) + 1,
              )
            : null;
        const changes = v.state.changes(
          !after
            ? [{ from, insert: before }]
            : segments.flatMap((r) => {
                const value = source.slice(r.from, r.to);
                const pad =
                  codeDelimiter &&
                  (/^`|`$/.test(value) ||
                    (/^ .* $/.test(value) && /\S/.test(value)))
                    ? " "
                    : "";
                return [
                  {
                    from: r.from,
                    insert: codeDelimiter ? codeDelimiter + pad : before,
                  },
                  {
                    from: r.to,
                    insert: codeDelimiter ? pad + codeDelimiter : after,
                  },
                ];
              }),
        );
        // Insert format markers around visible runs. Replacing the selection
        // recreated CRDT identities and could wrap hidden records in code.
        v.dispatch({
          changes,
          selection:
            from === to
              ? { anchor: from + (codeDelimiter?.length || before.length) }
              : {
                  anchor: changes.mapPos(from, 1),
                  head: changes.mapPos(to, -1),
                },
        });
        v.focus();
      },
      selection(wholeLine = false) {
        const v = view.current;
        if (!v) return { quote: "", anchor: null };
        let { from, to } = v.state.selection.main;
        if (wholeLine && from === to) {
          const line = v.state.doc.lineAt(from);
          from = line.from;
          to =
            sourceComments(v.state.doc.toString()).find(
              (thread) => thread.from >= from && thread.from <= line.to,
            )?.from ?? line.to;
        }
        const text = ydoc.getText("content");
        return {
          quote: commentReadingText(v.state.sliceDoc(from, to)),
          anchor: {
            start: Y.relativePositionToJSON(
              Y.createRelativePositionFromTypeIndex(text, from),
            ),
            end: Y.relativePositionToJSON(
              Y.createRelativePositionFromTypeIndex(
                text,
                to,
                wholeLine ? -1 : 0,
              ),
            ),
          },
        };
      },
      locate(anchor) {
        try {
          const v = view.current;
          if (!v) return;
          const start = Y.createAbsolutePositionFromRelativePosition(
            Y.createRelativePositionFromJSON(anchor.start),
            ydoc,
          );
          const end = Y.createAbsolutePositionFromRelativePosition(
            Y.createRelativePositionFromJSON(anchor.end),
            ydoc,
          );
          if (start && end) {
            v.dispatch({
              selection: { anchor: start.index, head: end.index },
              effects: [
                EditorView.scrollIntoView(start.index, { y: "center" }),
              ],
            });
          }
        } catch {
          /* A malformed anonymous anchor must not break the editor. */
        }
      },
      focus() {
        view.current?.focus();
      },
      revealComment(id) {
        if (view.current) commentExtension.current?.reveal(view.current, id);
      },
    }),
    [ydoc, editable, path],
  );
  useLayoutEffect(() => {
    const text = ydoc.getText("content");
    const undo = new Y.UndoManager(text);
    const layer = commentLayer(commentHost, (id) =>
      callbacks.current.onOpenComment?.(id),
    );
    commentExtension.current = layer;
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: text.toString(),
        extensions: [
          sourceCommentLayer,
          Prec.highest(
            EditorView.domEventHandlers({
              beforeinput(event, view) {
                // yCollab handles native historyUndo/historyRedo independently of
                // its keymap. Intercept before that plugin after a permission change.
                if (!view.state.readOnly) return false;
                event.preventDefault();
                return true;
              },
            }),
          ),
          EditorView.lineWrapping,
          drawSelection(),
          bracketMatching(),
          highlightSelectionMatches(),
          layer.extension,
          access.current.of([
            EditorState.readOnly.of(!editable),
            EditorView.editable.of(editable),
          ]),
          preview.current.of(documentPreview(id, token, path, entries)),
          yCollab(text, provider.awareness, { undoManager: undo }),
          keymap.of([
            {
              key: "Mod-Alt-m",
              run: () => {
                callbacks.current.onComment();
                return true;
              },
            },
            {
              key: "Mod-k",
              run: () => {
                if (v.state.readOnly || !callbacks.current.onInsertLink)
                  return false;
                callbacks.current.onInsertLink();
                return true;
              },
            },
            ...yUndoManagerKeymap.map((binding) => ({
              ...binding,
              run: (view: EditorView) =>
                !view.state.readOnly && !!binding.run?.(view),
              shift: binding.shift
                ? (view: EditorView) =>
                    !view.state.readOnly && binding.shift!(view)
                : undefined,
            })),
            ...defaultKeymap,
            ...searchKeymap,
            indentWithTab,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged)
              callbacks.current.onChange(u.state.doc.toString());
          }),
          EditorView.domEventHandlers({
            mouseover(e) {
              const link = (e.target as Element).closest<HTMLAnchorElement>(
                "a[data-link-url]",
              );
              if (
                !link ||
                (e.relatedTarget instanceof Node &&
                  link.contains(e.relatedTarget))
              )
                return false;
              const rect = link.getBoundingClientRect();
              callbacks.current.onLink?.({
                url: link.dataset.linkUrl!,
                label: link.dataset.linkLabel!,
                rect,
              });
              return false;
            },
            mousedown(e) {
              const link = (e.target as Element).closest<HTMLAnchorElement>(
                "a[data-link-url]",
              );
              if (link) {
                const rect = link.getBoundingClientRect();
                callbacks.current.onLink?.({
                  url: link.dataset.linkUrl!,
                  label: link.dataset.linkLabel!,
                  rect,
                });
              }
              return false;
            },
            click(e) {
              if ((e.target as Element).closest("a[data-link-url]")) {
                e.preventDefault();
                return true;
              }
              return false;
            },
            keydown(e) {
              if (e.key !== "Enter") return false;
              const link = (e.target as Element).closest<HTMLAnchorElement>(
                "a[data-link-url]",
              );
              if (!link) return false;
              const rect = link.getBoundingClientRect();
              callbacks.current.onLink?.({
                url: link.dataset.linkUrl!,
                label: link.dataset.linkLabel!,
                rect,
              });
              e.preventDefault();
              return true;
            },
            paste(e, view) {
              const file = Array.from(e.clipboardData?.files || [])[0];
              if (file && !view.state.readOnly) {
                callbacks.current.onUpload(file);
                e.preventDefault();
                return true;
              }
              return false;
            },
            drop(e, view) {
              const file = e.dataTransfer?.files[0];
              if (file && !view.state.readOnly) {
                callbacks.current.onUpload(file);
                e.preventDefault();
                return true;
              }
              return false;
            },
          }),
        ],
      }),
    });
    view.current = v;
    callbacks.current.onChange(text.toString());
    return () => {
      view.current = null;
      v.destroy();
      undo.destroy();
    };
  }, [ydoc, provider, id]);
  useLayoutEffect(() => {
    const v = view.current;
    if (!v) return;
    v.dispatch({
      effects: setCommentLayout.of({
        items: (comments || []).map((comment) => ({
          id: comment.id,
          resolved: comment.resolved,
          ...(resolveCommentAnchor(ydoc, comment.anchor) || { from: 0, to: 0 }),
        })),
        active: activeComment || null,
        draft: commentDraft
          ? resolveCommentAnchor(ydoc, commentDraft.anchor) || {
              from: 0,
              to: 0,
            }
          : null,
      }),
    });
    v.requestMeasure();
  }, [comments, activeComment, commentDraft, ydoc]);
  useLayoutEffect(() => {
    view.current?.requestMeasure();
  }, [conversation]);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => view.current?.requestMeasure());
    observer.observe(commentHost);
    return () => observer.disconnect();
  }, [commentHost]);
  const previewEntries =
    documentFormat(path) === "fountain" ? undefined : entries;
  useEffect(() => {
    view.current?.dispatch({
      effects: preview.current.reconfigure(
        documentPreview(id, token, path, previewEntries),
      ),
    });
  }, [id, token, path, previewEntries]);
  useEffect(() => {
    view.current?.dispatch({
      effects: access.current.reconfigure([
        EditorState.readOnly.of(!editable),
        EditorView.editable.of(editable),
      ]),
    });
  }, [editable]);
  return (
    <>
      <div className="markdown-editor" ref={host} />
      {createPortal(conversation, commentHost)}
    </>
  );
});
