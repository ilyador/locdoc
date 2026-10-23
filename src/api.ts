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

function request(path: string, init?: RequestInit) {
  const session = ownerSession();
  return fetch(path, {
    ...init,
    headers: {
      ...(session ? { Authorization: `Bearer ${session}` } : {}),
      ...(init?.body && !(init.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...init?.headers,
    },
  });
}

export async function api<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  return answer<T>(path, await request(path, init));
}

// A response kept with the tag the server gave it.
export type Kept<T> = { path: string; tag: string; body: T };

// A GET asked again with the tag of the response kept for it. The server
// answers 304, without a body, while that response is still current, and the
// kept one stands. A response kept for another path is never offered.
export async function revalidate<T>(
  path: string,
  kept: Kept<T> | null,
): Promise<Kept<T>> {
  const held = kept?.path === path && kept.tag ? kept : null;
  const response = await request(path, {
    // The page keeps the copy itself; the HTTP cache stores nothing.
    cache: "no-store",
    headers: held ? { "If-None-Match": held.tag } : {},
  });
  if (held && response.status === 304) return held;
  const body = await answer<T>(path, response);
  return { path, tag: response.headers.get("ETag") || "", body };
}

async function answer<T>(path: string, response: Response): Promise<T> {
  const body = await response
    .json()
    .catch(() => ({ error: "The server returned an unexpected response." }));
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
