import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";
import * as Y from "yjs";
import { createDecoder, readVarUint, readVarString } from "lib0/decoding";
import { createEncoder, writeVarString, toUint8Array } from "lib0/encoding";
import type { Document } from "../src/model";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost:3594/",
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
const { hasUnstoredDrafts } = await import("../src/drafts");
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
