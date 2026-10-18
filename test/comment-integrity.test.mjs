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

test("desktop cut/paste keeps unique thread dates and resolution without carrying author rights across raw copies", async () => {
  const source = "First passage.\n\nDestination passage.";
  const doc = await create(source);
  const posted = await request(`/api/docs/${doc.id}/comments`, "POST", {
    name: "Ana",
    body: "An unchanged conversation",
    anchor: anchor(doc, 0, 5),
    quote: "First",
    requestId: crypto.randomUUID(),
  });
  await request(`/api/docs/${doc.id}/comments/${posted.id}`, "PATCH", {
    name: "Alex",
    body: "An unchanged reply",
    resolved: true,
    requestId: crypto.randomUUID(),
  });
  const before = await request(`/api/docs/${doc.id}/comments`);
  const current = await request(`/api/docs/${doc.id}`);
  const thread = sourceComments(current.content)[0];
  const raw = current.content.slice(thread.from, thread.to);
  const cut = current.content.slice(0, thread.from) + current.content.slice(thread.to);
  await writeFile(join(dir, "docs", doc.path), cut);
  assert.equal((await request(`/api/docs/${doc.id}/comments`)).comments.length, 0);
  await writeFile(join(dir, "docs", doc.path), `${cut}\n\n${raw}`);
  const moved = (await request(`/api/docs/${doc.id}/comments`)).comments[0];
  assert.equal(moved.id, posted.id);
  assert.equal(moved.created, before.comments[0].created);
  assert.equal(moved.replies[0].created, before.comments[0].replies[0].created);
  assert.equal(moved.resolved, true);
  assert.equal(moved.guest, undefined, "internal author identity is never exposed");
  assert.equal(moved.requestId, undefined);
  assert.equal(moved.replyRequests, undefined);

  const secondDoc = await create(`A different document.\n\n${raw}`);
  const independent = (await request(`/api/docs/${secondDoc.id}/comments`)).comments[0];
  assert.notEqual(independent.id, posted.id, "metadata never crosses documents");
  assert.equal(independent.created, 0);
  assert.equal(independent.resolved, false);

  const movedSource = (await request(`/api/docs/${doc.id}`)).content;
  await writeFile(join(dir, "docs", doc.path), `${movedSource}\n\n${raw}`);
  const copies = (await request(`/api/docs/${doc.id}/comments`)).comments;
  assert.equal(copies.length, 2);
  assert.equal(copies[0].id, posted.id);
  assert.notEqual(copies[1].id, posted.id);
  assert.equal(copies[1].created, 0);
  const copiedThread = sourceComments(`${movedSource}\n\n${raw}`)[0];
  const copiedSource = `${movedSource}\n\n${raw}`;
  await writeFile(join(dir, "docs", doc.path), copiedSource.slice(0, copiedThread.from) + copiedSource.slice(copiedThread.to));
  const survivingCopy = (await request(`/api/docs/${doc.id}/comments`)).comments[0];
  assert.equal(survivingCopy.id, copies[1].id, "deleting the original cannot reassign its metadata to an existing copy");
  assert.equal(survivingCopy.resolved, false);
});

test("out-of-range comment anchor IDs return an error without crashing or aliasing valid positions", async () => {
  const doc = await create("A safe selected passage.");
  const selected = anchor(doc, 2, 6);
  for (const field of ["item", "type"]) {
    const invalid = structuredClone(selected);
    invalid.start[field] = { client: 2 ** 53, clock: 0 };
    const response = await fetch(`${base}/api/docs/${doc.id}/comments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify({ name: "Ana", body: "Must not be inserted", anchor: invalid }),
      signal: AbortSignal.timeout(7000),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "Invalid comment anchor.");
    const current = await request(`/api/docs/${doc.id}`);
    assert.equal(current.content, "A safe selected passage.");
    assert.equal((await request(`/api/docs/${doc.id}/comments`)).comments.length, 0);
  }
});
