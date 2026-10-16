import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rename,
  open,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
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

const base = "http://127.0.0.1:3497";
let dir, server;
const providers = [];
async function until(check, timeout = 7000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  throw Error("Adversarial sync condition timed out");
}
async function request(path, body) {
  const response = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: "Bearer adversarial-sync-test",
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "locdoc-adversarial-sync-"));
  await mkdir(join(dir, "state"));
  await writeFile(join(dir, "state/owner.key"), "adversarial-sync-test");
  await startServer();
});
async function startServer() {
  server = spawn("./target/debug/locdoc", [], {
    env: {
      ...process.env,
      LOCDOC_BIND: "127.0.0.1:3497",
      LOCDOC_STATE: join(dir, "state"),
      LOCDOC_DOCS: join(dir, "docs"),
      LOCDOC_PUBLIC_URL: base,
    },
    stdio: "ignore",
  });
  await until(async () => {
    if (server.exitCode !== null) throw Error("Adversarial test server exited");
    try {
      return (await fetch(base + "/api/config")).ok;
    } catch {
      return false;
    }
  });
}
after(async () => {
  for (const provider of providers) {
    provider.destroy();
    provider.doc.destroy();
  }
  server?.kill("SIGINT");
  if (server?.exitCode === null) await once(server, "exit");
  if (dir) await rm(dir, { recursive: true, force: true });
});
async function connect(id) {
  const snapshot = await request(`/api/docs/${id}`),
    ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, Buffer.from(snapshot.state, "base64"));
  class Socket extends WebSocket {
    constructor(url) {
      super(url, {
        headers: { Authorization: "Bearer adversarial-sync-test" },
      });
    }
  }
  const provider = new WebsocketProvider(
    base.replace("http", "ws") + "/ws",
    id,
    ydoc,
    { WebSocketPolyfill: Socket, disableBc: true, connect: false },
  );
  for (const kind of [121, 122, 123, 127])
    provider.messageHandlers[kind] = () => {};
  providers.push(provider);
  const synced = once(provider, "sync");
  provider.connect();
  await synced;
  return { ydoc, provider, text: ydoc.getText("content") };
}

test("a destructive desktop atomic replacement preserves accepted browser edits in owner-restorable history across restart", async () => {
  const doc = await request("/api/files", {
    kind: "file",
    path: "atomic-save.md",
  });
  const a = await connect(doc.id),
    b = await connect(doc.id);
  const path = join(dir, "docs/atomic-save.md"),
    tmp = path + ".tmp";
  const desktopBaseline = await readFile(path, "utf8");
  // Typical safe-write editor: prepare a replacement inode while the original
  // Markdown remains readable. The original file has no write handle to lease.
  const fd = await open(tmp, "w");
  await fd.write(desktopBaseline + "Desktop addition.\n");
  for (let i = 0; i < 8; i++) {
    a.text.insert(a.text.length, `Browser-${i}.\n`);
    await delay(25);
  }
  await until(
    async () =>
      (await readFile(path, "utf8")) === a.text.toString() &&
      a.text.toString() === b.text.toString(),
  );
  assert.ok((await readFile(path, "utf8")).includes("Browser-7."));
  await fd.sync();
  await fd.close();
  await rename(tmp, path);
  await until(
    () =>
      a.text.toString().includes("Desktop addition.") &&
      a.text.toString() === b.text.toString(),
  );
  const saved = await readFile(path, "utf8");
  assert.ok(saved.includes("Desktop addition."));
  // A whole-file desktop save has no causal base identifier. Importing its
  // intentional deletions is valid, but accepted web text must remain recoverable.
  server.kill("SIGINT");
  await once(server, "exit");
  await startServer();
  const history = await request(`/api/docs/${doc.id}/versions`);
  const versions = await Promise.all(
    history.versions.map((version) =>
      request(`/api/docs/${doc.id}/versions/${version.id}`),
    ),
  );
  const recovered = versions.some((version) =>
    Array.from({ length: 8 }, (_, i) => `Browser-${i}.`).every((token) =>
      version.content.includes(token),
    ),
  );
  assert.ok(
    recovered,
    "A destructive atomic desktop replacement must preserve the previously accepted browser version in durable owner history",
  );
});

function checkpoint(provider, id) {
  const encoder = createEncoder();
  writeVarUint(encoder, 124);
  writeVarString(encoder, id);
  provider.ws.send(toUint8Array(encoder));
}
test("checkpoint retries and disconnected clients cannot exhaust the room receipt budget", async () => {
  const doc = await request("/api/files", {
    kind: "file",
    path: "receipt-exhaustion.md",
  });
  const attacker = await connect(doc.id),
    victim = await connect(doc.id);
  const fd = await open(join(dir, "docs/receipt-exhaustion.md"), "r+");
  const replies = [],
    failures = [];
  attacker.provider.messageHandlers[122] = (_e, decoder) =>
    replies.push(readVarString(decoder));
  attacker.provider.messageHandlers[125] = (_e, decoder) => {
    failures.push(readVarString(decoder));
    attacker.provider.disconnect();
  };
  const victimReplies = [],
    victimFailures = [];
  victim.provider.messageHandlers[122] = (_e, decoder) =>
    victimReplies.push(readVarString(decoder));
  victim.provider.messageHandlers[125] = (_e, decoder) => {
    victimFailures.push(readVarString(decoder));
    victim.provider.disconnect();
  };
  try {
    victim.text.insert(victim.text.length, "Pending browser edit.");
    await until(() =>
      attacker.text.toString().includes("Pending browser edit."),
    );
    const ids = Array.from({ length: 128 }, () => crypto.randomUUID());
    for (const id of ids) checkpoint(attacker.provider, id);
    await until(() => replies.length === 128 || failures.length);
    assert.equal(failures.length, 0);
    checkpoint(attacker.provider, ids.at(-1));
    await until(() => replies.length === 129 || failures.length);
    assert.equal(
      failures.length,
      0,
      "Retrying an existing checkpoint must be idempotent even at the pending-receipt limit",
    );
    attacker.provider.disconnect();
    await delay(100);
    const victimId = crypto.randomUUID();
    checkpoint(victim.provider, victimId);
    await until(
      () => victimReplies.includes(victimId) || victimFailures.length,
    );
    assert.equal(
      victimFailures.length,
      0,
      "Disconnected clients must not reserve receipt capacity and prevent another editor from saving",
    );
    await fd.close();
    await until(async () =>
      (
        await readFile(join(dir, "docs/receipt-exhaustion.md"), "utf8")
      ).includes("Pending browser edit."),
    );
  } finally {
    await fd.close().catch(() => {});
  }
});

test("seeded mixed editing, undo, offline peers, and repeated restart converge to the complete CRDT oracle", async () => {
  const doc = await request("/api/files", {
    kind: "file",
    path: "mixed-oracle.md",
  });
  const peers = await Promise.all([
    connect(doc.id),
    connect(doc.id),
    connect(doc.id),
  ]);
  const oracle = new Y.Doc();
  Y.applyUpdate(oracle, Y.encodeStateAsUpdate(peers[0].ydoc));
  const managers = peers.map(
    (peer) => new Y.UndoManager(peer.text, { captureTimeout: 0 }),
  );
  const listeners = peers.map((peer) => {
    const update = (bytes) => Y.applyUpdate(oracle, bytes);
    peer.ydoc.on("update", update);
    return update;
  });
  let seed = 0x4c6f6364;
  const random = (max) => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % max;
  };
  const rounds = Number(process.env.LOCDOC_SYNC_SOAK_ROUNDS || 70);
  const deadline = Math.max(7000, rounds * 20);
  const stable = () =>
    peers.every(
      (peer) =>
        peer.provider.wsconnected &&
        peer.provider.synced &&
        peer.text.toString() === oracle.getText("content").toString(),
    );
  try {
    for (let step = 0; step < rounds; step++) {
      const writer = step % peers.length,
        peer = peers[writer];
      if (step % 23 === 0) peer.provider.disconnect();
      const points = [0];
      for (const char of peer.text.toString())
        points.push(points.at(-1) + char.length);
      const position = points[random(points.length)];
      peer.text.insert(position, `[${writer}:${step}:☕👋]`);
      if (step % 5 === 0 && points.length > 2) {
        const from = random(points.length - 1),
          to = Math.min(from + 2, points.length - 1);
        // Calculate fresh safe boundaries so no operation splits an emoji.
        const fresh = [0];
        for (const char of peer.text.toString())
          fresh.push(fresh.at(-1) + char.length);
        const lower = Math.min(from, fresh.length - 2),
          upper = Math.min(to, fresh.length - 1);
        peer.text.delete(fresh[lower], fresh[upper] - fresh[lower]);
      }
      if (step % 7 === 0) managers[writer].undo();
      if (step % 11 === 0) managers[writer].redo();
      if (step % 23 === 7)
        for (const current of peers) current.provider.connect();
      if (
        [Math.floor(rounds / 3), Math.floor((rounds * 2) / 3)].includes(step)
      ) {
        server.kill("SIGINT");
        await once(server, "exit");
        await delay(80);
        await startServer();
        for (const current of peers) current.provider.connect();
      }
      await delay(40);
    }
    for (const peer of peers) peer.provider.connect();
    await until(stable, deadline);
    const expected = oracle.getText("content").toString();
    await until(
      async () =>
        (await readFile(join(dir, "docs/mixed-oracle.md"), "utf8")) ===
        expected,
      deadline,
    );
    const reopened = await connect(doc.id);
    assert.equal(
      reopened.text.toString(),
      expected,
      `Mixed-sync failure after seed 0x4c6f6364 (${rounds} rounds)`,
    );
    const remoteState = new Y.Doc();
    Y.applyUpdate(
      remoteState,
      Buffer.from((await request(`/api/docs/${doc.id}`)).state, "base64"),
    );
    assert.equal(remoteState.getText("content").toString(), expected);
    remoteState.destroy();
  } finally {
    peers.forEach((peer, index) => peer.ydoc.off("update", listeners[index]));
    for (const manager of managers) manager.destroy();
    oracle.destroy();
  }
});
