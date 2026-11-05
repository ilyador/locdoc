import * as Y from "yjs";
import {
  appendAcceptedUpdate,
  offlineList,
  scopedKey,
  type OfflineScope,
} from "./offline-db.ts";

export function base64State(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
export const replicaKey = (scope: string, path: string, epoch: string) =>
  `${scopedKey(scope, path)}|${epoch}|`;

// Only server-originated updates and receipt-confirmed local edits enter
// this replica. Unacknowledged edits belong exclusively to DraftJournal.
// Small deltas avoid rewriting a whole script on every acknowledgement.
export class OfflineReplica {
  private replica = new Y.Doc();
  private closed = false;
  private writes = Promise.resolve();
  private scope: OfflineScope;
  private path: string;
  private epoch: string;
  constructor(
    scope: OfflineScope,
    path: string,
    epoch: string,
    bootstrap: Uint8Array,
  ) {
    this.scope = scope;
    this.path = path;
    this.epoch = epoch;
    Y.applyUpdate(this.replica, bootstrap);
  }
  private append(update: Uint8Array) {
    if (update.length <= 2) return this.writes;
    const key = replicaKey(this.scope.scope, this.path, this.epoch);
    const task = this.writes.then(() =>
      appendAcceptedUpdate(key, update, Y.mergeUpdates),
    );
    this.writes = task.catch(() => {});
    return task;
  }
  remote(update: Uint8Array) {
    const delta = Y.diffUpdate(update, Y.encodeStateVector(this.replica));
    return this.append(delta).then(() => {
      if (!this.closed) Y.applyUpdate(this.replica, delta);
    });
  }
  accepted(document: Y.Doc) {
    const update = Y.encodeStateAsUpdate(
      document,
      Y.encodeStateVector(this.replica),
    );
    // Advance only after persistence. A failed append is offered again on
    // the next receipt; it never clears the draft's only surviving copy.
    return this.append(update).then(() => {
      if (!this.closed) Y.applyUpdate(this.replica, update);
    });
  }
  destroy() {
    this.closed = true;
    this.replica.destroy();
  }
}

export async function acceptedUpdates(
  scope: OfflineScope,
  path: string,
  epoch: string,
) {
  return offlineList<Uint8Array>(
    "updates",
    replicaKey(scope.scope, path, epoch),
  );
}
