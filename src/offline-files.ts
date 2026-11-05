import {
  enqueueOffline,
  offlineDelete,
  offlineGet,
  offlineList,
  offlinePut,
  scopedKey,
} from "./offline-db.ts";
import {
  cachedRead,
  currentOfflineScope,
  cacheRead,
  offlineCacheEnabled,
} from "./offline-cache.ts";
import { documentFormat } from "./document-format.ts";
import { flushOpenDrafts, pendingDraftDocuments } from "./drafts.ts";
import type { Document, Entry, TrashItem } from "./model.ts";

export type FileCommand = {
  id: string;
  kind: string;
  document: string;
  from: string;
  path: string;
  identity: string;
  children: string[];
};
export type QueuedFile = {
  key: string;
  command: FileCommand;
  entries: Entry[];
  created: number;
  error?: string;
  result?: { id?: string; path?: string; identity?: string; trash?: TrashItem };
};
const notifyLocal = () => {
  if (typeof window !== "undefined")
    window.dispatchEvent(new window.Event("locdoc-offline-files"));
};
export const notifyOfflinePeers = () => {
  try {
    localStorage.setItem("locdoc.offlineChange", crypto.randomUUID());
  } catch {
    /* local work still wakes its own window */
  }
};
export const changedOfflineFiles = () => {
  notifyLocal();
  notifyOfflinePeers();
};
if (typeof window !== "undefined")
  window.addEventListener("storage", (event) => {
    if (event.key === "locdoc.offlineChange") notifyLocal();
  });

const within = (path: string, parent: string) =>
  path === parent || path.startsWith(`${parent}/`);
const rename = (path: string, from: string, to: string) =>
  `${to}${path.slice(from.length)}`;
export async function queuedFiles() {
  if (!offlineCacheEnabled()) return [];
  const scope = await currentOfflineScope();
  return scope?.slot === "owner"
    ? (
        await offlineList<QueuedFile & { type?: string }>(
          "commands",
          `${scope.scope}|`,
        )
      ).filter((item) => !item.type)
    : [];
}

export function projectEntries(base: Entry[], queue: QueuedFile[]) {
  let entries = base;
  for (const { command: c, entries: kept, result } of queue) {
    if (c.kind.startsWith("create")) {
      if (
        !entries.some((entry) =>
          c.kind === "create-file"
            ? entry.id === c.document
            : entry.path === c.path,
        )
      )
        entries = [
          ...entries,
          {
            path: c.path,
            kind: c.kind === "create-file" ? "file" : "folder",
            id: c.kind === "create-file" ? c.document : null,
            shared: false,
            modified: 0,
            title: c.path
              .split("/")
              .pop()
              ?.replace(/\.(md|fountain|txt)$/i, ""),
            ...(c.kind === "create-folder"
              ? { identity: result?.identity || `new.${c.id}` }
              : { format: documentFormat(c.path) }),
          },
        ];
    } else if (c.kind.startsWith("move")) {
      entries = entries.map((entry) =>
        within(entry.path, c.from)
          ? {
              ...entry,
              path: rename(entry.path, c.from, c.path),
              title:
                entry.path === c.from
                  ? c.path
                      .split("/")
                      .pop()
                      ?.replace(/\.(md|fountain|txt)$/i, "")
                  : entry.title,
            }
          : entry,
      );
    } else if (c.kind.startsWith("delete"))
      entries = entries.filter((entry) => !within(entry.path, c.from));
    else if (c.kind === "restore")
      entries = [
        ...entries,
        ...kept.filter(
          (restored) => !entries.some((entry) => entry.path === restored.path),
        ),
      ];
  }
  return entries;
}

export async function projectRead<T>(path: string, body: T): Promise<T> {
  if (path !== "/api/tree" && !/^\/api\/docs\/[\da-f-]+(?:\?|$)/.test(path))
    return body;
  const queue = await queuedFiles().catch(() => []);
  if (!queue.length) return body;
  if (path === "/api/tree")
    return {
      ...body,
      entries: projectEntries((body as { entries: Entry[] }).entries, queue),
    } as T;
  const id = path.match(/^\/api\/docs\/([\da-f-]+)(?:\?|$)/)?.[1];
  if (id && body) {
    const tree = await cachedRead<{ entries: Entry[] }>("/api/tree");
    const entry = projectEntries(tree?.body.entries || [], queue).find(
      (entry) => entry.id === id,
    );
    if (entry) return { ...body, path: entry.path };
  }
  return body;
}

export async function localDocument(
  path: string,
): Promise<Document | undefined> {
  const id = path.match(/^\/api\/docs\/([\da-f-]+)(?:\?|$)/)?.[1];
  if (!id) return;
  const queue = await queuedFiles();
  const creation = queue.find(
    (entry) =>
      entry.command.kind === "create-file" &&
      entry.command.document === id &&
      !entry.result,
  );
  if (!creation) return;
  return projectRead(path, {
    id,
    path: creation.command.path,
    owner: true,
    edit: true,
    permission: "private",
    shareUrl: null,
    usage: 0,
    content: "",
    state: "AAA=",
    modified: creation.created,
    collaborationEpoch: "",
    offlineMedia: [],
  });
}
export async function localDeletion(path: string) {
  const id = path.match(/^\/api\/docs\/([\da-f-]+)(?:\?|$)/)?.[1];
  if (!id) return;
  let removed: QueuedFile | undefined;
  for (const entry of await queuedFiles()) {
    const command = entry.command;
    if (
      command.kind.startsWith("delete") &&
      (command.document === id || command.children.includes(id))
    )
      removed = entry;
    if (
      command.kind === "restore" &&
      removed &&
      [removed.command.id, removed.result?.trash?.id].includes(command.document)
    )
      removed = undefined;
  }
  if (removed)
    return {
      path: removed.command.from,
      trash: removed.result?.trash || {
        id: removed.command.id,
        kind: removed.command.kind === "delete-file" ? "document" : "folder",
        path: removed.command.from,
        deleted: removed.created,
        documents: removed.command.children.length || 1,
      },
    };
}

// Every supported action uses the idempotent endpoint, including online.
// A network failure can then safely keep the same operation for reconnect.
export async function queueFileRequest(
  path: string,
  init: RequestInit | undefined,
  send: (command: FileCommand) => Promise<QueuedFile["result"]>,
) {
  if (!offlineCacheEnabled()) return;
  const method = (init?.method || "GET").toUpperCase();
  if (!(
    path === "/api/files" ||
    path === "/api/folders" ||
    /^\/api\/docs\/[\da-f-]+$/.test(path) ||
    /^\/api\/trash\/[\da-f-]+\/restore$/.test(path)
  ))
    return;
  if (
    method === "GET" ||
    (typeof init?.body !== "string" &&
      method !== "DELETE" &&
      !path.endsWith("/restore"))
  )
    return;
  const scope = await currentOfflineScope().catch(() => undefined);
  if (scope?.slot !== "owner") return;
  const data = typeof init?.body === "string" ? JSON.parse(init.body) : {};
  const held = await cachedRead<{ entries: Entry[] }>("/api/tree");
  const queue = await queuedFiles();
  const otherWork = await offlineList("commands", `${scope.scope}|`);
  const entries = projectEntries(held?.body.entries || [], queue);
  const c: FileCommand = {
    id: crypto.randomUUID(),
    kind: "",
    document: "",
    from: "",
    path: "",
    identity: "",
    children: [],
  };
  let saved: Entry[] = [];
  if (
    path === "/api/files" &&
    method === "POST" &&
    ["file", "folder"].includes(data.kind)
  ) {
    c.kind = `create-${data.kind}`;
    c.path = data.path;
    if (data.kind === "file") c.document = c.id;
  } else if (
    /^\/api\/docs\/[\da-f-]+$/.test(path) &&
    ["PATCH", "DELETE"].includes(method)
  ) {
    c.document = path.split("/").pop()!;
    const current = entries.find((entry) => entry.id === c.document);
    if (!current) return;
    c.kind = method === "PATCH" ? "move-file" : "delete-file";
    c.from = current.path;
    c.path = data.path || current.path;
    saved = [current];
  } else if (path === "/api/folders" && ["PATCH", "DELETE"].includes(method)) {
    c.from = data.from || data.path;
    c.path = data.to || c.from;
    const folder = entries.find(
      (entry) => entry.path === c.from && entry.kind === "folder",
    );
    if (!folder) return;
    c.kind = method === "PATCH" ? "move-folder" : "delete-folder";
    c.identity = folder.identity || "";
    saved = entries.filter((entry) => within(entry.path, c.from));
    c.children = saved.flatMap((entry) => (entry.id ? [entry.id] : []));
  } else if (
    /^\/api\/trash\/[\da-f-]+\/restore$/.test(path) &&
    method === "POST"
  ) {
    c.kind = "restore";
    c.document = path.split("/")[3];
    const removed =
      queue.find((entry) => entry.command.id === c.document) ||
      (await offlineGet<QueuedFile>(
        "access",
        scopedKey(scope.scope, `trash:${c.document}`),
      ));
    saved = removed?.entries || [];
    c.path = removed?.command.from || "";
  } else return;
  if (c.kind.endsWith("folder") && !c.kind.startsWith("create") && !c.identity)
    throw new Error(
      "Reconnect once to prepare this folder for offline changes.",
    );
  // Persist first; a tab crash after acceptance cannot lose the action.
  await flushOpenDrafts();
  let pending = await enqueueOffline(scope.scope, {
    command: c,
    entries: saved,
    created: Math.floor(Date.now() / 1000),
  });
  if (c.kind.startsWith("delete"))
    await offlinePut(
      "access",
      scopedKey(scope.scope, `trash:${c.id}`),
      pending,
    );
  const affected = c.document ? [c.document] : c.children;
  for (const id of affected)
    window.dispatchEvent(
      new window.CustomEvent("locdoc-offline-pause", { detail: id }),
    );
  changedOfflineFiles();
  if (
    !otherWork.length &&
    !(await pendingDraftDocuments("owner")).some((id) =>
      affected.includes(id),
    ) &&
    navigator.onLine !== false
  ) {
    try {
      const result = await send(c);
      await finishFile(pending, result);
      await offlineDelete("commands", pending.key);
      changedOfflineFiles();
      return { handled: true, result };
    } catch (error) {
      if (
        !(error instanceof TypeError) &&
        !((error as { status?: number }).status! >= 500)
      ) {
        await offlineDelete("commands", pending.key);
        changedOfflineFiles();
        throw error;
      }
      // A lost HTTP response is safe to retry with this exact UUID.
    }
  }
  if (c.kind === "create-file") {
    const doc = await localDocument(`/api/docs/${c.document}`);
    if (doc) await cacheRead(`/api/docs/${c.document}`, doc);
    await cacheRead(`/api/docs/${c.document}/comments`, { comments: [] });
  }
  return {
    handled: true,
    result: c.kind.startsWith("delete")
      ? {
          ok: true,
          trash: {
            id: c.id,
            kind: c.kind === "delete-file" ? "document" : "folder",
            path: c.from,
            deleted: pending.created,
            documents: c.children.length || 1,
          },
        }
      : c.kind === "create-file"
        ? { id: c.document }
        : { ok: true, path: c.path },
  };
}

export async function finishFile(
  entry: QueuedFile,
  result: QueuedFile["result"],
) {
  if (entry.command.kind.startsWith("delete") && result?.trash) {
    const scope = entry.key.slice(0, entry.key.indexOf("|"));
    for (const id of [entry.command.id, result.trash.id])
      await offlinePut("access", scopedKey(scope, `trash:${id}`), {
        ...entry,
        result,
      });
  }
  await offlinePut("commands", entry.key, {
    ...entry,
    result,
    error: undefined,
  });
  changedOfflineFiles();
}
