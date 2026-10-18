import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import * as Y from "yjs";
import { DraftJournal, hasUnstoredDrafts } from "../src/drafts.ts";

function seed() {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, "Accepted text");
  return doc;
}
function clone(doc) {
  const result = new Y.Doc();
  Y.applyUpdate(result, Y.encodeStateAsUpdate(doc));
  return result;
}
async function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("locdoc-drafts-v1", 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function put(record) {
  const db = await database();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction("drafts", "readwrite");
      tx.objectStore("drafts").put(record);
      tx.oncomplete = resolve;
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
async function records(key) {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const request = db
        .transaction("drafts")
        .objectStore("drafts")
        .index("document")
        .getAll(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}
async function clear(journal) {
  for (const recovery of journal.recoveries)
    await journal.clearRecovery(recovery.id);
}

test("blocked IndexedDB never blocks a viewer and keeps editable drafts guarded in memory", async () => {
  const original = globalThis.indexedDB;
  let calls = 0;
  globalThis.indexedDB = {
    open() {
      calls++;
      throw new Error("Storage denied");
    },
  };
  const viewerDoc = seed(),
    editableDoc = seed();
  const viewer = new DraftJournal(viewerDoc, crypto.randomUUID());
  const editable = new DraftJournal(editableDoc, crypto.randomUUID());
  try {
    await viewer.restore(false);
    assert.equal(
      calls,
      0,
      "a read-only document must not request draft storage",
    );
    assert.equal(viewerDoc.getText("content").toString(), "Accepted text");
    await editable.restore(true);
    assert.equal(calls, 1);
    assert.match(editable.storageWarning, /unavailable/);
    editable.bind("server");
    editableDoc.getText("content").insert(13, " unsaved");
    await assert.rejects(editable.flush(), /Storage denied/);
    assert.equal(hasUnstoredDrafts(), true);
    assert.equal(editable.stored, false);
  } finally {
    globalThis.indexedDB = original;
    await editable.flush();
    await editable.acknowledge(editable.checkpoint());
    editable.dispose();
    viewer.dispose();
    editableDoc.destroy();
    viewerDoc.destroy();
  }
  assert.equal(hasUnstoredDrafts(), false);
});

test("a rejected edit is quarantined atomically, never replays, and does not block later valid edits", async () => {
  const accepted = seed(),
    edited = clone(accepted),
    key = crypto.randomUUID();
  const journal = new DraftJournal(edited, key);
  journal.bind("server");
  edited.getText("content").insert(13, " rejected draft");
  const oldReceipt = journal.checkpoint();
  await journal.flush();
  const original = (await records(key))[0].state;
  edited.getText("content").insert(edited.getText("content").length, " latest");
  await journal.reject("Document limit reached");
  const archives = await records(key);
  assert.ok(archives.length > 0 && archives.every((row) => row.recovery));
  assert.ok(
    journal.recoveries.some(
      (entry) => entry.text === "Accepted text rejected draft latest",
    ),
  );
  assert.ok(
    journal.recoveries.some((entry) =>
      entry.originalUpdates?.some((snapshot) =>
        Buffer.from(snapshot.update).equals(Buffer.from(original)),
      ),
    ),
    "the original serialized update must remain downloadable",
  );
  const recoveryCount = archives.length;
  await journal.reject("Duplicate rejection");
  assert.equal((await records(key)).length, recoveryCount);
  assert.equal(await journal.acknowledge(oldReceipt), false);
  assert.equal(journal.checkpoint(), null);
  journal.dispose();
  edited.destroy();

  const restored = clone(accepted),
    next = new DraftJournal(restored, key);
  await next.restore(true);
  assert.equal(restored.getText("content").toString(), "Accepted text");
  assert.equal(next.pending, false);
  assert.equal(next.recoveries.length, recoveryCount);
  next.bind("server");
  restored.getText("content").insert(13, " valid later edit");
  await next.flush();
  await next.acknowledge(next.checkpoint());
  assert.equal(
    (await records(key)).length,
    recoveryCount,
    "saving a later valid edit must not discard recovery copies",
  );
  await clear(next);
  assert.equal((await records(key)).length, 0);
  next.dispose();
  restored.destroy();
  accepted.destroy();
});

test("a malformed draft cannot partially mutate the opened document or prevent another draft restoring", async () => {
  const accepted = seed(),
    bad = clone(accepted),
    good = clone(accepted),
    key = crypto.randomUUID();
  const initialization = new DraftJournal(accepted, key);
  await initialization.restore(true);
  initialization.dispose();
  bad.getText("content").insert(13, " malformed");
  good.getText("content").insert(13, " healthy");
  const update = Y.encodeStateAsUpdate(bad, Y.encodeStateVector(accepted));
  const broken = update.slice(0, -1);
  await put({
    key,
    writer: "a-broken",
    token: "broken",
    state: broken,
    formatVersion: 2,
  });
  await put({
    key,
    writer: "b-healthy",
    token: "healthy",
    state: Y.encodeStateAsUpdate(good, Y.encodeStateVector(accepted)),
    formatVersion: 2,
  });
  const opened = clone(accepted),
    journal = new DraftJournal(opened, key);
  await journal.restore(true);
  assert.equal(opened.getText("content").toString(), "Accepted text healthy");
  assert.equal(journal.pending, true);
  assert.equal(journal.recoveries.length, 1);
  assert.ok(
    Buffer.from(journal.recoveries[0].update).equals(Buffer.from(broken)),
  );
  await journal.acknowledge(journal.checkpoint());
  await clear(journal);
  journal.dispose();
  opened.destroy();
  accepted.destroy();
  bad.destroy();
  good.destroy();
});

test("an invalid stored value opens cleanly and remains downloadable without pretending to be update bytes", async () => {
  const accepted = seed(),
    key = crypto.randomUUID();
  const journal = new DraftJournal(accepted, key);
  await journal.restore(true);
  await put({
    key,
    writer: "damaged",
    token: "damaged",
    state: { damaged: "state" },
  });
  await journal.restore(true);
  assert.equal(accepted.getText("content").toString(), "Accepted text");
  assert.equal(journal.recoveries.length, 1);
  assert.equal(journal.recoveries[0].update.length, 0);
  assert.deepEqual(journal.recoveries[0].rawState, { damaged: "state" });
  await clear(journal);
  journal.dispose();
  accepted.destroy();
});

test("a draft with invisible shared roots is preserved for recovery without applying it", async () => {
  const accepted = seed(),
    invalid = clone(accepted),
    key = crypto.randomUUID();
  const journal = new DraftJournal(accepted, key);
  await journal.restore(true);
  invalid.getMap("hidden").set("payload", "unwanted");
  await put({
    key,
    writer: "invalid-root",
    token: "root",
    formatVersion: 2,
    state: Y.encodeStateAsUpdate(invalid, Y.encodeStateVector(accepted)),
  });
  await journal.restore(true);
  assert.equal(accepted.share.has("hidden"), false);
  assert.equal(journal.pending, false);
  assert.equal(journal.recoveries.length, 1);
  await clear(journal);
  journal.dispose();
  accepted.destroy();
  invalid.destroy();
});

test("line-ending migration quarantines legacy updates while version-two drafts still restore", async () => {
  const accepted = seed(),
    legacy = clone(accepted),
    modern = clone(accepted),
    key = crypto.randomUUID();
  const initialization = new DraftJournal(accepted, key);
  await initialization.restore(true);
  initialization.dispose();
  legacy.getText("content").insert(13, " legacy");
  modern.getText("content").insert(13, " modern");
  const oldBytes = Y.encodeStateAsUpdate(legacy, Y.encodeStateVector(accepted));
  await put({ key, writer: "a-legacy", token: "legacy", state: oldBytes });
  await put({
    key,
    writer: "b-modern",
    token: "modern",
    formatVersion: 2,
    state: Y.encodeStateAsUpdate(modern, Y.encodeStateVector(accepted)),
  });
  const opened = clone(accepted),
    journal = new DraftJournal(opened, key);
  await journal.restore(true, { lineEndingMigrated: true });
  assert.equal(opened.getText("content").toString(), "Accepted text modern");
  assert.equal(journal.recoveries.length, 1);
  assert.match(journal.recoveries[0].reason, /line endings/);
  assert.ok(
    Buffer.from(journal.recoveries[0].update).equals(Buffer.from(oldBytes)),
  );
  await journal.acknowledge(journal.checkpoint());
  await clear(journal);
  journal.dispose();
  accepted.destroy();
  legacy.destroy();
  modern.destroy();
  opened.destroy();
});

test("failed quarantine storage retains recovery bytes and the unload guard until explicitly cleared", async () => {
  const accepted = seed(),
    edited = clone(accepted),
    key = crypto.randomUUID();
  const journal = new DraftJournal(edited, key);
  journal.bind("server");
  edited.getText("content").insert(13, " rejected");
  await journal.flush();
  const putOriginal = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = () => {
    throw new Error("Storage full");
  };
  try {
    await journal.reject("Rejected edit");
    assert.ok(
      journal.recoveries.some(
        (entry) => entry.text === "Accepted text rejected",
      ),
    );
    assert.equal(hasUnstoredDrafts(), true);
    assert.ok(
      (await records(key)).some((record) => !record.recovery),
      "a failed archive transaction must preserve the original active outbox",
    );
    journal.dispose();
    assert.equal(
      hasUnstoredDrafts(),
      true,
      "leaving the old session must not forget an unstored recovery",
    );
  } finally {
    IDBObjectStore.prototype.put = putOriginal;
    await clear(journal);
    assert.equal(
      (await records(key)).length,
      0,
      "explicitly clearing a failed archive also clears its original active outbox",
    );
    assert.equal(hasUnstoredDrafts(), false);
    edited.destroy();
    accepted.destroy();
  }
});

test("an old outbox is quarantined after an explicit collaboration rebuild while new-epoch edits restore", async () => {
  const accepted = seed(),
    edited = clone(accepted),
    key = crypto.randomUUID();
  const old = new DraftJournal(edited, key);
  await old.restore(true, { collaborationEpoch: "before-rebuild" });
  old.bind("server");
  edited.getText("content").insert(13, " old history");
  await old.flush();
  const original = (await records(key))[0];
  assert.equal(original.collaborationEpoch, "before-rebuild");
  old.dispose();
  edited.destroy();
  const opened = clone(accepted),
    current = new DraftJournal(opened, key);
  await current.restore(true, { collaborationEpoch: "after-rebuild" });
  assert.equal(opened.getText("content").toString(), "Accepted text");
  assert.equal(current.pending, false);
  assert.equal(current.recoveries.length, 1);
  assert.match(current.recoveries[0].reason, /rebuilt/);
  assert.ok(
    Buffer.from(current.recoveries[0].update).equals(
      Buffer.from(original.state),
    ),
  );
  current.bind("server");
  opened.getText("content").insert(13, " new history");
  await current.flush();
  current.dispose();
  opened.destroy();
  const nextDoc = clone(accepted),
    next = new DraftJournal(nextDoc, key);
  await next.restore(true, { collaborationEpoch: "after-rebuild" });
  assert.equal(
    nextDoc.getText("content").toString(),
    "Accepted text new history",
  );
  assert.equal(
    next.recoveries.length,
    1,
    "the old outbox must never replay after rebuild",
  );
  await next.acknowledge(next.checkpoint());
  await clear(next);
  next.dispose();
  nextDoc.destroy();
  accepted.destroy();
});
