// Private workspace data lives here, never in the public app-shell cache.
// This module is also bundled into the service worker; it has no UI dependencies.
export type CachedRead<T = unknown> = { body: T; tag: string; saved: number };
export type CachedResource = {
  blob: Blob;
  type: string;
  version: string;
  pending?: boolean;
};
export type OfflineScope = { slot: string; scope: string };
type Store = "access" | "reads" | "resources" | "updates" | "commands";
let opening: Promise<IDBDatabase> | undefined;

function database() {
  return (opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("locdoc-offline-v1", 1);
    let settled = false;
    let remaining = 1500;
    let last = performance.now();
    // A suspended page or a busy startup must not outrun IndexedDB's answer.
    const timer = setInterval(() => {
      const now = performance.now();
      remaining -= Math.min(now - last, 100);
      last = now;
      if (remaining <= 0) fail(new Error("Offline storage did not open."));
    }, 100);
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      opening = undefined;
      reject(error);
    };
    request.onupgradeneeded = () => {
      for (const store of [
        "access",
        "reads",
        "resources",
        "updates",
        "commands",
      ])
        request.result.createObjectStore(store);
    };
    request.onerror = () => fail(request.error);
    request.onblocked = () =>
      fail(new Error("Close older Locdoc tabs to enable offline storage."));
    request.onsuccess = () => {
      if (settled) return request.result.close();
      settled = true;
      clearInterval(timer);
      request.result.onversionchange = () => {
        request.result.close();
        opening = undefined;
      };
      resolve(request.result);
    };
  }));
}

// Authority transitions serialize across tabs as well as local response queues.
export async function offlineAuthority<T>(
  operation: () => Promise<T>,
): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks)
    return navigator.locks.request("locdoc-offline-authority", operation);
  return operation();
}

function storageError(tx: IDBTransaction, event: Event) {
  return (
    tx.error ||
    (event.target as IDBRequest | null)?.error ||
    new Error("Offline storage could not complete the transaction.")
  );
}

// WebKit can reject Blob/File records in private browsing. Binary buffers use
// the same durable store without its separate Blob backing-file subsystem.
function unpack<T>(store: Store, value: T): T {
  if (
    store === "resources" &&
    value &&
    typeof value === "object" &&
    "bytes" in value
  ) {
    const { bytes, ...metadata } = value as unknown as Omit<
      CachedResource,
      "blob"
    > & { bytes: ArrayBuffer };
    return {
      ...metadata,
      blob: new Blob([bytes], { type: metadata.type }),
    } as T;
  }
  return value;
}

export async function offlineGet<T>(
  store: Store,
  key: string,
): Promise<T | undefined> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store);
    const request = transaction.objectStore(store).get(key);
    transaction.oncomplete = () => resolve(unpack(store, request.result));
    transaction.onabort = transaction.onerror = (event) =>
      reject(storageError(transaction, event));
  });
}

export async function offlinePut(store: Store, key: string, value: unknown) {
  if (store === "resources") {
    const { blob, ...metadata } = value as CachedResource;
    value = { ...metadata, bytes: await blob.arrayBuffer() };
  }
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(store, "readwrite", {
      durability: "strict",
    });
    transaction.objectStore(store).put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = (event) =>
      reject(storageError(transaction, event));
  });
}

export async function offlineDelete(store: Store, key: string, prefix = false) {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(store, "readwrite", {
      durability: "strict",
    });
    transaction
      .objectStore(store)
      .delete(prefix ? IDBKeyRange.bound(key, `${key}\uffff`) : key);
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = (event) =>
      reject(storageError(transaction, event));
  });
}
export async function offlineList<T>(
  store: Store,
  prefix: string,
): Promise<T[]> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store);
    const request = transaction
      .objectStore(store)
      .getAll(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
    transaction.oncomplete = () =>
      resolve(request.result.map((value: T) => unpack(store, value)));
    transaction.onabort = transaction.onerror = (event) =>
      reject(storageError(transaction, event));
  });
}
export async function offlineKeys(
  store: Store,
  prefix: string,
): Promise<string[]> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store);
    const read = tx
      .objectStore(store)
      .getAllKeys(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
    tx.oncomplete = () => resolve(read.result.map(String));
    tx.onabort = tx.onerror = (event) => reject(storageError(tx, event));
  });
}
export async function offlineBatch(entries: { key: string; value: unknown }[]) {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("commands", "readwrite", {
      durability: "strict",
    });
    for (const { key, value } of entries)
      tx.objectStore("commands").put(value, key);
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = (event) => reject(storageError(tx, event));
  });
}
export const documentCacheLock = (scope: string, id: string) =>
  `locdoc-document-cache:${scope}:${id}`;
export function holdDocumentCache(scope: string, id: string) {
  let enter!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  if (typeof navigator === "undefined" || !navigator.locks) enter();
  else
    void navigator.locks
      .request(documentCacheLock(scope, id), { mode: "shared" }, async () => {
        enter();
        await held;
      })
      .catch(enter);
  return { ready, release };
}
export async function enqueueOffline<T extends object>(
  scope: string,
  value: T,
  quota?: { document: string; usage: number; bytes: number },
): Promise<T & { key: string; reservedUsage?: number }> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["access", "commands"], "readwrite", {
      durability: "strict",
    });
    const counter = `sequence|${scope}`;
    const read = tx.objectStore("access").get(counter);
    let queued: T & { key: string; reservedUsage?: number };
    let refusal: Error | undefined;
    read.onsuccess = () => {
      const next = Number(read.result || 0) + 1;
      const key = `${scope}|${String(next).padStart(16, "0")}`;
      const commit = (baseUsage?: number, reservedUsage?: number) => {
        queued = {
          ...value,
          key,
          ...(quota ? { baseUsage, reservedUsage } : {}),
        };
        tx.objectStore("access").put(next, counter);
        tx.objectStore("commands").put(queued, key);
      };
      if (!quota) return commit();
      const held = tx
        .objectStore("commands")
        .getAll(IDBKeyRange.bound(`${scope}|`, `${scope}|\uffff`));
      held.onsuccess = () => {
        const uploads = held.result.filter(
          (item) => item.type === "upload" && item.document === quota.document,
        );
        const baseUsage = uploads[0]?.baseUsage ?? quota.usage;
        const reservedUsage =
          Math.max(
            quota.usage,
            baseUsage + uploads.reduce((sum, item) => sum + item.bytes, 0),
          ) + quota.bytes;
        if (reservedUsage > 50_000_000) {
          refusal = new Error(
            "This document would exceed its 50 MB attachment limit. Reconnect to refresh usage after removing attachments.",
          );
          tx.abort();
          return;
        }
        commit(baseUsage, reservedUsage);
      };
    };
    tx.oncomplete = () => resolve(queued);
    tx.onabort = tx.onerror = (event) =>
      reject(refusal || storageError(tx, event));
  });
}
export async function appendAcceptedUpdate(
  prefix: string,
  update: Uint8Array,
  merge: (updates: Uint8Array[]) => Uint8Array,
) {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("updates", "readwrite", { durability: "strict" });
    const store = tx.objectStore("updates");
    const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
    store.put(update, `${prefix}${crypto.randomUUID()}`);
    const count = store.count(range);
    count.onsuccess = () => {
      if (count.result < 128) return;
      const read = store.getAll(range);
      read.onsuccess = () => {
        try {
          const compacted = merge(read.result);
          // Read, merge and replace are one transaction, including across tabs.
          store.delete(range);
          store.put(compacted, `${prefix}compacted`);
        } catch {
          tx.abort();
        }
      };
    };
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () =>
      reject(
        tx.error || new Error("Could not retain accepted document updates."),
      );
  });
}

// Cache scopes use a hash of the token. Owner and every sharing link have
// independent caches, even when the owner opens their own sharing link.
export async function offlineSlot(url: URL) {
  const token = url.pathname.match(/^\/s\/([^/]+)\/?$/)?.[1];
  if (!token) return "owner";
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return `link.${Array.from(new Uint8Array(hash), (n) => n.toString(16).padStart(2, "0")).join("")}`;
}

export async function offlineScope(
  url: URL,
): Promise<OfflineScope | undefined> {
  const slot = await offlineSlot(url);
  const scope = await offlineGet<string>("access", slot);
  const owner = await offlineGet<string>("access", `guard:${slot}`);
  if (owner && (await offlineGet<string>("access", "owner")) !== owner) return;
  return scope ? { slot, scope } : undefined;
}

export const scopedKey = (scope: string, path: string) => `${scope}|${path}`;

// Credentials and cache-busting parameters are not a resource's identity.
// The caller's scope supplies authorization; paths remain document-specific.
export function resourcePath(url: URL) {
  if (/^\/api\/docs\/[\da-f-]+\/media$/.test(url.pathname))
    return `${url.pathname}?${new URLSearchParams({ path: url.searchParams.get("path") || "" })}`;
  return url.pathname;
}

export async function forgetOffline(slot: string) {
  const scope = await offlineGet<string>("access", slot);
  // Remove authority first. A failing cleanup can never leave data readable.
  await offlineDelete("access", slot);
  await offlineDelete("access", `guard:${slot}`);
  if (scope) {
    await offlineDelete("access", `${scope}|`, true);
    await offlineDelete("reads", `${scope}|`, true);
    await offlineDelete("resources", `${scope}|`, true);
    await offlineDelete("updates", `${scope}|`, true);
    await offlineDelete("commands", `${scope}|`, true);
  }
}
