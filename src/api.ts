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
      response = await fetch(path, options);
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

export async function api<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  return answer<T>(path, await request(path, init));
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
  const held = kept?.path === path && kept.tag ? kept : null;
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
  if (response.status === 226) {
    const body =
      held &&
      changes &&
      response.headers.get("IM")?.trim() === changes.manipulation &&
      response.headers.get("Delta-Base") === held.tag
        ? changes.apply(held.body, await response.json().catch(() => null))
        : null;
    if (body === null) return revalidate(path, null, { signal });
    return { path, tag: response.headers.get("ETag") || "", body };
  }
  const body = await answer<T>(path, response);
  return { path, tag: response.headers.get("ETag") || "", body };
}

async function answer<T>(path: string, response: Response): Promise<T> {
  let body;
  try {
    body = await response.json();
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
  if (path === "/api/logout") rememberSession("");
  return body;
}
export function send(method: string, body?: unknown): RequestInit {
  return {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}
