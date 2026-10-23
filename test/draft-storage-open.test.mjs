import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import * as Y from "yjs";
import { DraftJournal } from "../src/drafts.ts";

// Opening draft storage gives IndexedDB a moment to answer before drafts are
// kept in this tab only. A page that is busy, as a large workspace is while
// it starts, delays IndexedDB's answer and that moment's timer alike.
function seed() {
  const ydoc = new Y.Doc();
  ydoc.getText("content").insert(0, "Accepted text");
  return ydoc;
}
const busy = (ms) => {
  const end = performance.now() + ms;
  while (performance.now() < end);
};

test("draft storage that never answers is reported unavailable", async () => {
  const original = globalThis.indexedDB;
  let opened = 0;
  globalThis.indexedDB = {
    open() {
      opened++;
      return {};
    },
  };
  const ydoc = seed();
  const journal = new DraftJournal(ydoc, crypto.randomUUID());
  try {
    const started = performance.now();
    await journal.restore(true);
    assert.equal(opened, 1);
    assert.match(journal.storageWarning, /unavailable/);
    assert.ok(performance.now() - started >= 1400, "after its wait");
  } finally {
    globalThis.indexedDB = original;
    journal.dispose();
    ydoc.destroy();
  }
});

test("a page busy for longer than the wait keeps its draft storage", async () => {
  const ydoc = seed();
  const journal = new DraftJournal(ydoc, crypto.randomUUID());
  // The open request goes out, then the page works without a break for
  // longer than IndexedDB is given to answer.
  const restoring = journal.restore(true);
  busy(1800);
  await restoring;
  assert.equal(journal.storageWarning, "", "storage is available");
  journal.bind("server");
  ydoc.getText("content").insert(13, " and a draft");
  await journal.flush();
  assert.equal(journal.stored, true, "the draft is stored");
  await journal.acknowledge(journal.checkpoint());
  journal.dispose();
  ydoc.destroy();
});
