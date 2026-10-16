import * as Y from "yjs";

type Draft = { key: string; writer: string; token: string; state: Uint8Array };
let database: Promise<IDBDatabase> | undefined;
function db() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("locdoc-drafts-v1", 1);
    request.onupgradeneeded = () => {
      request.result
        .createObjectStore("drafts", { keyPath: ["key", "writer"] })
        .createIndex("document", "key");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      database = undefined;
      reject(request.error);
    };
  }));
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
async function write(record: Draft) {
  const database = await db();
  return new Promise<void>((resolve, reject) => {
    const tx = database.transaction("drafts", "readwrite");
    tx.objectStore("drafts").put(record);
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () =>
      reject(tx.error || new Error("Draft storage failed"));
  });
}
async function clear(saved: Draft[]) {
  if (!saved.length) return;
  const database = await db();
  return new Promise<void>((resolve, reject) => {
    const tx = database.transaction("drafts", "readwrite");
    const store = tx.objectStore("drafts");
    for (const record of saved) {
      const key = [record.key, record.writer];
      const request = store.get(key);
      request.onsuccess = () => {
        if (request.result?.token === record.token) store.delete(key);
      };
    }
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () =>
      reject(tx.error || new Error("Draft storage failed"));
  });
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
  return [...journals].some((journal) => journal.pending && !journal.stored);
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
  async restore(editable: boolean) {
    const drafts = await records(this.key);
    if (!editable || !drafts.length) return;
    this.restored = drafts;
    for (const draft of drafts) Y.applyUpdate(this.ydoc, draft.state, this);
    this.pending = true;
    this.stored = true;
    this.revision++;
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
    if (origin === this.remote) return;
    this.revision++;
    this.pending = true;
    this.stored = false;
    // Bound the recovery window even while input continues. A trailing debounce
    // can postpone IndexedDB storage indefinitely during key repeat or IME input.
    this.timer ??= setTimeout(() => {
      void this.flush().catch(this.failure);
    }, 250);
    this.changed();
    this.requestSave();
  };
  checkpoint() {
    if (!this.pending || this.receipt) return null;
    this.receipt = { id: crypto.randomUUID(), revision: this.revision };
    return this.receipt.id;
  }
  disconnected() {
    this.receipt = undefined;
  }
  requestSave() {
    if (!this.sendReceipt) return;
    const id = this.checkpoint();
    if (id && !this.sendReceipt(id)) this.receipt = undefined;
  }
  async flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.pending || this.stored) {
      await this.queue;
      return;
    }
    const revision = this.revision;
    const record = {
      key: this.key,
      writer: this.writer,
      token: crypto.randomUUID(),
      state: Y.encodeStateAsUpdate(this.ydoc, this.baseline),
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
    if (!this.receipt || this.receipt.id !== id) return false;
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
