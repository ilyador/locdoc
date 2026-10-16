import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import * as Y from "yjs";
import { DraftJournal } from "../src/drafts.ts";

function copy(doc) {
  const next = new Y.Doc();
  Y.applyUpdate(next, Y.encodeStateAsUpdate(doc));
  return next;
}

test("recoverable draft snapshots exclude the already durable multi-megabyte baseline", async () => {
  const server = new Y.Doc();
  server.getText("content").insert(0, "x".repeat(2_000_000));
  const doc = copy(server);
  const key = `size-${crypto.randomUUID()}`;
  const journal = new DraftJournal(doc, key);
  journal.bind("server");
  const originalPut = IDBObjectStore.prototype.put;
  let snapshotBytes = 0;
  IDBObjectStore.prototype.put = function (record, ...args) {
    if (record.key === key) snapshotBytes = record.state.byteLength;
    return originalPut.call(this, record, ...args);
  };
  try {
    doc
      .getText("content")
      .insert(doc.getText("content").length, "Small unsaved edit");
    await journal.flush();
    assert.ok(snapshotBytes > 0, "The unsaved change must still be stored");
    assert.ok(
      snapshotBytes < 4096,
      `One small edit wrote ${snapshotBytes} bytes of durable base text again`,
    );
    journal.dispose();
    const reopened = copy(server);
    const recovery = new DraftJournal(reopened, key);
    try {
      await recovery.restore(true);
      assert.equal(recovery.pending, true);
      assert.equal(
        reopened.getText("content").toString(),
        doc.getText("content").toString(),
      );
    } finally {
      recovery.dispose();
      reopened.destroy();
    }
  } finally {
    IDBObjectStore.prototype.put = originalPut;
    journal.dispose();
    doc.destroy();
    server.destroy();
  }
});

test("delta recovery preserves baseline deletions across two crashes and newer remote state", async () => {
  const server = new Y.Doc();
  server.getText("content").insert(0, "DELETE THIS\nKeep this paragraph.\n");
  const key = `deletion-${crypto.randomUUID()}`;
  let doc = copy(server);
  let journal = new DraftJournal(doc, key);
  journal.bind("server");
  try {
    doc.getText("content").delete(0, "DELETE THIS\n".length);
    doc
      .getText("content")
      .insert(doc.getText("content").length, "Local change\n");
    await journal.flush();
    const localState = Y.encodeStateAsUpdate(doc);
    journal.dispose();
    doc.destroy();
    server
      .getText("content")
      .insert(server.getText("content").length, "Remote change\n");
    const expected = copy(server);
    Y.applyUpdate(expected, localState);
    const expectedText = expected.getText("content").toString();
    expected.destroy();
    for (let crash = 0; crash < 2; crash++) {
      doc = copy(server);
      journal = new DraftJournal(doc, key);
      await journal.restore(true);
      journal.bind("server");
      assert.equal(doc.getText("content").toString(), expectedText);
      assert.ok(!doc.getText("content").toString().includes("DELETE THIS"));
      await journal.flush();
      journal.dispose();
      doc.destroy();
    }
  } finally {
    journal.dispose();
    doc.destroy();
    server.destroy();
  }
});

test("six draft outboxes survive repeated partitions, reversed delivery, duplicates and crash recovery", async () => {
  const server = new Y.Doc();
  server.getText("content").insert(0, "Adversarial draft fixture\n");
  const clients = Array.from({ length: 6 }, (_, number) => {
    const doc = copy(server);
    const key = `stress-${crypto.randomUUID()}`;
    const journal = new DraftJournal(doc, key);
    journal.bind("server");
    return { number, doc, key, journal };
  });
  const expected = new Set();
  const stale = copy(server);
  try {
    for (let round = 0; round < 20; round++) {
      const packets = [];
      for (const client of clients) {
        // Each writer works without seeing its peers' current batch. One CRDT
        // operation per line makes loss or duplication observable after merges.
        for (let n = 0; n < 10; n++) {
          const marker = `writer-${client.number}-round-${round}-edit-${n}-👋`;
          expected.add(marker);
          const text = client.doc.getText("content");
          text.insert(text.length, `${marker}\n`);
        }
        await client.journal.flush();
        packets.push(Y.encodeStateAsUpdate(client.doc));
      }
      // Only half the clients receive intermediate remote progress. Apply every
      // server packet twice and in reverse writer order to force idempotence.
      for (const update of packets.reverse()) {
        Y.applyUpdate(server, update);
        Y.applyUpdate(server, update);
      }
      if (round % 3 === 0) {
        const update = Y.encodeStateAsUpdate(server);
        for (const client of clients.filter(
          (c) => c.number % 2 === round % 2,
        )) {
          Y.applyUpdate(client.doc, update, "server");
        }
      }
      if (round === 7 || round === 14) {
        // A crashed tab has no live document/provider to rescue it. Reconstruct
        // each client from the deliberately stale server snapshot plus IndexedDB.
        for (const client of clients) {
          client.journal.dispose();
          client.doc.destroy();
          client.doc = copy(stale);
          client.journal = new DraftJournal(client.doc, client.key);
          await client.journal.restore(true);
          assert.equal(client.journal.pending, true);
          client.journal.bind("server");
        }
      }
    }
    const finalUpdate = Y.encodeStateAsUpdate(server);
    const finalText = server.getText("content").toString();
    const lines = finalText.trimEnd().split("\n");
    assert.equal(lines.length, expected.size + 1);
    assert.equal(
      new Set(lines).size,
      lines.length,
      "No duplicate operation may appear as duplicate prose",
    );
    for (const marker of expected) assert.ok(lines.includes(marker), marker);
    for (const client of clients) {
      Y.applyUpdate(client.doc, finalUpdate, "server");
      assert.equal(client.doc.getText("content").toString(), finalText);
      const receipt = client.journal.checkpoint();
      assert.equal(await client.journal.acknowledge(receipt), true);
      client.journal.dispose();
      client.doc.destroy();
      client.doc = copy(server);
      client.journal = new DraftJournal(client.doc, client.key);
      await client.journal.restore(true);
      assert.equal(
        client.journal.pending,
        false,
        "Exact receipts clear recovered outboxes",
      );
      assert.equal(client.doc.getText("content").toString(), finalText);
    }
  } finally {
    for (const client of clients) {
      client.journal.dispose();
      client.doc.destroy();
    }
    stale.destroy();
    server.destroy();
  }
});
