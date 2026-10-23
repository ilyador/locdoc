import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { freePort } from "./fixtures/free-port.mjs";

test("HTTP shells and static files use the configured web build without a dist directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "locdoc-web-assets-"));
  const web = join(directory, "staged frontend");
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let server;
  let logs = "";
  try {
    await assert.rejects(access(join(directory, "dist")), { code: "ENOENT" });
    await assert.rejects(access(join(directory, ".locdoc")), { code: "ENOENT" });
    await mkdir(join(web, "assets"), { recursive: true });
    await writeFile(
      join(web, "index.html"),
      '<html><title>__LOCDOC_TITLE__</title><script type="module" src="/assets/fixture.js"></script><main>Isolated staged frontend</main></html>',
    );
    await writeFile(join(web, "assets/fixture.js"), 'console.log("staged asset");');
    server = spawn(resolve("target/debug/locdoc"), [], {
      cwd: directory,
      env: {
        ...process.env,
        LOCDOC_WEB: web,
        LOCDOC_BIND: `127.0.0.1:${port}`,
        LOCDOC_DOCS: join(directory, "docs"),
        LOCDOC_STATE: join(directory, "state"),
        LOCDOC_PUBLIC_URL: base,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    server.stderr.on("data", (bytes) => {
      logs = (logs + bytes).slice(-2000);
    });
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      assert.equal(server.exitCode, null, `Fixture exited: ${logs}`);
      try {
        ready = (await fetch(base + "/api/config")).ok;
        if (ready) break;
      } catch {}
      await delay(20);
    }
    assert.ok(ready, `Fixture did not start: ${logs}`);
    for (const path of ["/", "/index.html", "/d/synthetic-document"]) {
      const page = await fetch(base + path);
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.ok(html.includes("Isolated staged frontend"));
      assert.ok(!html.includes("__LOCDOC_TITLE__"));
    }
    const asset = await fetch(base + "/assets/fixture.js");
    assert.equal(asset.status, 200);
    assert.equal(await asset.text(), 'console.log("staged asset");');
    assert.match(asset.headers.get("cache-control"), /immutable/);
    await assert.rejects(access(join(directory, "dist")), { code: "ENOENT" });
  } finally {
    if (server?.exitCode === null) {
      server.kill("SIGINT");
      await once(server, "exit");
    }
    await rm(directory, { recursive: true, force: true });
  }
});
