import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import * as Y from "yjs";
import {
  commentParser,
  commentReadingText,
  sourceComments,
} from "../src/comment-syntax.ts";

const base = "http://127.0.0.1:3522";
const key = "comment-integrity-fixture-owner";
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
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  return data;
}
async function create(source) {
  const path = crypto.randomUUID() + ".md";
  const created = await request("/api/files", "POST", { path, kind: "file" });
  await writeFile(join(dir, "docs", path), source);
  return request(`/api/docs/${created.id}`);
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
function selectedText(snapshot, selected) {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, Buffer.from(snapshot.state, "base64"));
    const from = Y.createAbsolutePositionFromRelativePosition(
      selected.start,
      doc,
    );
    const to = Y.createAbsolutePositionFromRelativePosition(selected.end, doc);
    assert.ok(from && to, "selected passage anchors must still resolve");
    return doc.getText("content").toString().slice(from.index, to.index);
  } finally {
    doc.destroy();
  }
}
const visible = (source) =>
  commentReadingText(source)
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "locdoc-comment-integrity-"));
  await mkdir(join(dir, "docs"));
  await mkdir(join(dir, "state"));
  await writeFile(join(dir, "state", "owner.key"), key);
  server = spawn("./target/debug/locdoc", [], {
    env: {
      ...process.env,
      LOCDOC_BIND: "127.0.0.1:3522",
      LOCDOC_DOCS: join(dir, "docs"),
      LOCDOC_STATE: join(dir, "state"),
      LOCDOC_PUBLIC_URL: base,
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null)
      throw Error("Comment integrity fixture exited");
    try {
      const response = await fetch(base + "/api/config");
      if (response.ok) {
        cookie = response.headers.get("set-cookie").split(";")[0];
        return;
      }
    } catch {}
    await delay(50);
  }
  throw Error("Comment integrity fixture did not start");
});
after(async () => {
  if (server && server.exitCode === null) {
    server.kill("SIGINT");
    await once(server, "exit");
  }
  if (dir) await rm(dir, { recursive: true, force: true });
});

for (const [name, source, from, to] of [
  ["a selection ending at the next list item", "- one\n- two\n", 0, 6],
  ["a selection ending at the next paragraph", "one\n\ntwo", 0, 5],
  [
    "a table cell with following prose",
    "| Name | Value |\n| - | - |\n| one | two |\n\nAfter the table.",
    2,
    6,
  ],
  [
    "an HTML attribute",
    'Before <span title="hello">text</span> after.',
    19,
    24,
  ],
  ["a nested list", "- first\n  - nested\n- last\n\nAfter the list.", 12, 18],
  ["a link label", "Before [a link](https://example.test) after.", 8, 14],
  ["a heading with closing marks", "# A heading #\n\nAfter.", 4, 11],
]) {
  test(`comment records preserve ${name} and its selected passage`, async () => {
    const doc = await create(source);
    const selected = anchor(doc, from, to);
    const payload = {
      name: "Ana",
      body: "A precise comment",
      quote: source.slice(from, to),
      anchor: selected,
      requestId: crypto.randomUUID(),
    };
    const posted = await request(
      `/api/docs/${doc.id}/comments`,
      "POST",
      payload,
    );
    const current = await request(`/api/docs/${doc.id}`);
    assert.equal(visible(current.content), visible(source));
    assert.equal(
      commentParser.parse(commentReadingText(current.content)).toString(),
      commentParser.parse(source).toString(),
      "the visible Markdown syntax must retain its original structure",
    );
    assert.equal(selectedText(current, posted.anchor), source.slice(from, to));
    assert.equal(
      await readFile(join(dir, "docs", doc.path), "utf8"),
      current.content,
    );
    const repeated = await request(
      `/api/docs/${doc.id}/comments`,
      "POST",
      payload,
    );
    assert.equal(repeated.id, posted.id, "a retried request is idempotent");
    assert.equal(
      (await request(`/api/docs/${doc.id}`)).content,
      current.content,
    );
  });
}

test("separate conversations and replies on the same word preserve prose and thread identity", async () => {
  const source =
    "A long paragraph with a selected word and more prose after it.";
  const doc = await create(source);
  const selected = anchor(doc, 24, 32);
  const one = await request(`/api/docs/${doc.id}/comments`, "POST", {
    name: "Ana",
    body: "First conversation",
    anchor: selected,
    quote: source.slice(24, 32),
    requestId: crypto.randomUUID(),
  });
  await request(`/api/docs/${doc.id}/comments/${one.id}`, "PATCH", {
    resolved: true,
  });
  const two = await request(`/api/docs/${doc.id}/comments`, "POST", {
    name: "Alex",
    body: "Second conversation",
    anchor: selected,
    quote: source.slice(24, 32),
    requestId: crypto.randomUUID(),
  });
  await request(`/api/docs/${doc.id}/comments/${two.id}`, "PATCH", {
    name: "Ana",
    body: "Reply to second",
    requestId: crypto.randomUUID(),
  });
  const current = await request(`/api/docs/${doc.id}`);
  assert.equal(visible(current.content), source);
  assert.equal(selectedText(current, selected), source.slice(24, 32));
  const { comments } = await request(`/api/docs/${doc.id}/comments`);
  assert.equal(comments.length, 2);
  assert.equal(comments.find((c) => c.id === one.id).resolved, true);
  assert.equal(comments.find((c) => c.id === one.id).created, one.created);
  assert.equal(
    comments.find((c) => c.id === two.id).replies[0].body,
    "Reply to second",
  );
  assert.deepEqual(
    sourceComments(current.content).map((thread) => thread.messages),
    comments.map((c) => [
      { name: c.name, body: c.body },
      ...c.replies.map(({ name, body }) => ({ name, body })),
    ]),
  );
});
