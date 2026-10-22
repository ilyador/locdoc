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
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, drawSelection } from "@codemirror/view";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { highlightSelectionMatches } from "@codemirror/search";
import { yCollab } from "y-codemirror.next";
import * as Y from "yjs";
import type { WebsocketProvider } from "y-websocket";
import {
  commentLayer,
  resolveCommentAnchor,
  setCommentLayout,
  sourceCommentLayer,
} from "./editor-comments";
import {
  formatFountainLine,
  insertDocumentLink,
  insertMarkdownTable,
  insertText,
  locateAnchor,
  selectionAnchor,
  toggleTaskList,
  wrapSelection,
} from "./editor-commands";
import { userEngagement } from "./editor-engagement";
import { fileDropEvents, linkEvents } from "./editor-events";
import {
  editorAccess,
  guardedUndoKeymap,
  readOnlyInputGuard,
} from "./editor-permissions";
import { rememberEditorScroll } from "./editor-scroll";
import { findExtension, findKeymap } from "./find-panel";
import type { EditorHandle, LinkTarget, Selection } from "./editor-types";
import { toggleInlineFormat } from "./inline-format";
import { lineBackspaceIntent } from "./line-backspace";
import {
  canonicalLineEndings,
  lineEndingAccess,
  lineEndingError,
} from "./line-endings";
import { documentPreview } from "./markdown-preview";
import { explainMedia, retryUnavailableMedia } from "./markdown-widgets";
import { documentFormat } from "./document-format";
import { perLineDirection } from "./text-direction";
import type { Comment, Entry } from "./model";

export const MarkdownEditor = forwardRef<
  EditorHandle,
  {
    ydoc: Y.Doc;
    provider: WebsocketProvider;
    editable: boolean;
    id: string;
    token?: string;
    // The owner's editor says why the server refuses media.
    owner?: boolean;
    // Grows each time the server says more of the document's media may be
    // served: media this view could not load is requested once more.
    mediaRetry?: number;
    onChange?: (text: string) => void;
    onIntegrityError?: (message: string) => void;
    onComment: () => void;
    onUpload: (file: File) => void;
    comments?: Comment[];
    activeComment?: string | null;
    commentDraft?: Selection | null;
    onOpenComment?: (id: string) => void;
    conversation?: ReactNode;
    path?: string;
    entries?: Entry[];
    scrollKey?: string;
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
    owner,
    mediaRetry,
    onChange,
    onIntegrityError,
    onComment,
    onUpload,
    comments,
    activeComment,
    commentDraft,
    onOpenComment,
    conversation,
    path,
    entries,
    scrollKey,
    onLink,
    onInsertLink,
  },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const undoHistory = useRef<Y.UndoManager | null>(null);
  const [commentHost] = useState(() => document.createElement("div"));
  const commentExtension = useRef<ReturnType<typeof commentLayer> | null>(null);
  const preview = useRef(new Compartment());
  const access = useRef(new Compartment());
  const integrity = useRef(new Compartment());
  const invalidText = useRef(false);
  const callbacks = useRef({
    onChange,
    onIntegrityError,
    onComment,
    onUpload,
    onOpenComment,
    onLink,
    onInsertLink,
  });
  callbacks.current = {
    onChange,
    onIntegrityError,
    onComment,
    onUpload,
    onOpenComment,
    onLink,
    onInsertLink,
  };
  useImperativeHandle(ref, () => {
    // Commands run only while this view accepts edits from this user.
    const writable = () => {
      const v = view.current;
      return v && editable && !invalidText.current && !v.state.readOnly
        ? v
        : null;
    };
    // Plain text has no Markdown or screenplay syntax to insert.
    const formatted = () =>
      documentFormat(path) === "text" ? null : writable();
    return {
      formatFountain(kind) {
        const v = writable();
        if (v && documentFormat(path) === "fountain")
          formatFountainLine(v, kind);
      },
      insertLink(url, label, anchor) {
        const v = formatted();
        if (v && anchor) insertDocumentLink(v, ydoc, url, label, anchor);
      },
      toggleTasks() {
        const v = formatted();
        if (v) toggleTaskList(v);
      },
      insert(text) {
        const v = writable();
        if (v) insertText(v, text);
      },
      insertTable(rows, columns) {
        const v = formatted();
        if (v) insertMarkdownTable(v, rows, columns);
      },
      wrap(before, after = "") {
        const v = formatted();
        if (!v) return;
        if (
          before === after &&
          (before === "*" || before === "**" || before === "_")
        ) {
          undoHistory.current?.stopCapturing();
          v.dispatch(
            toggleInlineFormat(
              v.state,
              before,
              documentFormat(path) === "fountain",
              callbacks.current.onIntegrityError,
            ),
          );
          undoHistory.current?.stopCapturing();
          v.focus();
          return;
        }
        wrapSelection(v, before, after);
      },
      selection(wholeLine = false) {
        const v = view.current;
        if (!v) return { quote: "", anchor: null };
        return selectionAnchor(v, ydoc, wholeLine);
      },
      locate(anchor) {
        const v = view.current;
        if (v) locateAnchor(v, ydoc, anchor);
      },
      focus() {
        view.current?.focus();
      },
      revealComment(id) {
        if (view.current) commentExtension.current?.reveal(view.current, id);
      },
    };
  }, [ydoc, editable, path]);
  useLayoutEffect(() => {
    const text = ydoc.getText("content");
    const source = text.toString();
    invalidText.current = source.includes("\r");
    const integrityAccess = () => lineEndingAccess(invalidText.current);
    const reportIntegrity = () =>
      callbacks.current.onIntegrityError?.(lineEndingError);
    if (invalidText.current) reportIntegrity();
    const undo = new Y.UndoManager(text);
    undoHistory.current = undo;
    const layer = commentLayer(commentHost, (id) =>
      callbacks.current.onOpenComment?.(id),
    );
    commentExtension.current = layer;
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: source,
        extensions: [
          EditorState.lineSeparator.of("\n"),
          EditorState.allowMultipleSelections.of(true),
          integrity.current.of(integrityAccess()),
          canonicalLineEndings,
          sourceCommentLayer,
          lineBackspaceIntent(),
          readOnlyInputGuard,
          EditorView.lineWrapping,
          perLineDirection,
          drawSelection(),
          highlightSelectionMatches(),
          findExtension(),
          layer.extension,
          access.current.of(editorAccess(editable)),
          // Outside the preview compartment: a new preview keeps whether the
          // user has engaged with this editor.
          userEngagement,
          preview.current.of([
            documentPreview(id, token, path, entries),
            explainMedia.of(!!owner),
          ]),
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
            ...guardedUndoKeymap,
            ...defaultKeymap,
            ...findKeymap,
            indentWithTab,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged)
              callbacks.current.onChange?.(u.state.doc.toString());
          }),
          linkEvents((target) => callbacks.current.onLink?.(target)),
          fileDropEvents((file) => callbacks.current.onUpload(file)),
        ],
      }),
    });
    view.current = v;
    let alive = true;
    const inspect = (event: Y.YTextEvent) => {
      if (
        !invalidText.current &&
        !event.delta.some(
          (part) =>
            typeof part.insert === "string" && part.insert.includes("\r"),
        )
      )
        return;
      const invalid = text.toString().includes("\r");
      if (invalid === invalidText.current) return;
      invalidText.current = invalid;
      if (invalid) reportIntegrity();
      queueMicrotask(() => {
        if (alive)
          v.dispatch({
            effects: integrity.current.reconfigure(integrityAccess()),
          });
      });
    };
    text.observe(inspect);
    callbacks.current.onChange?.(text.toString());
    const stopRemembering = scrollKey
      ? rememberEditorScroll(v, scrollKey, text)
      : undefined;
    return () => {
      // Capture while the view and its DOM geometry still exist.
      stopRemembering?.();
      alive = false;
      text.unobserve(inspect);
      view.current = null;
      undoHistory.current = null;
      v.destroy();
      undo.destroy();
    };
  }, [ydoc, provider, id, scrollKey]);
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
    documentFormat(path) === "markdown" ? entries : undefined;
  useEffect(() => {
    view.current?.dispatch({
      effects: preview.current.reconfigure([
        documentPreview(id, token, path, previewEntries),
        explainMedia.of(!!owner),
      ]),
    });
  }, [id, token, path, previewEntries, owner]);
  // A permission change applies in the commit that shows it, before the
  // browser paints or takes another keystroke.
  useLayoutEffect(() => {
    view.current?.dispatch({
      effects: access.current.reconfigure(editorAccess(editable)),
    });
  }, [editable]);
  useEffect(() => {
    if (mediaRetry && view.current) retryUnavailableMedia(view.current.dom);
  }, [mediaRetry]);
  return (
    <>
      <div className="markdown-editor" ref={host} />
      {createPortal(conversation, commentHost)}
    </>
  );
});
