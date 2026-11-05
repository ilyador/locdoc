import {
  documentCacheLock,
  offlineDelete,
  offlineGet,
  offlineKeys,
  offlineList,
  offlinePut,
  scopedKey,
  type OfflineScope,
} from "./offline-db.ts";
import { hasStoredDocumentDraft, pendingDraftDocuments } from "./drafts.ts";
import type { Entry } from "./model.ts";

const DAY = 86_400_000;
// Match Locdoc's trash grace period. Pending work and recovery copies always
// retain their bootstrap and media. Inspect keys/metadata, never load a whole
// workspace's video blobs just to decide what can expire.
export async function pruneOffline(
  scope: OfflineScope,
  files: Entry[],
  draftPrefix: string,
  now = Date.now(),
) {
  // Older browsers retain copies rather than racing an editor in another tab.
  if (typeof navigator === "undefined" || !navigator.locks) return;
  const lastKey = scopedKey(scope.scope, "pruned");
  const last = await offlineGet<number>("access", lastKey);
  if (last !== undefined && now - last < DAY) return;
  const live = new Set(files.flatMap((entry) => (entry.id ? [entry.id] : [])));
  const protectedDocs = new Set(await pendingDraftDocuments(draftPrefix, true));
  const protectedMedia = new Set<string>();
  for (const item of await offlineList<{
    document?: string;
    resource?: string;
    command?: { document: string; children: string[] };
    entries?: Entry[];
  }>("commands", `${scope.scope}|`)) {
    if (item.document) protectedDocs.add(item.document);
    if (item.resource) protectedMedia.add(item.resource);
    if (item.command?.document) protectedDocs.add(item.command.document);
    for (const id of item.command?.children || []) protectedDocs.add(id);
    for (const entry of item.entries || [])
      if (entry.id) protectedDocs.add(entry.id);
  }
  const media = new Set<string>();
  for (const id of live) {
    const ready = await offlineGet<{ media?: string[] }>(
      "access",
      scopedKey(scope.scope, `ready:${id}`),
    );
    for (const path of ready?.media || [])
      media.add(scopedKey(scope.scope, path));
  }
  const expire = async (
    kind: string,
    path: string,
    keep: boolean,
    remove: () => Promise<void>,
  ) => {
    const marker = scopedKey(scope.scope, `removed:${kind}:${path}`);
    if (keep) return offlineDelete("access", marker);
    const since = await offlineGet<number>("access", marker);
    if (since === undefined) await offlinePut("access", marker, now);
    else if (now - since >= 30 * DAY) {
      await remove();
      await offlineDelete("access", marker);
    }
  };
  for (const key of await offlineKeys("reads", `${scope.scope}|/api/docs/`)) {
    const path = key.slice(scope.scope.length + 1);
    const id = path.match(/^\/api\/docs\/([\da-f-]{36})(?:\?|$)/)?.[1];
    if (!id) continue;
    await navigator.locks.request(
      documentCacheLock(scope.scope, id),
      { ifAvailable: true },
      async (lease) => {
        if (!lease || (await hasStoredDocumentDraft(`${draftPrefix}/${id}`)))
          return;
        await expire(
          "doc",
          id,
          live.has(id) || protectedDocs.has(id),
          async () => {
            await offlineDelete(
              "reads",
              scopedKey(scope.scope, `/api/docs/${id}`),
              true,
            );
            await offlineDelete(
              "updates",
              scopedKey(scope.scope, `/api/docs/${id}`),
              true,
            );
            await offlineDelete(
              "access",
              scopedKey(scope.scope, `ready:${id}`),
            );
          },
        );
      },
    );
  }
  for (const key of await offlineKeys(
    "resources",
    `${scope.scope}|/api/docs/`,
  )) {
    const id = key
      .slice(scope.scope.length + 1)
      .match(/^\/api\/docs\/([\da-f-]{36})\/media\?/)?.[1];
    if (id)
      await navigator.locks.request(
        documentCacheLock(scope.scope, id),
        { ifAvailable: true },
        async (lease) => {
          if (lease && !(await hasStoredDocumentDraft(`${draftPrefix}/${id}`)))
            await expire(
              "media",
              key,
              protectedDocs.has(id) ||
                protectedMedia.has(key) ||
                media.has(key),
              () => offlineDelete("resources", key),
            );
        },
      );
  }
  await offlinePut("access", lastKey, now);
}
