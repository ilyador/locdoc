/// <reference lib="webworker" />
import {
  offlineDelete,
  offlineGet,
  offlinePut,
  offlineScope,
  resourcePath,
  scopedKey,
  type CachedResource,
} from "./offline-db.ts";
import { resourceResponse } from "./offline-resource.ts";
declare const self: ServiceWorkerGlobalScope;
declare const __LOCDOC_OFFLINE_BUILD__: string;
const shell = `locdoc-shell-${__LOCDOC_OFFLINE_BUILD__}`;
const offlinePage = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const response = await fetch("/offline-manifest.json", {
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Offline asset list is unavailable.");
      const { files } = (await response.json()) as { files: string[] };
      const cache = await caches.open(shell);
      try {
        // Bound fetches so installation does not starve the editor's requests.
        let next = 0;
        await Promise.all(
          Array.from({ length: 3 }, async () => {
            while (next < files.length) {
              const path = files[next++];
              const item = await fetch(path, { cache: "reload" });
              if (!item.ok) throw new Error(`Could not cache ${path}`);
              await cache.put(path, item);
            }
          }),
        );
      } catch (error) {
        await caches.delete(shell);
        throw error;
      }
      // An update waits for old tabs to close; never replace their runtime.
    })(),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const old = (await caches.keys()).filter(
        (name) => name.startsWith("locdoc-shell-") && name !== shell,
      );
      for (const name of old.slice(0, -1)) await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});

async function resource(
  request: Request,
  clientId: string,
  retain: (task: Promise<unknown>) => void,
) {
  const url = new URL(request.url);
  const client = await self.clients.get(clientId);
  const scope = client
    ? await offlineScope(new URL(client.url)).catch(() => undefined)
    : undefined;
  const key = scope ? scopedKey(scope.scope, resourcePath(url)) : "";
  const pending = key
    ? await offlineGet<CachedResource>("resources", key).catch(() => undefined)
    : undefined;
  if (pending?.pending) return resourceResponse(pending, request);
  try {
    const response = await fetch(request, {
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(2500)]),
    });
    const type = response.headers.get("Content-Type")?.split(";")[0] || "";
    if (
      key &&
      response.status === 200 &&
      Number(response.headers.get("Content-Length") || 0) <= 20_000_000 &&
      /^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm|quicktime)|font\/[\w.+-]+|application\/(font-woff|octet-stream)|text\/css)$/.test(
        type,
      )
    ) {
      const copy = response.clone();
      retain(
        copy
          .blob()
          .then(async (blob) => {
            if (blob.size <= 20_000_000)
              await offlinePut("resources", key, {
                blob,
                type,
                version: pending?.version || "runtime",
              });
          })
          .catch(() => {}),
      );
    }
    if ([401, 403, 404, 410].includes(response.status) && key)
      await offlineDelete("resources", key).catch(() => {});
    if (![502, 503, 504].includes(response.status)) return response;
    if (!key) return response;
    const cached = await offlineGet<CachedResource>("resources", key).catch(
      () => undefined,
    );
    return cached ? resourceResponse(cached, request) : response;
  } catch (error) {
    const cached = key
      ? await offlineGet<CachedResource>("resources", key).catch(
          () => undefined,
        )
      : undefined;
    if (cached) return resourceResponse(cached, request);
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (
    url.origin !== self.location.origin ||
    !["GET", "HEAD"].includes(request.method)
  )
    return;
  if (request.mode === "navigate") {
    // Never cache personalized HTML or API replies in the public shell.
    if (!/^\/(?:d\/[\da-f-]+\/?|s\/[^/]+\/?)?$/.test(url.pathname)) return;
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request, {
            signal: AbortSignal.any([
              request.signal,
              AbortSignal.timeout(2500),
            ]),
          });
          if (![502, 503, 504].includes(response.status)) return response;
        } catch {
          /* the installed public shell also works without a server */
        }
        const cache = await caches.open(shell);
        return (
          (await cache.match(offlinePage)) ||
          (await caches.match(offlinePage)) ||
          Response.error()
        );
      })(),
    );
  } else if (
    /^\/api\/docs\/[\da-f-]+\/media$/.test(url.pathname) ||
    url.pathname === "/api/fonts.css" ||
    url.pathname.startsWith("/fonts/")
  ) {
    event.respondWith(
      resource(request, event.clientId, (task) => event.waitUntil(task)),
    );
  } else if (
    url.pathname.startsWith("/assets/") ||
    url.pathname === "/theme.js" ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/manifest.webmanifest" ||
    url.pathname === "/font-catalog.json"
  ) {
    event.respondWith(
      (async () => {
        // Old hashed chunks remain usable by tabs from the previous release.
        const cache = await caches.open(shell);
        const cached =
          (await cache.match(url.pathname)) ||
          (await caches.match(url.pathname));
        return cached || fetch(request);
      })(),
    );
  }
});
