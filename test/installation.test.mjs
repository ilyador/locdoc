import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  copyFile,
  writeFile,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { freePort } from "./fixtures/free-port.mjs";

test("user service installation handles another checkout and refuses accidental replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "locdoc-install-"));
  const checkout = join(root, "Other computer 100%", "locdoc");
  const config = join(root, "user config");
  try {
    for (const path of ["scripts", "target/release", "dist"])
      await mkdir(join(checkout, path), { recursive: true });
    await copyFile(
      resolve("scripts/install-service.mjs"),
      join(checkout, "scripts/install-service.mjs"),
    );
    await writeFile(
      join(checkout, "target/release/locdoc"),
      "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    );
    await writeFile(join(checkout, "dist/index.html"), "<html></html>");
    const install = (...flags) =>
      spawnSync(
        process.execPath,
        [join(checkout, "scripts/install-service.mjs"), "--no-start", ...flags],
        { env: { ...process.env, XDG_CONFIG_HOME: config }, encoding: "utf8" },
      );
    const first = install();
    assert.equal(first.status, 0, first.stderr);
    const unit = join(config, "systemd/user/locdoc.service");
    const source = await readFile(unit, "utf8");
    assert.ok(source.includes(checkout.replaceAll("%", "%%")));
    assert.ok(source.includes('EnvironmentFile=-"'));
    assert.ok(!source.includes("/home/") && !source.includes("dedyn.io"));
    const runtime = join(root, "runtime");
    await mkdir(runtime, { mode: 0o700 });
    const validation = spawnSync(
      "systemd-analyze",
      ["--user", "verify", unit],
      { encoding: "utf8", env: { ...process.env, XDG_RUNTIME_DIR: runtime } },
    );
    // Foreground use also works on Linux distributions without systemd.
    if (validation.error?.code !== "ENOENT")
      assert.equal(validation.status, 0, validation.stderr);
    assert.equal(install().status, 1);
    assert.equal(install("--replace").status, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("npm start forwards .env configuration to Rust and respects exported overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "locdoc-start-"));
  try {
    await mkdir(join(root, "scripts"));
    await mkdir(join(root, "target/release"), { recursive: true });
    await copyFile(
      resolve("scripts/start.mjs"),
      join(root, "scripts/start.mjs"),
    );
    const bind = `127.0.0.1:${await freePort()}`;
    await writeFile(
      join(root, ".env"),
      `LOCDOC_DOCS=notes\nLOCDOC_BIND=${bind}\n`,
    );
    await writeFile(
      join(root, "target/release/locdoc"),
      "#!/usr/bin/env node\nconsole.log(JSON.stringify({docs:process.env.LOCDOC_DOCS,bind:process.env.LOCDOC_BIND}));\n",
      { mode: 0o755 },
    );
    const result = spawnSync(
      process.execPath,
      ["--env-file-if-exists=.env", "scripts/start.mjs"],
      {
        cwd: root,
        env: { ...process.env, LOCDOC_DOCS: "exported-notes" },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      docs: "exported-notes",
      bind,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
