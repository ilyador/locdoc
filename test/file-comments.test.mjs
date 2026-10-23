import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  open,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WebSocket from "ws";
import { readVarString, createDecoder, readVarUint } from "lib0/decoding";
import { publishPresence } from "../src/presence.ts";
import { commentParser } from "../src/comment-syntax.ts";
import { freePort } from "./fixtures/free-port.mjs";

const port = await freePort();
const base = `http://127.0.0.1:${port}`,
  key = "file-comments-owner";
let dir, server, cookie;
const peers = [];
async function until(check) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  throw Error("File comment condition timed out");
}
async function start() {
  server = spawn("./target/debug/locdoc", [], {
    env: {
      ...process.env,
      LOCDOC_BIND: `127.0.0.1:${port}`,
      LOCDOC_DOCS: join(dir, "docs"),
      LOCDOC_STATE: join(dir, "state"),
      LOCDOC_PUBLIC_URL: base,
      LOCDOC_OWNER_NAME: "alex",
    },
    stdio: "ignore",
  });
  await until(async () => {
    if (server.exitCode !== null) throw Error("Server exited");
    try {
      return (await fetch(base + "/api/config")).ok;
    } catch {
      return false;
    }
  });
  const config = await fetch(base + "/api/config");
  cookie = config.headers.get("set-cookie").split(";")[0];
}
async function stop() {
  server.kill("SIGINT");
  if (server.exitCode === null) await once(server, "exit");
}
async function request(path, method = "GET", body, token) {
  const response = await fetch(base + path + (token ? `?token=${token}` : ""), {
    method,
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      ...(!token ? { Authorization: `Bearer ${key}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(7000),
  });
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  return data;
}
async function create(path, source) {
  const d = await request("/api/files", "POST", { path, kind: "file" });
  await writeFile(join(dir, "docs", path), source);
  await request(`/api/docs/${d.id}`);
  return d;
}
function anchor(snapshot, from, to) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(snapshot.state, "base64"));
  const text = doc.getText("content");
  return {
    start: Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(text, from),
    ),
    end: Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(text, to, -1),
    ),
  };
}
function assertSelectedPassage(snapshot, comment, expected) {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, Buffer.from(snapshot.state, "base64"));
    const from = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(comment.anchor.start),
      doc,
    );
    const to = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(comment.anchor.end),
      doc,
    );
    assert.ok(from && to, "the original selection anchors must remain valid");
    assert.equal(
      doc.getText("content").toString().slice(from.index, to.index),
      expected,
    );
    assert.equal(comment.quote, expected);
  } finally {
    doc.destroy();
  }
}
async function connect(id) {
  const snapshot = await request(`/api/docs/${id}`),
    doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(snapshot.state, "base64"));
  class Socket extends WebSocket {
    constructor(url) {
      super(url, { headers: { Authorization: `Bearer ${key}`, Origin: base } });
    }
  }
  const provider = new WebsocketProvider(
    base.replace("http", "ws") + "/ws",
    id,
    doc,
    {
      WebSocketPolyfill: Socket,
      disableBc: true,
      connect: false,
      params: { client: "plain-text-v2" },
    },
  );
  const peer = { doc, provider, text: doc.getText("content"), waiting: false };
  provider.messageHandlers[121] = (_e, d) =>
    (peer.waiting = readVarString(d) === "1");
  for (const n of [122, 123, 127]) provider.messageHandlers[n] = () => {};
  const ready = once(provider, "sync", { signal: AbortSignal.timeout(5000) });
  peers.push(peer);
  provider.connect();
  await ready;
  return peer;
}
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "locdoc-file-comments-"));
  await mkdir(join(dir, "docs"));
  await mkdir(join(dir, "state"));
  await writeFile(join(dir, "state/owner.key"), key);
  await writeFile(join(dir, "docs/legacy.md"), "Original passage.");
  const db = new DatabaseSync(join(dir, "state/locdoc.sqlite"));
  db.exec(
    "CREATE TABLE docs(id TEXT PRIMARY KEY,path TEXT UNIQUE NOT NULL,permission TEXT NOT NULL DEFAULT 'private',token TEXT,state BLOB); CREATE TABLE comments(id TEXT PRIMARY KEY,doc TEXT NOT NULL,guest TEXT NOT NULL,data TEXT NOT NULL);",
  );
  db.prepare("INSERT INTO docs(id,path) VALUES(?,?)").run(
    "legacy-doc",
    "legacy.md",
  );
  db.prepare("INSERT INTO comments VALUES(?,?,?,?)").run(
    "legacy-thread",
    "legacy-doc",
    "old-guest",
    JSON.stringify({
      id: "legacy-thread",
      name: "You",
      body: "Existing comment",
      guest: "old-guest",
      quote: "passage",
      anchor: null,
      created: 123456,
      resolved: true,
      replies: [{ name: "ana", body: "Existing response", created: 123460 }],
    }),
  );
  db.close();
  await start();
});
afterEach(() => {
  for (const peer of peers.splice(0)) {
    peer.provider.destroy();
    peer.doc.destroy();
  }
});
after(async () => {
  await stop();
  await rm(dir, { recursive: true, force: true });
});

test("raw-file comments are conversations, disk edits win, and deleted threads stay deleted", async () => {
  const initial =
    "# Notes\n\nA passage[[comment(alex): first]]\n[[comment(ana): response]]\n\nAnother passage[[comment(alex): second]]";
  const d = await create("raw.md", initial);
  const first = (await request(`/api/docs/${d.id}/comments`)).comments;
  assert.equal(first.length, 2);
  assert.equal(first[0].name, "alex");
  assert.equal(first[0].replies[0].name, "ana");
  await request(`/api/docs/${d.id}/comments/${first[1].id}`, "PATCH", {
    resolved: true,
  });
  await writeFile(
    join(dir, "docs/raw.md"),
    initial.replace("first", "edited").split("\n\nAnother")[0],
  );
  const updated = (await request(`/api/docs/${d.id}/comments`)).comments;
  assert.equal(updated.length, 1);
  assert.equal(updated[0].body, "edited");
  assert.equal(updated[0].id, first[0].id);
  await writeFile(
    join(dir, "docs/raw.md"),
    initial.replace("first", "edited").replace("second", "new conversation"),
  );
  const added = (await request(`/api/docs/${d.id}/comments`)).comments;
  assert.equal(added.length, 2);
  assert.notEqual(added[1].id, first[1].id);
  assert.equal(added[1].resolved, false);
});

test("separate raw-file conversations anchor to visible prose instead of another hidden comment", async () => {
  const passage = "Visible passage.";
  const source = `${passage}\n[[comment(alex): First conversation]]\n[[comment(ana): First response]]\n\n[[comment(alex): Separate conversation]]`;
  const d = await create("consecutive-threads.md", source);
  const { comments } = await request(`/api/docs/${d.id}/comments`);
  assert.equal(comments.length, 2);
  const snapshot = await request(`/api/docs/${d.id}`);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(snapshot.state, "base64"));
  for (const c of comments) {
    assert.equal(c.quote, passage);
    assert.equal(
      Y.createAbsolutePositionFromRelativePosition(
        Y.createRelativePositionFromJSON(c.anchor.start),
        doc,
      ).index,
      0,
    );
    assert.equal(
      Y.createAbsolutePositionFromRelativePosition(
        Y.createRelativePositionFromJSON(c.anchor.end),
        doc,
      ).index,
      passage.length,
    );
  }
  doc.destroy();
});

test("view-link comments and concurrent replies round-trip to the exact file syntax, with retry deduplication", async () => {
  const source = "A passage 😀 here and more text.";
  const d = await create("web.md", source);
  const share = await request(`/api/docs/${d.id}/share`, "POST", {
      permission: "view",
    }),
    token = share.shareUrl.split("/").pop();
  const snapshot = await request(`/api/docs/${d.id}`),
    end = source.indexOf(" and");
  const body = {
    name: "alex",
    body: "this is my comment",
    quote: source.slice(0, end),
    anchor: anchor(snapshot, 0, end),
    requestId: crypto.randomUUID(),
  };
  const c = await request(`/api/docs/${d.id}/comments`, "POST", body, token);
  assert.equal(
    (await request(`/api/docs/${d.id}/comments`, "POST", body, token)).id,
    c.id,
  );
  assert.equal(
    await readFile(join(dir, "docs/web.md"), "utf8"),
    source + "[[comment(alex): this is my comment]]",
  );
  assertSelectedPassage(
    await request(`/api/docs/${d.id}`),
    c,
    source.slice(0, end),
  );
  const reply = {
    name: "ana",
    body: "this is a response",
    requestId: crypto.randomUUID(),
  };
  await request(`/api/docs/${d.id}/comments/${c.id}`, "PATCH", reply, token);
  await request(`/api/docs/${d.id}/comments/${c.id}`, "PATCH", reply, token);
  await Promise.all(
    ["ben", "chen"].map((name) =>
      request(
        `/api/docs/${d.id}/comments/${c.id}`,
        "PATCH",
        { name, body: `Reply from ${name}`, requestId: crypto.randomUUID() },
        token,
      ),
    ),
  );
  const list = (
    await request(`/api/docs/${d.id}/comments`, "GET", undefined, token)
  ).comments;
  assert.equal(list.length, 1);
  assert.equal(list[0].replies.length, 3);
  assert.equal(list[0].replies[0].body, "this is a response");
  const file = await readFile(join(dir, "docs/web.md"), "utf8");
  assert.equal(file.match(/comment\(alex\)/g).length, 1);
  assert.equal(file.match(/comment\(ana\)/g).length, 1);
  assert.ok(file.includes("]]\n[[comment(ana): this is a response]]"));
  const other = await request(
    `/api/docs/${d.id}/comments`,
    "POST",
    { ...body, body: "Separate thread", requestId: crypto.randomUUID() },
    token,
  );
  assert.notEqual(other.id, c.id);
  assert.equal(
    (await request(`/api/docs/${d.id}/comments`)).comments.length,
    2,
  );
});

test("posting a comment on newly typed text tolerates HTTP overtaking the CRDT update", async () => {
  const d = await create("causal.md", "Original."),
    peer = await connect(d.id);
  const local = new Y.Doc();
  Y.applyUpdate(local, Y.encodeStateAsUpdate(peer.doc));
  const text = local.getText("content"),
    from = text.length;
  text.insert(from, " Newly typed passage");
  const selection = {
    start: Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(text, from),
    ),
    end: Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(text, text.length, -1),
    ),
  };
  const pending = request(`/api/docs/${d.id}/comments`, "POST", {
    name: "alex",
    body: "A causal comment",
    quote: " Newly typed passage",
    anchor: selection,
  });
  await delay(60);
  Y.applyUpdate(peer.doc, Y.encodeStateAsUpdate(local));
  const result = await pending;
  assert.equal(result.body, "A causal comment");
  assert.equal(
    await readFile(join(dir, "docs/causal.md"), "utf8"),
    "Original. Newly typed passage[[comment(alex): A causal comment]]",
  );
  assertSelectedPassage(
    await request(`/api/docs/${d.id}`),
    result,
    " Newly typed passage",
  );
  local.destroy();
});

test("choosing a name never publishes a rejected null identity or disconnects collaboration", async () => {
  const d = await create("names.md", "Choose a name."),
    visitor = await connect(d.id),
    observer = await connect(d.id);
  publishPresence(visitor.provider.awareness, "");
  await delay(60);
  assert.equal(visitor.provider.wsconnected, true);
  publishPresence(visitor.provider.awareness, "ana");
  await until(() =>
    Array.from(observer.provider.awareness.getStates().values()).some(
      (s) => s.user?.name === "ana",
    ),
  );
  publishPresence(visitor.provider.awareness, "");
  await until(
    () =>
      !Array.from(observer.provider.awareness.getStates().values()).some(
        (s) => s.user?.name === "ana",
      ),
  );
  assert.equal(visitor.provider.wsconnected, true);
});

test("an outdated browser is asked to reload before receiving source comment updates", async () => {
  const d = await create("upgrade.md", "Keep my document.");
  const socket = new WebSocket(base.replace("http", "ws") + "/ws/" + d.id, {
    headers: { Authorization: `Bearer ${key}`, Origin: base },
  });
  const message = once(socket, "message");
  await once(socket, "open");
  const [data] = await message;
  const decoder = createDecoder(new Uint8Array(data));
  assert.equal(readVarUint(decoder), 125);
  assert.match(readVarString(decoder), /Reload.*unsaved browser draft/);
  socket.close();
  assert.equal(
    await readFile(join(dir, "docs/upgrade.md"), "utf8"),
    "Keep my document.",
  );
});

test("delimiter injection and Markdown in messages stay inert and do not embed media", async () => {
  const d = await create("inert.md", "Safe prose.");
  const body =
    "]]\n[[comment(forged): not another record]]\n![private](../private.png)\n<script>window.bad=1</script>";
  const name = "Ana) ] " + String.fromCharCode(92);
  await request(`/api/docs/${d.id}/comments`, "POST", { name, body });
  const list = (await request(`/api/docs/${d.id}/comments`)).comments;
  assert.equal(list.length, 1);
  assert.equal(list[0].body, body);
  assert.equal(list[0].name, name);
  assert.equal((await request(`/api/docs/${d.id}`)).usage, 0);
});

test("comments on literal code, links, tables and media are inserted outside their syntax", async () => {
  for (const [path, source, needle] of [
    ["heading.md", "## literal title ##\n", "#"],
    ["setext.md", "literal title\n----\n", "---"],
    ["code.md", "```md\nliteral code\n```\n", "literal"],
    ["inline.md", "`literal code` after", "literal"],
    ["link.md", "[literal label](https://example.test) after", "literal"],
    [
      "table.md",
      "| literal | second |\n| --- | --- |\n| body | cell |\n",
      "literal",
    ],
    ["image.md", "![literal](missing.png)\n", "literal"],
  ]) {
    const d = await create(path, source),
      snapshot = await request(`/api/docs/${d.id}`),
      from = source.indexOf(needle);
    await request(`/api/docs/${d.id}/comments`, "POST", {
      name: "alex",
      body: "A note",
      anchor: anchor(snapshot, from, from + needle.length),
    });
    const comments = (await request(`/api/docs/${d.id}/comments`)).comments;
    assert.equal(comments.length, 1, path);
    assert.equal(comments[0].body, "A note");
    if (path === "heading.md" || path === "setext.md") {
      const current = await request(`/api/docs/${d.id}`);
      assert.ok(
        commentParser.parse(current.content).toString().includes("Heading"),
        path + " keeps its heading syntax",
      );
    }
  }
});

test("a comment on a paragraph that a heading follows adds no line, and another starts after a blank line", async () => {
  const source =
    "# ADHD\nMost of it is wrong.\nSo first, we need to talk about brain, personality, and choice.\n## 1\nMore.";
  const path = join(dir, "docs/gaps.md");
  const d = await create("gaps.md", source);
  const comment = async (body) => {
    const snapshot = await request(`/api/docs/${d.id}`),
      from = snapshot.content.indexOf("choice.");
    return request(`/api/docs/${d.id}/comments`, "POST", {
      name: "alex",
      body,
      quote: "choice.",
      anchor: anchor(snapshot, from, from + "choice.".length),
    });
  };
  const first = await comment("A note on choice");
  assert.equal(
    await readFile(path, "utf8"),
    source.replace("choice.", "choice.[[comment(alex): A note on choice]]"),
    "the record ends the paragraph's last line",
  );
  await comment("Another note");
  await request(`/api/docs/${d.id}/comments/${first.id}`, "PATCH", {
    name: "ana",
    body: "A reply",
  });
  assert.equal(
    await readFile(path, "utf8"),
    source.replace(
      "choice.",
      "choice.[[comment(alex): A note on choice]]\n[[comment(ana): A reply]]\n\n[[comment(alex): Another note]]",
    ),
  );
  const { comments } = await request(`/api/docs/${d.id}/comments`);
  assert.deepEqual(
    comments.map((c) => [c.quote, c.body, c.replies.map((r) => r.body)]),
    [
      ["choice.", "A note on choice", ["A reply"]],
      ["choice.", "Another note", []],
    ],
  );
});

test("plain text comments end their line, ignore Markdown syntax and keep replies and separate conversations", async () => {
  const path = join(dir, "docs/list.txt");
  const d = await create("list.txt", "Buy milk\nBuy eggs\n```\nunclosed fence");
  const comment = async (name, body, quote) => {
    const snapshot = await request(`/api/docs/${d.id}`),
      from = snapshot.content.indexOf(quote);
    return request(`/api/docs/${d.id}/comments`, "POST", {
      name,
      body,
      quote,
      anchor: anchor(snapshot, from, from + quote.length),
    });
  };
  const first = await comment("alex", "Which brand?", "milk");
  assert.equal(
    await readFile(path, "utf8"),
    "Buy milk[[comment(alex): Which brand?]]\nBuy eggs\n```\nunclosed fence",
    "no line is added and Markdown placement rules do not apply",
  );
  await comment("ana", "Close it?", "fence");
  await comment("ben", "Separate", "milk");
  await request(`/api/docs/${d.id}/comments/${first.id}`, "PATCH", {
    name: "ana",
    body: "Oat",
  });
  assert.equal(
    await readFile(path, "utf8"),
    "Buy milk[[comment(alex): Which brand?]]\n[[comment(ana): Oat]]\n\n[[comment(ben): Separate]]\nBuy eggs\n```\nunclosed fence[[comment(ana): Close it?]]",
  );
  const { comments } = await request(`/api/docs/${d.id}/comments`);
  assert.deepEqual(
    comments.map((c) => [c.quote, c.body, c.replies.map((r) => r.body)]),
    [
      ["milk", "Which brand?", ["Oat"]],
      ["milk", "Separate", []],
      ["fence", "Close it?", []],
    ],
  );
});

test("a comment queued during a desktop save remains durable and never imports partial text", async () => {
  const d = await create("writer.md", "Original passage."),
    peer = await connect(d.id),
    path = join(dir, "docs/writer.md");
  const writer = await open(path, "w");
  try {
    await writer.write("First half.");
    await request(`/api/docs/${d.id}/comments`, "POST", {
      name: "alex",
      body: "Queued comment",
    });
    await until(
      () =>
        peer.waiting &&
        peer.text.toString().includes("[[comment(alex): Queued comment]]"),
    );
    assert.ok(!peer.text.toString().includes("First half."));
    assert.equal(await readFile(path, "utf8"), "First half.");
    await writer.write(" Second half.");
  } finally {
    await writer.close();
  }
  await until(
    () =>
      !peer.waiting &&
      peer.text.toString().includes("First half. Second half."),
  );
  assert.equal(await readFile(path, "utf8"), peer.text.toString());
  assert.equal(
    (await request(`/api/docs/${d.id}/comments`)).comments.length,
    1,
  );
});

test("existing conversations export once, preserve identity and resolution, and survive restart", async () => {
  const first = (await request("/api/docs/legacy-doc/comments")).comments;
  assert.equal(first.length, 1);
  assert.equal(first[0].id, "legacy-thread");
  assert.equal(first[0].name, "alex");
  assert.equal(first[0].resolved, true);
  assert.equal(first[0].created, 123456);
  assert.equal(first[0].replies[0].created, 123460);
  const file = await readFile(join(dir, "docs/legacy.md"), "utf8");
  assert.equal(
    file,
    "Original passage.[[comment(alex): Existing comment]]\n[[comment(ana): Existing response]]",
  );
  assertSelectedPassage(
    await request("/api/docs/legacy-doc"),
    first[0],
    "passage",
  );
  await request("/api/docs/legacy-doc/comments");
  assert.equal(await readFile(join(dir, "docs/legacy.md"), "utf8"), file);
  await stop();
  await start();
  const reopened = (await request("/api/docs/legacy-doc/comments")).comments;
  assert.equal(reopened[0].id, first[0].id);
  assert.equal(reopened[0].created, 123456);
  assert.equal(await readFile(join(dir, "docs/legacy.md"), "utf8"), file);
});

// Runs last: it changes the owner's name that the tests above rely on.
test("the owner's chosen name is stored for every device, owner-only, and checked like presence names", async () => {
  const d = await create("profile.md", "A passage.");
  await request(`/api/docs/${d.id}/comments`, "POST", {
    name: "alex",
    body: "Written before the change",
  });
  const config = async (owner = true) =>
    (
      await fetch(base + "/api/config", {
        headers: {
          Cookie: cookie,
          ...(owner ? { Authorization: `Bearer ${key}` } : {}),
        },
      })
    ).json();
  const choose = (name, owner = true) =>
    fetch(base + "/api/profile", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Origin: base,
        Cookie: cookie,
        ...(owner ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({ name }),
    });
  assert.equal((await config()).ownerName, "alex", "LOCDOC_OWNER_NAME first");
  assert.equal((await choose("A visitor", false)).status, 403);
  for (const name of ["", "   ", "Tab\tname", "x".repeat(61)])
    assert.equal((await choose(name)).status, 400, JSON.stringify(name));
  assert.equal((await config()).ownerName, "alex");
  const saved = await choose(" Ilya ");
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { name: "Ilya" });
  assert.equal((await config()).ownerName, "Ilya");
  assert.equal((await config(false)).ownerName, undefined);
  await stop();
  await start();
  assert.equal(
    (await config()).ownerName,
    "Ilya",
    "the choice outlasts a restart that still sets LOCDOC_OWNER_NAME",
  );
  assert.ok(
    (await readFile(join(dir, "docs/profile.md"), "utf8")).includes(
      "[[comment(alex): Written before the change]]",
    ),
    "existing comment records keep their name",
  );
});
