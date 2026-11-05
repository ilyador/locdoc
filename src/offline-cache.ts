import {
  offlineAuthority,
  forgetOffline,
  offlineDelete,
  offlineGet,
  offlineList,
  offlinePut,
  offlineScope,
  offlineSlot,
  scopedKey,
  type CachedRead,
} from "./offline-db.ts";
import type { Document, Config } from "./model.ts";
import * as Y from "yjs";
import { acceptedUpdates, base64State } from "./offline-replica.ts";
import { pendingDraftDocuments } from "./drafts.ts";

type Open = Config & { document?: Document | null; entries?: unknown[] };
let enabled = false;
export const offlineCacheEnabled = () => enabled;
let generation = 0;
const generations = new WeakMap<object, string>();
let logoutNonce = "";
export const offlineGeneration = () => {
  try {
    logoutNonce = localStorage.getItem("locdoc.offlineLogout") || "";
  } catch {
    /* in-memory authority still works */
  }
  return `${generation}|${logoutNonce}`;
};
export function stampOffline(value: unknown, ticket: string) {
  if (value !== null && typeof value === "object")
    generations.set(value, ticket);
}
export const offlineStamp = (value: object) =>
  generations.get(value) ?? offlineGeneration();
let writes = Promise.resolve();
export const waitForOfflineCache = () => writes;
let warning = "";
const listeners = new Set<() => void>();
export const offlineWarning = () => warning;
export const watchOfflineWarning = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function storageFailed(error: unknown) {
  const quota =
    error instanceof DOMException && error.name === "QuotaExceededError";
  warning = quota
    ? "Device storage is full. The workspace is not fully available offline."
    : "Offline storage is unavailable. Keep this tab open until your edits reach the server.";
  for (const notify of listeners) notify();
}
const pageUrl = () => new URL(location.href);
const linkToken = () => pageUrl().pathname.match(/^\/s\/([^/]+)\/?$/)?.[1];
export const documentReadPath = (id: string) =>
  `/api/docs/${id}${linkToken() ? `?token=${encodeURIComponent(linkToken()!)}` : ""}`;
export const cacheableRead = (path: string) =>
  path === "/api/config" ||
  path === "/api/fonts" ||
  /^\/api\/(?:tree(?:\?|$)|open\/[^/]+(?:\?|$)|docs\/[\da-f-]+(?:\?|$|\/comments(?:\?|$)))/.test(
    path,
  );

export async function currentOfflineScope() {
  return offlineScope(pageUrl());
}

export async function cachedRead<T>(
  path: string,
  recovery = false,
): Promise<CachedRead<T> | undefined> {
  if (!cacheableRead(path)) return;
  const bootstrap = path === "/api/config" || path.startsWith("/api/open/");
  if (!enabled && !bootstrap) return;
  await writes;
  const current = await currentOfflineScope();
  if (!current) return;
  if (
    !recovery &&
    (await offlineGet("access", scopedKey(current.scope, `denied:${path}`)))
  )
    return;
  let held = await offlineGet<CachedRead<T>>(
    "reads",
    scopedKey(current.scope, path),
  );
  if (!held && path.startsWith("/api/open/"))
    held = await offlineGet<CachedRead<T>>(
      "reads",
      scopedKey(current.scope, path.split("?")[0]),
    );
  if (held && bootstrap && (held.body as Open).offlineScope) enabled = true;
  if (held && path.startsWith("/api/open/")) {
    const opened = held.body as Open;
    const selected = opened.folder
      ? new URL(path, location.origin).searchParams.get("doc") ||
        opened.document?.id
      : opened.document?.id;
    if (selected) {
      const doc = await cachedRead<Document>(documentReadPath(selected));
      if (!doc) return;
      return { ...held, body: { ...opened, document: doc.body } as T };
    }
  }
  if (held && /^\/api\/docs\/[\da-f-]+(?:\?|$)/.test(path)) {
    const doc = held.body as Document;
    if (doc.state) {
      const updates = await acceptedUpdates(
        current,
        path,
        doc.collaborationEpoch || "",
      );
      if (updates.length) {
        const replica = new Y.Doc();
        try {
          Y.applyUpdate(
            replica,
            Uint8Array.from(atob(doc.state), (n) => n.charCodeAt(0)),
          );
          for (const update of updates) Y.applyUpdate(replica, update);
          return {
            ...held,
            body: {
              ...doc,
              state: base64State(Y.encodeStateAsUpdate(replica)),
              content: replica.getText("content").toString(),
            } as T,
          };
        } finally {
          replica.destroy();
        }
      }
    }
  }
  return held;
}

// Kept responses are always whole application values, including after an
// HTTP delta. Never cache an authentication failure or an HTTP error page.
export async function cacheRead(path: string, body: unknown, tag = "") {
  if (!cacheableRead(path)) return;
  const bootstrap = path === "/api/config" || path.startsWith("/api/open/");
  if (bootstrap && (body as Open).offlineScope) enabled = true;
  if (!enabled) return;
  const ticket =
    body !== null && typeof body === "object"
      ? offlineStamp(body)
      : offlineGeneration();
  const operation = async () => {
    if (ticket !== offlineGeneration()) return;
    if (path === "/api/config" || path.startsWith("/api/open/")) {
      const config = body as Open;
      const slot = await offlineSlot(pageUrl());
      if (slot === "owner" && config.owner === false) {
        // An expired login locks access; it must not erase unsynced work.
        await offlineDelete("access", slot);
        return;
      }
      // Old servers/test fixtures without offlineScope stay entirely online.
      if (!config.offlineScope) return;
      const name =
        slot === "owner"
          ? config.offlineScope
          : `${config.offlineScope}.${slot}.${config.owner ? "owner" : "guest"}`;
      const previous = await offlineGet<string>("access", slot);
      if (previous && previous !== name)
        await offlinePut("access", `recovery:${previous}`, true);
      if (slot !== "owner") {
        if (config.owner) {
          await offlinePut("access", "owner", config.offlineScope);
          await offlinePut("access", `guard:${slot}`, config.offlineScope);
        } else await offlineDelete("access", `guard:${slot}`);
      }
      await offlinePut("access", slot, name);
    }
    const current = await currentOfflineScope();
    if (!current || ticket !== offlineGeneration()) return;
    const opened = body as Open;
    // The open response refers to the one document replica. Do not leave a
    // second, stale full-text copy hidden inside a sharing-link bootstrap.
    const heldBody =
      path.startsWith("/api/open/") && opened.document
        ? { ...opened, document: { id: opened.document.id } }
        : body;
    await offlinePut("reads", scopedKey(current.scope, path), {
      body: heldBody,
      tag,
      saved: Date.now(),
    });
    await offlineDelete("access", scopedKey(current.scope, `denied:${path}`));
    if (path.startsWith("/api/open/"))
      await offlinePut("reads", scopedKey(current.scope, path.split("?")[0]), {
        body: heldBody,
        tag,
        saved: Date.now(),
      });
    if (path.startsWith("/api/open/") && opened.document) {
      await offlinePut(
        "reads",
        scopedKey(current.scope, documentReadPath(opened.document.id)),
        {
          body: opened.document,
          tag: "",
          saved: Date.now(),
        },
      );
    }
  };
  const next = writes
    .catch(() => {})
    .then(() => (bootstrap ? offlineAuthority(operation) : operation()));
  writes = next.catch(storageFailed);
  await next;
}

export async function invalidateRead(path: string) {
  const current = await currentOfflineScope();
  if (current)
    await offlinePut(
      "access",
      scopedKey(current.scope, `denied:${path}`),
      true,
    );
}

export async function logoutOffline() {
  generation++;
  logoutNonce = crypto.randomUUID();
  try {
    localStorage.setItem("locdoc.offlineLogout", logoutNonce);
  } catch {
    /* local authority is still revoked */
  }
  await writes;
  await offlineAuthority(async () => {
    const owner = await offlineGet<string>("access", "owner");
    const commands = owner
      ? await offlineList<{ result?: unknown }>("commands", `${owner}|`)
      : [];
    if (
      commands.some((entry) => !entry.result) ||
      (await pendingDraftDocuments("owner")).length
    )
      await offlineDelete("access", "owner");
    else await forgetOffline("owner");
  });
  // A tab that was already open must stop using its in-memory authority too.
}
if (typeof window !== "undefined")
  window.addEventListener("storage", (event) => {
    if (event.key === "locdoc.offlineLogout") {
      generation++;
    }
  });
