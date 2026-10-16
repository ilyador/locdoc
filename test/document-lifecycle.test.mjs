import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rename,
  unlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WebSocket from "ws";

test("document identity survives aliases and rename, while new files never inherit shares", async () => {
  const dir = await mkdtemp(join(tmpdir(), "locdoc-lifecycle-"));
  await mkdir(join(dir, "state"));
  await writeFile(join(dir, "state/owner.key"), "lifecycle-owner");
  const base = "http://127.0.0.1:3484";
  const server = spawn("./target/debug/locdoc", [], {
    env: {
      ...process.env,
      LOCDOC_BIND: "127.0.0.1:3484",
      LOCDOC_STATE: join(dir, "state"),
      LOCDOC_DOCS: join(dir, "docs"),
      LOCDOC_PUBLIC_URL: base,
    },
    stdio: "ignore",
  });
  const peers = [];
  async function until(check) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw Error("Test server exited");
      if (await check()) return;
      await delay(20);
    }
    throw Error("Timed out waiting for lifecycle condition");
  }
  async function request(path, method = "GET", body, owner = true) {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(owner ? { Authorization: "Bearer lifecycle-owner" } : {}),
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  }
  function connect(id) {
    const doc = new Y.Doc();
    class Socket extends WebSocket {
      constructor(url) {
        super(url, { headers: { Authorization: "Bearer lifecycle-owner" } });
      }
    }
    const provider = new WebsocketProvider(
      base.replace("http", "ws") + "/ws",
      id,
      doc,
      { WebSocketPolyfill: Socket, disableBc: true },
    );
    provider.messageHandlers[121] = () => {};
  provider.messageHandlers[127] = () => {};
    provider.messageHandlers[122] = () => {};
    provider.messageHandlers[123] = () => {};
    peers.push(provider);
    return { doc, provider, text: doc.getText("content") };
  }
  try {
    await until(async () => {
      try {
        return (await fetch(base + "/api/config")).ok;
      } catch {
        return false;
      }
    });
    const first = await request("/api/files", "POST", {
      kind: "file",
      path: "reuse.md",
    });
    const share = await request(`/api/docs/${first.body.id}/share`, "POST", {
      permission: "edit",
    });
    const token = share.body.shareUrl.split("/").pop();
    await rename(join(dir, "docs/reuse.md"), join(dir, "docs/archive.md"));
    const replacement = await request("/api/files", "POST", {
      kind: "file",
      path: "reuse.md",
    });
    assert.equal(replacement.status, 200);
    assert.notEqual(replacement.body.id, first.body.id);
    assert.equal(replacement.body.permission, "private");
    assert.equal(
      (await request(`/api/open/${token}`, "GET", undefined, false)).status,
      404,
    );

    const alias = await request("/api/files", "POST", {
      kind: "file",
      path: "Folder//alias.md",
    });
    const tree = await request("/api/tree");
    const canonical = tree.body.entries.find(
      (entry) => entry.path === "Folder/alias.md",
    );
    assert.equal(alias.body.id, canonical.id);
    const a = connect(alias.body.id),
      b = connect(canonical.id);
    await Promise.all([once(a.provider, "sync"), once(b.provider, "sync")]);
    b.text.insert(b.text.length, "Both clients see this");
    await until(() => a.text.toString().includes("Both clients see this"));
    assert.equal(a.text.toString(), b.text.toString());

    const alpha = await request("/api/files", "POST", {
      kind: "file",
      path: "alpha.md",
    });
    await request("/api/files", "POST", { kind: "file", path: "beta.md" });
    await unlink(join(dir, "docs/beta.md"));
    assert.equal(
      (
        await request(`/api/docs/${alpha.body.id}`, "PATCH", {
          path: "beta.md",
        })
      ).status,
      200,
    );
    assert.equal(
      (await request(`/api/docs/${alpha.body.id}`)).body.path,
      "beta.md",
    );
    assert.equal(
      await readFile(join(dir, "docs/beta.md"), "utf8"),
      "# alpha\n\n",
    );
    // A complete editor-style atomic replacement keeps the same sharing identity.
    const file = join(dir, "docs/beta.md"),
      temp = join(dir, "docs/.save.tmp");
    await writeFile(temp, "Desktop editor saved this 👋");
    await rename(temp, file);
    await until(
      async () =>
        (await request(`/api/docs/${alpha.body.id}`)).body.content ===
        "Desktop editor saved this 👋",
    );
    assert.equal(
      (await request("/api/tree")).body.entries.find(
        (entry) => entry.path === "beta.md",
      ).id,
      alpha.body.id,
    );
  } finally {
    for (const peer of peers) {
      peer.destroy();
      peer.doc.destroy();
    }
    server.kill("SIGINT");
    if (server.exitCode === null) await once(server, "exit");
    await rm(dir, { recursive: true, force: true });
  }
});
