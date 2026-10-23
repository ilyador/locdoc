import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { freePort } from "./fixtures/free-port.mjs";

const binary = resolve("target/debug/locdoc");
const key = "shutdown-owner";

// systemd stops and restarts the unit with SIGTERM, not SIGINT.
test("SIGTERM shuts the server down gracefully and keeps its state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "locdoc-shutdown-"));
  const state = join(dir, "state");
  await mkdir(state);
  await writeFile(join(state, "owner.key"), key);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let server;
  let logs = "";
  async function start() {
    logs = "";
    server = spawn(binary, [], {
      env: {
        ...process.env,
        LOCDOC_BIND: `127.0.0.1:${port}`,
        LOCDOC_PUBLIC_URL: base,
        LOCDOC_STATE: state,
        LOCDOC_DOCS: join(dir, "docs"),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    server.stderr.on("data", (chunk) => (logs += chunk));
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw Error(`Server exited: ${logs}`);
      try {
        if ((await fetch(base + "/api/config")).ok) return;
      } catch {}
      await delay(20);
    }
    throw Error(`Server did not start: ${logs}`);
  }
  async function terminate() {
    const exit = once(server, "exit");
    server.kill("SIGTERM");
    const timer = new AbortController();
    const timeout = delay(10_000, undefined, { signal: timer.signal }).then(
      () => {
        throw Error(`Server ignored SIGTERM: ${logs}`);
      },
    );
    try {
      return await Promise.race([exit, timeout]);
    } finally {
      timer.abort();
    }
  }
  async function request(path, init = {}) {
    const response = await fetch(base + path, {
      ...init,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
    });
    return { status: response.status, body: await response.json() };
  }
  try {
    await start();
    const created = await request("/api/files", {
      method: "POST",
      body: JSON.stringify({ kind: "file", path: "Notes/kept.md" }),
    });
    assert.equal(created.status, 200);
    const id = created.body.id;
    await writeFile(join(dir, "docs/Notes/kept.md"), "Kept across a restart\n");
    const opened = await request(`/api/docs/${id}`);
    assert.equal(opened.status, 200);
    assert.equal(opened.body.content, "Kept across a restart\n");
    // An open collaboration socket must not hold the shutdown up.
    const socket = new WebSocket(
      `${base.replace("http", "ws")}/ws/${id}?client=plain-text-v2&epoch=${opened.body.collaborationEpoch}`,
      { headers: { Authorization: `Bearer ${key}` } },
    );
    await once(socket, "message");
    const [code, signal] = await terminate();
    assert.equal(signal, null, "SIGTERM must end in a graceful shutdown");
    assert.equal(code, 0, logs);
    assert.doesNotMatch(logs, /panicked/);
    socket.terminate();

    // The state lock was released and the document kept its identity.
    await start();
    const reopened = await request(`/api/docs/${id}`);
    assert.equal(reopened.status, 200);
    assert.equal(reopened.body.path, "Notes/kept.md");
    assert.equal(reopened.body.content, "Kept across a restart\n");
    assert.equal(await readFile(join(state, "owner.key"), "utf8"), key);
    const [again] = await terminate();
    assert.equal(again, 0, logs);
  } finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      server.kill("SIGKILL");
      await once(server, "exit");
    }
    await rm(dir, { recursive: true, force: true });
  }
});
