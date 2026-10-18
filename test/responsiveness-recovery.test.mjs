import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WebSocket from "ws";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import { readVarString } from "lib0/decoding";
import {
  createEncoder,
  writeVarUint,
  writeVarString,
  writeVarUint8Array,
  toUint8Array,
} from "lib0/encoding";

const base = "http://127.0.0.1:3553";
const key = "isolated-responsiveness-recovery-test";
let directory, server;
let serverLog = "";
const peers = [];
async function until(check, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(15);
  }
  throw Error(
    "Isolated responsiveness/recovery condition timed out; server: " +
      serverLog.slice(-1500),
  );
}
async function response(path, body) {
  return fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function request(path, body) {
  const result = await response(path, body);
  assert.equal(result.status, 200, await result.clone().text());
  return result.json();
}
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "locdoc-responsive-recovery-"));
  await mkdir(join(directory, "state"));
  await writeFile(join(directory, "state/owner.key"), key);
  server = spawn("./target/debug/locdoc", [], {
    env: {
      ...process.env,
      LOCDOC_BIND: "127.0.0.1:3553",
      LOCDOC_STATE: join(directory, "state"),
      LOCDOC_DOCS: join(directory, "docs"),
      LOCDOC_PUBLIC_URL: base,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (chunk) => {
    serverLog = (serverLog + chunk.toString()).slice(-4000);
  });
  server.stdout.on("data", (chunk) => {
    serverLog = (serverLog + chunk.toString()).slice(-4000);
  });
  await until(async () => {
    if (server.exitCode !== null) throw Error("Isolated test server exited");
    try {
      return (await fetch(base + "/api/config")).ok;
    } catch {
      return false;
    }
  });
});
afterEach(() => {
  for (const peer of peers.splice(0)) {
    peer.provider.destroy();
    peer.ydoc.destroy();
  }
});
after(async () => {
  server?.kill("SIGINT");
  if (server?.exitCode === null) await once(server, "exit");
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function connect(id, snapshot, prepare) {
  snapshot ??= await request(`/api/docs/${id}`);
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, Buffer.from(snapshot.state, "base64"));
  prepare?.(ydoc);
  const rawFrames = [],
    connectionFailures = [];
  class OwnerSocket extends WebSocket {
    constructor(url) {
      super(url, { headers: { Authorization: `Bearer ${key}`, Origin: base } });
      this.on("message", (bytes) =>
        rawFrames.push([...new Uint8Array(bytes)].slice(0, 6)),
      );
      this.on("unexpected-response", (_request, response) =>
        connectionFailures.push(response.statusCode),
      );
    }
  }
  const provider = new WebsocketProvider(
    base.replace("http", "ws") + "/ws",
    id,
    ydoc,
    {
      WebSocketPolyfill: OwnerSocket,
      disableBc: true,
      connect: false,
      params: {
        client: "plain-text-v2",
        epoch: snapshot.collaborationEpoch || "",
      },
    },
  );
  const errors = [];
  const receipts = new Set();
  for (const kind of [121, 122, 123]) provider.messageHandlers[kind] = () => {};
  provider.messageHandlers[127] = (_encoder, decoder) =>
    receipts.add(readVarString(decoder));
  provider.messageHandlers[125] = (_encoder, decoder) => {
    errors.push(readVarString(decoder));
    provider.disconnect();
  };
  provider.messageHandlers[120] = (_encoder, decoder) =>
    errors.push(readVarString(decoder));
  const peer = {
    ydoc,
    provider,
    text: ydoc.getText("content"),
    errors,
    receipts,
  };
  peers.push(peer);
  provider.connect();
  try {
    await until(() => provider.synced || errors.length);
  } catch (error) {
    throw Error(
      `${error.message}; connection ${JSON.stringify({ status: provider.wsconnected, shouldConnect: provider.shouldConnect, errors, epoch: snapshot.collaborationEpoch, rawFrames, connectionFailures, url: provider.url })}`,
    );
  }
  return peer;
}

async function saved(peer) {
  const id = crypto.randomUUID();
  const frame = createEncoder();
  writeVarUint(frame, 124);
  writeVarString(frame, id);
  peer.provider.ws.send(toUint8Array(frame));
  await until(() => peer.receipts.has(id) || peer.errors.length);
  assert.equal(peer.errors.length, 0, peer.errors.join("; "));
}

test(
  "a 100KB desktop rewrite does not stall another document or overwrite concurrent typing",
  { timeout: 20000 },
  async () => {
    const big = await request("/api/files", { kind: "file", path: "large.md" });
    const quick = await request("/api/files", {
      kind: "file",
      path: "quick.md",
    });
    const old = "abcde12345\n".repeat(10_000);
    const rewritten = "98765zyxwv\n".repeat(10_000);
    await writeFile(join(directory, "docs/large.md"), old);
    const large = await connect(big.id),
      a = await connect(quick.id),
      b = await connect(quick.id);
    const initial = a.text.toString();
    const expected = [];
    const requestTimes = [],
      deliveryTimes = [];
    await writeFile(join(directory, "docs/large.md"), rewritten);
    for (let n = 0; n < 24; n++) {
      const writer = n % 2 ? a : b,
        reader = n % 2 ? b : a;
      const token = `[concurrent-${n}] `;
      expected.push(token);
      const started = performance.now();
      writer.text.insert(writer.text.length, token);
      await until(() => reader.text.toString().includes(token), 1500);
      deliveryTimes.push(performance.now() - started);
      const requested = performance.now();
      await request(`/api/docs/${quick.id}`);
      requestTimes.push(performance.now() - requested);
      await delay(10);
    }
    await until(
      () =>
        large.text.toString() === rewritten &&
        a.text.toString() === b.text.toString(),
    );
    await Promise.all([saved(large), saved(a), saved(b)]);
    assert.ok(
      (await readFile(join(directory, "docs/large.md"), "utf8")) === rewritten,
      "Completed desktop rewrite must match exact source",
    );
    assert.equal(
      await readFile(join(directory, "docs/quick.md"), "utf8"),
      a.text.toString(),
    );
    assert.ok(
      Math.max(...requestTimes) < 1500,
      `Other-document requests exceeded the responsiveness budget (max ${Math.max(...requestTimes).toFixed(1)} ms; samples ${requestTimes.map(ms => ms.toFixed(1)).join(", ")})`,
    );
    assert.ok(
      Math.max(...deliveryTimes) < 1500,
      `Other-document collaboration stalled behind a desktop rewrite (max ${Math.max(...deliveryTimes).toFixed(1)} ms)`,
    );
    const tokens =
      a.text
        .toString()
        .slice(initial.length)
        .match(/\[concurrent-\d+\] /g) || [];
    assert.equal(tokens.length, expected.length);
    for (const token of expected)
      assert.equal(tokens.filter((value) => value === token).length, 1);
    assert.equal(a.errors.length + b.errors.length + large.errors.length, 0);
    large.text.insert(large.text.length, "After import.\n");
    await saved(large);
    assert.ok(
      (await readFile(join(directory, "docs/large.md"), "utf8")) ===
        rewritten + "After import.\n",
      "Typing after a desktop rewrite must fsync exact source",
    );
  },
);

test(
  "rebuilding rotates the epoch and refuses stale bootstrap updates before replay",
  { timeout: 12000 },
  async () => {
    const doc = await request("/api/files", {
      kind: "file",
      path: "rebuild.md",
    });
    const old = await request(`/api/docs/${doc.id}`);
    const live = await connect(doc.id, old);
    const blocked = await response(`/api/docs/${doc.id}/rebuild`, {
      source: "durable",
    });
    assert.equal(blocked.status, 409);
    live.provider.destroy();
    let rebuilt;
    await until(async () => {
      const attempt = await response(`/api/docs/${doc.id}/rebuild`, {
        source: "durable",
      });
      if (attempt.status === 409) return false;
      assert.equal(attempt.status, 200);
      rebuilt = await attempt.json();
      return true;
    });
    assert.ok(rebuilt.collaborationEpoch.length > 0);
    const raw = new WebSocket(
      base.replace("http", "ws") + `/ws/${doc.id}?client=plain-text-v2&epoch=`,
      { headers: { Authorization: `Bearer ${key}`, Origin: base } },
    );
    const rawFrames = [];
    raw.on("message", (bytes) => rawFrames.push([...bytes].slice(0, 8)));
    await once(raw, "close");
    assert.ok(
      rawFrames.some((frame) => frame[0] === 125),
      `Raw epoch rejection missing125: ${JSON.stringify(rawFrames)}`,
    );
    for (let n = 0; n < 3; n++) {
      const staleDoc = new Y.Doc();
      const awareness = new Awareness(staleDoc);
      Y.applyUpdate(staleDoc, Buffer.from(old.state, "base64"));
      const probe = new WebSocket(
        base.replace("http", "ws") +
          `/ws/${doc.id}?client=plain-text-v2&epoch=`,
        { headers: { Authorization: `Bearer ${key}`, Origin: base } },
      );
      const frames = [];
      probe.on("message", (bytes) =>
        frames.push([...new Uint8Array(bytes)].slice(0, 8)),
      );
      probe.on("open", () => {
        const step = createEncoder();
        writeVarUint(step, 0);
        writeVarUint(step, 0);
        writeVarUint8Array(step, Y.encodeStateVector(staleDoc));
        probe.send(toUint8Array(step));
        const presence = createEncoder();
        writeVarUint(presence, 1);
        writeVarUint8Array(
          presence,
          encodeAwarenessUpdate(awareness, [staleDoc.clientID]),
        );
        probe.send(toUint8Array(presence));
      });
      const [code] = await once(probe, "close");
      staleDoc.destroy();
      awareness.destroy();
      assert.ok(
        frames.some((frame) => frame[0] === 125),
        `Epoch rejection lost after initial client handshake: ${JSON.stringify({ frames, code })}`,
      );
    }
    const stale = await connect(doc.id, old, (ydoc) => {
      const text = ydoc.getText("content");
      text.insert(text.length, "MUST NOT REPLAY");
    });
    assert.equal(stale.errors.length, 1);
    assert.equal(stale.provider.synced, false);
    const fresh = await connect(doc.id);
    assert.equal(fresh.errors.length, 0);
    fresh.text.insert(fresh.text.length, "New epoch edit.");
    await saved(fresh);
    assert.equal(
      await readFile(join(directory, "docs/rebuild.md"), "utf8"),
      fresh.text.toString(),
    );
    assert.equal(fresh.text.toString().includes("MUST NOT REPLAY"), false);
    assert.equal(
      (await request(`/api/docs/${doc.id}`)).collaborationEpoch,
      rebuilt.collaborationEpoch,
    );
  },
);
