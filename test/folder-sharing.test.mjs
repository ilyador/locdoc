import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  rename,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WebSocket from "ws";

const base = "http://127.0.0.1:3514",
  key = "folder-sharing-fixture-owner";
let dir, server, cookie;
const peers = [];
async function until(check) {
  const end = Date.now() + 7000;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(20);
  }
  throw Error("Folder sharing condition timed out");
}
async function request(
  path,
  { method = "GET", body, owner = true, status = 200 } = {},
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie || "",
      ...(owner ? { Authorization: `Bearer ${key}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(7000),
  });
  const data = await response.json();
  assert.equal(response.status, status, JSON.stringify(data));
  return data;
}
async function doc(path, source = "# Document\n\nA passage.\n") {
  const result = await request("/api/files", {
    method: "POST",
    body: { path, kind: "file" },
  });
  await writeFile(join(dir, "docs", path), source);
  await request(`/api/docs/${result.id}`);
  return result;
}
async function share(path, permission = "view", rotate = false) {
  const result = await request("/api/folders/share", {
    method: "POST",
    body: { path, permission, rotate },
  });
  return { ...result, token: result.shareUrl?.split("/").pop() };
}
function connect(document, token) {
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, Buffer.from(document.state, "base64"));
  const provider = new WebsocketProvider(
    base.replace("http", "ws") + "/ws",
    document.id,
    ydoc,
    {
      params: { token, client: "plain-text-v2" },
      disableBc: true,
      WebSocketPolyfill: WebSocket,
    },
  );
  for (const tag of [121, 122, 123, 126, 127])
    provider.messageHandlers[tag] = () => {};
  const peer = { ydoc, provider, text: ydoc.getText("content") };
  peers.push(peer);
  return peer;
}

test("Fountain files share the same discovery, concurrent editing and desktop sync", async () => {
  const created = await request("/api/files", {
    method: "POST",
    body: { kind: "file", path: "Scripts/Signal.fountain" },
  });
  assert.equal(
    await readFile(join(dir, "docs/Scripts/Signal.fountain"), "utf8"),
    "Title: Signal\n\n",
  );
  await writeFile(
    join(dir, "docs/Scripts/Other.FOUNTAIN"),
    "INT. ROOM - DAY\n\nA quiet room.",
  );
  const tree = await request("/api/tree");
  assert.ok(tree.entries.some((e) => e.path === "Scripts/Other.FOUNTAIN"));
  const grant = await share("Scripts", "edit");
  const snapshot = await request(
    `/api/docs/${created.id}?token=${grant.token}`,
    { owner: false },
  );
  const a = connect(snapshot, grant.token),
    b = connect(snapshot, grant.token);
  await until(() => a.provider.synced && b.provider.synced);
  a.text.insert(a.text.length, "INT. STUDIO - DAY\n\n");
  b.text.insert(b.text.length, "A signal arrives.\n");
  await until(
    () =>
      a.text.toString() === b.text.toString() &&
      a.text.toString().includes("STUDIO") &&
      a.text.toString().includes("signal arrives"),
  );
  await until(
    async () =>
      (await readFile(join(dir, "docs/Scripts/Signal.fountain"), "utf8")) ===
      a.text.toString(),
  );
  await writeFile(
    join(dir, "docs/Scripts/Signal.fountain"),
    a.text.toString() + "\nMORGAN\nDesktop dialogue.\n",
  );
  await until(
    () =>
      a.text.toString().includes("Desktop dialogue") &&
      a.text.toString() === b.text.toString(),
  );
  await request(`/api/docs/${created.id}`, {
    method: "PATCH",
    body: { path: "Scripts/Renamed.FOUNTAIN" },
  });
  const renamed = await request(
    `/api/docs/${created.id}?token=${grant.token}`,
    { owner: false },
  );
  assert.equal(renamed.path, "Renamed.FOUNTAIN");
  assert.ok(
    (
      await readFile(join(dir, "docs/Scripts/Renamed.FOUNTAIN"), "utf8")
    ).includes("Desktop dialogue"),
  );
  a.provider.destroy();
  b.provider.destroy();
});
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "locdoc-folder-test-"));
  await mkdir(join(dir, "state"));
  await mkdir(join(dir, "docs"));
  await writeFile(join(dir, "state/owner.key"), key);
  server = spawn("./target/debug/locdoc", [], {
    env: {
      ...process.env,
      LOCDOC_BIND: "127.0.0.1:3514",
      LOCDOC_DOCS: join(dir, "docs"),
      LOCDOC_STATE: join(dir, "state"),
      LOCDOC_PUBLIC_URL: base,
    },
    stdio: "ignore",
  });
  await until(async () => {
    if (server.exitCode !== null) throw Error("Fixture server exited");
    try {
      return (await fetch(base + "/api/config")).ok;
    } catch {
      return false;
    }
  });
  cookie = (await fetch(base + "/api/config")).headers
    .get("set-cookie")
    .split(";")[0];
});
after(async () => {
  for (const peer of peers) {
    peer.provider.destroy();
    peer.ydoc.destroy();
  }
  server?.kill("SIGINT");
  if (server?.exitCode === null) await once(server, "exit");
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("folder bootstrap exposes only descendants, with relative paths and selected-document refresh", async () => {
  const first = await doc("Team/first.md");
  const nested = await doc("Team/Design/second.md");
  const outside = await doc("Team-private/secret.md");
  await doc("elsewhere.md");
  await writeFile(join(dir, "docs/Team/.secret.md"), "hidden");
  await symlink(join(dir, "docs/Team-private"), join(dir, "docs/Team/alias"));
  const grant = await share("Team");
  const opened = await request(`/api/open/${grant.token}?doc=${nested.id}`, {
    owner: false,
  });
  assert.equal(opened.root, "");
  assert.equal(opened.folder.name, "Team");
  assert.equal(opened.document.id, nested.id);
  assert.equal(opened.document.edit, false);
  assert.deepEqual(
    opened.entries.map((e) => e.path),
    ["Design", "Design/second.md", "first.md"],
  );
  for (const entry of opened.entries.filter((e) => e.id))
    assert.equal(entry.url, `${base}/s/${grant.token}?doc=${entry.id}`);
  await request(`/api/open/${grant.token}?doc=${outside.id}`, {
    owner: false,
    status: 403,
  });
  await request(`/api/docs/${outside.id}?token=${grant.token}`, {
    owner: false,
    status: 403,
  });
  const tree = await request(`/api/tree?token=${grant.token}`, {
    owner: false,
  });
  assert.equal(tree.entries.length, 3);
  const owner = await request(`/api/docs/${first.id}?token=${grant.token}`);
  assert.equal(owner.edit, true);
  assert.equal(owner.owner, true);
  await request("/api/folders/share?path=Team", { owner: false, status: 403 });
  await request("/api/folders/share", {
    owner: false,
    method: "POST",
    body: { path: "Team", permission: "edit" },
    status: 403,
  });
});

test("new nested documents inherit folder access; empty folders can be shared", async () => {
  await mkdir(join(dir, "docs/Empty"));
  const grant = await share("Empty", "edit");
  const empty = await request(`/api/open/${grant.token}`, { owner: false });
  assert.equal(empty.document, null);
  assert.deepEqual(empty.entries, []);
  const created = await doc("Empty/New/deep.md");
  const opened = await request(`/api/open/${grant.token}`, { owner: false });
  assert.equal(opened.document.id, created.id);
  assert.equal(opened.document.permission, "edit");
  await request("/api/files?token=" + grant.token, {
    owner: false,
    method: "POST",
    body: { path: "escape.md", kind: "file" },
    status: 403,
  });
});

test("view links allow source comments but reject forged CRDT writes and uploads", async () => {
  const d = await doc("Review/page.md");
  const grant = await share("Review");
  const snapshot = await request(`/api/docs/${d.id}?token=${grant.token}`, {
    owner: false,
  });
  const peer = connect(snapshot, grant.token);
  await until(() => peer.provider.synced);
  peer.text.insert(0, "FORGED WRITE");
  await request(`/api/docs/${d.id}/comments?token=${grant.token}`, {
    owner: false,
    method: "POST",
    body: { name: "Alex", body: "A folder comment", quote: "passage" },
  });
  const source = await readFile(join(dir, "docs/Review/page.md"), "utf8");
  assert.ok(!source.includes("FORGED"));
  assert.ok(source.includes("[[comment(Alex): A folder comment]]"));
  const form = new FormData();
  form.append(
    "file",
    new Blob(
      [
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7xkAAAAASUVORK5CYII=",
          "base64",
        ),
      ],
      { type: "image/png" },
    ),
    "pixel.png",
  );
  // Buffer this small fixture: an early 403 can close the socket while Node's
  // streaming multipart encoder is still writing, hiding the actual response.
  const encoded = new Response(form);
  const upload = await fetch(
    `${base}/api/docs/${d.id}/upload?token=${grant.token}`,
    {
      method: "POST",
      headers: { "Content-Type": encoded.headers.get("Content-Type") },
      body: await encoded.arrayBuffer(),
      signal: AbortSignal.timeout(7000),
    },
  );
  assert.equal(upload.status, 403);
  await request(`/api/docs/${d.id}/share?token=${grant.token}`, {
    owner: false,
    method: "POST",
    body: { permission: "edit" },
    status: 403,
  });
  peer.provider.destroy();
});

test("folder editing merges two simultaneous clients and desktop edits without cross-document access", async () => {
  const d = await doc("Writing/page.md");
  const other = await doc("Outside/page.md");
  const grant = await share("Writing", "edit");
  const snapshot = await request(`/api/docs/${d.id}?token=${grant.token}`, {
    owner: false,
  });
  const a = connect(snapshot, grant.token),
    b = connect(snapshot, grant.token);
  await until(() => a.provider.synced && b.provider.synced);
  for (let i = 0; i < 30; i++) {
    a.text.insert(a.text.length, ` A${i}🧡`);
    b.text.insert(b.text.length, ` B${i}🌍`);
  }
  await until(
    () =>
      a.text.toString() === b.text.toString() &&
      a.text.toString().includes("B29"),
  );
  await until(
    async () =>
      (await readFile(join(dir, "docs/Writing/page.md"), "utf8")) ===
      a.text.toString(),
  );
  for (let i = 0; i < 30; i++) {
    assert.ok(a.text.toString().includes(` A${i}🧡`));
    assert.ok(a.text.toString().includes(` B${i}🌍`));
  }
  await writeFile(
    join(dir, "docs/Writing/page.md"),
    a.text.toString() + "\nDesktop addition.",
  );
  await until(
    () =>
      a.text.toString().includes("Desktop addition.") &&
      a.text.toString() === b.text.toString(),
  );
  await request(`/api/docs/${other.id}?token=${grant.token}`, {
    owner: false,
    status: 403,
  });
  a.provider.destroy();
  b.provider.destroy();
});

test("rotation, downgrade, and revocation apply to connected peers while independent document links survive", async () => {
  const d = await doc("Access/page.md");
  let grant = await share("Access", "edit");
  const independent = await request(`/api/docs/${d.id}/share`, {
    method: "POST",
    body: { permission: "view" },
  });
  const snapshot = await request(`/api/docs/${d.id}?token=${grant.token}`, {
    owner: false,
  });
  const peer = connect(snapshot, grant.token);
  await until(() => peer.provider.synced);
  await share("Access", "view");
  const view = await request(`/api/docs/${d.id}?token=${grant.token}`, {
    owner: false,
  });
  assert.equal(view.edit, false);
  peer.text.insert(0, "AFTER DOWNGRADE");
  const previous = grant.token;
  grant = await share("Access", "edit", true);
  assert.notEqual(previous, grant.token);
  await request(`/api/docs/${d.id}?token=${previous}`, {
    owner: false,
    status: 403,
  });
  await request(`/api/open/${previous}`, { owner: false, status: 404 });
  assert.ok(
    !(await readFile(join(dir, "docs/Access/page.md"), "utf8")).includes(
      "AFTER DOWNGRADE",
    ),
  );
  await share("Access", "private");
  await request(`/api/docs/${d.id}?token=${grant.token}`, {
    owner: false,
    status: 403,
  });
  await request(`/api/open/${independent.shareUrl.split("/").pop()}`, {
    owner: false,
  });
  assert.equal((await request(`/api/docs/${d.id}`)).edit, true);
  peer.provider.destroy();
});

test("nested grants do not grant parents; moved files and replacement folders cannot revive old links", async () => {
  const d = await doc("Scoped/Child/page.md");
  const parent = await doc("Scoped/private.md");
  const nested = await share("Scoped/Child");
  await request(`/api/docs/${parent.id}?token=${nested.token}`, {
    owner: false,
    status: 403,
  });
  await request(`/api/docs/${d.id}`, {
    method: "PATCH",
    body: { path: "Scoped/Child/renamed.md" },
  });
  await request(`/api/docs/${d.id}?token=${nested.token}`, { owner: false });
  await rename(join(dir, "docs/Scoped/Child"), join(dir, "docs/MovedChild"));
  await mkdir(join(dir, "docs/Scoped/Child"));
  const replacement = await doc("Scoped/Child/replacement.md");
  await request(`/api/open/${nested.token}`, { owner: false, status: 404 });
  await request(`/api/docs/${replacement.id}?token=${nested.token}`, {
    owner: false,
    status: 403,
  });
  const renewed = await share("Scoped/Child");
  assert.notEqual(renewed.token, nested.token);
  await request(`/api/open/${renewed.token}`, { owner: false });
  const state = await request("/api/folders/share?path=Scoped%2FChild");
  assert.equal(state.shareUrl, renewed.shareUrl);
});

test("path aliases normalize once; traversal, symlink, file and hidden folder grants are rejected", async () => {
  await doc("Paths/file.md");
  const first = await share("./Paths//");
  const second = await share("Paths");
  assert.equal(first.token, second.token);
  for (const path of [
    "../Paths",
    "/tmp",
    "Paths/../Paths",
    ".hidden",
    "Paths\\child",
  ]) {
    await request("/api/folders/share", {
      method: "POST",
      body: { path, permission: "view" },
      status: 400,
    });
  }
  await request("/api/folders/share", {
    method: "POST",
    body: { path: "Paths/file.md", permission: "view" },
    status: 400,
  });
  await symlink(join(dir, "docs/Paths"), join(dir, "docs/Alias"));
  await request("/api/folders/share", {
    method: "POST",
    body: { path: "Alias", permission: "view" },
    status: 403,
  });
});

test("internal previews authorize folder destinations and preserve the folder link", async () => {
  const target = await doc("Links/target.md", "# Shared target\n");
  const outside = await doc("Hidden/target.md", "# Secret title\n");
  const targetUrl = `${base}/d/${target.id}`,
    outsideUrl = `${base}/d/${outside.id}`;
  const source = await doc(
    "Links/source.md",
    `[Target](${targetUrl}) [Private](${outsideUrl})`,
  );
  const grant = await share("Links");
  const preview = await request(
    `/api/docs/${source.id}/link-preview?token=${grant.token}&url=${encodeURIComponent(targetUrl)}`,
    { owner: false },
  );
  assert.equal(preview.title, "Shared target");
  assert.equal(preview.url, `${base}/s/${grant.token}?doc=${target.id}`);
  await request(
    `/api/docs/${source.id}/link-preview?token=${grant.token}&url=${encodeURIComponent(outsideUrl)}`,
    { owner: false, status: 403 },
  );
  const sharedPreview = await request(
    `/api/docs/${source.id}/link-preview?token=${grant.token}&url=${encodeURIComponent(preview.url)}`,
    { status: 200 },
  );
  assert.equal(sharedPreview.id, target.id);
});

test("namespace changes close passive folder sockets before later edits are relayed", async () => {
  const d = await doc("Passive/page.md");
  const folder = await share("Passive", "view");
  const direct = await request(`/api/docs/${d.id}/share`, {
    method: "POST",
    body: { permission: "edit" },
  });
  const snapshot = await request(`/api/docs/${d.id}?token=${folder.token}`, {
    owner: false,
  });
  const viewer = connect(snapshot, folder.token),
    writer = connect(snapshot, direct.shareUrl.split("/").pop());
  await until(() => viewer.provider.synced && writer.provider.synced);
  // Exercise a real namespace replacement: the document and independent editor
  // capability remain valid, while the original directory grant does not.
  await rename(join(dir, "docs/Passive"), join(dir, "docs/Passive-old"));
  await mkdir(join(dir, "docs/Passive"));
  await rename(join(dir, "docs/Passive-old/page.md"), join(dir, "docs/Passive/page.md"));
  let probes = 0;
  await until(() => {
    writer.provider.awareness.setLocalStateField("user", { name: `Probe ${++probes}` });
    return !viewer.provider.wsconnected;
  });
  writer.text.insert(writer.text.length, "PRIVATE AFTER REPLACEMENT");
  await until(async () =>
    (await readFile(join(dir, "docs/Passive/page.md"), "utf8")).includes(
      "PRIVATE AFTER REPLACEMENT",
    ),
  );
  await until(() => !viewer.provider.wsconnected);
  assert.ok(!viewer.text.toString().includes("PRIVATE AFTER REPLACEMENT"));
  writer.provider.destroy();
  viewer.provider.destroy();
});
