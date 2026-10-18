import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  open,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import "fake-indexeddb/auto";
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
import { DraftJournal } from "../src/drafts.ts";

// The ordinary suite runs every disruption once. An explicit soak runs the same
// deterministic scenario for minutes, retaining assertions throughout the run.
const duration = Number(process.env.LOCDOC_SOAK_MS || 8000);
const port = Number(process.env.LOCDOC_SOAK_PORT || 3510);
assert.ok(
  Number.isInteger(port) && port >= 3500 && port <= 3999,
  "Use an isolated test port between 3500 and 3999",
);
const base = `http://127.0.0.1:${port}`,
  key = "isolated-soak-owner";
async function until(check, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  throw Error(message);
}

test(
  "mixed sync soak preserves edits, replies, undo, disk saves and recovered sessions",
  { timeout: duration + 60000 },
  async () => {
    assert.ok(
      Number.isFinite(duration) && duration >= 1000 && duration <= 1800000,
    );
    const dir = await mkdtemp(join(tmpdir(), "locdoc-sync-soak-"));
    await mkdir(join(dir, "state"));
    await mkdir(join(dir, "docs"));
    await writeFile(join(dir, "state/owner.key"), key);
    let server,
      cookie,
      doc,
      path = join(dir, "docs/soak.md");
    let writer = null,
      thread = null,
      replyCount = 0,
      serial = 0;
    const peers = [],
      oracle = new Y.Doc(),
      expected = [],
      expectedReplies = [];
    const stats = {
      rounds: 0,
      inserts: 0,
      replacements: 0,
      undo: 0,
      diskSaves: 0,
      reconnects: 0,
      restarts: 0,
      replies: 0,
      checkpoints: 0,
    };
    const errors = [];
    const executable = resolve("target/debug/locdoc");
    async function request(suffix, method = "GET", body) {
      const r = await fetch(base + suffix, {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          ...(cookie ? { Cookie: cookie } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10000),
      });
      if (r.headers.get("set-cookie"))
        cookie = r.headers.get("set-cookie").split(";")[0];
      const data = await r.json();
      if (r.status === 409 && body?.anchor) {
        // Keep a bounded causal diagnosis if a long-run comment fails. Never
        // format a Y.Doc/store graph or complete source in assertion output.
        const position = (ydoc, selected) => {
          const absolute = Y.createAbsolutePositionFromRelativePosition(
            Y.createRelativePositionFromJSON(selected), ydoc,
          );
          return absolute?.index ?? null;
        };
        data.causal = {
          peers: peers.map((peer) => ({
            synced: peer.provider.synced,
            connected: peer.provider.wsconnected,
            socket: peer.provider.ws?.readyState ?? null,
            length: peer.text.length,
            from: position(peer.ydoc, body.anchor.start),
            to: position(peer.ydoc, body.anchor.end),
            pendingClients: peer.ydoc.store.pendingStructs?.missing.size ?? 0,
            pendingDeletes: peer.ydoc.store.pendingDs?.byteLength ?? 0,
          })),
          errors: errors.slice(-8).map((error) => String(error).slice(0, 180)),
        };
        try {
          const response = await fetch(`${base}/api/docs/${doc.id}`, {
            headers: { Authorization: `Bearer ${key}`, Cookie: cookie },
            signal: AbortSignal.timeout(3000),
          });
          if (response.ok) {
            const snapshot = await response.json();
            const accepted = new Y.Doc();
            try {
              Y.applyUpdate(accepted, Buffer.from(snapshot.state, "base64"));
              data.causal.server = {
                length: accepted.getText("content").length,
                from: position(accepted, body.anchor.start),
                to: position(accepted, body.anchor.end),
              };
            } finally { accepted.destroy(); }
          } else data.causal.serverStatus = response.status;
        } catch { data.causal.serverUnavailable = true; }
      }
      assert.equal(r.status, 200, JSON.stringify(data));
      return data;
    }
    async function start() {
      server = spawn(executable, [], {
        env: {
          ...process.env,
          LOCDOC_BIND: `127.0.0.1:${port}`,
          LOCDOC_DOCS: join(dir, "docs"),
          LOCDOC_STATE: join(dir, "state"),
          LOCDOC_PUBLIC_URL: base,
        },
        stdio: "ignore",
      });
      await until(async () => {
        if (server.exitCode !== null) throw Error("Soak server exited");
        try {
          return (await fetch(base + "/api/config")).ok;
        } catch {
          return false;
        }
      }, "Soak server did not start");
      await request("/api/config");
    }
    async function stop(signal = "SIGINT") {
      if (!server || server.exitCode !== null || server.signalCode !== null)
        return;
      const exit = once(server, "exit");
      server.kill(signal);
      await exit;
    }
    async function connect(draftKey = crypto.randomUUID()) {
      const snapshot = await request(`/api/docs/${doc.id}`),
        ydoc = new Y.Doc();
      assert.equal(
        snapshot.diskConflict,
        false,
        "Ordinary desktop/browser co-editing must not require manual recovery",
      );
      Y.applyUpdate(ydoc, Buffer.from(snapshot.state, "base64"));
      Y.applyUpdate(oracle, Y.encodeStateAsUpdate(ydoc));
      ydoc.on("update", (u) => Y.applyUpdate(oracle, u));
      class Socket extends WebSocket {
        constructor(url) {
          super(url, { headers: { Authorization: `Bearer ${key}` } });
        }
      }
      const provider = new WebsocketProvider(
        base.replace("http", "ws") + "/ws",
        doc.id,
        ydoc,
        {
          WebSocketPolyfill: Socket,
          disableBc: true,
          connect: false,
          maxBackoffTime: 300,
          params: { client: "plain-text-v2" },
        },
      );
      const drafts = new DraftJournal(
        ydoc,
        draftKey,
        () => {},
        () => errors.push("Draft storage failed"),
      );
      await drafts.restore(true);
      drafts.bind(provider, (id) => {
        if (!provider.wsconnected || !provider.ws) return false;
        const e = createEncoder();
        writeVarUint(e, 124);
        writeVarString(e, id);
        provider.ws.send(toUint8Array(e));
        stats.checkpoints++;
        return true;
      });
      provider.messageHandlers[121] = (_e, decoder) => {
        if (readVarString(decoder) === "3")
          errors.push("Unexpected recovery lock during ordinary co-editing");
      };
      provider.messageHandlers[122] = () => {};
      provider.messageHandlers[123] = () => {};
      provider.messageHandlers[125] = (_e, d) => errors.push(readVarString(d));
      provider.messageHandlers[127] = (_e, d) =>
        void drafts
          .acknowledge(readVarString(d))
          .catch((e) => errors.push(e.message));
      provider.on("connection-close", () => drafts.disconnected());
      provider.on("sync", (synced) => {
        if (synced) drafts.requestSave();
      });
      const peer = {
        provider,
        ydoc,
        drafts,
        draftKey,
        text: ydoc.getText("content"),
      };
      peer.undo = new Y.UndoManager(peer.text, {
        trackedOrigins: new Set(["scratch"]),
        captureTimeout: 0,
      });
      peers.push(peer);
      const ready = once(provider, "sync");
      provider.connect();
      await ready;
      return peer;
    }
    function dispose(peer) {
      peer.drafts.dispose();
      peer.undo.destroy();
      peer.provider.destroy();
      peer.ydoc.destroy();
      peers.splice(peers.indexOf(peer), 1);
    }
    function type(peer) {
      const source = peer.text.toString(),
        start = source.indexOf("Scratch: ") + 9;
      assert.ok(start >= 9);
      const end = source.indexOf("\n", start);
      peer.ydoc.transact(() => {
        if (end > start && serial % 3 === 0) {
          peer.text.delete(start, Math.min(2, end - start));
          stats.replacements++;
        }
        peer.text.insert(start, serial % 4 === 0 ? "é" : "x");
      }, "scratch");
      if (serial % 4 === 0) {
        const token = `[web-${serial++}]`;
        expected.push(token);
        peer.text.insert(peer.text.toString().indexOf("\n## Disk"), token);
        stats.inserts++;
      } else serial++;
      if (serial % 13 === 0) {
        peer.undo.undo();
        peer.undo.redo();
        stats.undo++;
      }
    }
    async function comments() {
      if (!thread || replyCount >= 80) {
        const text = peers[0].text,
          at = text.toString().indexOf("Comment target.");
        thread = await request(`/api/docs/${doc.id}/comments`, "POST", {
          name: "soak",
          body: `Conversation ${stats.replies}`,
          quote: "Comment target.",
          requestId: crypto.randomUUID(),
          anchor: {
            start: Y.relativePositionToJSON(
              Y.createRelativePositionFromTypeIndex(text, at),
            ),
            end: Y.relativePositionToJSON(
              Y.createRelativePositionFromTypeIndex(text, at + 15, -1),
            ),
          },
        });
        replyCount = 0;
      }
      const replies = [0, 1].map((n) => ({
        name: `writer${n}`,
        body: `reply-${serial}-${n}`,
        requestId: crypto.randomUUID(),
      }));
      await Promise.all(
        replies.map((r) =>
          request(`/api/docs/${doc.id}/comments/${thread.id}`, "PATCH", r),
        ),
      );
      await request(
        `/api/docs/${doc.id}/comments/${thread.id}`,
        "PATCH",
        replies[0],
      );
      expectedReplies.push(...replies.map((r) => r.body));
      replyCount += 2;
      stats.replies += 2;
    }
    async function diskSave() {
      const token = `[desktop-${stats.diskSaves++}]`;
      expected.push(token);
      const fd = await open(path, "a");
      writer = fd;
      const inode = (await stat(path)).ino;
      try {
        await fd.write(`\n${token.slice(0, -1)}`);
        for (let n = 0; n < 6; n++) {
          type(peers[n % peers.length]);
          await delay(35);
        }
        for (const p of peers)
          assert.ok(
            !p.text.toString().includes(token),
            "Partial desktop writes must remain invisible",
          );
        await fd.write("]\n");
        await fd.sync();
      } finally {
        await fd.close();
        writer = null;
      }
      await until(
        () => {
          assert.deepEqual(errors, [], "Desktop saves must not lock the document");
          return peers.every((p) => p.text.toString().includes(token));
        },
        "Completed desktop save did not reach every peer",
      );
      assert.equal((await stat(path)).ino, inode);
    }
    async function recover() {
      const peer = peers.at(-1),
        draftKey = peer.draftKey;
      peer.provider.disconnect();
      for (let n = 0; n < 8; n++) {
        type(peer);
        type(peers[0]);
        await delay(15);
      }
      await peer.drafts.flush();
      assert.ok(peer.drafts.pending && peer.drafts.stored);
      dispose(peer);
      await connect(draftKey);
      stats.reconnects++;
    }
    async function settle() {
      await until(
        async () => {
          assert.deepEqual(errors, [], "Ordinary edits must remain writable");
          const target = oracle.getText("content").toString();
          return (
            peers.every(
              (p) => p.text.toString() === target && !p.drafts.pending,
            ) && (await readFile(path, "utf8")) === target
          );
        },
        "Peers, local journals, server and disk did not converge",
        15000,
      );
      const saved = await readFile(path, "utf8");
      for (const token of expected)
        assert.equal(saved.split(token).length - 1, 1, token);
      for (const body of expectedReplies)
        assert.equal(saved.split(body + "]]").length - 1, 1, body);
      assert.deepEqual(errors, []);
    }
    try {
      await start();
      doc = await request("/api/files", "POST", {
        kind: "file",
        path: "soak.md",
      });
      await writeFile(
        path,
        "# Soak\nScratch: initial\n## Browser\n\n## Disk\n\n## Comments\nComment target.\n",
      );
      await Promise.all(Array.from({ length: 4 }, () => connect()));
      const started = Date.now();
      let nextDisk = 300,
        nextRecover = 900,
        nextComment = 100,
        nextRestart = 1800,
        nextLog = 30000;
      while (Date.now() - started < duration) {
        stats.rounds++;
        if (stats.rounds % 5 === 0) peers.forEach(type);
        else type(peers[stats.rounds % peers.length]);
        const elapsed = Date.now() - started;
        if (elapsed >= nextComment) {
          await comments();
          nextComment = elapsed + 1800;
        }
        if (elapsed >= nextDisk) {
          await diskSave();
          nextDisk = elapsed + 4000;
        }
        if (elapsed >= nextRecover) {
          await recover();
          nextRecover = elapsed + 6000;
        }
        if (elapsed >= nextRestart) {
          await Promise.all(peers.map((p) => p.drafts.flush()));
          await stop("SIGKILL");
          peers.forEach(type);
          await start();
          stats.restarts++;
          nextRestart = elapsed + 30000;
        }
        if (elapsed >= nextLog) {
          console.log(JSON.stringify({ elapsedMs: elapsed, ...stats }));
          nextLog += 30000;
        }
        assert.deepEqual(errors, []);
        await delay(55);
      }
      await settle();
      const reopened = await connect();
      assert.equal(
        reopened.text.toString(),
        oracle.getText("content").toString(),
      );
      await settle();
      console.log(
        JSON.stringify({
          durationMs: Date.now() - started,
          ...stats,
          verifiedTokens: expected.length,
          verifiedReplies: expectedReplies.length,
        }),
      );
    } finally {
      if (writer) await writer.close();
      while (peers.length) dispose(peers[0]);
      await stop();
      oracle.destroy();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
