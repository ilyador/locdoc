import { useCallback, useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import { api, send } from "./api";
import { sourceComments } from "./comment-syntax";
import type { Comment } from "./model";

// Keep the cache below the document boundary. Only a fresh GET replaces existing
// threads: a mutation response may already be older than a collaborator's reply.
export function useComments(
  endpoint: (suffix: string) => string,
  ready: boolean,
  source: string | Y.Text | undefined,
) {
  const [comments, setComments] = useState<Comment[]>([]);
  const alive = useRef(false);
  const read = useRef<AbortController | null>(null);
  const retry = useRef(false);
  const requests = useRef(new Map<string, { body: string; id: string }>());
  const sourceKey = useRef<string | null>(null);
  const refresh = useCallback(async () => {
    if (!ready || !alive.current) return;
    read.current?.abort();
    const request = new AbortController();
    read.current = request;
    const timeout = setTimeout(() => request.abort(), 8000);
    retry.current = true;
    try {
      const result = await api<{ comments: Comment[] }>(endpoint("/comments"), {
        signal: request.signal,
      });
      if (!request.signal.aborted) {
        setComments(result.comments);
        retry.current = false;
      }
    } catch {
      // Keep the last snapshot while offline. Source changes, reconnecting and
      // visibility changes all retry; a successful POST must still clear its form.
    } finally {
      clearTimeout(timeout);
      if (read.current === request) read.current = null;
    }
  }, [endpoint, ready]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const snapshot = () => {
      timer = undefined;
      if (source === undefined) return;
      const text = typeof source === "string" ? source : source.toString();
      const key = sourceComments(text)
        .map((t) => text.slice(t.from, t.to))
        .join("\n\n");
      const changed = sourceKey.current !== null && sourceKey.current !== key;
      sourceKey.current = key;
      if (changed) void refresh();
    };
    const changed = () => {
      // A bounded sampling interval, rather than a trailing debounce: metadata
      // stays current during sustained typing without parsing every keystroke.
      timer ??= setTimeout(snapshot, 100);
    };
    snapshot();
    if (source && typeof source !== "string") source.observe(changed);
    return () => {
      clearTimeout(timer);
      if (source && typeof source !== "string") source.unobserve(changed);
    };
  }, [source, refresh]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      read.current?.abort();
    };
  }, []);
  useEffect(() => {
    void refresh();
    const refreshVisible = () => {
      if (!document.hidden) void refresh();
    };
    // Source changes arrive immediately over the existing WebSocket. Poll only
    // metadata on documents with threads, without overlapping slow requests.
    const timer = setInterval(() => {
      if (
        !document.hidden &&
        !read.current &&
        (sourceKey.current || retry.current)
      )
        void refresh();
    }, 2000);
    document.addEventListener("visibilitychange", refreshVisible);
    window.addEventListener("online", refreshVisible);
    return () => {
      read.current?.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshVisible);
      window.removeEventListener("online", refreshVisible);
    };
  }, [refresh]);
  const forgetRequest = (id = "") => requests.current.delete(id);
  const mutate = async (
    id: string,
    data: {
      body?: string;
      name?: string;
      resolved?: boolean;
      quote?: string;
      anchor?: unknown;
    },
  ) => {
    let requestId: string | undefined;
    if (data.body !== undefined) {
      if (requests.current.get(id)?.body !== data.body)
        requests.current.set(id, { body: data.body, id: crypto.randomUUID() });
      requestId = requests.current.get(id)!.id;
    }
    const result = await api<Comment>(
      endpoint(`/comments${id ? `/${id}` : ""}`),
      {
        ...send(id ? "PATCH" : "POST", { ...data, requestId }),
        signal: AbortSignal.timeout(15000),
      },
    );
    if (requests.current.get(id)?.id === requestId) forgetRequest(id);
    // A committed write releases its form immediately. Only new roots need a
    // provisional entry; never replace an existing thread with a stale PATCH.
    if (!id)
      setComments((current) =>
        current.some((c) => c.id === result.id)
          ? current
          : [...current, result],
      );
    void refresh();
    return result;
  };
  return { comments, mutate, forgetRequest };
}
