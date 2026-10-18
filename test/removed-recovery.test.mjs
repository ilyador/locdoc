import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import * as Y from "yjs";
import { DraftJournal, archiveOwnerDrafts } from "../src/drafts.ts";
import { recoveredSource } from "../src/removed-recovery.ts";

function fixture() {
  const accepted = new Y.Doc();
  accepted.getText("content").insert(0, "Accepted text\n");
  return {
    accepted,
    bundle: {
      document: crypto.randomUUID(),
      path: "moved.fountain",
      state: Buffer.from(Y.encodeStateAsUpdate(accepted)).toString("base64"),
      liveState: null,
      collaborationEpoch: "",
      updates: [],
    },
  };
}

test("removed recovery combines durable state with this owner's offline outboxes without replaying or clearing them", async () => {
  const { accepted, bundle } = fixture();
  const edited = new Y.Doc();
  Y.applyUpdate(edited, Y.encodeStateAsUpdate(accepted));
  const journal = new DraftJournal(edited, `owner/${bundle.document}`);
  journal.bind("server");
  edited.getText("content").insert(0, "Offline edit. ");
  const guest = new DraftJournal(new Y.Doc(), `guest/${bundle.document}`);
  guest.bind("server");
  guest.ydoc.getText("content").insert(0, "Guest-private draft");
  try {
    // Export flushes this still-open owner's outbox, not unrelated namespaces.
    const drafts = await archiveOwnerDrafts(bundle.document);
    assert.equal(drafts.length, 1);
    assert.equal(
      recoveredSource(bundle, drafts),
      "Offline edit. Accepted text\n",
    );
    assert.equal(accepted.getText("content").toString(), "Accepted text\n");
    assert.equal(journal.pending, true);
    assert.equal((await archiveOwnerDrafts(bundle.document)).length, 1);
    assert.equal(guest.stored, false);
  } finally {
    await journal.flush();
    await journal.acknowledge(journal.checkpoint());
    await guest.flush();
    await guest.acknowledge(guest.checkpoint());
    journal.dispose();
    guest.dispose();
    guest.ydoc.destroy();
    accepted.destroy();
    edited.destroy();
  }
});

test("removed recovery refuses incompatible, incomplete or invisible local data instead of returning a misleading text copy", () => {
  const { accepted, bundle } = fixture();
  const edited = new Y.Doc();
  Y.applyUpdate(edited, Y.encodeStateAsUpdate(accepted));
  const vector = Y.encodeStateVector(edited);
  edited.getText("content").insert(0, "Draft. ");
  const base = {
    key: `owner/${bundle.document}`,
    writer: "writer",
    token: "token",
    formatVersion: 2,
    collaborationEpoch: "",
    state: Array.from(Y.encodeStateAsUpdate(edited, vector)),
  };
  try {
    assert.equal(recoveredSource(bundle, [base]), "Draft. Accepted text\n");
    assert.equal(
      recoveredSource(bundle, [{ ...base, collaborationEpoch: "old" }]),
      null,
    );
    assert.equal(
      recoveredSource(bundle, [{ ...base, formatVersion: 1 }]),
      null,
    );
    assert.equal(
      recoveredSource(bundle, [
        {
          ...base,
          recovery: {
            reason: "Rejected",
            text: null,
            originalWriter: "writer",
            originalToken: "token",
          },
        },
      ]),
      null,
    );
    assert.equal(
      recoveredSource(
        { ...bundle, state: Buffer.from([255]).toString("base64") },
        [],
      ),
      null,
    );
    const incomplete = new Y.Doc();
    Y.applyUpdate(incomplete, Y.encodeStateAsUpdate(accepted));
    incomplete.getText("content").insert(0, "Predecessor");
    const withoutPredecessor = Y.encodeStateVector(incomplete);
    incomplete.getText("content").insert(2, "Only delta");
    assert.equal(
      recoveredSource(bundle, [
        {
          ...base,
          state: Array.from(
            Y.encodeStateAsUpdate(incomplete, withoutPredecessor),
          ),
        },
      ]),
      null,
    );
    incomplete.getText("hidden").insert(0, "Invisible content");
    assert.equal(
      recoveredSource(bundle, [
        { ...base, state: Array.from(Y.encodeStateAsUpdate(incomplete)) },
      ]),
      null,
    );
    incomplete.destroy();
  } finally {
    accepted.destroy();
    edited.destroy();
  }
});
