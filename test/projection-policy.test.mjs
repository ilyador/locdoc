import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

const base = "http://127.0.0.1:3568";
const key = "projection-policy-test-owner";
let directory, server;
let logs = "";
const peers = [];
async function until(check, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(15);
  }
  throw Error("Projection policy condition timed out: " + logs.slice(-1200));
}
async function request(path) {
  const result = await fetch(base + path, {
    headers: { Authorization: `Bearer ${key}` },
  });
  assert.equal(result.status, 200, (await result.clone().text()).slice(0, 200));
  return result.json();
}
async function connect(path) {
  const entries = (await request("/api/tree")).entries;
  const id = entries.find((e) => e.path === path).id;
  const snapshot = await request(`/api/docs/${id}`);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(snapshot.state, "base64"));
  class OwnerSocket extends WebSocket {
    constructor(url) {
      super(url, { headers: { Authorization: `Bearer ${key}`, Origin: base } });
    }
  }
  const provider = new WebsocketProvider(
    base.replace("http", "ws") + "/ws",
    id,
    doc,
    {
      WebSocketPolyfill: OwnerSocket,
      disableBc: true,
      connect: false,
      params: { client: "plain-text-v2", epoch: snapshot.collaborationEpoch },
    },
  );
  const receipts = new Set(),
    errors = [];
  for (const type of [121, 122, 123]) provider.messageHandlers[type] = () => {};
  provider.messageHandlers[127] = (_e, decoder) =>
    receipts.add(readVarString(decoder));
  for (const type of [120, 125])
    provider.messageHandlers[type] = (_e, decoder) => {
      errors.push(readVarString(decoder));
      provider.disconnect();
    };
  const peer = {
    provider,
    doc,
    text: doc.getText("content"),
    receipts,
    errors,
  };
  provider.connect();
  peers.push(peer);
  await until(() => provider.synced || errors.length);
  assert.equal(errors.length, 0, errors.join("; "));
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
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "locdoc-projection-policy-"));
  await mkdir(join(directory, "state"));
  await mkdir(join(directory, "docs"));
  await writeFile(join(directory, "state/owner.key"), key);
  await writeFile(
    join(directory, "docs/large.md"),
    "A calm line of prose.\n".repeat(18000),
  );
  await writeFile(join(directory, "docs/small.md"), "Original note.\n");
  server = spawn("./target/debug/locdoc", [], {
    env: {
      ...process.env,
      LOCDOC_BIND: "127.0.0.1:3568",
      LOCDOC_PUBLIC_URL: base,
      LOCDOC_DOCS: join(directory, "docs"),
      LOCDOC_STATE: join(directory, "state"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [server.stdout, server.stderr])
    stream.on("data", (chunk) => {
      logs = (logs + chunk).slice(-16000);
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
  for (const peer of peers) {
    peer.provider.destroy();
    peer.doc.destroy();
  }
  server?.kill("SIGINT");
  if (server?.exitCode === null) await once(server, "exit");
  if (directory) await rm(directory, { recursive: true, force: true });
});

test(
  "continuous large-note edits coalesce file writes while another document stays responsive",
  { timeout: 15000 },
  async () => {
    const large = await connect("large.md"),
      small = await connect("small.md");
    const path = join(directory, "docs/large.md");
    // Millisecond metadata is sufficient here; each old cadence pass was 100ms.
    let modified = (await stat(path)).mtimeMs;
    let writes = 0,
      worst = 0;
    for (let n = 0; n < 60; n++) {
      large.text.insert(large.text.length, ` token${n}`);
      const current = (await stat(path)).mtimeMs;
      if (current !== modified) {
        writes++;
        modified = current;
      }
      if (n % 15 === 0) {
        const started = Date.now();
        small.text.insert(small.text.length, ` small${n}`);
        await saved(small);
        worst = Math.max(worst, Date.now() - started);
      }
      await delay(30);
    }
    await saved(large);
    assert.ok(
      (await readFile(path, "utf8")) === large.text.toString(),
      "The receipt identifies exact projected source",
    );
    assert.ok(
      writes > 0,
      "Typing must not indefinitely debounce disk projection",
    );
    assert.ok(
      writes <= 6,
      `Large-note file writes must be coalesced (${writes} writes during typing)`,
    );
    assert.ok(worst < 2000, `Small-note saves remain independent (${worst}ms)`);
  },
);

test(
  "invalid desktop text backs off without losing browser edits and a real save retries immediately",
  { timeout: 12000 },
  async () => {
    const small =
      peers.find((peer) => peer.text.toString().startsWith("Original")) ??
      (await connect("small.md"));
    const path = join(directory, "docs/small.md");
    await writeFile(path, Buffer.from([0xff, 0xfe, 0x80]));
    small.text.insert(small.text.length, " durable browser words");
    await until(() => logs.includes("not valid UTF-8"));
    const start = logs.split("pending disk save failed").length;
    await delay(1800);
    const retries = logs.split("pending disk save failed").length - start;
    assert.ok(
      retries <= 5,
      `Persistent invalid files must not retry at 10Hz (${retries} retries)`,
    );
    const expected = small.text.toString();
    const started = Date.now();
    await writeFile(path, "Desktop replacement.\n");
    try {
      await until(
        () =>
          small.text.toString().replace(" durable browser words", "") ===
          "Desktop replacement.\n",
        1500,
      );
    } catch (error) {
      throw Error(
        error.message +
          "; client=" +
          small.text.toString().slice(0, 250) +
          "; file=" +
          (await readFile(path, "utf8")).slice(0, 250) +
          "; errors=" +
          JSON.stringify(small.errors),
      );
    }
    assert.ok(
      Date.now() - started < 1500,
      "A completed desktop save bypasses the error backoff",
    );
    await until(
      async () => (await readFile(path, "utf8")) === small.text.toString(),
    );
    assert.ok(
      small.text.toString().includes("durable browser words"),
      "Accepted browser edits survive the invalid file",
    );
    assert.ok(expected.includes("durable browser words"));
  },
);
