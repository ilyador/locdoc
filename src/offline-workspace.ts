import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { onlineApi, send, decodeState, ApiError } from "./api.ts";
import {
  cachedRead,
  cacheRead,
  currentOfflineScope,
  documentReadPath,
  storageFailed,
  offlineWarning,
  watchOfflineWarning,
} from "./offline-cache.ts";
import {
  offlineDelete,
  offlineGet,
  offlinePut,
  resourcePath,
  scopedKey,
  documentCacheLock,
  type CachedRead,
  type CachedResource,
} from "./offline-db.ts";
import {
  queuedFiles,
  finishFile,
  changedOfflineFiles,
  notifyOfflinePeers,
  type QueuedFile,
} from "./offline-files.ts";
import {
  DraftJournal,
  flushOpenDrafts,
  pendingDraftDocuments,
  hasOpenDraft,
  textHash,
} from "./drafts.ts";
import { base64State } from "./offline-replica.ts";
import { mediaUrl } from "./markdown-widgets.ts";
import {
  queuedActions,
  runAction,
  type FormAction,
} from "./offline-actions.ts";
import { pruneOffline } from "./offline-retention.ts";
import {
  sharedToken,
  type Config,
  type Document,
  type Entry,
} from "./model.ts";

export type OfflineStatus = {
  message: string;
  detail: string;
  busy: boolean;
  problems: QueuedFile[];
};
const initial: OfflineStatus = {
  message: "Preparing offline access…",
  detail: "Documents and media download automatically on this device.",
  busy: true,
  problems: [],
};
let shell: Promise<ServiceWorkerRegistration> | undefined;
let nextRead = 0;
async function paceBackground(signal: AbortSignal) {
  const delay = Math.max(0, nextRead - performance.now());
  nextRead = Math.max(nextRead, performance.now()) + 200;
  if (delay)
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, delay);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  signal.throwIfAborted();
}
async function prefetch<T>(path: string, signal: AbortSignal) {
  await paceBackground(signal);
  return onlineApi<T>(path, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
}
export function installOfflineShell() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  return (shell ??= navigator.serviceWorker
    .register("/sw.js", { type: "module", updateViaCache: "none" })
    .then(() => navigator.serviceWorker.ready));
}

async function syncDraft(id: string, prefix: string, signal: AbortSignal) {
  const path = documentReadPath(id);
  const doc = await prefetch<Document>(path, signal);
  await cacheRead(path, doc);
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, decodeState(doc.state));
  const drafts = new DraftJournal(ydoc, `${prefix}/${id}`);
  try {
    if (!doc.edit && !doc.diskConflict) {
      await drafts.preserveReadOnly(
        "Editing access changed while you were offline. Your draft is kept for download.",
        {
          collaborationEpoch: doc.collaborationEpoch,
          lineEndingMigrated: doc.lineEndingMigrated,
        },
      );
      throw new Error(`Open ${doc.path} to download its offline draft.`);
    }
    await drafts.restore(doc.edit && !doc.diskConflict, {
      collaborationEpoch: doc.collaborationEpoch,
      lineEndingMigrated: doc.lineEndingMigrated,
    });
    if (drafts.recoveries.length)
      throw new Error(`Open ${doc.path} to review a recovered offline draft.`);
    if (!drafts.pending) return;
    if (!doc.edit || doc.diskConflict)
      throw new Error(`Open ${doc.path} to review its offline changes.`);
    drafts.bind("server");
    await paceBackground(signal);
    const result = await onlineApi<Document>(
      `/api/docs/${id}/offline${sharedToken ? `?token=${encodeURIComponent(sharedToken)}` : ""}`,
      send("POST", {
        epoch: doc.collaborationEpoch || "",
        update: base64State(Y.encodeStateAsUpdate(ydoc)),
      }),
    );
    await cacheRead(path, result);
    if (result.diskPending || result.diskSaving || result.diskConflict)
      throw new ApiError(`Waiting for the desktop file: ${doc.path}`, 503);
    const receipt = drafts.checkpoint();
    if (receipt) await drafts.acknowledge(receipt);
  } finally {
    drafts.dispose();
    ydoc.destroy();
  }
}

const transient = (error: unknown) =>
  error instanceof TypeError ||
  (error instanceof ApiError && (error.status >= 500 || error.status === 429));

export async function reconnectFiles(
  prefix: string,
  refresh: () => Promise<void>,
  report: (queue: QueuedFile[]) => void,
  signal: AbortSignal,
  visibleIds: Set<string>,
): Promise<string[]> {
  await flushOpenDrafts();
  const pending = await queuedFiles();
  const forms = await queuedActions();
  const errors: string[] = [];
  const processForms = async (ids: string[], type: FormAction["type"]) => {
    for (const action of await queuedActions()) {
      if (
        action.type !== type ||
        action.result ||
        !ids.includes(action.document)
      )
        continue;
      if (action.error) throw new Error(action.error);
      try {
        await paceBackground(signal);
        await runAction(action, onlineApi);
      } catch (error) {
        if (!transient(error))
          await offlinePut("commands", action.key, {
            ...action,
            error: (error as Error).message,
          });
        throw error;
      }
    }
  };
  for (const entry of pending) {
    if (entry.result) continue;
    if (entry.error) {
      report(pending);
      return [entry.error];
    }
    try {
      const { command } = entry;
      const ids =
        command.kind.includes("file") && !command.kind.startsWith("create")
          ? [command.document]
          : command.children;
      const drafts = new Set(await pendingDraftDocuments(prefix));
      await processForms(ids, "upload");
      for (const id of ids)
        if (drafts.has(id)) await syncDraft(id, prefix, signal);
      await processForms(ids, "comment");
      await paceBackground(signal);
      await finishFile(
        entry,
        await onlineApi<QueuedFile["result"]>(
          "/api/offline/file",
          send("POST", command),
        ),
      );
    } catch (error) {
      if (transient(error)) throw error;
      await offlinePut("commands", entry.key, {
        ...entry,
        error: (error as Error).message,
      });
      report(await queuedFiles());
      // Later namespace actions may depend on this path. Downloading and
      // live text editing on other documents can still proceed.
      return [(error as Error).message];
    }
  }
  const deleted = new Set(
    pending
      .filter((entry) => entry.command.kind.startsWith("delete"))
      .flatMap((entry) =>
        entry.entries.flatMap((item) => (item.id ? [item.id] : [])),
      ),
  );
  const formDocuments = new Set(forms.map((item) => item.document));
  const drafts = new Set(await pendingDraftDocuments(prefix));
  const ids = new Set([
    ...formDocuments,
    ...[...drafts].filter(
      (id) => visibleIds.has(id) && !hasOpenDraft(`${prefix}/${id}`),
    ),
  ]);
  for (const id of ids) {
    if (deleted.has(id)) continue;
    try {
      await processForms([id], "upload");
      if (drafts.has(id)) await syncDraft(id, prefix, signal);
      await processForms([id], "comment");
      if (formDocuments.has(id)) {
        const path = `${documentReadPath(id).split("?")[0]}/comments${sharedToken ? `?token=${encodeURIComponent(sharedToken)}` : ""}`;
        await cacheRead(path, await prefetch(path, signal));
        await cacheRead(
          documentReadPath(id),
          await prefetch(documentReadPath(id), signal),
        );
      }
    } catch (error) {
      if (transient(error)) throw error;
      // A refused comment/upload or a retired draft cannot stop another
      // document's queue or prevent the workspace from downloading.
      errors.push((error as Error).message);
    }
  }
  if (pending.length) {
    await cacheRead(
      "/api/tree",
      await prefetch<{ entries: Entry[] }>("/api/tree", signal),
    );
    for (const entry of pending) await offlineDelete("commands", entry.key);
    await refresh();
    changedOfflineFiles();
  }
  for (const action of forms) {
    const current = await offlineGet<FormAction>("commands", action.key);
    // Failed or still pending forms retain their only durable copy.
    if (current?.result) await offlineDelete("commands", action.key);
  }
  report([]);
  return errors;
}

async function downloadResource(
  scope: string,
  url: string,
  version: string,
  bytes: number | undefined,
  signal: AbortSignal,
) {
  const request = new URL(url, location.origin);
  if (
    request.origin !== location.origin ||
    !(
      /^\/api\/docs\/[\da-f-]+\/media$/.test(request.pathname) ||
      request.pathname.startsWith("/fonts/") ||
      request.pathname === "/api/fonts.css"
    )
  )
    throw new Error("Invalid offline resource.");
  const key = scopedKey(scope, resourcePath(request));
  const old = await offlineGet<CachedResource>("resources", key);
  if (old?.version === version) return old;
  await paceBackground(signal);
  const response = await fetch(request, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  if (!response.ok)
    throw new Error(`Could not download an attachment (${response.status}).`);
  const type = response.headers.get("Content-Type")?.split(";")[0] || "";
  if (
    !/^(?:image\/(?:png|jpeg|gif|webp|avif)|video\/(?:mp4|webm|quicktime)|font\/[\w.+-]+|application\/(?:font-woff|octet-stream)|text\/css)$/.test(
      type,
    )
  )
    throw new Error("The offline download returned an unsupported file type.");
  const blob = await response.blob();
  if ((bytes !== undefined && blob.size !== bytes) || blob.size > 20_000_000)
    throw new Error(
      "An attachment changed during download. It will be retried.",
    );
  const value = { blob, type, version };
  await offlinePut("resources", key, value);
  return value;
}

export function useOfflineWorkspace(
  config: Config | null,
  entries: Entry[],
  refresh: () => Promise<void>,
  initialDocument: Document | null,
) {
  const [status, setStatus] = useState(initial);
  const [warning, setWarning] = useState(offlineWarning);
  const listing =
    sharedToken && !config?.folder && initialDocument
      ? [
          {
            id: initialDocument.id,
            path: initialDocument.path,
            kind: "file" as const,
            shared: true,
            modified: initialDocument.modified,
          },
        ]
      : entries;
  const latest = useRef(listing);
  latest.current = listing;
  const kick = useRef(() => {});
  useEffect(() => watchOfflineWarning(() => setWarning(offlineWarning())), []);
  useEffect(() => {
    kick.current();
  }, [entries]);
  useEffect(() => {
    if (!config?.offlineScope) return;
    const installed = installOfflineShell();
    if (!installed) {
      setStatus({
        message: "Offline access unavailable",
        detail: "Use HTTPS and a browser with service worker support.",
        busy: false,
        problems: [],
      });
      return;
    }
    const abort = new AbortController();
    let running = false;
    let rerun = false;
    let fontsChecked = 0;
    let retryDelay = 1000;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const update = (value: Partial<OfflineStatus>) => {
      if (!abort.signal.aborted)
        setStatus((previous) => ({ ...previous, ...value }));
    };
    let replaying: Promise<void> | undefined;
    let replayAgain = false;
    let replayErrors: string[] = [];
    const prefix = config.owner ? "owner" : textHash(sharedToken || "guest");
    const drain = () =>
      (replaying ??= (async () => {
        do {
          replayAgain = false;
          if (navigator.onLine === false || abort.signal.aborted) return;
          const scope = await currentOfflineScope();
          if (!scope) return;
          const apply = async () => {
            replayErrors = await reconnectFiles(
              await prefix,
              refresh,
              (queue) =>
                update({ problems: queue.filter((item) => !!item.error) }),
              abort.signal,
              new Set(
                latest.current.flatMap((entry) => (entry.id ? [entry.id] : [])),
              ),
            );
          };
          if (navigator.locks)
            await navigator.locks.request(
              `locdoc-offline-${scope.scope}`,
              { signal: abort.signal },
              apply,
            );
          else await apply();
        } while (replayAgain);
      })().finally(() => {
        replaying = undefined;
      }));
    const run = async () => {
      if (abort.signal.aborted) return;
      if (running) {
        rerun = true;
        return;
      }
      running = true;
      clearTimeout(retry);
      let failed = false;
      try {
        await installed;
        const scope = await currentOfflineScope();
        if (!scope) return;
        await drain();
        const lock = async () => {
          let downloaded = false;
          const files = latest.current.filter(
            (entry) => entry.kind === "file" && entry.id,
          );
          if (config.owner && !sharedToken) {
            const tree = await cachedRead<{ entries: Entry[] }>("/api/tree");
            // Config can arrive before the initial listing; zero documents
            // must mean an empty workspace, not a listing still in flight.
            if (!tree) return;
          }
          let completed = 0;
          const prior = await offlineGet(
            "access",
            scopedKey(scope.scope, "ready"),
          );
          const held = await navigator.locks?.query();
          const active = new Set(held?.held?.map((lock) => lock.name) || []);
          if (!prior)
            update({
              busy: true,
              message: "Preparing offline access…",
              detail: `0 of ${files.length} documents, including media`,
            });
          let next = 0;
          // Two downloads at most; an editing socket keeps its own priority.
          await Promise.all(
            Array.from({ length: 2 }, async () => {
              while (next < files.length && !abort.signal.aborted) {
                const entry = files[next++];
                const key = scopedKey(scope.scope, `ready:${entry.id}`);
                const ready = await offlineGet<{
                  modified?: number;
                  version?: string;
                  path: string;
                  media?: string[];
                  checked?: number;
                }>("access", key);
                if (
                  ready?.version !== entry.offlineVersion ||
                  ready?.modified !== entry.modified ||
                  ready?.path !== entry.path ||
                  !ready?.media ||
                  (!!ready.media.length &&
                    Date.now() - (ready.checked || 0) > 60_000)
                ) {
                  downloaded = true;
                  const path = documentReadPath(entry.id!);
                  const stored = active.has(
                    documentCacheLock(scope.scope, entry.id!),
                  )
                    ? await offlineGet<CachedRead<Document>>(
                        "reads",
                        scopedKey(scope.scope, path),
                      )
                    : undefined;
                  let doc: Document;
                  if (stored) {
                    const url = new URL(path, location.origin);
                    const meta = await prefetch<
                      Omit<Document, "state" | "content">
                    >(`${url.pathname}/offline${url.search}`, abort.signal);
                    if (
                      meta.collaborationEpoch === stored.body.collaborationEpoch
                    ) {
                      doc = { ...stored.body, ...meta };
                      // A live replica already persists accepted text as deltas.
                      // Do not rewrite its multi-megabyte bootstrap on every poll.
                      if (
                        Object.entries(meta).some(
                          ([name, value]) =>
                            name !== "modified" &&
                            JSON.stringify(
                              stored.body[name as keyof Document],
                            ) !== JSON.stringify(value),
                        )
                      )
                        await cacheRead(path, doc);
                    } else {
                      doc = await prefetch<Document>(path, abort.signal);
                      await cacheRead(path, doc);
                    }
                  } else {
                    doc = await prefetch<Document>(path, abort.signal);
                    await cacheRead(path, doc);
                  }
                  const commentsPath = `${path.split("?")[0]}/comments${sharedToken ? `?token=${encodeURIComponent(sharedToken)}` : ""}`;
                  await cacheRead(
                    commentsPath,
                    await prefetch(commentsPath, abort.signal),
                  );
                  for (const media of doc.offlineMedia || [])
                    await downloadResource(
                      scope.scope,
                      mediaUrl(
                        doc.id,
                        media.path,
                        doc.mediaToken || sharedToken,
                      ),
                      media.version,
                      media.bytes,
                      abort.signal,
                    );
                  await offlinePut("access", key, {
                    modified: entry.modified,
                    version: entry.offlineVersion,
                    path: entry.path,
                    checked: Date.now(),
                    media: (doc.offlineMedia || []).map((item) =>
                      resourcePath(
                        new URL(mediaUrl(doc.id, item.path), location.origin),
                      ),
                    ),
                  });
                }
                completed++;
                if (!prior)
                  update({
                    detail: `${completed} of ${files.length} documents, including media`,
                  });
              }
            }),
          );
          if (
            navigator.onLine !== false &&
            Date.now() - fontsChecked > 60_000
          ) {
            const fonts = await prefetch("/api/fonts", abort.signal);
            await cacheRead("/api/fonts", fonts);
            await paceBackground(abort.signal);
            const cssResponse = await fetch("/api/fonts.css", {
              signal: abort.signal,
            });
            if (!cssResponse.ok)
              throw new Error("Could not download installed fonts.");
            const css = await cssResponse.text();
            for (const match of css.matchAll(
              /url\(['"]?(\/fonts\/[^)'"\s]+)['"]?\)/g,
            ))
              await downloadResource(
                scope.scope,
                match[1],
                match[1],
                undefined,
                abort.signal,
              );
            await offlinePut(
              "resources",
              scopedKey(scope.scope, "/api/fonts.css"),
              {
                blob: new Blob([css], { type: "text/css" }),
                type: "text/css",
                version: css,
              },
            );
            fontsChecked = Date.now();
            downloaded = true;
          }
          update({
            busy: false,
            message: replayErrors.length
              ? "Offline changes need review"
              : navigator.onLine === false
                ? "Offline · workspace ready"
                : "Available offline",
            detail:
              replayErrors[0] ||
              `${files.length} documents and their media are stored on this device.`,
          });
          await pruneOffline(scope, files, await prefix);
          await offlinePut("access", scopedKey(scope.scope, "ready"), {
            total: files.length,
            ids: files.map((file) => file.id),
            updated: Date.now(),
          });
          if (
            !(await offlineGet("access", scopedKey(scope.scope, "persistent")))
          ) {
            await navigator.storage?.persist?.().catch(() => false);
            await offlinePut(
              "access",
              scopedKey(scope.scope, "persistent"),
              true,
            );
          }
          if (downloaded || !prior) notifyOfflinePeers();
        };
        if (navigator.locks)
          await navigator.locks.request(
            `locdoc-offline-download-${scope.scope}`,
            { ifAvailable: true },
            (available) => (available ? lock() : undefined),
          );
        else await lock();
        retryDelay = 1000;
      } catch (error) {
        failed = true;
        if (abort.signal.aborted) return;
        const scope = await currentOfflineScope().catch(() => undefined);
        const ready = scope
          ? await offlineGet<{ ids: string[] }>(
              "access",
              scopedKey(scope.scope, "ready"),
            ).catch(() => undefined)
          : undefined;
        const created = (await queuedFiles().catch(() => []))
          .filter((entry) => entry.command.kind === "create-file")
          .map((entry) => entry.command.document);
        const complete =
          ready &&
          latest.current
            .filter((entry) => entry.kind === "file")
            .every(
              (entry) =>
                ready.ids?.includes(entry.id!) || created.includes(entry.id!),
            );
        const offline =
          error instanceof TypeError || navigator.onLine === false;
        update({
          busy: false,
          message:
            offline && complete
              ? "Offline · workspace ready"
              : offline
                ? "Offline download incomplete"
                : "Offline access needs attention",
          detail: offline
            ? complete
              ? "Edits are saved on this device and sync when reconnected."
              : "Reconnect to finish downloading this workspace."
            : (error as Error).message,
        });
        if (
          error instanceof DOMException &&
          ["QuotaExceededError", "InvalidStateError", "UnknownError"].includes(
            error.name,
          )
        )
          storageFailed(error);
      } finally {
        running = false;
        if (!abort.signal.aborted) {
          if (rerun) {
            rerun = false;
            void run();
          } else {
            retry = setTimeout(run, failed ? retryDelay : 60_000);
            if (failed) retryDelay = Math.min(retryDelay * 2, 30_000);
          }
        }
      }
    };
    const start = () => {
      replayAgain = true;
      // Replay stays responsive even while this window downloads a large workspace.
      void drain().catch((error) => {
        if (!abort.signal.aborted)
          update({
            message: "Offline changes waiting",
            detail: (error as Error).message,
          });
      });
      void run();
    };
    kick.current = start;
    window.addEventListener("online", start);
    window.addEventListener("offline", start);
    window.addEventListener("locdoc-offline-files", start);
    const visible = () => {
      if (!document.hidden) start();
    };
    document.addEventListener("visibilitychange", visible);
    start();
    return () => {
      abort.abort();
      clearTimeout(retry);
      kick.current = () => {};
      window.removeEventListener("online", start);
      window.removeEventListener("offline", start);
      window.removeEventListener("locdoc-offline-files", start);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [config?.offlineScope, config?.owner, refresh]);
  return { ...status, warning, retry: () => kick.current() };
}
