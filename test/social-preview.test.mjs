import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { JSDOM } from "jsdom";
import { setTimeout as delay } from "node:timers/promises";
import { freePort } from "./fixtures/free-port.mjs";

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const publicUrl = "https://notes.example";
const owner = { Authorization: "Bearer social-test-owner-key" };
let dir, server;
async function request(path, body) {
  const response = await fetch(base + path, {
    method: "POST",
    headers: { ...owner, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function metadata(path, headers) {
  const response = await fetch(base + path, { headers });
  assert.equal(response.status, 200, path);
  const html = await response.text();
  const dom = new JSDOM(html);
  const get = (key) =>
    dom.window.document.querySelector(
      `meta[property="${key}"],meta[name="${key}"]`,
    )?.content;
  const result = {
    title: get("og:title"),
    text: get("og:description"),
    image: get("og:image"),
    url: get("og:url"),
    html,
  };
  dom.window.close();
  return result;
}
const localPath = (value) => {
  const url = new URL(value);
  return url.pathname + url.search;
};
async function replaceDocument(doc, path, content) {
  await writeFile(join(dir, "docs", path), content);
  for (let i = 0; i < 100; i++) {
    const response = await fetch(base + `/api/docs/${doc.id}`, {
      headers: owner,
    });
    if (response.ok && (await response.json()).content === content) return;
    await delay(25);
  }
  assert.fail("Desktop update did not import");
}
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
    resolve("public/social/locdoc-v4.png"),
    join(dir, "dist/social/locdoc-v4.png"),
  );
  server = spawn(resolve("target/debug/locdoc"), [], {
    cwd: dir,
    env: {
      ...process.env,
      LOCDOC_BIND: `127.0.0.1:${port}`,
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
    // Keep small crawler pages intact through compression proxies: encoding an
    // empty HEAD body can otherwise advertise a bogus 13/20-byte page size.
    assert.equal(
      response.headers.get("cache-control"),
      "no-store, no-transform",
    );
    const html = await response.text();
    const head = await fetch(base + path, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(
      head.headers.get("content-length"),
      String(Buffer.byteLength(html)),
    );
    assert.equal(
      head.headers.get("cache-control"),
      response.headers.get("cache-control"),
    );
    assert.equal(await head.text(), "");
    const dom = new JSDOM(html);
    const meta = (key) =>
      dom.window.document.querySelector(
        `meta[property="${key}"],meta[name="${key}"]`,
      )?.content;
    assert.match(meta("og:title"), /Locdoc/);
    assert.ok(meta("og:description"));
    assert.equal(meta("og:url"), publicUrl + new URL(path, base).pathname);
    assert.equal(meta("og:image"), publicUrl + "/social/locdoc-v4.png");
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
  const response = await fetch(base + "/social/locdoc-v4.png");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  const png = Buffer.from(await response.arrayBuffer());
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
  assert.equal((await fetch(base + "/assets/missing.js")).status, 404);
});

test("shared previews use real headings and prose, update with the file, and deny cached images after revocation", async () => {
  const doc = await request("/api/files", { kind: "file", path: "Shared.md" });
  await replaceDocument(
    doc,
    "Shared.md",
    '# "Travel" & plans\n\nA **short** opening with a [link](https://private-destination.example).[[comment(alex): hidden-preview-canary]]\n\n![alt](image.png)',
  );
  const share = await request(`/api/docs/${doc.id}/share`, {
    permission: "view",
  });
  const path = localPath(share.shareUrl);
  const first = await metadata(path);
  assert.equal(first.url, share.shareUrl);
  assert.equal((await metadata(path + "/")).url, share.shareUrl);
  assert.equal(first.title, '"Travel" & plans · Locdoc');
  assert.equal(first.text, "A short opening with a link.");
  assert.ok(
    !first.html.includes("hidden-preview-canary") &&
      !first.html.includes("private-destination.example"),
  );
  const imagePath = localPath(first.image);
  assert.ok(imagePath.includes("/preview.png?doc="));
  const response = await fetch(base + imagePath);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const png = Buffer.from(await response.arrayBuffer());
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
  assert.deepEqual(
    Buffer.from(await (await fetch(base + imagePath)).arrayBuffer()),
    png,
  );

  await replaceDocument(
    doc,
    "Shared.md",
    "# Updated title\n\nNew opening words from the desktop file.",
  );
  const updated = await metadata(path);
  assert.equal(updated.title, "Updated title · Locdoc");
  assert.equal(updated.text, "New opening words from the desktop file.");
  assert.notEqual(updated.image, first.image);
  assert.notDeepEqual(
    Buffer.from(
      await (await fetch(base + localPath(updated.image))).arrayBuffer(),
    ),
    png,
  );
  await request(`/api/docs/${doc.id}/share`, { permission: "private" });
  assert.ok(!(await metadata(path)).html.includes("Updated title"));
  assert.equal((await fetch(base + imagePath)).status, 404);
  assert.equal((await fetch(base + imagePath, { headers: owner })).status, 404);
  assert.ok(
    !(await metadata(`/d/${doc.id}`, owner)).html.includes("Updated title"),
  );
});

test("folder previews select only documents inside the shared folder and respect revocation", async () => {
  await request("/api/files", { kind: "folder", path: "Notes" });
  const doc = await request("/api/files", {
    kind: "file",
    path: "Notes/Selected.md",
  });
  await replaceDocument(
    doc,
    "Notes/Selected.md",
    "# Selected folder note\n\nOnly this selected document belongs in the preview.",
  );
  const outside = await request("/api/files", {
    kind: "file",
    path: "Outside.md",
  });
  await replaceDocument(
    outside,
    "Outside.md",
    "# Outside private canary\n\nThis must never escape through a folder link.",
  );
  const share = await request("/api/folders/share", {
    path: "Notes",
    permission: "view",
  });
  const path = localPath(share.shareUrl);
  const selected = await metadata(path + `?doc=${doc.id}`);
  assert.equal(selected.title, "Selected folder note · Locdoc");
  assert.equal(
    selected.text,
    "Only this selected document belongs in the preview.",
  );
  assert.equal(new URL(selected.url).searchParams.get("doc"), doc.id);
  assert.equal((await fetch(base + localPath(selected.image))).status, 200);
  assert.ok(
    !(await metadata(path + `?doc=${outside.id}`)).html.includes(
      "Outside private canary",
    ),
  );
  assert.equal(
    (await fetch(base + path + `/preview.png?doc=${outside.id}`)).status,
    403,
  );
  await request("/api/folders/share", { path: "Notes", permission: "private" });
  assert.equal((await fetch(base + localPath(selected.image))).status, 404);
  assert.ok(
    !(await metadata(path + `?doc=${doc.id}`)).html.includes(
      "Selected folder note",
    ),
  );
});

test("rotating an edit link blocks old generated images while the new link uses the current document", async () => {
  const doc = await request("/api/files", { kind: "file", path: "Rotate.md" });
  await replaceDocument(
    doc,
    "Rotate.md",
    '# "Quoted" <span>title</span>\n\nVisible text with & characters.',
  );
  const original = await request(`/api/docs/${doc.id}/share`, {
    permission: "edit",
  });
  const first = await metadata(localPath(original.shareUrl));
  assert.equal(first.title, '"Quoted" title · Locdoc');
  assert.equal((await fetch(base + localPath(first.image))).status, 200);
  const rotated = await request(`/api/docs/${doc.id}/share`, {
    permission: "edit",
    rotate: true,
  });
  const latest = await metadata(localPath(rotated.shareUrl));
  assert.equal(latest.title, first.title);
  assert.notEqual(latest.image, first.image);
  assert.equal((await fetch(base + localPath(first.image))).status, 404);
  assert.equal((await fetch(base + localPath(latest.image))).status, 200);
});
