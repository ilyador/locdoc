import { useEffect, useState, type RefObject } from "react";
import type * as Y from "yjs";
import { CommentComposer, CommentThread } from "./comments";
import type { EditorHandle, Selection } from "./editor";
import { normalizePresence } from "./presence";
import { useComments } from "./use-comments";

type DraftConversation = { kind: "draft"; selection: Selection };
type Conversation = DraftConversation | { kind: "thread"; id: string };
type Action = (fn: () => Promise<void>) => Promise<boolean>;

// The open comment conversation and its form drafts. A new-comment draft and
// each reply draft keep their text until the server accepts them.
export function useConversation({
  editor,
  endpoint,
  ready,
  source,
  name,
  action,
}: {
  editor: RefObject<EditorHandle | null>;
  endpoint: (suffix: string) => string;
  ready: boolean;
  source: Y.Text | undefined;
  name: string;
  action: Action;
}) {
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [newCommentDraft, setNewCommentDraft] = useState<{
    conversation: DraftConversation;
    body: string;
  } | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const selection =
    conversation?.kind === "draft" ? conversation.selection : null;
  const commentsOpen = conversation !== null;
  const {
    comments,
    mutate: mutateComment,
    forgetRequest,
  } = useComments(endpoint, ready, source);
  const cancel = () => {
    if (conversation?.kind === "draft") {
      forgetRequest();
      setNewCommentDraft(null);
    } else if (conversation?.kind === "thread") {
      forgetRequest(conversation.id);
    }
    setConversation(null);
    editor.current?.focus();
  };
  useEffect(() => {
    if (!commentsOpen) return;
    const dismiss = (event: MouseEvent) => {
      // Keep the original event path: Cancel may remove its own form before
      // this listener runs. Waiting for click also preserves editor caret hit
      // testing and avoids dismissing while a touch gesture is just scrolling.
      const inside = event
        .composedPath()
        .some(
          (node) =>
            node instanceof Element &&
            node.matches(
              ".inline-comment-host, .comment-marker, [data-comment-control]",
            ),
        );
      if (!inside) setConversation(null);
    };
    document.addEventListener("click", dismiss);
    return () => document.removeEventListener("click", dismiss);
  }, [commentsOpen]);
  const start = () => {
    if (selection) {
      document.getElementById("new-comment")?.focus();
      return;
    }
    if (newCommentDraft) {
      setConversation(newCommentDraft.conversation);
      return;
    }
    forgetRequest();
    const draft: DraftConversation = {
      kind: "draft",
      selection: editor.current?.selection(true) || { quote: "", anchor: null },
    };
    setNewCommentDraft({ conversation: draft, body: "" });
    setConversation(draft);
  };
  useEffect(() => {
    if (conversation?.kind === "thread")
      editor.current?.revealComment(conversation.id);
    if (conversation?.kind === "draft") {
      editor.current?.revealComment();
      document.getElementById("new-comment")?.focus({ preventScroll: true });
    }
  }, [conversation]);
  const add = (body: string) =>
    action(async () => {
      const c = await mutateComment("", {
        body,
        name: normalizePresence({ name })?.name || "Guest",
        quote: selection?.quote,
        anchor: selection?.anchor,
      });
      setNewCommentDraft((current) =>
        current?.conversation === conversation && current.body === body
          ? null
          : current,
      );
      setConversation((current) =>
        current === conversation ? { kind: "thread", id: c.id } : current,
      );
    });
  const update = (
    cid: string,
    data: { body?: string; name?: string; resolved?: boolean },
  ) =>
    action(async () => {
      await mutateComment(cid, data);
    });
  const toggle = () => {
    if (commentsOpen) setConversation(null);
    else if (newCommentDraft) start();
    else {
      const first = comments.find((c) => !c.resolved) || comments[0];
      if (first) setConversation({ kind: "thread", id: first.id });
      else start();
    }
  };
  const open = (id: string) =>
    setConversation((current) =>
      current?.kind === "thread" && current.id === id
        ? null
        : { kind: "thread", id },
    );
  const currentComment =
    conversation?.kind === "thread"
      ? comments.find((c) => c.id === conversation.id)
      : null;
  return {
    comments,
    conversation,
    setConversation,
    selection,
    commentsOpen,
    currentComment,
    newCommentDraft,
    setNewCommentDraft,
    replyDrafts,
    setReplyDrafts,
    name,
    start,
    cancel,
    add,
    update,
    toggle,
    open,
    close: () => setConversation(null),
  };
}

export function CommentConversation({
  thread,
  busy,
  editable,
}: {
  thread: ReturnType<typeof useConversation>;
  busy: boolean;
  editable: boolean;
}) {
  const {
    comments,
    conversation,
    setConversation,
    selection,
    currentComment,
    newCommentDraft,
    setNewCommentDraft,
    replyDrafts,
    setReplyDrafts,
    name,
  } = thread;
  const currentCommentIndex = comments.findIndex(
    (c) => c.id === currentComment?.id,
  );
  return (
    <section className="inline-conversation" aria-label="Comment conversation">
      {selection ? (
        <CommentComposer
          draft={newCommentDraft?.body || ""}
          onDraftChange={(body) =>
            setNewCommentDraft((current) =>
              current?.conversation === conversation
                ? { ...current, body }
                : current,
            )
          }
          busy={busy}
          onSubmit={thread.add}
          onCancel={thread.cancel}
        />
      ) : currentComment ? (
        <CommentThread
          key={currentComment.id}
          comment={currentComment}
          onResolve={() =>
            thread.update(currentComment.id, {
              resolved: !currentComment.resolved,
            })
          }
          navigation={
            comments.length > 1 && (
              <>
                <button
                  type="button"
                  disabled={currentCommentIndex <= 0}
                  onClick={() =>
                    setConversation({
                      kind: "thread",
                      id: comments[currentCommentIndex - 1].id,
                    })
                  }
                >
                  Previous comment
                </button>
                <button
                  type="button"
                  disabled={currentCommentIndex >= comments.length - 1}
                  onClick={() =>
                    setConversation({
                      kind: "thread",
                      id: comments[currentCommentIndex + 1].id,
                    })
                  }
                >
                  Next comment
                </button>
              </>
            )
          }
          canResolve={editable || !!currentComment.canResolve}
          onReply={(body) =>
            thread.update(currentComment.id, {
              body,
              name: normalizePresence({ name })?.name || "Guest",
            })
          }
          busy={busy}
          onCancel={thread.cancel}
          draft={replyDrafts[currentComment.id] || ""}
          onDraftChange={(body) =>
            setReplyDrafts((current) => ({
              ...current,
              [currentComment.id]: body,
            }))
          }
        />
      ) : (
        <p className="field-help">This conversation is no longer available.</p>
      )}
    </section>
  );
}
