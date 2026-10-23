import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import * as Y from "yjs";
import { sourceComments } from "../src/comment-syntax.ts";
import { freePort } from "./fixtures/free-port.mjs";

// The fixture server takes a free port: a fixed one can belong to another
// local server.
let base;
const key = "adversarial-comment-fixture-owner";
let dir, server, cookie;
async function request(path, method = "GET", body) {
  const response = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Cookie: cookie || "",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(7000),
  });
  return { status: response.status, data: await response.json() };
}
async function ok(path, method = "GET", body) {
  const result = await request(path, method, body);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data;
}
async function create(source) {
  const path = crypto.randomUUID() + ".md";
  const created = await ok("/api/files", "POST", { path, kind: "file" });
  await writeFile(join(dir, "docs", path), source);
  return ok(`/api/docs/${created.id}`);
}
function anchor(snapshot, from, to) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(snapshot.state, "base64"));
  const text = doc.getText("content");
  const result = {
    start: Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(text, from),
    ),
    end: Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(text, to, -1),
    ),
  };
  doc.destroy();
  return result;
}
const serverMessages = (comments) =>
  comments.map((c) => [
    { name: c.name, body: c.body },
    ...c.replies.map(({ name, body }) => ({ name, body })),
  ]);

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  dir = await mkdtemp(join(tmpdir(), "locdoc-adversarial-comments-"));
  await mkdir(join(dir, "docs"));
  await mkdir(join(dir, "state"));
  await writeFile(join(dir, "state", "owner.key"), key);
  server = spawn("./target/debug/locdoc", [], {
    env: {
      ...process.env,
      LOCDOC_BIND: `127.0.0.1:${port}`,
      LOCDOC_DOCS: join(dir, "docs"),
      LOCDOC_STATE: join(dir, "state"),
      LOCDOC_PUBLIC_URL: base,
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw Error("Comment fixture server exited");
    try {
      const config = await fetch(base + "/api/config");
      if (config.ok) {
        cookie = config.headers.get("set-cookie").split(";")[0];
        return;
      }
    } catch {}
    await delay(50);
  }
  throw Error("Comment fixture server did not start");
});
after(async () => {
  if (server && server.exitCode === null) {
    server.kill("SIGINT");
    await once(server, "exit");
  }
  if (dir) await rm(dir, { recursive: true, force: true });
});

for (const [description, source] of [
  ["a trailing backslash", "A backslash \\"],
  ["an unfinished bracket", "Do [something"],
  ["an HTML block without a final newline", '<span title="hello">'],
  ["a closed HTML block", "<div>one\n</div>"],
]) {
  test(`posting a root after ${description} cannot acknowledge an invisible comment`, async () => {
    const doc = await create(source);
    const post = await ok(`/api/docs/${doc.id}/comments`, "POST", {
      name: "alex",
      body: "Posted comment",
      anchor: anchor(doc, 0, source.length),
      requestId: crypto.randomUUID(),
    });
    const current = await ok(`/api/docs/${doc.id}`);
    const { comments } = await ok(`/api/docs/${doc.id}/comments`);
    assert.equal(
      comments.length,
      1,
      "an acknowledged root must remain readable",
    );
    assert.equal(
      comments[0].id,
      post.id,
      "the response must identify the readable root",
    );
    assert.deepEqual(
      sourceComments(current.content).map((t) => t.messages),
      serverMessages(comments),
    );
  });
}

test("an unfinished fenced block never swallows an acknowledged comment or mutates a rejected save", async () => {
  const source = "```md\nUnclosed code";
  const doc = await create(source);
  const result = await request(`/api/docs/${doc.id}/comments`, "POST", {
    name: "alex",
    body: "Posted comment",
    anchor: anchor(doc, 0, source.length),
    requestId: crypto.randomUUID(),
  });
  const disk = await readFile(join(dir, "docs", doc.path), "utf8");
  if (result.status !== 200) {
    assert.ok(result.status >= 400 && result.status < 500);
    assert.equal(disk, source, "rejection must not change the Markdown file");
    assert.equal(
      (await ok(`/api/docs/${doc.id}`)).content,
      source,
      "rejection must not change CRDT text",
    );
  } else {
    const { comments } = await ok(`/api/docs/${doc.id}/comments`);
    assert.equal(comments.length, 1);
    assert.equal(comments[0].id, result.data.id);
    assert.deepEqual(
      sourceComments(disk).map((t) => t.messages),
      serverMessages(comments),
    );
  }
});

for (const gap of [" ", "\n", " \n\t"]) {
  test(`a separate root after an existing conversation plus ${JSON.stringify(gap)} does not become a reply`, async () => {
    const source = `Text[[comment(ana): Previous]]${gap}`;
    const doc = await create(source);
    const before = (await ok(`/api/docs/${doc.id}/comments`)).comments;
    const post = await ok(`/api/docs/${doc.id}/comments`, "POST", {
      name: "alex",
      body: "Separate conversation",
      anchor: anchor(doc, source.length, source.length),
      requestId: crypto.randomUUID(),
    });
    const { comments } = await ok(`/api/docs/${doc.id}/comments`);
    assert.equal(comments.length, 2);
    assert.ok(comments.some((c) => c.id === before[0].id));
    assert.ok(comments.some((c) => c.id === post.id));
    assert.ok(comments.every((c) => c.replies.length === 0));
  });
}

test("a separate root before whitespace preceding another conversation does not adopt the older messages", async () => {
  const source = " [[comment(ana): Previous]]";
  const doc = await create(source);
  const old = (await ok(`/api/docs/${doc.id}/comments`)).comments[0];
  const post = await ok(`/api/docs/${doc.id}/comments`, "POST", {
    name: "alex",
    body: "Separate conversation",
    anchor: anchor(doc, 0, 0),
    requestId: crypto.randomUUID(),
  });
  const { comments } = await ok(`/api/docs/${doc.id}/comments`);
  assert.equal(comments.length, 2);
  assert.ok(comments.some((c) => c.id === old.id));
  assert.ok(comments.some((c) => c.id === post.id));
});

for (const source of [
  "A [unfinished [[comment(alex): note]]",
  "[text[[comment(alex): note]]]",
  "![text[[comment(alex): note]]]",
  "[text[[comment(alex): note]]][undefined]",
  "<https://a.test/[[comment(alex): note]]>",
  "<https://a.test/[[comment(alex):note]]>",
  "a\r[[comment(alex): one]]\r[[comment(ana): two]]",
  "[[comment(alex): a]]\r\r[[comment(ana): b]]",
  "[[comment(alex): a]]\r\n\r[[comment(ana): b]]",
]) {
  test(`desktop and editor parsers agree for ${JSON.stringify(source)}`, async () => {
    const doc = await create(source);
    const { comments } = await ok(`/api/docs/${doc.id}/comments`);
    assert.deepEqual(
      sourceComments(source).map((t) => t.messages),
      serverMessages(comments),
    );
  });
}

test("a modest desktop document imports and updates promptly without losing Unicode text", async () => {
  const line = "A normal paragraph with a few words, café, 世界, and 😀.\n";
  const source = line.repeat(Math.ceil(50000 / Buffer.byteLength(line)));
  const firstStarted = performance.now();
  const doc = await create(source);
  const firstElapsed = performance.now() - firstStarted;
  assert.equal(doc.content, source);
  assert.ok(
    firstElapsed < 2000,
    `A 50 KB desktop import took ${Math.round(firstElapsed)} ms`,
  );

  const from = source.indexOf("\n", 15000) + 1;
  const to = source.indexOf("\n", 15500) + 1;
  const changed =
    source.slice(0, from) + "A desktop change 😀.\n" + source.slice(to);
  const changedStarted = performance.now();
  await writeFile(join(dir, "docs", doc.path), changed);
  const current = await ok(`/api/docs/${doc.id}`);
  const changedElapsed = performance.now() - changedStarted;
  assert.equal(current.content, changed);
  assert.equal(await readFile(join(dir, "docs", doc.path), "utf8"), changed);
  assert.ok(
    changedElapsed < 2000,
    `A 50 KB desktop edit took ${Math.round(changedElapsed)} ms`,
  );
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Buffer.from(current.state, "base64"));
  assert.equal(copy.getText("content").toString(), changed);
  copy.destroy();
});
