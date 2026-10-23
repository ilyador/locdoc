import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
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
  writeVarUint8Array,
  writeVarString,
  toUint8Array,
} from "lib0/encoding";
import { freePort } from "./fixtures/free-port.mjs";

let directory, server, base, document, token;
const sockets = new Set();
const providers = new Set();
const ownerKey = "peer-isolation-synthetic-owner-key";

async function waitFor(check, milliseconds = 5000) {
  const until = Date.now() + milliseconds;
  while (Date.now() < until) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error("Timed out waiting for peer isolation condition");
}

async function request(path, body) {
  const response = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${ownerKey}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal(response.status, 200);
  return response.json();
}

function raw(options = {}) {
  const socket = new WebSocket(
    base.replace("http", "ws") + `/ws/${document.id}?token=${token}`,
    options,
  );
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  return socket;
}

async function connected(owner = false, id = document.id) {
  const ydoc = new Y.Doc();
  class Socket extends WebSocket {
    constructor(url) {
      super(url, { headers: owner ? { Authorization: `Bearer ${ownerKey}` } : {} });
    }
  }
  const provider = new WebsocketProvider(
    base.replace("http", "ws") + "/ws",
    id,
    ydoc,
    { params: { token }, WebSocketPolyfill: Socket, disableBc: true, connect: false },
  );
  for (const type of [121, 122, 123, 127]) provider.messageHandlers[type] = () => {};
  provider.messageHandlers[125] = () => provider.disconnect();
  providers.add(provider);
  provider.awareness.setLocalStateField("user", {
    name: owner ? "Owner" : "Guest",
    color: "#487495",
  });
  const synchronized = once(provider, "sync");
  provider.connect();
  await synchronized;
  return { provider, ydoc };
}

function awareness(entries) {
  const update = createEncoder();
  writeVarUint(update, entries.length);
  for (const [client, clock, state] of entries) {
    writeVarUint(update, client);
    writeVarUint(update, clock);
    writeVarString(update, JSON.stringify(state));
  }
  const frame = createEncoder();
  writeVarUint(frame, 1);
  writeVarUint8Array(frame, toUint8Array(update));
  return toUint8Array(frame);
}

async function close(socket) {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = once(socket, "close");
  socket.close();
  await closed;
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "locdoc-peers-"));
  await mkdir(join(directory, "state"));
  await mkdir(join(directory, "docs"));
  await writeFile(join(directory, "state/owner.key"), ownerKey);
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn("./target/debug/locdoc", [], {
    env: {
      ...process.env,
      LOCDOC_BIND: `127.0.0.1:${port}`,
      LOCDOC_STATE: join(directory, "state"),
      LOCDOC_DOCS: join(directory, "docs"),
      LOCDOC_PUBLIC_URL: base,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let logs = "";
  server.stderr.on("data", (data) => { logs = (logs + data).slice(-6000); });
  await waitFor(async () => {
    if (server.exitCode !== null) throw new Error(logs);
    try { return (await fetch(base + "/api/config")).ok; } catch { return false; }
  });
  document = await request("/api/files", { kind: "file", path: "shared.md" });
  const shared = await request(`/api/docs/${document.id}/share`, { permission: "view" });
  token = shared.shareUrl.split("/").pop();
});

after(async () => {
  for (const provider of providers) {
    provider.destroy();
    provider.doc.destroy();
  }
  for (const socket of sockets) socket.terminate();
  server?.kill("SIGINT");
  if (server && server.exitCode === null) await once(server, "exit");
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("viewers cannot change or remove another connection's cursor or name", async () => {
  const owner = await connected(true);
  const viewer = await connected();
  const observer = await connected();
  observer.provider.awareness.setLocalStateField("user", { name: "Observer", color: "#487495" });
  const states = observer.provider.awareness.getStates();
  const named = (name) => [...states].find(([, state]) => state.user?.name === name);
  await waitFor(() => named("Owner") && named("Guest"));
  const ownerWire = named("Owner")[0];
  const viewerWire = named("Guest")[0];
  assert.notEqual(ownerWire, owner.ydoc.clientID);
  for (const state of [{ user: { name: "Forged owner", color: "#487495" } }, null]) {
    for (const client of [ownerWire, owner.ydoc.clientID]) {
      viewer.provider.ws.send(awareness([[client, 0xffffffff, state]]));
    }
  }
  // An unbound peer also gets a new wire ID when it claims an existing ID.
  const unbound = raw();
  await once(unbound, "open");
  unbound.send(awareness([[ownerWire, 0xffffffff, null]]));
  unbound.send(awareness([[ownerWire, 0xffffffff, { user: { name: "Hijacked" } }]]));
  await close(unbound);
  viewer.provider.awareness.setLocalStateField("user", { name: "Guest after attack", color: "#487495" });
  await waitFor(() => states.get(viewerWire)?.user?.name === "Guest after attack");
  assert.equal(states.get(ownerWire)?.user?.name, "Owner");
  assert.equal(viewer.provider.wsconnected, true);
  // Queries must strip the sender's public wire ID just like broadcasts do.
  owner.provider.ws.send(new Uint8Array([3]));
  owner.provider.awareness.setLocalStateField("user", { name: "Owner after query", color: "#487495" });
  await waitFor(() => states.get(ownerWire)?.user?.name === "Owner after query");
  const ownerStates = [...owner.provider.awareness.getStates().values()];
  assert.equal(ownerStates.filter((state) => state.user?.name?.startsWith("Owner")).length, 1);
  const disconnected = once(viewer.provider, "status");
  viewer.provider.disconnect();
  await disconnected;
  await waitFor(() => !states.has(viewerWire));
  assert.equal(states.get(ownerWire)?.user?.name, "Owner after query");
  for (const client of [owner, viewer, observer]) {
    client.provider.destroy();
    client.ydoc.destroy();
    providers.delete(client.provider);
  }
});

test("claiming a disconnected client's ID with a MAX clock cannot block its reconnect", async () => {
  const owner = await connected(true);
  const observer = await connected();
  const states = observer.provider.awareness.getStates();
  const ownerEntry = () => [...states].find(([, state]) => state.user?.name === "Owner");
  await waitFor(() => ownerEntry());
  const oldWire = ownerEntry()[0];
  const disconnected = once(owner.provider, "status");
  owner.provider.disconnect();
  await disconnected;
  await waitFor(() => !states.has(oldWire));
  const attacker = raw();
  await once(attacker, "open");
  attacker.send(awareness([[owner.ydoc.clientID, 0xffffffff, { user: { name: "Impostor" } }]]));
  await waitFor(() => [...states.values()].some((state) => state.user?.name === "Impostor"));
  const synced = once(owner.provider, "sync");
  owner.provider.connect();
  await synced;
  await waitFor(() => ownerEntry());
  assert.notEqual(ownerEntry()[0], oldWire);
  assert.equal(attacker.readyState, WebSocket.OPEN);
  await close(attacker);
  await waitFor(() => ![...states.values()].some((state) => state.user?.name === "Impostor"));
  // A MAX clock must not panic remove_state or poison other cursors.
  assert.equal((await fetch(base + "/api/config")).status, 200);
  assert.equal(owner.provider.wsconnected, true);
  assert.equal(ownerEntry()[1].user.name, "Owner");
  for (const client of [owner, observer]) {
    client.provider.destroy();
    client.ydoc.destroy();
    providers.delete(client.provider);
  }
});

test("one address cannot occupy every guest slot and owners remain exempt", async () => {
  const held = [];
  const headers = { "X-Forwarded-For": "192.0.2.20" };
  try {
    for (let n = 0; n < 16; n++) {
      const socket = raw({ headers });
      await once(socket, "open");
      held.push(socket);
    }
    const rejected = raw({ headers });
    const status = await new Promise((resolve, reject) => {
      rejected.once("unexpected-response", (_, response) => {
        response.resume();
        resolve(response.statusCode);
        rejected.terminate();
      });
      rejected.once("open", () => reject(new Error("Address limit was bypassed")));
      rejected.on("error", () => {});
    });
    assert.equal(status, 503);
    const other = raw({ headers: { "X-Forwarded-For": "192.0.2.21" } });
    await once(other, "open");
    await close(other);
    const owner = raw({ headers: { ...headers, Authorization: `Bearer ${ownerKey}` } });
    await once(owner, "open");
    await close(owner);
    await close(held.pop());
    const replacement = raw({ headers });
    await once(replacement, "open");
    await close(replacement);
  } finally {
    await Promise.all(held.map(close));
  }
});

test("rotating IPv6 privacy addresses cannot bypass one prefix's visitor cap", async () => {
  const held = [];
  try {
    for (let n = 1; n <= 16; n++) {
      const socket = raw({ headers: { "X-Forwarded-For": `2001:db8:abcd:1::${n.toString(16)}` } });
      await once(socket, "open");
      held.push(socket);
    }
    const rejected = raw({ headers: { "X-Forwarded-For": "2001:db8:abcd:1:ffff:ffff:ffff:ffff" } });
    const status = await new Promise((resolve, reject) => {
      rejected.once("unexpected-response", (_, response) => {
        response.resume();
        resolve(response.statusCode);
        rejected.terminate();
      });
      rejected.once("open", () => reject(new Error("IPv6 prefix limit was bypassed")));
      rejected.on("error", () => {});
    });
    assert.equal(status, 503);
    const other = raw({ headers: { "X-Forwarded-For": "2001:db8:abcd:2::1" } });
    await once(other, "open");
    await close(other);
  } finally {
    await Promise.all(held.map(close));
  }
});

test("an editor alone in a document stays connected while it idles", { timeout: 50_000 }, async () => {
  // y-websocket closes a connection that brings it no message for 30 seconds,
  // and an answered ping is not one. Alone, the editor gets no presence back.
  const alone = await request("/api/files", { kind: "file", path: "alone.md" });
  const { provider, ydoc } = await connected(true, alone.id);
  let closes = 0;
  provider.on("connection-close", () => { closes++; });
  try {
    await delay(36_000);
    assert.equal(closes, 0, "the idle connection was closed by its own client");
    assert.equal(provider.wsconnected, true);
    assert.deepEqual(
      [...provider.awareness.getStates().keys()],
      [ydoc.clientID],
      "staying connected shows no other peer",
    );
  } finally {
    provider.destroy();
    ydoc.destroy();
    providers.delete(provider);
  }
});

test("a peer that never answers the ping challenge is disconnected", { timeout: 25_000 }, async () => {
  const healthy = await connected();
  let healthyDisconnects = 0;
  healthy.provider.on("connection-close", () => { healthyDisconnects++; });
  const socket = raw({ autoPong: false });
  let pinged = false;
  socket.on("ping", () => {
    pinged = true;
    // A pong is insufficient unless it echoes the server's current nonce.
    socket.pong("wrong challenge");
  });
  // Traffic in either direction cannot keep a peer alive without its pong.
  const traffic = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) socket.send(new Uint8Array([3]));
  }, 250);
  try {
    await once(socket, "close");
    assert.equal(pinged, true);
    assert.equal(healthyDisconnects, 0);
    assert.equal(healthy.provider.wsconnected, true);
  } finally {
    clearInterval(traffic);
    healthy.provider.destroy();
    healthy.ydoc.destroy();
    providers.delete(healthy.provider);
  }
});
