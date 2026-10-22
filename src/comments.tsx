import { useRef, useState, type ReactNode } from "react";
import {
  ArrowBendUpLeft,
  DotsThree,
  PaperPlaneTilt,
  X,
} from "@phosphor-icons/react";
import { IconButton, timeAgo } from "./ui";
import type { Comment } from "./model";

function CommentInput({
  id,
  label,
  placeholder,
  value,
  onChange,
  onSubmit,
  onCancel,
  cancelLabel,
  busy = false,
  autoFocus = false,
}: {
  id?: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (body: string) => void;
  onSubmit: (body: string) => Promise<boolean>;
  onCancel: () => void;
  cancelLabel: string;
  busy?: boolean;
  autoFocus?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const disabled = busy || pending;
  return (
    <form
      className="comment-composer"
      onSubmit={async (event) => {
        event.preventDefault();
        if (disabled || submitting.current || !value.trim()) return;
        submitting.current = true;
        setPending(true);
        try {
          if (await onSubmit(value)) {
            onChange("");
          }
        } finally {
          submitting.current = false;
          setPending(false);
        }
      }}
    >
      <textarea
        id={id}
        dir="auto"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        rows={1}
        maxLength={4000}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        autoFocus={autoFocus}
      />
      <div className="comment-composer-actions">
        <IconButton
          label={cancelLabel}
          type="button"
          disabled={disabled}
          onClick={onCancel}
        >
          <X size={16} />
        </IconButton>
        <IconButton
          label="Post"
          type="submit"
          className="comment-post"
          disabled={disabled || !value.trim()}
          aria-busy={pending}
        >
          <PaperPlaneTilt size={16} />
        </IconButton>
      </div>
    </form>
  );
}

export function CommentComposer({
  onSubmit,
  onCancel,
  draft,
  onDraftChange,
  busy = false,
}: {
  onSubmit: (body: string) => Promise<boolean>;
  onCancel?: () => void;
  draft?: string;
  onDraftChange?: (body: string) => void;
  busy?: boolean;
}) {
  const [localBody, setLocalBody] = useState("");
  const body = draft ?? localBody;
  const setBody = onDraftChange || setLocalBody;
  return (
    <CommentInput
      id="new-comment"
      label="New comment"
      placeholder="Write a comment…"
      value={body}
      onChange={setBody}
      onSubmit={onSubmit}
      busy={busy}
      onCancel={() => {
        setBody("");
        onCancel?.();
      }}
      cancelLabel="Cancel comment"
      autoFocus
    />
  );
}

function CommentMessage({
  name,
  body,
  created,
  resolved = false,
}: {
  name: string;
  body: string;
  created: number;
  resolved?: boolean;
}) {
  // The message reads in the direction of its text. The author's name is
  // isolated, so it neither decides that direction nor takes the colon.
  return (
    <p className="comment-message" dir="auto">
      <strong className="comment-name">
        <bdi>{name}</bdi>:
      </strong>{" "}
      <span>{body}</span>
      {created > 0 && (
        <>
          {" "}
          <time title={new Date(created * 1000).toLocaleString()}>
            [{timeAgo(created)}]
          </time>
        </>
      )}
      {resolved && <span className="comment-resolved"> Resolved</span>}
    </p>
  );
}

export function CommentThread({
  comment: c,
  onResolve,
  canResolve,
  onReply,
  busy,
  draft,
  onDraftChange,
  navigation,
  onCancel,
}: {
  comment: Comment;
  onResolve: () => void;
  canResolve: boolean;
  onReply: (body: string) => Promise<boolean>;
  busy: boolean;
  draft?: string;
  onDraftChange?: (value: string) => void;
  navigation?: ReactNode;
  onCancel?: () => void;
}) {
  const [localReply, setLocalReply] = useState("");
  const [replying, setReplying] = useState(false);
  const reply = draft ?? localReply;
  const setReply = onDraftChange || setLocalReply;
  return (
    <section className={`comment-thread ${c.resolved ? "resolved" : ""}`}>
      <div className="comment-message-row">
        <CommentMessage
          name={c.name}
          body={c.body}
          created={c.created}
          resolved={c.resolved}
        />
        {(navigation || canResolve) && (
          <details className="comment-tools">
            <summary aria-label="Comment actions" title="Comment actions">
              <DotsThree size={18} />
            </summary>
            <div className="comment-tools-menu">
              {navigation}
              {canResolve && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.currentTarget.closest("details")!.open = false;
                    onResolve();
                  }}
                  disabled={busy}
                >
                  {c.resolved ? "Reopen conversation" : "Resolve conversation"}
                </button>
              )}
            </div>
          </details>
        )}
      </div>
      {c.replies.map((r, i) => (
        <div className="comment-reply" key={i}>
          <CommentMessage name={r.name} body={r.body} created={r.created} />
        </div>
      ))}
      {!c.resolved &&
        (replying || reply ? (
          <CommentInput
            label="Reply to comment"
            placeholder="Reply…"
            value={reply}
            onChange={setReply}
            onSubmit={async (body) => {
              const success = await onReply(body);
              if (success) setReplying(false);
              return success;
            }}
            onCancel={() => {
              setReply("");
              setReplying(false);
              onCancel?.();
            }}
            cancelLabel="Cancel reply"
            busy={busy}
            autoFocus={replying}
          />
        ) : (
          <button
            className="comment-reply-trigger"
            type="button"
            onClick={() => setReplying(true)}
            disabled={busy}
          >
            <ArrowBendUpLeft size={14} aria-hidden="true" />
            Reply
          </button>
        ))}
    </section>
  );
}
