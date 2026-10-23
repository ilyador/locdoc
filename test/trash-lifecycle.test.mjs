import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WebSocket from "ws";
import { freePort } from "./fixtures/free-port.mjs";

test("an open document follows a folder move, closes when deleted and returns whole", async () => {
  const dir = await mkdtemp(join(tmpdir(), "locdoc-trash-"));
  await mkdir(join(dir, "state"));
  await writeFile(join(dir, "state/owner.key"), "trash-owner");
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawn("./target/debug/locdoc", [], {
    env: {
      ...process.env,
      LOCDOC_BIND: `127.0.0.1:${port}`,
      LOCDOC_STATE: join(dir, "state"),
      LOCDOC_DOCS: join(dir, "docs"),
      LOCDOC_PUBLIC_URL: base,
    },
    stdio: "ignore",
  });
  const owner = { Authorization: "Bearer trash-owner" };
  let provider;
  const doc = new Y.Doc();
  async function until(check, what) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw Error("Test server exited");
      if (await check()) return;
      await delay(25);
    }
    throw Error(`Timed out waiting until ${what}`);
  }
  async function request(path, method = "GET", body, headers = owner) {
    const response = await fetch(base + path, {
      method,
      headers: { ...headers, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  }
  const saved = (path, text) => async () =>
    existsSync(join(dir, "docs", path)) &&
    (await readFile(join(dir, "docs", path), "utf8")).includes(text);
  try {
    await until(async () => {
      try {
        return (await fetch(base + "/api/config")).ok;
      } catch {
        return false;
      }
    }, "the server answers");
    const page = await request("/api/files", "POST", {
      kind: "file",
      path: "Notes/page.md",
    });
    const id = page.body.id;
    const share = await request(`/api/docs/${id}/share`, "POST", {
      permission: "edit",
    });
    const token = share.body.shareUrl.split("/").pop();
    class Socket extends WebSocket {
      constructor(url) {
        super(url, { headers: owner });
      }
    }
    provider = new WebsocketProvider(base.replace("http", "ws") + "/ws", id, doc, {
      WebSocketPolyfill: Socket,
      disableBc: true,
    });
    for (const type of [121, 122, 123, 127]) provider.messageHandlers[type] = () => {};
    await until(() => provider.synced, "the editor syncs");
    const text = doc.getText("content");
    text.insert(text.length, "Typed before the move\n");
    await until(saved("Notes/page.md", "Typed before the move"), "the edit is saved");

    // The folder moves under the open document; it stays connected.
    const moved = await request("/api/folders", "PATCH", {
      from: "Notes",
      to: "Archive",
    });
    assert.deepEqual(moved.body, { ok: true, path: "Archive" });
    text.insert(text.length, "Typed after the move\n");
    await until(saved("Archive/page.md", "Typed after the move"), "edits reach the moved file");
    assert.equal(existsSync(join(dir, "docs/Notes")), false);
    assert.equal(provider.wsconnected, true);

    // Deleting it closes the socket; the owner learns it is in the trash,
    // and its link is refused as a removed document's.
    const closed = new Promise((resolve) => provider.once("connection-close", resolve));
    const deleted = await request(`/api/docs/${id}`, "DELETE");
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.trash.path, "Archive/page.md");
    await closed;
    const gone = await request(`/api/docs/${id}`);
    assert.equal(gone.status, 410);
    assert.equal(gone.body.error, "trashed");
    assert.deepEqual(gone.body.trash, deleted.body.trash);
    assert.equal((await request(`/api/open/${token}`, "GET", undefined, {})).status, 404);
    assert.equal((await request(`/api/docs/${id}?token=${token}`, "GET", undefined, {})).status, 404);
    const listing = await request("/api/tree");
    assert.deepEqual(
      listing.body.entries.map((entry) => entry.path),
      ["Archive"],
    );
    await delay(700);
    assert.equal(provider.wsconnected, false, "reconnects are refused while it is in the trash");

    // Restored, the editor reconnects to it, edits save again and the link opens it.
    const restored = await request(`/api/trash/${deleted.body.trash.id}/restore`, "POST");
    assert.deepEqual(restored.body, { ok: true, path: "Archive/page.md" });
    await until(() => provider.wsconnected && provider.synced, "the editor reconnects");
    text.insert(text.length, "Typed after the restore\n");
    await until(saved("Archive/page.md", "Typed after the restore"), "edits save after the restore");
    const file = await readFile(join(dir, "docs/Archive/page.md"), "utf8");
    for (const line of ["Typed before the move", "Typed after the move", "Typed after the restore"]) {
      assert.equal(file.split(line).length, 2, line);
    }
    const reopened = await request(`/api/open/${token}`, "GET", undefined, {});
    assert.equal(reopened.status, 200);
    assert.equal(reopened.body.document.id, id);
    assert.deepEqual((await request("/api/trash")).body, { items: [] });
  } finally {
    provider?.destroy();
    doc.destroy();
    server.kill("SIGINT");
    if (server.exitCode === null) await once(server, "exit");
    await rm(dir, { recursive: true, force: true });
  }
});
