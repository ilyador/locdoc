import * as Y from "yjs";

type RecoveryRecord = {
  reason: string;
  text: string | null;
  originalWriter: string;
  originalToken: string;
  originals?: {
    writer: string;
    token: string;
    state: Uint8Array;
    formatVersion?: number;
    collaborationEpoch?: string;
  }[];
};
type Draft = {
  key: string;
  writer: string;
  token: string;
  state: Uint8Array;
  formatVersion?: number;
  collaborationEpoch?: string;
  recovery?: RecoveryRecord;
};
export type DraftArchive = Omit<Draft, "state" | "recovery"> & {
  state: unknown;
  recovery?: Omit<RecoveryRecord, "originals"> & {
    originals?: (Omit<
      NonNullable<RecoveryRecord["originals"]>[number],
      "state"
    > & {
      state: unknown;
    })[];
  };
};
// Explicit recovery reads the outbox without replaying or deleting it. Only the
// owner's document namespace is included, never a guest link's local identity.
export async function archiveOwnerDrafts(
  document: string,
): Promise<DraftArchive[]> {
  const key = `owner/${document}`;
  await Promise.all(
    [...journals]
      .filter((journal) => journal.key === key)
      .map((journal) => journal.flush()),
  );
  const saved = new Map(
    (await records(key)).map((record) => [recoveryId(record), record]),
  );
  for (const { record } of recoveryMemory.values())
    if (record.key === key) saved.set(recoveryId(record), record);
  return [...saved.values()].map((record) => ({
    ...record,
    state:
      record.state instanceof Uint8Array
        ? Array.from(record.state)
        : record.state,
    ...(record.recovery
      ? {
          recovery: {
            ...record.recovery,
            originals: record.recovery.originals?.map((original) => ({
              ...original,
              state:
                original.state instanceof Uint8Array
                  ? Array.from(original.state)
                  : original.state,
            })),
          },
        }
      : {}),
  }));
}
export type DraftRecovery = {
  id: string;
  reason: string;
  text: string | null;
  update: Uint8Array;
  formatVersion: number;
  collaborationEpoch?: string;
  rawState?: unknown;
  originalUpdates?: {
    update: Uint8Array;
    formatVersion: number;
    collaborationEpoch?: string;
    rawState?: unknown;
  }[];
};
// Keep failed archive writes alive across document navigation. Losing a browser
// storage permission must not turn a preserved-in-memory draft into "saved".
const recoveryMemory = new Map<string, { record: Draft; durable: boolean }>();
const recoveryId = (record: Draft) => `${record.writer}/${record.token}`;
// How long IndexedDB may take to open before drafts are kept in memory only.
// Only time in which the page could have taken the answer counts: a page busy
// for longer, as while it starts, would otherwise give up on an answer that
// is already waiting behind its work.
const OPEN_WAIT = 1500;
const OPEN_STEP = 100;
let database: Promise<IDBDatabase> | undefined;
function db() {
  if (!database) {
    database = new Promise<IDBDatabase>((resolve, reject) => {
      let finished = false;
      let waited = 0;
      let last = performance.now();
      let timeout: ReturnType<typeof setTimeout>;
      const wait = () => {
        const now = performance.now();
        // A step that ran late waited for the page's other work.
        waited += Math.min(Math.max(0, now - last), OPEN_STEP);
        last = now;
        if (waited < OPEN_WAIT) {
          timeout = setTimeout(wait, OPEN_STEP);
          return;
        }
        finished = true;
        reject(new Error("Browser draft storage did not respond"));
      };
      timeout = setTimeout(wait, OPEN_STEP);
      const fail = (error: unknown) => {
        clearTimeout(timeout);
        finished = true;
        reject(error);
      };
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open("locdoc-drafts-v1", 1);
      } catch (error) {
        fail(error);
        return;
      }
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("drafts"))
          request.result
            .createObjectStore("drafts", { keyPath: ["key", "writer"] })
            .createIndex("document", "key");
      };
      request.onsuccess = () => {
        clearTimeout(timeout);
        if (finished) {
          request.result.close();
          return;
        }
        request.result.onversionchange = () => {
          request.result.close();
          database = undefined;
        };
        resolve(request.result);
      };
      request.onerror = () => fail(request.error);
      request.onblocked = () =>
        fail(new Error("Browser draft storage is blocked"));
    }).catch((error) => {
      database = undefined;
      throw error;
    });
  }
  return database;
}
async function records(key: string): Promise<Draft[]> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = database
      .transaction("drafts")
      .objectStore("drafts")
      .index("document")
      .getAll(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function mutate(change: (store: IDBObjectStore) => void) {
  const database = await db();
  return new Promise<void>((resolve, reject) => {
    const tx = database.transaction("drafts", "readwrite");
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () =>
      reject(tx.error || new Error("Draft storage failed"));
    try {
      change(tx.objectStore("drafts"));
    } catch (error) {
      // A synchronous quota/clone error does not automatically roll back
      // earlier queued deletes. Never remove an outbox without its archive.
      tx.abort();
      reject(error);
    }
  });
}
async function write(record: Draft) {
  return mutate((store) => {
    store.put(record);
  });
}
function deleteUnchanged(store: IDBObjectStore, record: Draft) {
  const key = [record.key, record.writer];
  const request = store.get(key);
  request.onsuccess = () => {
    if (request.result?.token === record.token) store.delete(key);
  };
}
async function clear(saved: Draft[]) {
  if (!saved.length) return;
  return mutate((store) => {
    for (const record of saved) deleteUnchanged(store, record);
  });
}
async function archive(originals: Draft[], copies: Draft[]) {
  return mutate((store) => {
    for (const original of originals) deleteUnchanged(store, original);
    for (const copy of copies) store.put(copy);
  });
}
export function plainText(doc: Y.Doc) {
  if ([...doc.share.keys()].some((name) => name !== "content")) return false;
  const content = doc.share.get("content");
  return (
    content instanceof Y.Text &&
    content
      .toDelta()
      .every(
        (entry: { insert?: unknown; attributes?: unknown }) =>
          typeof entry.insert === "string" && !entry.attributes,
      )
  );
}
export async function textHash(text: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
const journals = new Set<DraftJournal>();
export function hasUnstoredDrafts() {
  return (
    [...journals].some((journal) => journal.pending && !journal.stored) ||
    [...recoveryMemory.values()].some((entry) => !entry.durable)
  );
}

// Each open session has its own outbox record. Another tab or an upload finishing
// in a background session cannot overwrite or acknowledge this session's draft.
export class DraftJournal {
  readonly writer = crypto.randomUUID();
  readonly ydoc: Y.Doc;
  readonly key: string;
  private readonly baseline: Uint8Array;
  pending = false;
  stored = true;
  private revision = 0;
  private restored: Draft[] = [];
  private own: Draft | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private remote: unknown;
  private sendReceipt?: (id: string) => boolean;
  private receipt: { id: string; revision: number } | undefined;
  private changed: () => void;
  private failure: () => void;
  private disposed = false;
  private rejected = false;
  private collaborationEpoch = "";
  storageWarning = "";
  get recoveries(): DraftRecovery[] {
    return [...recoveryMemory.values()]
      .filter(({ record }) => record.key === this.key)
      .map(({ record }) => ({
        id: recoveryId(record),
        reason: record.recovery!.reason,
        text: record.recovery!.text,
        update:
          record.state instanceof Uint8Array ? record.state : new Uint8Array(),
        ...(record.state instanceof Uint8Array
          ? {}
          : { rawState: record.state }),
        formatVersion: record.formatVersion ?? 1,
        collaborationEpoch: record.collaborationEpoch,
        originalUpdates: record.recovery?.originals?.map((original) => ({
          update:
            original.state instanceof Uint8Array
              ? original.state
              : new Uint8Array(),
          ...(original.state instanceof Uint8Array
            ? {}
            : { rawState: original.state }),
          formatVersion: original.formatVersion ?? 1,
          collaborationEpoch: original.collaborationEpoch,
        })),
      }));
  }
  private storageFailed = () => {
    this.storageWarning =
      "Local draft storage is unavailable. Keep this tab open while changes are pending.";
    this.failure();
    this.changed();
  };
  constructor(
    ydoc: Y.Doc,
    key: string,
    changed: () => void = () => {},
    failure: () => void = () => {},
  ) {
    this.ydoc = ydoc;
    this.key = key;
    // The fetched bootstrap is already durable on the server. Keep only its
    // causal delta in the browser outbox, including deletions of baseline text.
    this.baseline = Y.encodeStateVector(ydoc);
    this.changed = changed;
    this.failure = failure;
    journals.add(this);
  }
  async restore(
    editable: boolean,
    options: { lineEndingMigrated?: boolean; collaborationEpoch?: string } = {},
  ) {
    this.collaborationEpoch = options.collaborationEpoch ?? "";
    // A viewer has no outbox to replay; unavailable IndexedDB must not block a
    // public read-only document or even delay it for a storage permission.
    if (!editable) return;
    let drafts: Draft[];
    try {
      drafts = await records(this.key);
    } catch {
      this.storageFailed();
      return;
    }
    let trial = new Y.Doc();
    trial.getText("content");
    Y.applyUpdate(trial, Y.encodeStateAsUpdate(this.ydoc));
    const quarantined: {
      record: Draft;
      reason: string;
      text: string | null;
    }[] = [];
    try {
      for (const draft of drafts) {
        if (draft.recovery) {
          recoveryMemory.set(recoveryId(draft), {
            record: draft,
            durable: true,
          });
          continue;
        }
        if (
          [...recoveryMemory.values()].some(
            ({ record }) =>
              record.key === this.key &&
              ((record.recovery?.originalWriter === draft.writer &&
                record.recovery.originalToken === draft.token) ||
                record.recovery?.originals?.some(
                  (original) =>
                    original.writer === draft.writer &&
                    original.token === draft.token,
                )),
          )
        )
          continue;
        if ((draft.collaborationEpoch ?? "") !== this.collaborationEpoch) {
          quarantined.push({
            record: draft,
            reason:
              "This document was rebuilt from its saved text. Download the previous draft for recovery instead of merging incompatible history.",
            text: null,
          });
          continue;
        }
        if (options.lineEndingMigrated && (draft.formatVersion ?? 1) < 2) {
          quarantined.push({
            record: draft,
            reason:
              "This older draft used different line endings. Download it for recovery instead of merging it automatically.",
            text: null,
          });
          continue;
        }
        let candidate: Y.Doc | undefined;
        try {
          if (!(draft.state instanceof Uint8Array))
            throw new Error("Invalid draft update");
          candidate = new Y.Doc();
          candidate.getText("content");
          Y.applyUpdate(candidate, Y.encodeStateAsUpdate(trial));
          Y.applyUpdate(candidate, draft.state);
          if (!plainText(candidate)) throw new Error("Draft is not plain text");
          trial.destroy();
          trial = candidate;
          candidate = undefined;
          this.restored.push(draft);
        } catch {
          quarantined.push({
            record: draft,
            reason:
              "This local draft could not be merged safely. Its original update is available for recovery.",
            text: null,
          });
        } finally {
          candidate?.destroy();
        }
      }
      if (this.restored.length) {
        Y.applyUpdate(
          this.ydoc,
          Y.encodeStateAsUpdate(trial, Y.encodeStateVector(this.ydoc)),
          this,
        );
        this.pending = true;
        this.stored = true;
        this.revision++;
      }
    } finally {
      trial.destroy();
    }
    await this.quarantine(quarantined);
    this.changed();
  }
  private async quarantine(
    entries: { record: Draft; reason: string; text: string | null }[],
    originals: Draft[] = [],
  ) {
    if (!entries.length) return;
    const copies = entries.map(({ record, reason, text }) => ({
      ...record,
      writer: crypto.randomUUID(),
      token: crypto.randomUUID(),
      recovery: {
        reason,
        text,
        originalWriter: record.writer,
        originalToken: record.token,
        originals: originals.map(
          ({ writer, token, state, formatVersion, collaborationEpoch }) => ({
            writer,
            token,
            state,
            formatVersion,
            collaborationEpoch,
          }),
        ),
      },
    }));
    for (const record of copies)
      recoveryMemory.set(recoveryId(record), { record, durable: false });
    try {
      await archive(
        [...entries.map(({ record }) => record), ...originals],
        copies,
      );
      for (const record of copies)
        recoveryMemory.set(recoveryId(record), { record, durable: true });
    } catch {
      this.storageFailed();
    }
  }
  async reject(reason: string) {
    if (this.rejected) {
      await this.queue;
      return;
    }
    this.rejected = true;
    this.receipt = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.pending && !this.restored.length && !this.own) return;
    const task = this.queue
      .catch(() => {})
      .then(async () => {
        const current: Draft = {
          key: this.key,
          writer: this.writer,
          token: crypto.randomUUID(),
          state: Y.encodeStateAsUpdate(this.ydoc, this.baseline),
          formatVersion: 2,
          collaborationEpoch: this.collaborationEpoch,
        };
        await this.quarantine(
          [
            {
              record: current,
              reason,
              text: this.ydoc.getText("content").toString(),
            },
          ],
          [...this.restored, ...(this.own ? [this.own] : [])],
        );
        this.own = undefined;
        this.restored = [];
        this.pending = false;
        this.stored = true;
        this.changed();
      });
    this.queue = task;
    await task;
  }
  async clearRecovery(id: string) {
    const saved = recoveryMemory.get(id);
    if (!saved || saved.record.key !== this.key) return;
    await clear([
      saved.record,
      {
        ...saved.record,
        writer: saved.record.recovery!.originalWriter,
        token: saved.record.recovery!.originalToken,
      },
      ...(saved.record.recovery!.originals ?? []).map((original) => ({
        ...saved.record,
        writer: original.writer,
        token: original.token,
      })),
    ]);
    recoveryMemory.delete(id);
    this.changed();
  }
  bind(remote: unknown, sendReceipt?: (id: string) => boolean) {
    this.remote = remote;
    this.sendReceipt = sendReceipt;
    this.ydoc.on("update", this.onUpdate);
    this.changed();
  }
  private onUpdate = (_update: Uint8Array, origin: unknown) => {
    // Only our own edits create outbox work. Remote changes cannot invalidate
    // the receipt for edits we already submitted on this ordered connection.
    if (origin === this.remote || this.rejected) return;
    this.revision++;
    this.pending = true;
    this.stored = false;
    // Bound the recovery window even while input continues. A trailing debounce
    // can postpone IndexedDB storage indefinitely during key repeat or IME input.
    this.timer ??= setTimeout(() => {
      void this.flush().catch(this.storageFailed);
    }, 250);
    this.changed();
    this.requestSave();
  };
  checkpoint() {
    if (this.rejected || !this.pending || this.receipt) return null;
    this.receipt = { id: crypto.randomUUID(), revision: this.revision };
    return this.receipt.id;
  }
  disconnected() {
    this.receipt = undefined;
  }
  requestSave() {
    if (this.rejected || !this.sendReceipt) return;
    const id = this.checkpoint();
    if (id && !this.sendReceipt(id)) this.receipt = undefined;
  }
  async flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.rejected || !this.pending || this.stored) {
      await this.queue;
      return;
    }
    const revision = this.revision;
    const record = {
      key: this.key,
      writer: this.writer,
      token: crypto.randomUUID(),
      state: Y.encodeStateAsUpdate(this.ydoc, this.baseline),
      formatVersion: 2,
      collaborationEpoch: this.collaborationEpoch,
    };
    const task = this.queue
      .catch(() => {})
      .then(async () => {
        await write(record);
        this.own = record;
        if (this.revision === revision) this.stored = true;
        this.changed();
      });
    this.queue = task;
    await task;
  }
  async acknowledge(id: string) {
    if (this.rejected || !this.receipt || this.receipt.id !== id) return false;
    const revision = this.receipt.revision;
    this.receipt = undefined;
    if (this.revision !== revision) {
      this.requestSave();
      return false;
    }
    // Queue before changing pending: a subsequent local edit must enqueue after
    // this conditional delete, and an earlier write must finish before it.
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = false;
    this.stored = true;
    const restored = this.restored;
    this.restored = [];
    const task = this.queue
      .catch(() => {})
      .then(async () => {
        await clear([...restored, ...(this.own ? [this.own] : [])]);
        this.own = undefined;
      });
    this.queue = task;
    await task;
    if (!this.disposed) this.changed();
    return true;
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.ydoc.off("update", this.onUpdate);
    journals.delete(this);
  }
}
