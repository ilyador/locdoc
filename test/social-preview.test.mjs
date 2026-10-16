import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { JSDOM } from "jsdom";

const base = "http://127.0.0.1:3528";
const publicUrl = "https://notes.example";
let dir, server;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "locdoc-social-"));
  for (const path of ["docs", "state", "dist/social"])
    await mkdir(join(dir, path), { recursive: true });
  await writeFile(join(dir, "state/owner.key"), "social-test-owner-key");
  await writeFile(
    join(dir, "docs/Private draft.md"),
    "Not for social previews",
  );
  await copyFile(resolve("index.html"), join(dir, "dist/index.html"));
  await copyFile(
    resolve("public/social/locdoc-v1.png"),
    join(dir, "dist/social/locdoc-v1.png"),
  );
  server = spawn(resolve("target/debug/locdoc"), [], {
    cwd: dir,
    env: {
      ...process.env,
      LOCDOC_BIND: "127.0.0.1:3528",
      LOCDOC_DOCS: join(dir, "docs"),
      LOCDOC_STATE: join(dir, "state"),
      LOCDOC_PUBLIC_URL: publicUrl + "/",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("Social fixture did not start")),
      5000,
    );
    server.once("error", reject);
    server.stdout.on("data", (chunk) => {
      if (String(chunk).includes("Locdoc listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
});
after(async () => {
  if (server && server.exitCode === null) {
    server.kill("SIGINT");
    await once(server, "exit");
  }
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("social crawlers receive app-only metadata with absolute URLs on every app route", async () => {
  for (const path of [
    "/",
    "/index.html",
    "/d/private-id",
    "/d/private-id/",
    "/s/public-token?doc=chosen",
    "/s/public-token/",
  ]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type"), /text\/html/);
    const html = await response.text();
    const dom = new JSDOM(html);
    const meta = (key) =>
      dom.window.document.querySelector(
        `meta[property="${key}"],meta[name="${key}"]`,
      )?.content;
    assert.match(meta("og:title"), /Locdoc/);
    assert.ok(meta("og:description"));
    assert.equal(meta("og:url"), publicUrl + new URL(path, base).pathname);
    assert.equal(meta("og:image"), publicUrl + "/social/locdoc-v1.png");
    assert.equal(meta("twitter:image"), meta("og:image"));
    assert.equal(meta("twitter:card"), "summary_large_image");
    assert.ok(meta("og:image:alt"));
    assert.ok(!html.includes("__LOCDOC_") && !html.includes("127.0.0.1"));
    assert.ok(
      !html.includes("Private draft") &&
        !html.includes("Not for social previews"),
    );
    dom.window.close();
  }
  const response = await fetch(base + "/social/locdoc-v1.png");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  const png = Buffer.from(await response.arrayBuffer());
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
  assert.equal((await fetch(base + "/assets/missing.js")).status, 404);
});
