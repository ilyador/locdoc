import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WebSocket from "ws";
import { freePort } from "./fixtures/free-port.mjs";

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const key = "offline-sync-fixture";
let dir, server;
const peers = [];
async function until(check) {
  const end = Date.now() + 7000;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(20);
  }
  throw Error("Offline convergence condition timed out");
}
async function raw(path, body, auth = key, method = body ? "POST" : "GET") {
  return fetch(base + path, {
    method,
    headers: {
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function request(path, body, auth = key) {
  const response = await raw(path, body, auth);
  assert.equal(
    response.status,
    200,
    (await response.clone().text()).slice(0, 400),
  );
  return response.json();
}
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "locdoc-offline-sync-"));
  await mkdir(join(dir, "state"));
  await mkdir(join(dir, "docs"));
  await writeFile(join(dir, "state/owner.key"), key);
  server = spawn(resolve("target/debug/locdoc"), [], {
    cwd: dir,
    env: {
      ...process.env,
      LOCDOC_BIND: `127.0.0.1:${port}`,
      LOCDOC_DOCS: join(dir, "docs"),
      LOCDOC_STATE: join(dir, "state"),
      LOCDOC_PUBLIC_URL: base,
    },
    stdio: "ignore",
  });
  await until(async () => {
    if (server.exitCode !== null) throw Error("Offline fixture exited");
    try {
      return (await fetch(base + "/api/config")).ok;
    } catch {
      return false;
    }
  });
});
after(async () => {
  for (const p of peers) {
    p.destroy();
    p.doc.destroy();
  }
  server?.kill("SIGINT");
  if (server?.exitCode === null) await once(server, "exit");
  if (dir) await rm(dir, { recursive: true, force: true });
});
function restored(doc) {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Buffer.from(doc.state, "base64"));
  return copy;
}
async function connect(id) {
  const doc = await request(`/api/docs/${id}`);
  const ydoc = restored(doc);
  class Socket extends WebSocket {
    constructor(url) {
      super(url, { headers: { Authorization: `Bearer ${key}` } });
    }
  }
  const provider = new WebsocketProvider(
    base.replace("http", "ws") + "/ws",
    id,
    ydoc,
    { WebSocketPolyfill: Socket, disableBc: true, connect: false },
  );
  for (const kind of [121, 122, 123, 125, 126, 127])
    provider.messageHandlers[kind] = () => {};
  peers.push(provider);
  const synced = once(provider, "sync");
  provider.connect();
  await synced;
  return ydoc;
}
const update = (ydoc, epoch = "") => ({
  epoch,
  update: Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString("base64"),
});

test("two disconnected writers merge with a live writer, persist, and tolerate replay", async () => {
  const { id } = await request("/api/files", {
    path: "Concurrent.md",
    kind: "file",
  });
  const original = await request(`/api/docs/${id}`);
  const a = restored(original),
    b = restored(original),
    live = await connect(id);
  try {
    a.getText("content").insert(0, "Offline A.\n");
    b.getText("content").insert(0, "Offline B.\n");
    live.getText("content").insert(0, "Live C.\n");
    await Promise.all([
      request(
        `/api/docs/${id}/offline`,
        update(a, original.collaborationEpoch),
      ),
      request(
        `/api/docs/${id}/offline`,
        update(b, original.collaborationEpoch),
      ),
    ]);
    await request(
      `/api/docs/${id}/offline`,
      update(a, original.collaborationEpoch),
    );
    await until(async () => {
      const text = await readFile(join(dir, "docs/Concurrent.md"), "utf8");
      return (
        ["Offline A.", "Offline B.", "Live C."].every((word) =>
          text.includes(word),
        ) && text === live.getText("content").toString()
      );
    });
    const text = (await request(`/api/docs/${id}`)).content;
    for (const word of ["Offline A.", "Offline B.", "Live C."])
      assert.equal(text.split(word).length - 1, 1);
    const meta = await request(`/api/docs/${id}/offline`);
    assert.equal(meta.state, undefined);
    assert.equal(meta.content, undefined);
    const privateRead = await raw(`/api/docs/${id}/offline`, undefined, "");
    assert.equal(privateRead.status, 403);
  } finally {
    a.destroy();
    b.destroy();
  }
});

test("offline merge checks current permissions and accepts only plain content roots", async () => {
  const { id } = await request("/api/files", {
    path: "Permissions.md",
    kind: "file",
  });
  const doc = await request(`/api/docs/${id}`);
  const ydoc = restored(doc);
  try {
    ydoc.getText("content").insert(0, "Refused guest draft");
    const shared = await request(`/api/docs/${id}/share`, {
      permission: "view",
    });
    const token = new URL(shared.shareUrl).pathname.split("/").pop();
    assert.equal(
      (
        await raw(
          `/api/docs/${id}/offline?token=${token}`,
          update(ydoc, doc.collaborationEpoch),
          "",
        )
      ).status,
      403,
    );
    assert.equal((await request(`/api/docs/${id}`)).content, doc.content);
    const malicious = restored(doc);
    malicious.getMap("hidden").set("payload", "not plain text");
    try {
      const response = await raw(
        `/api/docs/${id}/offline`,
        update(malicious, doc.collaborationEpoch),
      );
      assert.ok(response.status >= 400, "non-text roots must be rejected");
    } finally {
      malicious.destroy();
    }
    assert.equal((await request(`/api/docs/${id}`)).content, doc.content);
    assert.equal(
      (await raw(`/api/docs/${id}/offline`, update(ydoc, "wrong-generation")))
        .status,
      409,
    );
  } finally {
    ydoc.destroy();
  }
});

test("upload retry keeps one file and rejects the same upload identity with different bytes", async () => {
  const { id } = await request("/api/files", {
    path: "Uploads.md",
    kind: "file",
  });
  const upload = crypto.randomUUID();
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
    "base64",
  );
  const send = async (body) => {
    const data = new FormData();
    data.append("file", new Blob([body], { type: "image/png" }), "pixel.png");
    return fetch(`${base}/api/docs/${id}/upload/${upload}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: data,
    });
  };
  const first = await send(bytes);
  assert.equal(first.status, 200);
  const result = await first.json();
  const path = join(dir, "docs", result.path);
  const before = await stat(path);
  const retry = await send(bytes);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).path, result.path);
  assert.equal((await stat(path)).ino, before.ino);
  const changed = Buffer.from(bytes);
  changed[changed.length - 1] ^= 1;
  assert.equal((await send(changed)).status, 409);
  assert.equal((await readFile(path)).equals(bytes), true);
});

test("offline operations retain identity, refuse collisions and reject path escapes", async () => {
  const id = crypto.randomUUID();
  const command = { id, kind: "create-file", document: id, path: "Queued.md" };
  assert.equal((await request("/api/offline/file", command)).id, id);
  assert.equal((await request("/api/offline/file", command)).id, id);
  const collision = {
    ...command,
    id: crypto.randomUUID(),
    document: crypto.randomUUID(),
  };
  assert.ok(
    [400, 409].includes((await raw("/api/offline/file", collision)).status),
    "a queued creation must never overwrite a collision",
  );
  const escape = {
    ...command,
    id: crypto.randomUUID(),
    document: crypto.randomUUID(),
    path: "../escape.md",
  };
  assert.ok((await raw("/api/offline/file", escape)).status >= 400);
  assert.equal((await request(`/api/docs/${id}`)).permission, "private");
});
