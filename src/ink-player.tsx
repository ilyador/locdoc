import { useEffect, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";
import { ArrowCounterClockwise, ArrowRight, X } from "@phosphor-icons/react";
import { api } from "./api";
import type { Document, Entry } from "./model";
import { IconButton } from "./ui";
import { loadInkProject } from "./ink-project";
import type { InkRequest, InkResult } from "./ink-runtime";

type PreviewRequest = {
  source: string;
  path: string;
  accessQuery: string;
  restart: number;
  includesVersion: string;
};

export function InkPlayer({
  text,
  path,
  entries,
  accessQuery,
  onClose,
}: {
  text: Y.Text;
  path: string;
  entries: Entry[];
  accessQuery: string;
  onClose: () => void;
}) {
  const [source, setSource] = useState(() => text.toString());
  const [restart, setRestart] = useState(0);
  const [busy, setBusy] = useState(true);
  const [result, setResult] = useState<
    (InkResult & { request: PreviewRequest }) | null
  >(null);
  const history = useRef<string[]>([]);
  const send = useRef<((request: InkRequest) => void) | null>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const choiceFocus = useRef<{
    button: HTMLButtonElement;
    next: number;
  } | null>(null);
  const latestEntries = useRef(entries);
  latestEntries.current = entries;
  const includesVersion = entries
    .filter((entry) => entry.path !== path && /\.ink$/i.test(entry.path))
    .map((entry) => `${entry.id}:${entry.path}:${entry.modified}`)
    .join("|");
  const request = useMemo(
    () => ({ source, path, accessQuery, restart, includesVersion }),
    [source, path, accessQuery, restart, includesVersion],
  );
  useEffect(() => {
    const changed = () => {
      setBusy(true);
      setSource(text.toString());
    };
    text.observe(changed);
    return () => text.unobserve(changed);
  }, [text]);
  useEffect(() => {
    const abort = new AbortController();
    choiceFocus.current = null;
    let worker: Worker | null = null;
    let timeout: ReturnType<typeof setTimeout>;
    let waiting = false;
    const fail = (message: string) => {
      if (abort.signal.aborted) return;
      worker?.terminate();
      clearTimeout(timeout);
      send.current = null;
      setBusy(false);
      setResult({
        request,
        turns: [],
        choices: [],
        history: [],
        messages: [{ text: message, severity: "error" }],
      });
    };
    setBusy(true);
    const debounce = setTimeout(() => {
      void loadInkProject(path, source, latestEntries.current, (id) =>
        api<Document>(`/api/docs/${id}${accessQuery}`, {
          signal: abort.signal,
        }),
      )
        .then((files) => {
          if (abort.signal.aborted) return;
          worker = new Worker(new URL("./ink-worker.ts", import.meta.url), {
            type: "module",
          });
          worker.onmessage = (event: MessageEvent<InkResult>) => {
            if (abort.signal.aborted) return;
            clearTimeout(timeout);
            waiting = false;
            history.current = event.data.history;
            setResult({ ...event.data, request });
            setBusy(false);
          };
          worker.onerror = () =>
            fail("The story preview stopped. Restart to try again.");
          const post = (request: InkRequest) => {
            if (waiting || abort.signal.aborted) return;
            waiting = true;
            setBusy(true);
            timeout = setTimeout(
              () =>
                fail(
                  "Preview timed out. Check for a loop or a very large story, then restart.",
                ),
              5000,
            );
            worker!.postMessage(request);
          };
          send.current = post;
          post({ type: "compile", path, files, history: history.current });
        })
        .catch((error) =>
          fail(
            error instanceof Error
              ? error.message
              : "Could not load this story.",
          ),
        );
    }, 400);
    return () => {
      abort.abort();
      clearTimeout(debounce);
      clearTimeout(timeout);
      worker?.terminate();
      send.current = null;
    };
  }, [request]);
  const pending = busy || result?.request !== request;
  useEffect(() => {
    if (pending) return;
    transcript.current?.scrollTo?.({ top: transcript.current.scrollHeight });
    const follow = choiceFocus.current;
    choiceFocus.current = null;
    // A choice can remove its own focused button. Put keyboard readers at
    // the new passage, without pulling a writer back from the editor.
    if (
      follow &&
      (document.activeElement === follow.button ||
        document.activeElement === document.body)
    ) {
      const next =
        transcript.current?.querySelector<HTMLElement>(
          `[data-ink-turn="${follow.next}"] p`,
        ) ||
        transcript.current?.querySelector<HTMLElement>(
          ".ink-message-error, .ink-choices button",
        ) ||
        transcript.current;
      next?.focus({ preventScroll: true });
      const pane = transcript.current;
      if (pane && next && next !== pane) {
        // Only this pane scrolls. The first new passage stays fully visible
        // even when a branch outputs more than one phone screen of text.
        pane.scrollTop +=
          next.getBoundingClientRect().top -
          pane.getBoundingClientRect().top -
          16;
      }
    }
  }, [result, pending]);
  const errors = result?.messages.some(
    (message) => message.severity === "error",
  );
  return (
    <section
      className="ink-player"
      aria-label="Story preview"
      aria-busy={pending}
    >
      <header className="ink-player-header">
        <h2>Story preview</h2>
        <div>
          <IconButton
            label="Restart story"
            onClick={() => {
              history.current = [];
              setRestart((value) => value + 1);
            }}
          >
            <ArrowCounterClockwise size={18} />
          </IconButton>
          <IconButton label="Close story preview" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
      </header>
      <div
        className="ink-transcript"
        ref={transcript}
        tabIndex={0}
        aria-label="Story transcript"
      >
        {result?.turns.map((turn, index) => (
          <div
            key={index}
            data-ink-turn={index}
            className={turn.choice ? "ink-chosen" : "ink-paragraph"}
          >
            <p dir="auto" tabIndex={-1}>
              {turn.choice && <ArrowRight size={14} aria-hidden="true" />}
              {turn.text}
            </p>
            {!!turn.tags?.length && (
              <small dir="auto">
                {turn.tags.map((tag) => `# ${tag}`).join(" · ")}
              </small>
            )}
          </div>
        ))}
        {!result?.turns.length && !errors && (
          <p className="ink-player-empty">
            {pending
              ? "Preparing your story…"
              : "Write a line, then follow where it leads."}
          </p>
        )}
        {!errors && !!result?.choices.length && (
          <div className="ink-choices" aria-label="Story choices">
            {result.choices.map((choice, index) => (
              <button
                key={`${index}:${choice}`}
                aria-disabled={pending}
                onClick={(event) => {
                  if (!pending && send.current) {
                    choiceFocus.current = {
                      button: event.currentTarget,
                      next: result.turns.length + 1,
                    };
                    send.current({ type: "choose", index });
                  }
                }}
              >
                <span dir="auto">{choice || "Continue"}</span>
                <ArrowRight size={18} aria-hidden="true" />
              </button>
            ))}
          </div>
        )}
        {result?.messages.map((message, index) => (
          <p
            key={index}
            className={`ink-message ink-message-${message.severity}`}
            dir="auto"
            tabIndex={-1}
          >
            {message.text}
          </p>
        ))}
        {!pending &&
          !errors &&
          !!result?.turns.length &&
          !result.choices.length && <p className="ink-end">End of story</p>}
      </div>
      <footer className="ink-player-status" role="status">
        {pending
          ? "Updating preview…"
          : errors
            ? "Fix the story above to continue"
            : "Updates as you write"}
      </footer>
    </section>
  );
}
