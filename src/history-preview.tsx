import { useLayoutEffect, useMemo, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, placeholder } from "@codemirror/view";
import { getChunks, unifiedMergeView } from "@codemirror/merge";
import { commentReadingText } from "./comment-syntax";
import { documentFormat } from "./document-format";
import { documentPreview } from "./markdown-preview";
import { perLineDirection } from "./text-direction";
import { documentSelection } from "./editor-selection";

export function HistoryPreview({
  content,
  original,
  path,
  documentId,
  token,
}: {
  content: string;
  original: string | null;
  path: string;
  documentId: string;
  token?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const source = useMemo(() => {
    // Compare readable text, preserving literal examples. Restore still uses
    // the untouched server snapshot, including its comment records.
    const reading = (text: string) =>
      commentReadingText(
        text.replace(/\r\n?/g, "\n"),
        documentFormat(path) === "text",
      );
    return {
      content: reading(content),
      original: original === null ? null : reading(original),
    };
  }, [content, original, path]);
  useLayoutEffect(() => {
    const pane = host.current!.closest<HTMLElement>(".history-preview-scroll")!;
    pane.scrollTop = 0;
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: source.content,
        extensions: [
          EditorState.readOnly.of(true),
          EditorState.lineSeparator.of("\n"),
          EditorView.editable.of(false),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            "aria-label": "Saved version content",
            "aria-readonly": "true",
            tabindex: "0",
            spellcheck: "false",
          }),
          placeholder("Empty version"),
          documentPreview(documentId, token, path),
          perLineDirection,
          documentSelection,
          // CodeMirror draws the target first; only this pane scrolls, even for
          // a long jump in WebKit. Live-document reading state stays separate.
          EditorView.scrollHandler.of((view, range, options) => {
            if (options.y !== "start") return false;
            pane.scrollTop +=
              view.documentTop +
              view.lineBlockAt(range.head).top -
              pane.getBoundingClientRect().top -
              options.yMargin;
            return true;
          }),
          source.original === null
            ? []
            : unifiedMergeView({
                original: source.original,
                mergeControls: false,
                gutter: false,
                allowInlineDiffs: true,
                syntaxHighlightDeletions: false,
                diffConfig: { scanLimit: 500, timeout: 30 },
              }),
        ],
      }),
    });
    const first = getChunks(view.state)?.chunks[0];
    if (first)
      view.dispatch({
        effects: EditorView.scrollIntoView(
          Math.min(first.fromB, view.state.doc.length),
          { y: "start", yMargin: 24 },
        ),
      });
    return () => view.destroy();
  }, [source, path, documentId, token]);
  return (
    <div ref={host} className="version-preview markdown-editor" dir="auto" />
  );
}
