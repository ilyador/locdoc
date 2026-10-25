import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { DraftJournal, hasUnstoredDrafts } from "../src/drafts.ts";
import {
  captureInsertion,
  insertAttachment,
  documentSession,
} from "../src/document-session.ts";
import { normalizePresence, pagePresence, publishPresence } from "../src/presence.ts";

test("closing a page withdraws its presence and a cached page restores it without touching text", () => {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, "My local draft");
  const awareness = new Awareness(doc);
  const page = new EventTarget();
  publishPresence(awareness, "Original name");
  const state = awareness.getLocalState();
  const stop = pagePresence(awareness, page);
  try {
    page.dispatchEvent(new Event("pagehide"));
    assert.equal(awareness.getLocalState(), null);
    page.dispatchEvent(new Event("pagehide"));
    page.dispatchEvent(new Event("pageshow"));
    assert.ok(awareness.getLocalState() === state, "restore the cached view's presence");
    page.dispatchEvent(new Event("pagehide"));
    awareness.setLocalState({ user: { name: "New name" } });
    page.dispatchEvent(new Event("pageshow"));
    assert.equal(awareness.getLocalState().user.name, "New name", "never restore over newer presence");
    stop();
    page.dispatchEvent(new Event("pagehide"));
    assert.equal(awareness.getLocalState().user.name, "New name", "a closed view has no page listeners");
    assert.equal(doc.getText("content").toString(), "My local draft");
  } finally {
    stop();
    awareness.destroy();
    doc.destroy();
  }
});

function seed(content = "Hello") {
  const ydoc = new Y.Doc();
  ydoc.getText("content").insert(0, content);
  return ydoc;
}
function clone(ydoc) {
  const other = new Y.Doc();
  Y.applyUpdate(other, Y.encodeStateAsUpdate(ydoc));
  return other;
}
function journal(ydoc, key = crypto.randomUUID()) {
  const drafts = new DraftJournal(ydoc, key);
  drafts.bind("server");
  return drafts;
}
test("offline draft survives closing and reopening a document from its saved server state", async () => {
  const original = seed(),
    snapshot = clone(original),
    key = crypto.randomUUID();
  const first = journal(original, key);
  original.getText("content").insert(5, " UNSAVED 👋");
  assert.equal(hasUnstoredDrafts(), true);
  await first.flush();
  assert.equal(first.stored, true);
  first.dispose();
  original.destroy();
  const reopened = new DraftJournal(snapshot, key);
  await reopened.restore(true);
  reopened.bind("server");
  assert.equal(snapshot.getText("content").toString(), "Hello UNSAVED 👋");
  assert.equal(reopened.pending, true);
  await reopened.acknowledge(reopened.checkpoint());
  reopened.dispose();
  snapshot.destroy();
});
test("continuous offline input stores recoverable progress without waiting for typing to stop", async (t) => {
  const original = seed(),
    baseline = clone(original),
    key = crypto.randomUUID();
  const draft = journal(original, key);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (let i = 0; i < 60; i++) {
    original
      .getText("content")
      .insert(original.getText("content").length, `[${i}]`);
    t.mock.timers.tick(10);
    await new Promise((resolve) => setImmediate(resolve));
  }
  // A killed tab cannot perform a final flush. Recover only what was stored
  // while edits were still arriving more frequently than the debounce.
  draft.dispose();
  original.destroy();
  t.mock.timers.reset();
  const recovery = new DraftJournal(baseline, key);
  await recovery.restore(true);
  assert.equal(
    recovery.pending,
    true,
    "Typing must not postpone storage indefinitely",
  );
  assert.ok(baseline.getText("content").toString().startsWith("Hello[0][1]"));
  recovery.dispose();
  baseline.destroy();
});

test("an old saved acknowledgement cannot erase newer edits or deletions", async () => {
  const doc = seed(),
    key = crypto.randomUUID(),
    drafts = journal(doc, key);
  const text = doc.getText("content");
  text.insert(5, " older");
  const oldReceipt = drafts.checkpoint();
  await drafts.flush();
  text.delete(5, 6);
  await drafts.flush();
  assert.equal(await drafts.acknowledge(oldReceipt), false);
  assert.equal(drafts.pending, true);
  drafts.dispose();
  const reopened = seed("");
  Y.applyUpdate(reopened, Y.encodeStateAsUpdate(doc));
  const recovery = new DraftJournal(reopened, key);
  await recovery.restore(true);
  assert.equal(reopened.getText("content").toString(), "Hello");
  assert.equal(recovery.pending, true);
  recovery.dispose();
  doc.destroy();
  reopened.destroy();
});
test("a background session cannot clear another session's newer offline draft", async () => {
  const a = seed(),
    b = clone(a),
    key = crypto.randomUUID();
  const first = journal(a, key),
    second = journal(b, key);
  a.getText("content").insert(5, " first");
  await first.flush();
  b.getText("content").insert(5, " second");
  await second.flush();
  await first.acknowledge(first.checkpoint());
  first.dispose();
  second.dispose();
  const recovered = clone(b),
    recovery = new DraftJournal(recovered, key);
  await recovery.restore(true);
  assert.equal(recovery.pending, true);
  assert.equal(recovered.getText("content").toString(), "Hello second");
  recovery.dispose();
  a.destroy();
  b.destroy();
  recovered.destroy();
});
test("saved acknowledgement clears only its exact recovered outbox records", async () => {
  const doc = seed(),
    key = crypto.randomUUID(),
    draft = journal(doc, key);
  doc.getText("content").insert(5, " saved");
  await draft.flush();
  assert.equal(await draft.acknowledge(draft.checkpoint()), true);
  draft.dispose();
  const next = new DraftJournal(clone(doc), key);
  await next.restore(true);
  assert.equal(next.pending, false);
  next.dispose();
  doc.destroy();
  next.ydoc.destroy();
});
test("view-only permission leaves offline drafts intact until edit access returns", async () => {
  const doc = seed(),
    baseline = clone(doc),
    key = crypto.randomUUID(),
    draft = journal(doc, key);
  doc.getText("content").insert(5, " private draft");
  await draft.flush();
  draft.dispose();
  const readonly = new DraftJournal(baseline, key);
  await readonly.restore(false);
  assert.equal(baseline.getText("content").toString(), "Hello");
  readonly.dispose();
  const editable = new DraftJournal(baseline, key);
  await editable.restore(true);
  assert.equal(baseline.getText("content").toString(), "Hello private draft");
  editable.dispose();
  doc.destroy();
  baseline.destroy();
});
test("storage failure prevents safe navigation and preserves the unsaved warning", async () => {
  const doc = seed(),
    drafts = journal(doc);
  doc.getText("content").insert(5, " unsaved");
  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = () => {
    throw new Error("Disk full");
  };
  try {
    await assert.rejects(drafts.flush(), /Disk full/);
    assert.equal(drafts.pending, true);
    assert.equal(drafts.stored, false);
    assert.equal(hasUnstoredDrafts(), true);
  } finally {
    IDBObjectStore.prototype.put = original;
    await drafts.flush();
    drafts.dispose();
    doc.destroy();
  }
});
test("delayed attachment targets its originating document and tracks concurrent typing", async () => {
  const a = seed("Original document"),
    b = seed("Other document");
  const position = captureInsertion(a, 8, 8);
  a.getText("content").insert(0, "👋 ");
  // The UI has switched to b by the time this upload resolves.
  insertAttachment(a, position, "![photo](.assets/original/photo.png)");
  assert.equal(
    a.getText("content").toString(),
    "👋 Original![photo](.assets/original/photo.png) document",
  );
  assert.equal(b.getText("content").toString(), "Other document");
  a.destroy();
  b.destroy();
});
test("an upload keeps its originating session alive after navigation", async () => {
  const doc = seed(),
    drafts = journal(doc);
  let destroyed = false;
  const provider = {
    wsconnected: false,
    awareness: { setLocalState() {} },
    destroy() {
      destroyed = true;
    },
  };
  const session = documentSession("origin", doc, provider, drafts);
  const release = session.retain();
  const position = captureInsertion(doc);
  session.leave();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(destroyed, false);
  insertAttachment(doc, position, "![image](photo.png)");
  await drafts.flush();
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(destroyed, true);
});
test("retaining a session while its final draft flush is pending cancels retirement", async () => {
  const doc = seed(),
    baseline = clone(doc),
    key = crypto.randomUUID(),
    drafts = journal(doc, key);
  let destroyed = false;
  const retired = Promise.withResolvers();
  const provider = {
    wsconnected: false,
    awareness: { setLocalState() {} },
    destroy() {
      destroyed = true;
      retired.resolve();
    },
  };
  const flushed = Promise.withResolvers();
  const continueFlush = Promise.withResolvers();
  const realFlush = drafts.flush.bind(drafts);
  drafts.flush = async () => {
    await realFlush();
    flushed.resolve();
    await continueFlush.promise;
  };
  const session = documentSession("origin", doc, provider, drafts);
  doc.getText("content").insert(5, " before navigation");
  session.leave();
  await flushed.promise;
  const release = session.retain();
  continueFlush.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    destroyed,
    false,
    "a successful retain must keep the document and its outbox alive",
  );
  insertAttachment(doc, captureInsertion(doc), " after upload");
  await drafts.flush();
  release();
  await retired.promise;
  assert.equal(destroyed, true);
  const recovered = new DraftJournal(baseline, key);
  try {
    await recovered.restore(true);
    assert.equal(
      baseline.getText("content").toString(),
      "Hello before navigation after upload",
    );
    await recovered.acknowledge(recovered.checkpoint());
  } finally {
    recovered.dispose();
    baseline.destroy();
  }
});
test("session retirement persists edits that arrive during the final draft transaction", async () => {
  const doc = seed(),
    baseline = clone(doc),
    key = crypto.randomUUID(),
    drafts = journal(doc, key);
  let destroyed = false;
  const retired = Promise.withResolvers();
  const provider = {
    wsconnected: false,
    awareness: { setLocalState() {} },
    destroy() {
      destroyed = true;
      retired.resolve();
    },
  };
  const flushed = Promise.withResolvers();
  const continueFlush = Promise.withResolvers();
  const realFlush = drafts.flush.bind(drafts);
  drafts.flush = async () => {
    await realFlush();
    flushed.resolve();
    await continueFlush.promise;
  };
  const session = documentSession("origin", doc, provider, drafts);
  doc.getText("content").insert(5, " first");
  session.leave();
  await flushed.promise;
  doc.getText("content").insert(doc.getText("content").length, " latest");
  continueFlush.resolve();
  await retired.promise;
  assert.equal(destroyed, true);
  const recovered = new DraftJournal(baseline, key);
  try {
    await recovered.restore(true);
    assert.equal(
      baseline.getText("content").toString(),
      "Hello first latest",
      "retirement must not mistake an older transaction for the latest draft",
    );
    await recovered.acknowledge(recovered.checkpoint());
  } finally {
    recovered.dispose();
    baseline.destroy();
  }
});
test("malformed remote user metadata cannot crash avatars or inject styles", () => {
  for (const value of [
    null,
    42,
    {},
    { name: 42 },
    { name: {} },
    { name: "  " },
  ])
    assert.equal(normalizePresence(value), null);
  assert.deepEqual(
    normalizePresence({ name: "Alice", color: "red;position:fixed" }),
    { name: "Alice", color: "#487495" },
  );
  assert.deepEqual(normalizePresence({ name: "\nAlice\t", color: "#aBc123" }), {
    name: "Alice",
    color: "#aBc123",
  });
});

test("a collaborator's later edit cannot invalidate our persisted checkpoint", async () => {
  const doc = seed(),
    drafts = journal(doc),
    peer = clone(doc);
  doc.getText("content").insert(5, " Alice");
  const receipt = drafts.checkpoint();
  await drafts.flush();
  peer.getText("content").insert(5, " Bob");
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer), "server");
  assert.match(doc.getText("content").toString(), /Alice/);
  assert.match(doc.getText("content").toString(), /Bob/);
  assert.equal(await drafts.acknowledge(receipt), true);
  assert.equal(drafts.pending, false);
  assert.equal(await drafts.acknowledge(receipt), false);
  drafts.dispose();
  doc.destroy();
  peer.destroy();
});

test("save checkpoints coalesce in-flight edits and retry after reconnect", async () => {
  const doc = seed(),
    sent = [];
  const drafts = new DraftJournal(doc, crypto.randomUUID());
  drafts.bind("server", (id) => {
    sent.push(id);
    return true;
  });
  doc.getText("content").insert(5, " one");
  doc.getText("content").insert(9, " two");
  assert.equal(sent.length, 1);
  assert.equal(await drafts.acknowledge(sent[0]), false);
  assert.equal(sent.length, 2);
  drafts.disconnected();
  drafts.requestSave();
  assert.equal(sent.length, 3);
  assert.equal(await drafts.acknowledge(sent[1]), false);
  assert.equal(drafts.pending, true);
  assert.equal(await drafts.acknowledge(sent[2]), true);
  assert.equal(drafts.pending, false);
  drafts.dispose();
  doc.destroy();
});
