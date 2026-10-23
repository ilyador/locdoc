import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import * as Y from "yjs";
import WebSocket from "ws";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { freePort } from "./fixtures/free-port.mjs";

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const key = "security-boundaries-fixture-owner";
let dir,
  server,
  logs = "";
async function until(check) {
  const end = Date.now() + 7000;
  while (Date.now() < end) {
    if (server?.exitCode !== null)
      throw Error(`Fixture server exited: ${logs.slice(-2000)}`);
    if (await check()) return;
    await delay(20);
  }
  throw Error("Security fixture condition timed out");
}
async function request(
  path,
  { method = "GET", body, owner = true, headers = {}, status = 200 } = {},
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(owner ? { Authorization: `Bearer ${key}` } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(7000),
  });
  const data = await response.json();
  assert.equal(response.status, status, JSON.stringify(data));
  return data;
}
async function create(path, permission = "edit") {
  const doc = await request("/api/files", {
    method: "POST",
    body: { path, kind: "file" },
  });
  const share = await request(`/api/docs/${doc.id}/share`, {
    method: "POST",
    body: { permission },
  });
  const token = share.shareUrl.split("/").pop();
  const snapshot = await request(`/api/docs/${doc.id}?token=${token}`, {
    owner: false,
  });
  return { ...snapshot, token };
}
function updateFrame(update) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  encoding.writeVarUint(encoder, 2);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}
async function rejected(doc, frame) {
  const socket = new WebSocket(
    `${base.replace("http", "ws")}/ws/${doc.id}?token=${doc.token}&client=plain-text-v2`,
  );
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("Invalid frame was not rejected")),
      5000,
    );
    socket.on("message", (bytes) => {
      const decoder = decoding.createDecoder(new Uint8Array(bytes));
      if (decoding.readVarUint(decoder) === 125) {
        clearTimeout(timer);
        resolve(decoding.readVarString(decoder));
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("close", () => {
      clearTimeout(timer);
      resolve("closed");
    });
  });
  await once(socket, "open");
  socket.send(frame);
  try {
    assert.ok(await result);
  } finally {
    socket.terminate();
  }
  assert.equal(
    server.exitCode,
    null,
    "Untrusted frame must not terminate the server",
  );
  await request("/api/config", { owner: false });
}
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "locdoc-security-test-"));
  await mkdir(join(dir, "docs"));
  await mkdir(join(dir, "state"));
  await writeFile(join(dir, "state/owner.key"), key);
  server = spawn("./target/debug/locdoc", [], {
    env: {
      ...process.env,
      LOCDOC_BIND: `127.0.0.1:${port}`,
      LOCDOC_DOCS: join(dir, "docs"),
      LOCDOC_STATE: join(dir, "state"),
      LOCDOC_PUBLIC_URL: "https://notes.example.test",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  server.stderr.on("data", (bytes) => {
    logs = (logs + bytes).slice(-4000);
  });
  await until(async () => {
    try {
      return (await fetch(base + "/api/config")).ok;
    } catch {
      return false;
    }
  });
});
after(async () => {
  server?.kill("SIGINT");
  if (server?.exitCode === null) await once(server, "exit");
  if (dir) await rm(dir, { recursive: true, force: true });
});
test("public origin scheme cannot be downgraded; actual local origin and CLI still work", async () => {
  for (const Origin of [
    "http://notes.example.test",
    "https://notes.example.test:444",
    "null",
    "http://127.0.0.1:9999",
  ]) {
    await request("/api/files", {
      method: "POST",
      headers: { Origin, Host: "notes.example.test" },
      body: { path: "denied.md", kind: "file" },
      status: 403,
    });
  }
  await request("/api/files", {
    method: "POST",
    headers: {
      Origin: "https://notes.example.test",
      Host: "notes.example.test",
    },
    body: { path: "public-origin.md", kind: "file" },
  });
  await request("/api/files", {
    method: "POST",
    headers: { Origin: base },
    body: { path: "local-origin.md", kind: "file" },
  });
});
test("invalid UTF-8 editor updates and view-only presence frames cannot crash the server", async () => {
  const doc = await create("utf8.md");
  const peer = new Y.Doc();
  peer.getText("content").insert(0, "a");
  const update = Y.encodeStateAsUpdate(peer);
  assert.equal(update[update.length - 2], "a".charCodeAt(0));
  update[update.length - 2] = 0xff;
  await rejected(doc, updateFrame(update));
  const view = await create("viewer.md", "view");
  await rejected(view, new Uint8Array([1, 5, 1, 1, 1, 1, 0xff]));
  assert.equal((await request(`/api/docs/${doc.id}`)).content, doc.content);
  peer.destroy();
});
test("untrusted allocation counts are rejected without destabilizing other requests", async () => {
  const doc = await create("wire-counts.md");
  for (const frame of [
    [1, 5, 255, 255, 255, 255, 15],
    [0, 0, 5, 255, 255, 255, 255, 15],
    [0, 2, 5, 255, 255, 255, 255, 15],
    [0, 2, 6, 1, 255, 255, 255, 255, 15],
  ])
    await rejected(doc, new Uint8Array(frame));
});
test("zero-length synchronization structures cannot be accepted or broadcast", async () => {
  const doc = await create("zero-structs.md");
  const observer = new WebSocket(
    `${base.replace("http", "ws")}/ws/${doc.id}?token=${doc.token}&client=plain-text-v2`,
  );
  let published = 0;
  observer.on("message", (bytes) => {
    const decoder = decoding.createDecoder(new Uint8Array(bytes));
    if (
      decoding.readVarUint(decoder) === 0 &&
      decoding.readVarUint(decoder) === 2
    )
      published++;
  });
  await once(observer, "open");
  try {
    const root = [...Buffer.from("content")];
    for (const update of [
      [1, 1, 43, 0, 0, 0, 0], // GC length zero
      [1, 1, 43, 0, 10, 0, 0], // Skip length zero
      [1, 1, 43, 0, 1, 1, 7, ...root, 0, 0], // Deleted length zero
      [1, 1, 43, 0, 4, 1, 7, ...root, 0, 0], // String length zero
      [1, 0, 43, 0, 0], // Empty client struct group
      [0, 1, 43, 1, 0, 0], // Zero delete interval
      [0, 1, 43, 0], // Empty client delete group
    ]) {
      await rejected(doc, updateFrame(new Uint8Array(update)));
      const current = await request(`/api/docs/${doc.id}`);
      assert.equal(current.content, doc.content);
      const state = new Y.Doc();
      Y.applyUpdate(state, Buffer.from(current.state, "base64"));
      assert.equal(state.getText("content").toString(), doc.content);
      state.destroy();
    }
    await delay(100);
    assert.equal(
      published,
      0,
      "Rejected structures must never enter the durable broadcast outbox",
    );
    assert.equal(
      await readFile(join(dir, "docs/zero-structs.md"), "utf8"),
      doc.content,
    );
  } finally {
    observer.terminate();
  }
});
test("hidden embeds, attributes, alternate roots and map data cannot enter the shared source", async () => {
  const doc = await create("schema.md");
  for (const mutate of [
    (peer) => peer.getText("content").insertEmbed(0, { image: "hidden" }),
    (peer) => peer.getText("content").insert(0, "formatted", { bold: true }),
    (peer) => peer.getText("elsewhere").insert(0, "invisible"),
    (peer) => peer.getMap("content").set("hidden", "invisible"),
  ]) {
    const peer = new Y.Doc();
    // Yjs prevents mixed constructors for one root. The last case creates a
    // map remotely; the server already knows this root as source Y.Text.
    Y.applyUpdate(peer, Buffer.from(doc.state, "base64"));
    const vector = Y.encodeStateVector(peer);
    mutate(peer);
    await rejected(doc, updateFrame(Y.encodeStateAsUpdate(peer, vector)));
    const current = await request(`/api/docs/${doc.id}`);
    assert.equal(current.content, doc.content);
    assert.equal(
      await readFile(join(dir, "docs/schema.md"), "utf8"),
      doc.content,
    );
    peer.destroy();
  }
  // Yjs insertEmbed(string) intentionally becomes plain text. Encode actual
  // JSON/string embeds to exercise values a custom client can send instead.
  for (const value of ["a", ""]) {
    const encoder = encoding.createEncoder();
    for (const number of [1, 1, 42, 0, 5, 1])
      encoding.writeVarUint(encoder, number);
    encoding.writeVarString(encoder, "content");
    encoding.writeVarString(encoder, JSON.stringify(value));
    encoding.writeVarUint(encoder, 0);
    await rejected(doc, updateFrame(encoding.toUint8Array(encoder)));
    assert.equal((await request(`/api/docs/${doc.id}`)).content, doc.content);
  }
});
test("revoking then re-sharing a document or folder permanently invalidates the old capability", async () => {
  const doc = await create("Team/page.md", "view");
  await request(`/api/docs/${doc.id}/share`, {
    method: "POST",
    body: { permission: "private" },
  });
  const next = await request(`/api/docs/${doc.id}/share`, {
    method: "POST",
    body: { permission: "edit" },
  });
  assert.notEqual(next.shareUrl.split("/").pop(), doc.token);
  await request(`/api/docs/${doc.id}?token=${doc.token}`, {
    owner: false,
    status: 403,
  });
  const folder = await request("/api/folders/share", {
    method: "POST",
    body: { path: "Team", permission: "view" },
  });
  const old = folder.shareUrl.split("/").pop();
  await request("/api/folders/share", {
    method: "POST",
    body: { path: "Team", permission: "private" },
  });
  const renewed = await request("/api/folders/share", {
    method: "POST",
    body: { path: "Team", permission: "edit" },
  });
  assert.notEqual(renewed.shareUrl, folder.shareUrl);
  await request(`/api/open/${old}`, { owner: false, status: 404 });
  await request(`/api/docs/${doc.id}?token=${old}`, {
    owner: false,
    status: 403,
  });
});
