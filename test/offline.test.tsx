import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";
import * as Y from "yjs";
import type { Document } from "../src/model";

let dom: JSDOM;
let cache: typeof import("../src/offline-cache");
let api: typeof import("../src/api");
let db: typeof import("../src/offline-db");
let replicas: typeof import("../src/offline-replica");
let drafts: typeof import("../src/drafts");
let files: typeof import("../src/offline-files");
const fetchBefore = globalThis.fetch;
before(async () => {
  dom = new JSDOM("", { url: "https://offline.example.test/" });
  for (const key of [
    "window",
    "document",
    "location",
    "localStorage",
    "navigator",
  ])
    Object.defineProperty(globalThis, key, {
      value: dom.window[key],
      configurable: true,
      writable: true,
    });
  Object.defineProperty(navigator, "onLine", {
    value: false,
    configurable: true,
  });
  cache = await import("../src/offline-cache");
  api = await import("../src/api");
  db = await import("../src/offline-db");
  replicas = await import("../src/offline-replica");
  drafts = await import("../src/drafts");
  files = await import("../src/offline-files");
  globalThis.fetch = async () => {
    throw new TypeError("Offline fixture");
  };
});
after(() => {
  globalThis.fetch = fetchBefore;
  dom.window.close();
});

async function owner() {
  dom.reconfigure({ url: "https://offline.example.test/" });
  const scope = crypto.randomUUID();
  await cache.cacheRead("/api/config", {
    owner: true,
    root: "/fixture/docs",
    guest: "fixture",
    publicUrl: location.origin,
    offlineScope: scope,
  });
  return (await cache.currentOfflineScope())!;
}
function document(content = "Original text", epoch = "") {
  const ydoc = new Y.Doc();
  ydoc.getText("content").insert(0, content);
  const doc: Document = {
    id: crypto.randomUUID(),
    path: "Note.md",
    owner: true,
    edit: true,
    permission: "private",
    shareUrl: null,
    usage: 0,
    content,
    state: replicas.base64State(Y.encodeStateAsUpdate(ydoc)),
    modified: 1,
    collaborationEpoch: epoch,
  };
  return { ydoc, doc, path: `/api/docs/${doc.id}` };
}

test("the entire cached tree opens documents never visited, without a server", async () => {
  await owner();
  const a = document("First"),
    b = document("Never opened before");
  try {
    await cache.cacheRead("/api/tree", {
      entries: [a, b].map(({ doc }) => ({
        id: doc.id,
        path: doc.path,
        kind: "file",
        shared: false,
      })),
    });
    for (const item of [a, b]) await cache.cacheRead(item.path, item.doc);
    const tree = await api.api<{ entries: { id: string }[] }>("/api/tree");
    assert.equal(tree.entries.length, 2);
    assert.equal(
      (await api.api<Document>(b.path)).content,
      "Never opened before",
    );
  } finally {
    a.ydoc.destroy();
    b.ydoc.destroy();
  }
});

test("acknowledged edits survive an offline reload, including the normal empty collaboration epoch", async () => {
  const scope = await owner();
  const item = document();
  await cache.cacheRead(item.path, item.doc);
  const replica = new replicas.OfflineReplica(
    scope,
    item.path,
    "",
    Y.encodeStateAsUpdate(item.ydoc),
  );
  const outbox = new drafts.DraftJournal(
    item.ydoc,
    `owner/${item.doc.id}`,
    undefined,
    undefined,
    () => replica.accepted(item.ydoc),
  );
  outbox.bind("server");
  try {
    item.ydoc
      .getText("content")
      .insert(item.ydoc.getText("content").length, " accepted edit");
    await outbox.flush();
    await outbox.acknowledge(outbox.checkpoint()!);
    assert.equal(outbox.pending, false);
    const reopened = await api.api<Document>(item.path);
    assert.equal(reopened.content, "Original text accepted edit");
    const recovered = new Y.Doc();
    Y.applyUpdate(recovered, api.decodeState(reopened.state));
    assert.equal(recovered.getText("content").toString(), reopened.content);
    recovered.destroy();
  } finally {
    outbox.dispose();
    replica.destroy();
    item.ydoc.destroy();
  }
});

test("receipt storage failure retains the outbox instead of losing accepted edits", async () => {
  await owner();
  const item = document();
  const journal = new drafts.DraftJournal(
    item.ydoc,
    `owner/${item.doc.id}`,
    undefined,
    undefined,
    async () => {
      throw new Error("Storage failed");
    },
  );
  journal.bind("server");
  try {
    item.ydoc.getText("content").insert(0, "Keep me. ");
    await journal.flush();
    assert.equal(await journal.acknowledge(journal.checkpoint()!), false);
    assert.equal(journal.pending, true);
    assert.equal(journal.stored, true);
  } finally {
    journal.dispose();
    item.ydoc.destroy();
  }
});

test("many accepted changes compact without losing concurrent edits", async () => {
  const scope = await owner();
  const item = document("Start");
  await cache.cacheRead(item.path, item.doc);
  const replica = new replicas.OfflineReplica(
    scope,
    item.path,
    "",
    Y.encodeStateAsUpdate(item.ydoc),
  );
  try {
    for (let i = 0; i < 300; i++) {
      item.ydoc
        .getText("content")
        .insert(item.ydoc.getText("content").length, String(i % 10));
      await replica.accepted(item.ydoc);
    }
    const updates = await replicas.acceptedUpdates(scope, item.path, "");
    assert.ok(
      updates.length < 128,
      "accepted-update storage is bounded by compaction",
    );
    assert.equal(
      (await api.api<Document>(item.path)).content,
      item.ydoc.getText("content").toString(),
    );
  } finally {
    replica.destroy();
    item.ydoc.destroy();
  }
});

test("creating, moving, deleting and undoing a file offline projects a durable ordered tree", async () => {
  const scope = await owner();
  await cache.cacheRead("/api/tree", { entries: [] });
  const created = await api.api<{ id: string }>(
    "/api/files",
    api.send("POST", { path: "Offline.md", kind: "file" }),
  );
  const initial = await api.api<Document>(`/api/docs/${created.id}`);
  assert.equal(initial.content, "");
  await api.api(
    `/api/docs/${created.id}`,
    api.send("PATCH", { path: "Renamed.md" }),
  );
  assert.equal(
    (await api.api<Document>(`/api/docs/${created.id}`)).path,
    "Renamed.md",
  );
  const removed = await api.api<{ trash: { id: string } }>(
    `/api/docs/${created.id}`,
    api.send("DELETE"),
  );
  assert.equal(
    (await api.api<{ entries: unknown[] }>("/api/tree")).entries.length,
    0,
  );
  await api.api(`/api/trash/${removed.trash.id}/restore`, api.send("POST"));
  const tree = await api.api<{ entries: { id: string; path: string }[] }>(
    "/api/tree",
  );
  assert.equal(tree.entries[0].id, created.id);
  assert.equal(tree.entries[0].path, "Renamed.md");
  const queue = await files.queuedFiles();
  assert.equal(queue.length, 4);
  assert.ok(
    queue.every((entry, index) => !index || entry.key > queue[index - 1].key),
    "cross-tab queue ordering is monotonic",
  );
  assert.equal(await db.offlineGet("access", scope.slot), scope.scope);
  const comments = await api.api<{ comments: unknown[] }>(
    `/api/docs/${created.id}/comments`,
  );
  assert.equal(
    comments.comments.length,
    0,
    "new offline documents also have an offline comment list",
  );
});

test("queued comments and sequential replies are visible offline without editing the raw source speculatively", async () => {
  await owner();
  const item = document();
  try {
    await cache.cacheRead(item.path, item.doc);
    await cache.cacheRead(`${item.path}/comments`, { comments: [] });
    const root = await api.api<{ id: string }>(
      `${item.path}/comments`,
      api.send("POST", {
        body: "Offline comment",
        name: "Writer",
        requestId: crypto.randomUUID(),
      }),
    );
    await api.api(
      `${item.path}/comments/${root.id}`,
      api.send("PATCH", {
        body: "Offline reply",
        name: "Reader",
        requestId: crypto.randomUUID(),
      }),
    );
    const list = await api.api<{
      comments: { body: string; replies: { body: string }[] }[];
    }>(`${item.path}/comments`);
    assert.equal(list.comments[0].body, "Offline comment");
    assert.equal(list.comments[0].replies[0].body, "Offline reply");
    assert.equal(item.ydoc.getText("content").toString(), "Original text");
  } finally {
    item.ydoc.destroy();
  }
});

test("an expired login locks the workspace and retains unsynced operations for login", async () => {
  const scope = await owner();
  await cache.cacheRead("/api/tree", { entries: [] });
  await api.api(
    "/api/files",
    api.send("POST", { path: "Keep.md", kind: "file" }),
  );
  await cache.cacheRead("/api/config", { owner: false });
  assert.equal(await cache.cachedRead("/api/tree"), undefined);
  assert.equal((await db.offlineList("commands", `${scope.scope}|`)).length, 1);
  await cache.cacheRead("/api/config", {
    owner: true,
    offlineScope: scope.scope,
  });
  assert.equal((await files.queuedFiles()).length, 1);
});

test("a sharing link never reads the owner's cached private workspace", async () => {
  const ownerScope = await owner();
  const item = document("Private owner content");
  try {
    await cache.cacheRead(item.path, item.doc);
    dom.reconfigure({ url: "https://offline.example.test/s/guest-token" });
    await cache.cacheRead("/api/open/guest-token", {
      owner: false,
      offlineScope: ownerScope.scope,
      document: null,
    });
    assert.equal(await cache.cachedRead(item.path), undefined);
    assert.equal(
      await cache.cachedRead(`${item.path}?token=guest-token`),
      undefined,
    );
    assert.equal(
      (await cache.currentOfflineScope())!.slot.startsWith("link."),
      true,
    );
  } finally {
    item.ydoc.destroy();
  }
});

test("a late authenticated response cannot reopen the cache after logout", async () => {
  const scope = await owner();
  const ticket = cache.offlineGeneration();
  const late = { owner: true, offlineScope: scope.scope };
  cache.stampOffline(late, ticket);
  await cache.logoutOffline();
  await cache.cacheRead("/api/config", late);
  assert.equal(await cache.currentOfflineScope(), undefined);
});

test("owner-only sharing-link downloads lock on logout", async () => {
  const scope = await owner();
  const item = document("Owner copy");
  try {
    dom.reconfigure({ url: "https://offline.example.test/s/owner-link" });
    await cache.cacheRead("/api/open/owner-link", {
      owner: true,
      offlineScope: scope.scope,
      document: item.doc,
    });
    assert.equal(
      (await cache.cachedRead<Document>(`${item.path}?token=owner-link`))?.body
        .content,
      "Owner copy",
    );
    await cache.logoutOffline();
    assert.equal(
      await cache.cachedRead(`${item.path}?token=owner-link`),
      undefined,
    );
  } finally {
    item.ydoc.destroy();
  }
});

test("concurrent tabs reserve attachment capacity atomically without loading blobs", async () => {
  const scope = await owner();
  const id = crypto.randomUUID();
  const attempts = await Promise.allSettled(
    Array.from({ length: 3 }, () =>
      db.enqueueOffline(
        scope.scope,
        { type: "upload", document: id, bytes: 20_000_000 },
        { document: id, usage: 0, bytes: 20_000_000 },
      ),
    ),
  );
  assert.equal(
    attempts.filter((item) => item.status === "fulfilled").length,
    2,
  );
  assert.equal(attempts.filter((item) => item.status === "rejected").length, 1);
  assert.equal((await db.offlineList("commands", `${scope.scope}|`)).length, 2);
});

test("offline video responses support full, partial, suffix and unsatisfiable byte ranges", async () => {
  const { resourceResponse } = await import("../src/offline-resource");
  const resource = {
    blob: new Blob(["0123456789"]),
    type: "video/mp4",
    version: "one",
  };
  const response = (range?: string, method = "GET") =>
    resourceResponse(
      resource,
      new Request("https://offline.example.test/media", {
        method,
        headers: range ? { Range: range } : {},
      }),
    );
  assert.equal(await response().text(), "0123456789");
  const part = response("bytes=2-5");
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("Content-Range"), "bytes 2-5/10");
  assert.equal(await part.text(), "2345");
  assert.equal(await response("bytes=-3").text(), "789");
  assert.equal(await response("bytes=8-99").text(), "89");
  assert.equal(await response("bytes=2-5", "HEAD").text(), "");
  for (const range of [
    "bytes=10-",
    "bytes=5-2",
    "bytes=",
    "bytes=-0",
    "bytes=0-1,4-5",
  ])
    assert.equal(response(range).status, 416, range);
});

test("a disconnected server with working Wi-Fi opens cached text without waiting for TCP timeout", async () => {
  await owner();
  const item = document("Immediate local text");
  await cache.cacheRead(item.path, item.doc);
  Object.defineProperty(navigator, "onLine", {
    value: true,
    configurable: true,
  });
  globalThis.fetch = () => new Promise(() => {});
  const start = performance.now();
  try {
    assert.equal(
      (await api.api<Document>(item.path)).content,
      "Immediate local text",
    );
    assert.ok(
      performance.now() - start < 2000,
      "cached opening is bounded independently of the network",
    );
  } finally {
    Object.defineProperty(navigator, "onLine", {
      value: false,
      configurable: true,
    });
    globalThis.fetch = async () => {
      throw new TypeError("Offline fixture");
    };
    item.ydoc.destroy();
  }
});

test("offline resources round-trip binary media without IndexedDB Blob backing files", async () => {
  const scope = await owner();
  const key = db.scopedKey(
    scope.scope,
    "/api/docs/fixture/media?path=movie.mp4",
  );
  await db.offlinePut("resources", key, {
    blob: new Blob(["movie bytes"], { type: "video/mp4" }),
    type: "video/mp4",
    version: "one",
    pending: true,
  });
  const value = await db.offlineGet<import("../src/offline-db").CachedResource>(
    "resources",
    key,
  );
  assert.equal(await value!.blob.text(), "movie bytes");
  assert.equal(value!.type, "video/mp4");
  assert.equal(value!.pending, true);
  const raw = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const request = indexedDB.open("locdoc-offline-v1");
    request.onsuccess = () => {
      const connection = request.result;
      const read = connection
        .transaction("resources")
        .objectStore("resources")
        .get(key);
      read.onsuccess = () => {
        connection.close();
        resolve(read.result);
      };
      read.onerror = () => reject(read.error);
    };
  });
  assert.equal(raw.blob, undefined);
  assert.ok(
    raw.bytes instanceof ArrayBuffer,
    "storage uses portable structured-clone binary data",
  );
});

test("cache expiry protects an open editor before its first keystroke and then its stored draft", async () => {
  const held = new Set<string>();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (
        name: string,
        options:
          | { mode?: string; ifAvailable?: boolean }
          | ((lock: { name: string }) => Promise<unknown>),
        callback?: (lock: { name: string } | null) => Promise<unknown>,
      ) => {
        if (typeof options === "function") return options({ name });
        if (options.ifAvailable)
          return callback!(held.has(name) ? null : { name });
        held.add(name);
        try {
          return await callback!({ name });
        } finally {
          held.delete(name);
        }
      },
    },
  });
  const scope = await owner();
  const item = document("Keep my bootstrap");
  const key = db.scopedKey(scope.scope, `removed:doc:${item.doc.id}`);
  const pruned = db.scopedKey(scope.scope, "pruned");
  const now = Date.now();
  await cache.cacheRead(item.path, item.doc);
  await db.offlinePut("access", key, now - 31 * 86_400_000);
  const lease = db.holdDocumentCache(scope.scope, item.doc.id);
  await lease.ready;
  const journal = new drafts.DraftJournal(item.ydoc, `owner/${item.doc.id}`);
  journal.bind("server");
  const { pruneOffline } = await import("../src/offline-retention");
  try {
    await pruneOffline(scope, [], "owner", now);
    assert.equal(
      (await cache.cachedRead<Document>(item.path))?.body.content,
      "Keep my bootstrap",
    );
    item.ydoc.getText("content").insert(0, "Offline addition. ");
    await journal.flush();
    lease.release();
    await db.offlineDelete("access", pruned);
    await pruneOffline(scope, [], "owner", now + 86_400_000);
    assert.ok(
      await cache.cachedRead(item.path),
      "the draft's causal bootstrap must survive retention",
    );
    await journal.acknowledge(journal.checkpoint()!);
    await db.offlineDelete("access", pruned);
    await pruneOffline(scope, [], "owner", now + 2 * 86_400_000);
    assert.equal(await cache.cachedRead(item.path), undefined);
  } finally {
    lease.release();
    journal.dispose();
    item.ydoc.destroy();
    Object.defineProperty(navigator, "locks", {
      value: undefined,
      configurable: true,
    });
  }
});

test("a refused offline comment stays recoverable while another document syncs, without replaying unrelated old drafts", async () => {
  await owner();
  const a = document("First document"),
    b = document("Second document");
  for (const item of [a, b]) {
    await cache.cacheRead(item.path, item.doc);
    await cache.cacheRead(`${item.path}/comments`, { comments: [] });
    await api.api(
      `${item.path}/comments`,
      api.send("POST", {
        body: item.doc.content,
        name: "Writer",
        requestId: crypto.randomUUID(),
      }),
    );
  }
  const calls: string[] = [];
  globalThis.fetch = async (path, init) => {
    const url = String(path);
    calls.push(url);
    if (init?.method === "POST" && url === `${a.path}/comments`)
      return Response.json(
        { error: "This comment needs review." },
        { status: 409 },
      );
    if (url === b.path) return Response.json(b.doc);
    if (url === `${b.path}/comments`) {
      const comment = {
        id: "accepted-comment",
        body: "Second document",
        name: "Writer",
        quote: null,
        anchor: null,
        created: 1,
        canResolve: true,
        resolved: false,
        replies: [],
      };
      return Response.json(
        init?.method === "POST" ? comment : { comments: [comment] },
      );
    }
    throw new Error(`Unrelated draft unexpectedly requested: ${url}`);
  };
  try {
    const { reconnectFiles } = await import("../src/offline-workspace");
    const problems = await reconnectFiles(
      "owner",
      async () => {},
      () => {},
      new AbortController().signal,
      new Set([a.doc.id, b.doc.id]),
    );
    assert.equal(problems[0], "This comment needs review.");
    const actions = await (
      await import("../src/offline-actions")
    ).queuedActions();
    assert.equal(
      actions.length,
      1,
      "only the refused form remains, with its original content",
    );
    assert.equal(actions[0].document, a.doc.id);
    assert.equal(actions[0].error, "This comment needs review.");
    assert.equal(
      (
        await cache.cachedRead<{ comments: { body: string }[] }>(
          `${b.path}/comments`,
        )
      )?.body.comments[0].body,
      "Second document",
    );
    assert.ok(
      calls.every((path) => path.startsWith(a.path) || path.startsWith(b.path)),
      "background replay stays within the current workspace",
    );
  } finally {
    globalThis.fetch = async () => {
      throw new TypeError("Offline fixture");
    };
    a.ydoc.destroy();
    b.ydoc.destroy();
  }
});

test("an online deletion can be undone after losing the connection, preserving its tree identity", async () => {
  await owner();
  const item = document("Deleted online, restored offline");
  const entry = {
    id: item.doc.id,
    path: item.doc.path,
    kind: "file",
    shared: false,
  };
  await cache.cacheRead("/api/tree", { entries: [entry] });
  await cache.cacheRead(item.path, item.doc);
  const trash = {
    id: crypto.randomUUID(),
    kind: "document",
    path: item.doc.path,
    deleted: Math.floor(Date.now() / 1000),
    documents: 1,
  };
  Object.defineProperty(navigator, "onLine", {
    value: true,
    configurable: true,
  });
  try {
    let sent = false;
    await files.queueFileRequest(item.path, { method: "DELETE" }, async () => {
      sent = true;
      return { trash };
    });
    assert.equal(
      sent,
      true,
      "unrelated historical drafts do not defer this file operation",
    );
    assert.equal((await files.queuedFiles()).length, 0);
    await cache.cacheRead("/api/tree", { entries: [] });
    Object.defineProperty(navigator, "onLine", {
      value: false,
      configurable: true,
    });
    await api.api(`/api/trash/${trash.id}/restore`, api.send("POST"));
    const tree = await api.api<{ entries: (typeof entry)[] }>("/api/tree");
    assert.equal(tree.entries[0].id, item.doc.id);
    assert.equal(tree.entries[0].path, item.doc.path);
  } finally {
    Object.defineProperty(navigator, "onLine", {
      value: false,
      configurable: true,
    });
    item.ydoc.destroy();
  }
});

test("sharing-link bootstrap references the document replica without retaining a second stale source", async () => {
  const scope = await owner();
  const item = document("Only one source copy");
  dom.reconfigure({ url: "https://offline.example.test/s/one-source" });
  try {
    await cache.cacheRead("/api/open/one-source", {
      owner: false,
      offlineScope: scope.scope,
      document: item.doc,
    });
    const current = (await cache.currentOfflineScope())!;
    const raw = await db.offlineGet<
      import("../src/offline-db").CachedRead<{
        document: { id: string; state?: string; content?: string };
      }>
    >("reads", db.scopedKey(current.scope, "/api/open/one-source"));
    assert.equal(raw!.body.document.id, item.doc.id);
    assert.equal(raw!.body.document.state, undefined);
    assert.equal(raw!.body.document.content, undefined);
    const opened = await cache.cachedRead<{ document: Document }>(
      "/api/open/one-source",
    );
    assert.equal(opened!.body.document.content, "Only one source copy");
  } finally {
    item.ydoc.destroy();
  }
});
