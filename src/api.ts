import {
  offlineCacheEnabled,
  cachedRead,
  cacheRead,
  cacheableRead,
  invalidateRead,
  logoutOffline,
  storageFailed,
  offlineGeneration,
  stampOffline,
  offlineStamp,
} from "./offline-cache.ts";
import {
  localDocument,
  localDeletion,
  projectRead,
  queueFileRequest,
} from "./offline-files.ts";
import {
  queueComment,
  queueUpload,
  projectComments,
} from "./offline-actions.ts";

export class ApiError extends Error {
  readonly status: number;
  // The parsed error response, for callers that need more than its message.
  readonly body: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

// A collaboration state as the API sends it, in base64. A loop over the
// decoded string is many times faster than Uint8Array.from with a mapping
// function, which made opening a long document wait.
export function decodeState(state: string) {
  const binary = atob(state);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const SESSION_KEY = "locdoc.ownerSession";
let volatileSession = "";

// Browser storage belongs to an origin (including its port); cookies do not.
// Local HTTP owner credentials must never be sent to unrelated localhost apps.
export function ownerSession() {
  const loopback =
    location.hostname === "localhost" ||
    location.hostname === "[::1]" ||
    /^127\./.test(location.hostname);
  if (location.protocol === "https:" && !loopback) return "";
  try {
    return localStorage.getItem(SESSION_KEY) || volatileSession;
  } catch {
    return volatileSession;
  }
}

function rememberSession(value: string) {
  volatileSession = value;
  try {
    if (value) localStorage.setItem(SESSION_KEY, value);
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    // An open tab can still authenticate when persistent browser storage is off.
  }
}

// A proxy can answer before the restarted server begins listening. Its empty
// or HTML error is distinct from a structured refusal sent by Locdoc itself.
function proxyFailure(response: Response) {
  return (
    [502, 503, 504].includes(response.status) &&
    !response.headers
      .get("Content-Type")
      ?.toLowerCase()
      .startsWith("application/json")
  );
}

// Retry only reads, with a short, bounded backoff: replaying a write could
// repeat an action whose response was lost. Cancellation also ends the wait.
function retryDelay(ms: number, signal?: AbortSignal | null) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

async function request(path: string, init?: RequestInit) {
  const generation = offlineGeneration();
  const session = ownerSession();
  const options: RequestInit = {
    ...init,
    headers: {
      ...(session ? { Authorization: `Bearer ${session}` } : {}),
      ...(init?.body && !(init.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...init?.headers,
    },
  };
  const read = ["GET", "HEAD"].includes((init?.method || "GET").toUpperCase());
  const delays = [250, 1000];
  for (let attempt = 0; ; attempt++) {
    let response: Response | undefined;
    try {
      const preloaded =
        attempt === 0 &&
        read &&
        !session &&
        path.startsWith("/api/open/") &&
        typeof window !== "undefined"
          ? window.__locdocOpen
          : undefined;
      if (preloaded) {
        window.__locdocOpen = undefined;
        response = (await preloaded)?.clone() || (await fetch(path, options));
      } else response = await fetch(path, options);
      stampOffline(response, generation);
    } catch (error) {
      if (!(error instanceof TypeError) || options.signal?.aborted || !read)
        throw error;
      if (attempt === delays.length) throw error;
    }
    if (
      response &&
      (!read || !proxyFailure(response) || attempt === delays.length)
    )
      return response;
    // Release an unused response before asking again, including proxy HTML.
    await response?.body?.cancel().catch(() => {});
    await retryDelay(delays[attempt], options.signal);
  }
}
// Reconnection must get a real permission/epoch answer. These callers must
// never mistake a cached response for the server accepting a command.
export async function onlineApi<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  return answer<T>(path, await request(path, init));
}

export async function api<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const network = apiRequest<T>(path, init);
  if (
    (init?.method || "GET").toUpperCase() !== "GET" ||
    !cacheableRead(path) ||
    navigator.onLine === false
  )
    return network;
  const local = cachedRead<T>(path)
    .catch(() => undefined)
    .then(async (cached) => {
      if (!cached) return network;
      // Wi-Fi can remain connected while the server is unreachable. Do not
      // make opening a downloaded document wait for a TCP timeout.
      await retryDelay(650, init?.signal);
      return projectRead(path, await projectComments(path, cached.body));
    });
  return Promise.race([network, local]);
}
async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const read = (init?.method || "GET").toUpperCase() === "GET";
  if (!read && offlineCacheEnabled()) {
    const form =
      (await queueUpload(path, init)) || (await queueComment(path, init));
    if (form?.handled) return form.result as T;
    const queued = await queueFileRequest(path, init, (command) =>
      request("/api/offline/file", send("POST", command)).then((response) =>
        answer("/api/offline/file", response),
      ),
    );
    if (queued?.handled) return queued.result as T;
  } else if (read && offlineCacheEnabled()) {
    const removed = await localDeletion(path).catch(() => undefined);
    if (removed)
      throw new ApiError("This document is in Recently deleted.", 410, {
        error: "trashed",
        ...removed,
      });
    const local = await localDocument(path).catch(() => undefined);
    if (local) return local as T;
  }
  try {
    if (
      read &&
      typeof navigator !== "undefined" &&
      navigator.onLine === false
    ) {
      const cached = await cachedRead<T>(path).catch(() => undefined);
      if (cached)
        return projectRead(path, await projectComments(path, cached.body));
    }
    const response = await request(path, init);
    if (read && proxyFailure(response)) {
      const cached = await cachedRead<T>(path).catch(() => undefined);
      if (cached)
        return projectRead(path, await projectComments(path, cached.body));
    }
    const body = await answer<T>(path, response);
    if (read)
      void cacheRead(path, body, response.headers.get("ETag") || "").catch(
        storageFailed,
      );
    return read && offlineCacheEnabled()
      ? projectRead(path, await projectComments(path, body))
      : body;
  } catch (error) {
    if (read && error instanceof TypeError && !init?.signal?.aborted) {
      const cached = await cachedRead<T>(path).catch(() => undefined);
      if (cached)
        return projectRead(path, await projectComments(path, cached.body));
    }
    if (
      error instanceof ApiError &&
      [401, 403, 404, 410].includes(error.status)
    )
      void invalidateRead(path).catch(storageFailed);
    throw error;
  }
}

// A response kept with the tag the server gave it.
export type Kept<T> = { path: string; tag: string; body: T };

// How a kept response takes in an answer that holds only what changed since
// it (RFC 3229 delta encoding): the instance manipulation asked for, and how
// such an answer applies to the kept body, or null when it does not.
export type Changes<T> = {
  manipulation: string;
  apply: (kept: T, changes: unknown) => T | null;
};

// A GET asked again with the tag of the response kept for it. The server
// answers 304, without a body, while that response is still current, and the
// kept one stands. A response kept for another path is never offered. With
// `changes`, a server that still has the kept response may answer 226 with
// only what changed since; one that does not apply is asked for again whole.
export async function revalidate<T>(
  path: string,
  kept: Kept<T> | null,
  { signal, changes }: { signal?: AbortSignal; changes?: Changes<T> } = {},
): Promise<Kept<T>> {
  try {
    const network = revalidateOnline(path, kept, { signal, changes });
    const local = cachedRead<T>(path)
      .catch(() => undefined)
      .then(async (cached) => {
        if (!cached) return network;
        await retryDelay(650, signal);
        return { path, tag: cached.tag, body: cached.body };
      });
    const held = await Promise.race([network, local]);
    const body = await projectRead(
      path,
      await projectComments(path, held.body),
    );
    return body === held.body ? held : { ...held, body, tag: "" };
  } catch (error) {
    if (error instanceof TypeError && !signal?.aborted) {
      const cached = await cachedRead<T>(path).catch(() => undefined);
      if (cached) return { path, tag: cached.tag, body: cached.body };
    }
    throw error;
  }
}
async function revalidateOnline<T>(
  path: string,
  kept: Kept<T> | null,
  { signal, changes }: { signal?: AbortSignal; changes?: Changes<T> },
): Promise<Kept<T>> {
  const held = kept?.path === path && kept.tag ? kept : null;
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    const cached = await cachedRead<T>(path).catch(() => undefined);
    if (cached) return { path, tag: cached.tag, body: cached.body };
  }
  const response = await request(path, {
    // The page keeps the copy itself; the HTTP cache stores nothing.
    cache: "no-store",
    signal,
    headers: held
      ? {
          "If-None-Match": held.tag,
          ...(changes ? { "A-IM": changes.manipulation } : {}),
        }
      : {},
  });
  if (held && response.status === 304) return held;
  if (proxyFailure(response)) {
    const cached = await cachedRead<T>(path).catch(() => undefined);
    if (cached) return { path, tag: cached.tag, body: cached.body };
  }
  if (response.status === 226) {
    const body =
      held &&
      changes &&
      response.headers.get("IM")?.trim() === changes.manipulation &&
      response.headers.get("Delta-Base") === held.tag
        ? changes.apply(held.body, await response.json().catch(() => null))
        : null;
    if (body === null) return revalidate(path, null, { signal });
    stampOffline(body, offlineStamp(response));
    const tag = response.headers.get("ETag") || "";
    void cacheRead(path, body, tag).catch(storageFailed);
    return { path, tag, body };
  }
  const body = await answer<T>(path, response);
  void cacheRead(path, body, response.headers.get("ETag") || "").catch(
    storageFailed,
  );
  return { path, tag: response.headers.get("ETag") || "", body };
}

async function answer<T>(path: string, response: Response): Promise<T> {
  let body;
  try {
    body = await response.json();
    stampOffline(body, offlineStamp(response));
  } catch {
    throw new ApiError(
      [502, 503, 504].includes(response.status)
        ? "The server is temporarily unavailable. Please try again."
        : `The server returned an unexpected response (${response.status}).`,
      response.status,
    );
  }
  // OAuth endpoints answer {error: code, error_description: message}.
  // A trashed document answers 410 with the code "trashed" and its trash item.
  if (!response.ok)
    throw new ApiError(
      response.status === 410 && body.error === "trashed"
        ? "This document is in Recently deleted."
        : body.error_description ||
            body.error ||
            `Request failed (${response.status}).`,
      response.status,
      body,
    );
  if ((path === "/api/login" || path === "/api/redeem") && body.session)
    rememberSession(body.session);
  if (path === "/api/logout") {
    rememberSession("");
    await logoutOffline().catch(storageFailed);
  }
  return body;
}
export function send(method: string, body?: unknown): RequestInit {
  return {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}
