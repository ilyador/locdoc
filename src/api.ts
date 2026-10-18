export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
export async function api<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...init?.headers,
    },
  });
  const body = await response
    .json()
    .catch(() => ({ error: "The server returned an unexpected response." }));
  if (!response.ok)
    throw new ApiError(
      body.error || `Request failed (${response.status}).`,
      response.status,
    );
  return body;
}
export function send(method: string, body?: unknown): RequestInit {
  return {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}
