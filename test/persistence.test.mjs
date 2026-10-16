import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  open,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import "fake-indexeddb/auto";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WebSocket from "ws";
import {
  createEncoder,
  writeVarUint,
  writeVarString,
  toUint8Array,
} from "lib0/encoding";
import { readVarString } from "lib0/decoding";
import { DraftJournal } from "../src/drafts.ts";

const base = "http://127.0.0.1:3487";
let dir, server;
const peers = [];
async function until(check) {
  const end = Date.now() + 7000;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(20);
  }
  throw Error("Persistence condition timed out");
}
async function request(path, body) {
  const response = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: "Bearer persistence-test",
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "locdoc-persistence-"));
  await mkdir(join(dir, "state"));
  await writeFile(join(dir, "state/owner.key"), "persistence-test");
  server = spawn("./target/debug/locdoc", [], {
    env: {
      ...process.env,
      LOCDOC_BIND: "127.0.0.1:3487",
      LOCDOC_STATE: join(dir, "state"),
      LOCDOC_DOCS: join(dir, "docs"),
      LOCDOC_PUBLIC_URL: base,
    },
    stdio: "ignore",
  });
  await until(async () => {
    if (server.exitCode !== null) throw Error("Test server exited");
    try {
      return (await fetch(base + "/api/config")).ok;
    } catch {
      return false;
    }
  });
});
function closePeers() {
  for (const { provider, drafts, ydoc } of peers) {
    drafts.dispose();
    provider.destroy();
    ydoc.destroy();
  }
  peers.length = 0;
}
afterEach(closePeers);
after(async () => {
  closePeers();
  server?.kill("SIGINT");
  if (server?.exitCode === null) await once(server, "exit");
  if (dir) await rm(dir, { recursive: true, force: true });
});
async function connect(id, draftKey = crypto.randomUUID()) {
  const snapshot = await request(`/api/docs/${id}`),
    ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, Buffer.from(snapshot.state, "base64"));
  class Socket extends WebSocket {
    constructor(url) {
      super(url, { headers: { Authorization: "Bearer persistence-test" } });
    }
  }
  const provider = new WebsocketProvider(
    base.replace("http", "ws") + "/ws",
    id,
    ydoc,
    { WebSocketPolyfill: Socket, disableBc: true, connect: false },
  );
  const drafts = new DraftJournal(ydoc, draftKey);
  await drafts.restore(true);
  drafts.bind(provider, (id) => {
    if (!provider.wsconnected || !provider.ws) return false;
    const encoder = createEncoder();
    writeVarUint(encoder, 124);
    writeVarString(encoder, id);
    provider.ws.send(toUint8Array(encoder));
    return true;
  });
  let usage = snapshot.usage;
  provider.messageHandlers[121] = () => {};
  provider.messageHandlers[127] = (_e, d) => {
    void drafts.acknowledge(readVarString(d));
  };
  provider.messageHandlers[122] = () => {};
  provider.messageHandlers[123] = (_e, d) => {
    usage = Number(readVarString(d));
  };
  provider.on("sync", (synced) => {
    if (synced) drafts.requestSave();
  });
  provider.on("connection-close", () => drafts.disconnected());
  const peer = {
    ydoc,
    provider,
    drafts,
    text: ydoc.getText("content"),
    get usage() {
      return usage;
    },
  };
  peers.push(peer);
  const ready = once(provider, "sync");
  provider.connect();
  await ready;
  return peer;
}

test("a long desktop save is never partially imported or detached by browser edits", async () => {
  const doc = await request("/api/files", { kind: "file", path: "writer.md" });
  const a = await connect(doc.id),
    b = await connect(doc.id);
  const path = join(dir, "docs/writer.md"),
    inode = (await stat(path)).ino;
  const fd = await open(path, "w");
  try {
    await fd.write("Desktop first half.");
    a.text.insert(0, "Browser addition. ");
    await until(() => b.text.toString().includes("Browser addition."));
    // Deliberately longer than any watcher debounce. No pause is a safe commit boundary.
    await delay(1200);
    assert.equal(await readFile(path, "utf8"), "Desktop first half.");
    assert.equal(a.drafts.pending, true);
    assert.equal(a.text.toString().includes("first half"), false);
    await fd.write(" Desktop second half.");
  } finally {
    await fd.close();
  }
  await until(
    () =>
      !a.drafts.pending &&
      a.text.toString().includes("Desktop first half. Desktop second half."),
  );
  assert.equal(await readFile(path, "utf8"), a.text.toString());
  assert.equal(a.text.toString(), b.text.toString());
  assert.equal((await stat(path)).ino, inode);
});

test("a completed desktop save reaches the browser immediately despite an open reader", async () => {
  const doc = await request("/api/files", { kind: "file", path: "reader.md" });
  const peer = await connect(doc.id);
  const path = join(dir, "docs/reader.md");
  const reader = await open(path, "r");
  try {
    const started = performance.now();
    await writeFile(path, "Completed desktop save with a reader still open.");
    await until(
      () =>
        peer.text.toString() ===
        "Completed desktop save with a reader still open.",
    );
    assert.ok(
      performance.now() - started < 1000,
      "Desktop import must not wait for a read handle to close",
    );
    assert.equal(peer.drafts.pending, false);
  } finally {
    await reader.close();
  }
});

test("three concurrent collaborators retain every insertion and settle independent save receipts", async () => {
  const doc = await request("/api/files", {
    kind: "file",
    path: "receipts.md",
  });
  const collaborators = await Promise.all([
    connect(doc.id),
    connect(doc.id),
    connect(doc.id),
  ]);
  const baseline = collaborators[0].text.toString();
  const expected = [];
  for (let i = 0; i < 30; i++) {
    for (const [writer, peer] of collaborators.entries()) {
      const token = `[${writer}:${i}]`;
      expected.push(token);
      peer.text.insert(peer.text.length, token + " ");
    }
    await delay(5);
  }
  await until(
    () =>
      collaborators.every((peer) => !peer.drafts.pending) &&
      collaborators.every(
        (peer) => peer.text.toString() === collaborators[0].text.toString(),
      ),
  );
  const saved = await readFile(join(dir, "docs/receipts.md"), "utf8");
  assert.equal(saved, collaborators[0].text.toString());
  assert.ok(saved.startsWith(baseline));
  const tokens = saved.slice(baseline.length).trim().split(/\s+/);
  assert.equal(tokens.length, expected.length);
  for (const token of expected)
    assert.equal(tokens.filter((value) => value === token).length, 1, token);
  const reopened = await connect(doc.id);
  assert.equal(reopened.text.toString(), saved);
  assert.equal(reopened.drafts.pending, false);
});

test("reopening an offline draft merges ongoing collaborators and desktop edits without lost or duplicate operations", async () => {
  const doc = await request("/api/files", {
    kind: "file",
    path: "offline-collaboration.md",
  });
  const a = await connect(doc.id),
    b = await connect(doc.id),
    draftKey = crypto.randomUUID(),
    offline = await connect(doc.id, draftKey);
  offline.provider.disconnect();
  await until(() => !offline.provider.wsconnected);
  const expected = [];
  for (let i = 0; i < 15; i++) {
    for (const [writer, peer] of [a, b, offline].entries()) {
      const token = `[${writer}:${i}]`;
      expected.push(token);
      peer.text.insert(0, token + " ");
    }
    await delay(5);
  }
  await offline.drafts.flush();
  assert.equal(offline.drafts.pending, true);
  assert.equal(offline.drafts.stored, true);
  await until(() => !a.drafts.pending && !b.drafts.pending);
  assert.ok(!a.text.toString().includes("[2:"));
  assert.ok(!b.text.toString().includes("[2:"));
  offline.drafts.dispose();
  offline.provider.destroy();
  offline.ydoc.destroy();
  peers.splice(peers.indexOf(offline), 1);

  const path = join(dir, "docs/offline-collaboration.md");
  await writeFile(
    path,
    (await readFile(path, "utf8")) + "\nDesktop addition.\n",
  );
  await until(
    () =>
      a.text.toString().includes("Desktop addition.") &&
      b.text.toString().includes("Desktop addition."),
  );
  const recovered = await connect(doc.id, draftKey);
  await until(
    () =>
      [a, b, recovered].every((peer) => !peer.drafts.pending) &&
      a.text.toString() === b.text.toString() &&
      a.text.toString() === recovered.text.toString(),
  );
  const saved = await readFile(path, "utf8");
  assert.equal(saved, recovered.text.toString());
  assert.ok(saved.endsWith("\nDesktop addition.\n"));
  const tokens = saved.split(/\s+/);
  for (const token of expected)
    assert.equal(tokens.filter((value) => value === token).length, 1, token);
  const reopened = await connect(doc.id, draftKey);
  assert.equal(reopened.text.toString(), saved);
  assert.equal(reopened.drafts.pending, false);
});

test("removing embeds immediately frees capacity while undo and restoration retain local media", async () => {
  const doc = await request("/api/files", { kind: "file", path: "quota.md" }),
    a = await connect(doc.id);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFlsAAAAASUVORK5CYII=",
    "base64",
  );
  const large = Buffer.alloc(5_000_000);
  png.copy(large);
  async function upload(bytes) {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "image/png" }), "test.png");
    const r = await fetch(base + `/api/docs/${doc.id}/upload`, {
      method: "POST",
      headers: { Authorization: "Bearer persistence-test" },
      body: form,
    });
    return { status: r.status, body: await r.json() };
  }
  const uploads = [];
  for (let i = 0; i < 10; i++) {
    const r = await upload(large);
    assert.equal(r.status, 200);
    uploads.push(r.body.path);
    a.text.insert(a.text.length, `\n![image](${r.body.path})\n`);
    await until(() => !a.drafts.pending);
  }
  assert.equal((await request(`/api/docs/${doc.id}`)).usage, 50_000_000);
  assert.equal((await upload(png)).status, 400);
  a.text.delete(0, a.text.length);
  a.text.insert(0, "No attachments now");
  await until(() => !a.drafts.pending && a.usage === 0);
  assert.equal((await request(`/api/docs/${doc.id}`)).usage, 0);
  assert.equal((await upload(png)).status, 200);
  assert.equal((await stat(join(dir, "docs", uploads[0]))).size, 5_000_000);
  // The old path remains usable for undo; it counts again only when referenced.
  a.text.insert(a.text.length, `\n![restored](${uploads[0]})\n`);
  await until(() => !a.drafts.pending);
  assert.ok((await request(`/api/docs/${doc.id}`)).usage >= 5_000_000);
});
