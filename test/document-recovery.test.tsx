import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";
import * as Y from "yjs";
import { createDecoder, readVarUint, readVarString } from "lib0/decoding";
import { createEncoder, writeVarString, toUint8Array } from "lib0/encoding";
import type { Document } from "../src/model";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  location: dom.window.location,
  localStorage: dom.window.localStorage,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
class FixtureSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static sockets: FixtureSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose:
    | ((event: { code: number; reason: string; wasClean: boolean }) => void)
    | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onerror: (() => void) | null = null;
  binaryType = "";
  constructor(_url: string) {
    FixtureSocket.sockets.push(this);
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.();
    });
  }
  messages: Uint8Array[] = [];
  send(message: Uint8Array) {
    this.messages.push(new Uint8Array(message));
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: "Fixture closed", wasClean: true });
  }
}
Object.assign(globalThis, { WebSocket: FixtureSocket });
const { renderHook, act, waitFor, cleanup } =
  await import("@testing-library/react");
const { useDocument } = await import("../src/use-document");
const { DraftJournal, archiveOwnerDrafts, hasUnstoredDrafts } =
  await import("../src/drafts");
const originalFetch = globalThis.fetch;
let fetchCount = 0;
function fixture(edit = true): Document {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, "Accepted document");
  const state = Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
  doc.destroy();
  return {
    id: crypto.randomUUID(),
    path: "fixture.md",
    owner: true,
    edit,
    permission: "private",
    shareUrl: null,
    usage: 0,
    content: "Accepted document",
    modified: 0,
    state,
  };
}
function respond(doc: Document) {
  fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount++;
    return new Response(JSON.stringify(doc), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}
function serverMessage(
  session: NonNullable<ReturnType<typeof useDocument>["session"]>,
  kind: number,
  message: string,
) {
  const encoder = createEncoder();
  writeVarString(encoder, message);
  const handler = session.provider.messageHandlers[kind];
  assert.ok(handler, "the protocol handler must be registered");
  handler(
    createEncoder(),
    createDecoder(toUint8Array(encoder)),
    session.provider,
    true,
    kind,
  );
}
afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 20));
  globalThis.fetch = originalFetch;
});
after(() => dom.window.close());

test("opening a document recovers from a restart's empty proxy response without a page reload", async () => {
  const doc = fixture();
  respond(doc);
  const healthy = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async (...args) =>
    ++attempts === 1 ? new Response("", { status: 502 }) : healthy(...args);
  const { result } = renderHook(() => useDocument(doc.id, true, null));
  await waitFor(() => assert.ok(result.current.session));
  assert.equal(attempts, 2);
  assert.equal(result.current.error, "");
  assert.equal(result.current.doc?.id, doc.id);
  assert.equal(
    result.current.session!.ydoc.getText("content").toString(),
    doc.content,
  );
});

test("switching documents cancels an opening request waiting to retry", async () => {
  const first = fixture();
  const next = fixture();
  respond(next);
  const healthy = globalThis.fetch;
  let attempts = 0;
  let signal: AbortSignal | null | undefined;
  globalThis.fetch = async (path, init) => {
    if (path === `/api/docs/${first.id}`) {
      attempts++;
      signal = init?.signal;
      return new Response("", { status: 502 });
    }
    return healthy(path, init);
  };
  const { result, rerender } = renderHook(
    ({ id }) => useDocument(id, true, null),
    { initialProps: { id: first.id } },
  );
  await act(async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  rerender({ id: next.id });
  await waitFor(() => assert.ok(result.current.session));
  assert.equal(signal?.aborted, true);
  assert.equal(result.current.doc?.id, next.id);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  assert.equal(attempts, 1);
  assert.equal(result.current.error, "");
});

test("a reconnect's temporary HTTP failure keeps the live editor and its pending draft", async () => {
  const doc = fixture();
  respond(doc);
  const healthy = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async (...args) =>
    ++attempts === 1 ? new Response("", { status: 502 }) : healthy(...args);
  const { result } = renderHook(() => useDocument(doc.id, true, doc));
  await waitFor(() => assert.ok(result.current.session?.provider.wsconnected));
  const session = result.current.session!;
  await act(async () => {
    session.ydoc.getText("content").insert(17, " pending");
    await session.drafts.flush();
    session.provider.ws!.close();
  });
  await waitFor(() => assert.equal(attempts, 2));
  assert.ok(
    result.current.session === session,
    "reconnect keeps the draft session",
  );
  assert.equal(
    session.ydoc.getText("content").toString(),
    "Accepted document pending",
  );
  assert.equal(session.drafts.pending, true);
  assert.equal(result.current.error, "");
  await act(async () => {
    await session.drafts.acknowledge(session.drafts.checkpoint()!);
  });
});

test("read-only document opens with IndexedDB blocked without creating a storage request", async () => {
  const doc = fixture(false);
  respond(doc);
  const saved = globalThis.indexedDB;
  let attempts = 0;
  Object.assign(globalThis, {
    indexedDB: {
      open() {
        attempts++;
        throw new Error("Blocked");
      },
    },
  });
  try {
    const { result } = renderHook(() => useDocument(doc.id, true, doc));
    await waitFor(() => assert.ok(result.current.session));
    assert.equal(result.current.doc?.edit, false);
    assert.equal(
      result.current.session!.ydoc.getText("content").toString(),
      "Accepted document",
    );
    assert.equal(result.current.error, "");
    assert.equal(attempts, 0);
  } finally {
    Object.assign(globalThis, { indexedDB: saved });
  }
});

test("a conflicted bootstrap opens accepted text read-only and preserves an older browser draft without replay", async () => {
  const doc = { ...fixture(), diskConflict: true };
  const edited = new Y.Doc();
  Y.applyUpdate(edited, Buffer.from(doc.state, "base64"));
  const outbox = new DraftJournal(edited, `owner/${doc.id}`);
  await outbox.restore(true);
  outbox.bind("server");
  edited.getText("content").insert(17, " offline draft");
  await outbox.flush();
  outbox.dispose();
  edited.destroy();
  respond(doc);
  const { result } = renderHook(() => useDocument(doc.id, true, doc));
  await waitFor(() => assert.ok(result.current.session?.provider.wsconnected));
  const session = result.current.session!;
  await act(async () => {
    session.provider.synced = true;
  });
  assert.equal(result.current.doc?.edit, false);
  assert.equal(result.current.status, "Recovery needed");
  assert.equal(session.ydoc.getText("content").toString(), "Accepted document");
  assert.equal(session.drafts.pending, false);
  const saved = await archiveOwnerDrafts(doc.id);
  assert.equal(
    saved.length,
    1,
    "recovery must retain the original browser outbox",
  );
  assert.ok(Array.isArray(saved[0].state));
  const recovered = new Y.Doc();
  try {
    Y.applyUpdate(recovered, Buffer.from(doc.state, "base64"));
    Y.applyUpdate(recovered, Uint8Array.from(saved[0].state));
    assert.equal(
      recovered.getText("content").toString(),
      "Accepted document offline draft",
    );
  } finally {
    recovered.destroy();
  }
  assert.equal(fetchCount, 0, "a conflict must not start a reload loop");
});

test("a live conflict freezes editing while retaining pending drafts and ignoring stale save receipts", async () => {
  const doc = fixture();
  respond(doc);
  const { result } = renderHook(() => useDocument(doc.id, true, doc));
  await waitFor(() => assert.ok(result.current.session?.provider.wsconnected));
  const session = result.current.session!;
  await act(async () => {
    session.ydoc.getText("content").insert(17, " pending draft");
    await session.drafts.flush();
  });
  const socket = session.provider.ws as unknown as FixtureSocket;
  const checkpoint = socket.messages
    .map((bytes) => createDecoder(bytes))
    .find((decoder) => readVarUint(decoder) === 124);
  assert.ok(checkpoint);
  const receipt = readVarString(checkpoint);
  const connections = FixtureSocket.sockets.length;
  const messages = socket.messages.length;
  await act(async () => serverMessage(session, 121, "3"));
  assert.ok(
    result.current.session === session,
    "conflict keeps the live draft session",
  );
  assert.equal(result.current.doc?.edit, false);
  assert.equal(result.current.doc?.diskConflict, true);
  assert.equal(result.current.status, "Recovery needed");
  await act(async () => {
    serverMessage(session, 127, receipt);
    serverMessage(session, 121, "0");
    serverMessage(session, 125, "Recovery required");
    serverMessage(session, 120, "Recovery required");
    session.provider.synced = true;
  });
  assert.equal(session.drafts.pending, true);
  assert.equal(session.drafts.stored, true);
  assert.equal(
    result.current.recovery.length,
    0,
    "conflict must not quarantine the draft",
  );
  assert.equal(result.current.status, "Recovery needed");
  assert.equal(
    session.ydoc.getText("content").toString(),
    "Accepted document pending draft",
  );
  assert.equal(
    socket.messages.length,
    messages,
    "read-only sync must not send a new checkpoint",
  );
  assert.equal(FixtureSocket.sockets.length, connections);
  assert.equal(session.provider.wsconnected, true);
  assert.equal(fetchCount, 0);
  assert.equal((await archiveOwnerDrafts(doc.id)).length, 1);
});

test("a permanent rejection opens a fresh accepted session and exposes the original draft for download", async () => {
  const doc = fixture();
  respond(doc);
  const { result } = renderHook(() => useDocument(doc.id, true, doc));
  await waitFor(() => assert.ok(result.current.session));
  const old = result.current.session!;
  await act(async () => {
    old.ydoc.getText("content").insert(17, " rejected content");
    await old.drafts.flush();
  });
  await act(async () => serverMessage(old, 125, "Document limit reached"));
  await waitFor(() =>
    assert.ok(
      result.current.session && result.current.session !== old,
      "rejection must replace the invalid session",
    ),
  );
  assert.equal(
    result.current.session!.ydoc.getText("content").toString(),
    "Accepted document",
  );
  assert.equal(result.current.doc?.edit, true);
  assert.equal(fetchCount, 1, "recovery fetches once and must not loop");
  assert.ok(
    result.current.recovery.some(
      (entry) => entry.text === "Accepted document rejected content",
    ),
  );
  assert.equal(result.current.session!.drafts.pending, false);
  await act(async () => {
    const next = result.current.session!;
    next.ydoc.getText("content").insert(17, " valid");
    await next.drafts.flush();
    await next.drafts.acknowledge(next.drafts.checkpoint()!);
    for (const entry of result.current.recovery)
      await result.current.clearRecovery(entry.id);
  });
  assert.equal(result.current.recovery.length, 0);
  assert.equal(hasUnstoredDrafts(), false);
});

test("a transient storage rejection retains the active draft and retries without quarantine", async () => {
  const doc = fixture();
  respond(doc);
  const { result } = renderHook(() => useDocument(doc.id, true, doc));
  await waitFor(() => assert.ok(result.current.session));
  const session = result.current.session!;
  await act(async () => {
    session.ydoc.getText("content").insert(17, " pending");
    await session.drafts.flush();
  });
  const sockets = FixtureSocket.sockets.length;
  await act(async () =>
    serverMessage(session, 120, "Storage is temporarily unavailable"),
  );
  assert.ok(
    result.current.session === session,
    "a transient failure keeps the current session",
  );
  assert.equal(result.current.recovery.length, 0);
  assert.equal(session.drafts.pending, true);
  assert.match(result.current.storageWarning, /temporarily unavailable/);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 600));
  });
  assert.ok(
    FixtureSocket.sockets.length > sockets,
    "retry must open a new socket",
  );
  assert.equal(
    session.ydoc.getText("content").toString(),
    "Accepted document pending",
  );
  await act(async () => {
    session.drafts.disconnected();
    await session.drafts.acknowledge(session.drafts.checkpoint()!);
  });
});

test("continuous typing does not rerender the document hook when its status is unchanged", async () => {
  const doc = fixture();
  respond(doc);
  let renders = 0;
  const { result } = renderHook(() => {
    renders++;
    return useDocument(doc.id, true, doc);
  });
  await waitFor(() => assert.ok(result.current.session));
  const session = result.current.session!;
  await act(async () => {
    session.ydoc.getText("content").insert(17, " first");
    await session.drafts.flush();
  });
  const settled = renders;
  await act(async () => {
    session.ydoc.getText("content").insert(23, " second");
    await session.drafts.flush();
  });
  assert.equal(
    renders,
    settled,
    "unchanged save/recovery state must not rerender the workspace per keystroke",
  );
  await act(async () => {
    await session.drafts.acknowledge(session.drafts.checkpoint()!);
  });
});

test("cursor-only presence updates do not rerender the workspace avatar state", async () => {
  const doc = fixture();
  respond(doc);
  let renders = 0;
  const { result } = renderHook(() => {
    renders++;
    return useDocument(doc.id, true, doc);
  });
  await waitFor(() => assert.ok(result.current.session));
  const awareness = result.current.session!.provider.awareness;
  await act(async () => {
    awareness.setLocalStateField("user", { name: "Ana", color: "#487495" });
  });
  assert.equal(result.current.people[0].name, "Ana");
  const settled = renders;
  await act(async () => {
    awareness.setLocalStateField("cursor", { anchor: 4, head: 9 });
  });
  assert.equal(
    renders,
    settled,
    "moving a remote cursor must not rerender unrelated workspace UI",
  );
  await act(async () => {
    awareness.setLocalStateField("user", { name: "Alex", color: "#487495" });
  });
  assert.equal(result.current.people[0].name, "Alex");
});

test("pending checkpoints show saving until the server actually reports a blocked file", async () => {
  const doc = fixture();
  respond(doc);
  const { result } = renderHook(() => useDocument(doc.id, true, doc));
  await waitFor(() => assert.ok(result.current.session?.provider.wsconnected));
  const session = result.current.session!;
  await act(async () => {
    session.ydoc.getText("content").insert(0, "New ");
  });
  const socket = session.provider.ws as unknown as FixtureSocket;
  const checkpoint = socket.messages
    .map((bytes) => createDecoder(bytes))
    .find((decoder) => readVarUint(decoder) === 124);
  assert.ok(checkpoint, "local edit must send an ordered save checkpoint");
  const receipt = readVarString(checkpoint);
  await act(async () => serverMessage(session, 122, receipt));
  assert.equal(result.current.status, "Saving…");
  await act(async () => serverMessage(session, 121, "1"));
  assert.equal(result.current.status, "Waiting for desktop file");
  await act(async () => serverMessage(session, 121, "0"));
  assert.equal(result.current.status, "Saving…");
  await act(async () => serverMessage(session, 127, receipt));
  assert.equal(session.drafts.pending, false);
});

test("opening accepted text with a pending projection cannot report Saved to disk", async () => {
  const doc = { ...fixture(false), diskSaving: true };
  respond(doc);
  const { result } = renderHook(() => useDocument(doc.id, true, doc));
  await waitFor(() => assert.ok(result.current.session));
  const session = result.current.session!;
  await act(async () => {
    session.provider.synced = true;
    session.provider.emit("sync", [true]);
  });
  assert.equal(result.current.status, "Saving…");
  await act(async () => serverMessage(session, 121, "1"));
  assert.equal(result.current.status, "Waiting for desktop file");
  await act(async () => serverMessage(session, 121, "2"));
  assert.equal(result.current.status, "Saving…");
  await act(async () => serverMessage(session, 121, "0"));
  assert.equal(result.current.status, "Saved to disk");
});

test("each media approval signal asks the editor once to request failed media again", async () => {
  const doc = fixture(false);
  respond(doc);
  const { result } = renderHook(() => useDocument(doc.id, true, doc));
  await waitFor(() => assert.ok(result.current.session));
  const session = result.current.session!;
  assert.equal(result.current.mediaRetry, 0);
  await act(async () => serverMessage(session, 119, ""));
  assert.equal(result.current.mediaRetry, 1);
  await act(async () => serverMessage(session, 119, ""));
  assert.equal(result.current.mediaRetry, 2);
  assert.ok(result.current.session === session, "the session stays open");
  assert.equal(fetchCount, 0, "the signal loads nothing itself");
});
