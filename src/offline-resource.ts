import type { CachedResource } from "./offline-db.ts";

export function resourceResponse(resource: CachedResource, request: Request) {
  const headers = new Headers({
    "Content-Type": resource.type,
    "Content-Length": String(resource.blob.size),
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  const range = request.headers.get("Range");
  if (!range)
    return new Response(request.method === "HEAD" ? null : resource.blob, {
      headers,
    });
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  const size = resource.blob.size;
  let start = match?.[1]
    ? Number(match[1])
    : Math.max(0, size - Number(match?.[2]));
  let end =
    match?.[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (
    !match ||
    (!match[1] && !match[2]) ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start >= size ||
    start > end ||
    end < 0
  ) {
    headers.set("Content-Range", `bytes */${size}`);
    headers.set("Content-Length", "0");
    return new Response(null, { status: 416, headers });
  }
  headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  headers.set("Content-Length", String(end - start + 1));
  return new Response(
    request.method === "HEAD" ? null : resource.blob.slice(start, end + 1),
    { status: 206, headers },
  );
}
