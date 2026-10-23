import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { freePort } from "./fixtures/free-port.mjs";

test("link previews enforce source and target permissions, revocation, and network isolation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "locdoc-links-"));
  await mkdir(join(dir, "state"));
  await mkdir(join(dir, "docs"));
  await writeFile(join(dir, "state/owner.key"), "links-test-owner");
  await writeFile(join(dir, "docs/source.md"), "# Source\n");
  await writeFile(
    join(dir, "docs/target.md"),
    "# Target notes\nA private sentence.\n",
  );
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(resolve("target/debug/locdoc"), [], {
    cwd: dir,
    env: {
      ...process.env,
      LOCDOC_BIND: `127.0.0.1:${port}`,
      LOCDOC_DOCS: join(dir, "docs"),
      LOCDOC_STATE: join(dir, "state"),
      LOCDOC_PUBLIC_URL: base,
    },
    stdio: "ignore",
  });
  const request = async (path, { owner = true, method = "GET", body } = {}) => {
    const r = await fetch(base + path, {
      method,
      headers: {
        ...(owner ? { Authorization: "Bearer links-test-owner" } : {}),
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: await r.json() };
  };
  try {
    let ready = false;
    for (let i = 0; i < 150; i++) {
      try {
        if ((await fetch(base + "/api/config")).ok) {
          ready = true;
          break;
        }
      } catch {}
      await delay(20);
    }
    assert.ok(ready);
    const tree = await request("/api/tree");
    const source = tree.body.entries.find((e) => e.path === "source.md"),
      target = tree.body.entries.find((e) => e.path === "target.md");
    assert.equal(target.title, "target");
    assert.ok(target.modified > 0);
    assert.equal(target.url, `${base}/d/${target.id}`);
    const preview = (url, token = "", owner = true) =>
      request(
        `/api/docs/${source.id}/link-preview?${new URLSearchParams({ url, ...(token ? { token } : {}) })}`,
        { owner },
      );
    assert.equal((await preview(target.url)).body.title, "Target notes");
    assert.equal((await preview(target.url, "", false)).status, 403);
    for (const url of [
      "http://127.0.0.1/",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/",
      "file:///etc/passwd",
      "https://example.com:8000/",
    ])
      assert.equal((await preview(url)).status, 400);
    const sharedSource = await request(`/api/docs/${source.id}/share`, {
      method: "POST",
      body: { permission: "view" },
    });
    const sourceToken = sharedSource.body.shareUrl.split("/").pop();
    // An unrelated external URL cannot turn a public document into a fetch proxy.
    assert.equal(
      (await preview("https://example.com/", sourceToken, false)).status,
      403,
    );
    const sharedTarget = await request(`/api/docs/${target.id}/share`, {
      method: "POST",
      body: { permission: "view" },
    });
    await writeFile(
      join(dir, "docs/source.md"),
      `# Source\n[Private](${target.url})\n[Shared](${sharedTarget.body.shareUrl})\n`,
    );
    // The disk watcher imports external Markdown before the guest's metadata request.
    let imported = false;
    for (let i = 0; i < 150; i++) {
      const d = await request(`/api/docs/${source.id}`);
      if (d.body.content.includes(sharedTarget.body.shareUrl)) {
        imported = true;
        break;
      }
      await delay(30);
    }
    assert.ok(imported);
    assert.equal((await preview(target.url, sourceToken, false)).status, 403);
    const guest = await preview(sharedTarget.body.shareUrl, sourceToken, false);
    assert.equal(guest.status, 200);
    assert.equal(guest.body.owner, false);
    assert.equal(guest.body.title, "Target notes");
    await request(`/api/docs/${target.id}/share`, {
      method: "POST",
      body: { permission: "private" },
    });
    assert.ok(
      [403, 404].includes(
        (await preview(sharedTarget.body.shareUrl, sourceToken, false)).status,
      ),
    );
  } finally {
    server.kill("SIGINT");
    await once(server, "exit");
    await rm(dir, { recursive: true, force: true });
  }
});
