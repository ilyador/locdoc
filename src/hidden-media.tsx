import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Eye, ImageBroken, VideoCamera } from "@phosphor-icons/react";
import { api, send } from "./api";
import { isVideo, mediaReasons, mediaUrl } from "./markdown-widgets";
import type { Document, HiddenMedia } from "./model";
import { PathText } from "./ui";
import { useRemote } from "./use-remote";

type Refusal = { path: string; reason: string };
type ShareResult = { ok: boolean; shared: string[]; refused: Refusal[] };

// The server's reasons, for an image it lists and for one POST
// /api/docs/{id}/media/share refuses, read as sentences; anything else is
// shown as inert text.
const reason = (code: string) =>
  Object.hasOwn(mediaReasons, code) ? mediaReasons[code] : code;
// Locdoc serves these to nobody, so there is no picture to load.
const unavailable = new Set([
  "missing",
  "outside",
  "state",
  "too-large",
  "unsupported",
  "invalid",
]);

function Preview({ doc, item }: { doc: Document; item: HiddenMedia }) {
  const [failed, setFailed] = useState(false);
  if (unavailable.has(item.reason) || failed)
    return (
      <span className="hidden-media-thumb is-missing" aria-hidden="true">
        <ImageBroken size={18} />
      </span>
    );
  if (isVideo(item.path))
    return (
      <span className="hidden-media-thumb" aria-hidden="true">
        <VideoCamera size={18} />
      </span>
    );
  return (
    <img
      className="hidden-media-thumb"
      src={mediaUrl(doc.id, item.path, doc.mediaToken || undefined)}
      alt=""
      loading="lazy"
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

// Images the owner sees but link visitors cannot. Showing one approves it
// through the server's desktop-approval checks. The list belongs to the
// document in its request URL; a remount for another document starts over.
export function HiddenMediaSection({ doc }: { doc: Document }) {
  const remote = useRemote<Document>(`/api/docs/${encodeURIComponent(doc.id)}`);
  const headingId = useId();
  const [shared, setShared] = useState<ReadonlySet<string>>(new Set());
  const [refused, setRefused] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const section = useRef<HTMLElement>(null);
  const statusLine = useRef<HTMLParagraphElement>(null);
  // An image shown to visitors leaves the list with the button that showed
  // it. Keyboard focus then moves to the next one instead of the page.
  const refocus = useRef<number | null>(null);
  useLayoutEffect(() => {
    const index = refocus.current;
    if (index === null) return;
    refocus.current = null;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const actions = Array.from(
      section.current?.querySelectorAll<HTMLButtonElement>(
        ".hidden-media-action",
      ) || [],
    );
    (
      actions[Math.min(index, actions.length - 1)] || statusLine.current
    )?.focus();
  });
  // Requests belong to this mounted document; a late answer is dropped.
  const requests = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    requests.current = controller;
    return () => controller.abort();
  }, []);
  const loaded =
    remote.data?.id === doc.id ? (remote.data.hiddenMedia ?? []) : null;
  const items = (loaded || []).filter((item) => !shared.has(item.path));
  const approvable = items.filter(
    (item) => item.reason === "unapproved" && !pending.has(item.path),
  );
  const show = async (paths: string[]) => {
    const signal = requests.current?.signal;
    if (!signal || signal.aborted) return;
    const actions = Array.from(
      section.current?.querySelectorAll(".hidden-media-action") || [],
    );
    const from = Math.max(0, actions.indexOf(document.activeElement!));
    setPending((current) => new Set([...current, ...paths]));
    setError("");
    setStatus("");
    try {
      const result = await api<ShareResult>(
        `/api/docs/${encodeURIComponent(doc.id)}/media/share`,
        { ...send("POST", { paths }), signal },
      );
      if (signal.aborted) return;
      const accepted = result.shared || [];
      const declined = result.refused || [];
      if (accepted.length) refocus.current = from;
      setShared((current) => new Set([...current, ...accepted]));
      setRefused((current) => {
        const next = new Map(current);
        for (const path of accepted) next.delete(path);
        for (const { path, reason } of declined) next.set(path, reason);
        return next;
      });
      setStatus(
        [
          accepted.length
            ? `Link visitors can now see ${accepted.length === 1 ? "this image" : `${accepted.length} images`}.`
            : "",
          declined.length
            ? `${declined.length === 1 ? "One image" : `${declined.length} images`} could not be shown.`
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      );
    } catch (failure) {
      if (!signal.aborted) setError((failure as Error).message);
    } finally {
      if (!signal.aborted)
        setPending((current) => {
          const next = new Set(current);
          for (const path of paths) next.delete(path);
          return next;
        });
    }
  };
  if (remote.error)
    return (
      <section className="hidden-media">
        <p className="field-help">
          Could not check which images link visitors can see.
        </p>
      </section>
    );
  if (!items.length && !status && !error) return null;
  return (
    <section
      ref={section}
      className="hidden-media"
      aria-labelledby={items.length ? headingId : undefined}
    >
      {items.length > 0 && (
        <>
          <div className="hidden-media-heading">
            <h3 id={headingId}>Hidden from link visitors</h3>
            {approvable.length > 1 && (
              <button
                type="button"
                className="text-button"
                onClick={() => void show(approvable.map((item) => item.path))}
              >
                Show all
              </button>
            )}
          </div>
          <p className="field-help">
            People opening the link cannot see these images.
          </p>
        </>
      )}
      <ul className="hidden-media-list" hidden={!items.length}>
        {items.map((item) => {
          const refusal = refused.get(item.path);
          const busy = pending.has(item.path);
          const name = item.path.split("/").pop() || item.path;
          return (
            <li key={item.path} className="hidden-media-item">
              <Preview doc={doc} item={item} />
              <span className="hidden-media-text">
                <span className="hidden-media-path" title={item.path}>
                  <PathText path={item.path} separator="/" />
                </span>
                <span
                  className={`hidden-media-reason ${refusal ? "is-refused" : ""}`}
                >
                  {refusal
                    ? `Not shown: ${reason(refusal)}`
                    : reason(item.reason)}
                </span>
              </span>
              {item.reason === "unapproved" && (
                // Never disabled while it works: a disabled button would
                // drop keyboard focus out of the dialog.
                <button
                  type="button"
                  className="button quiet hidden-media-action"
                  aria-label={`Show ${name} to link visitors`}
                  aria-disabled={busy || undefined}
                  onClick={() => {
                    if (!busy) void show([item.path]);
                  }}
                >
                  <Eye size={16} aria-hidden="true" />
                  <span>{busy ? "Showing…" : "Show to link visitors"}</span>
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {error && (
        <p role="alert" className="field-help">
          {error}
        </p>
      )}
      <p
        ref={statusLine}
        className="field-help hidden-media-status"
        role="status"
        tabIndex={-1}
      >
        {status}
      </p>
    </section>
  );
}
