import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readlink,
  rm,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const script = resolve("scripts/deploy.sh");

// Fake releases need no build: --no-restart checks release files and the
// state database only, so rollbacks and their failure paths stay cheap.
async function fixture(root) {
  const releases = join(root, "releases-100%");
  const state = join(root, "state");
  const docs = join(root, "docs");
  await mkdir(state, { recursive: true });
  await mkdir(docs);
  const created = spawnSync(
    "python3",
    [
      "-I",
      "-c",
      "import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.executescript(\"CREATE TABLE docs(id TEXT); CREATE TABLE revisions(id TEXT); CREATE TABLE comments(id TEXT); INSERT INTO docs VALUES('a');\"); db.commit()",
      join(state, "locdoc.sqlite"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(created.status, 0, created.stderr);
  const release = async (name, previous) => {
    const dir = join(releases, name);
    await mkdir(join(dir, "web"), { recursive: true });
    const binary = `#!/bin/sh\necho ${name}\n`;
    await writeFile(join(dir, "locdoc"), binary, { mode: 0o700 });
    await writeFile(
      join(dir, "web/index.html"),
      `<script type="module" src="/assets/index-${name}.js"></script>`,
    );
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({
        release: name,
        previous,
        binary_sha256: createHash("sha256").update(binary).digest("hex"),
      }),
    );
  };
  await release("20260101T000000Z-aaaaaaaaaaaa", null);
  await release(
    "20260102T000000Z-bbbbbbbbbbbb",
    "20260101T000000Z-aaaaaaaaaaaa",
  );
  const env = {
    ...process.env,
    LOCDOC_RELEASES: releases,
    LOCDOC_STATE: state,
    LOCDOC_DOCS: docs,
    LOCDOC_SERVICE: "locdoc-deploy-script-test",
    XDG_CONFIG_HOME: join(root, "config"),
  };
  delete env.LOCDOC_DEPLOY_TEST_FAIL;
  const run = (args, extra = {}) =>
    spawnSync("bash", [script, ...args, "--no-restart"], {
      env: { ...env, ...extra },
      encoding: "utf8",
    });
  const current = () => readlink(join(releases, "current"));
  return { releases, run, current };
}

test("deploy script parses and documents its commands", () => {
  const syntax = spawnSync("bash", ["-n", script], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  const help = spawnSync("bash", [script, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  for (const word of ["rollback", "install-unit", "--rehearse", "--no-restart"])
    assert.ok(help.stdout.includes(word), `usage mentions ${word}`);
  const unknown = spawnSync("bash", [script, "--bogus"], { encoding: "utf8" });
  assert.equal(unknown.status, 1);
});

test("rollback repoints current, restores it after failed checks and refuses missing releases", async () => {
  const root = await mkdtemp(join(tmpdir(), "locdoc-deploy-"));
  try {
    const { releases, run, current } = await fixture(root);
    const older = "20260101T000000Z-aaaaaaaaaaaa";
    const newer = "20260102T000000Z-bbbbbbbbbbbb";
    assert.equal(run(["rollback"]).status, 1, "no current release yet");
    spawnSync("ln", ["-s", newer, join(releases, "current")]);

    const missing = run(["rollback", "20260103T000000Z-missing"]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /does not exist/);
    assert.equal(await current(), newer);

    const rolled = run(["rollback"]);
    assert.equal(rolled.status, 0, rolled.stderr);
    assert.equal(
      await current(),
      older,
      "default target is the recorded previous release",
    );

    const none = run(["rollback"]);
    assert.equal(none.status, 1);
    assert.match(none.stderr, /records no previous release/);
    assert.equal(await current(), older);

    const failed = run(["rollback", newer], {
      LOCDOC_DEPLOY_TEST_FAIL: "activate",
    });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /restored 20260101T000000Z-aaaaaaaaaaaa/);
    assert.equal(
      await current(),
      older,
      "failed checks restore the previous release",
    );

    const install = run(["install-unit"]);
    assert.equal(install.status, 0, install.stderr);
    const dropIn = await readFile(
      join(
        root,
        "config/systemd/user/locdoc-deploy-script-test.service.d/release.conf",
      ),
      "utf8",
    );
    const escaped = releases.replaceAll("%", "%%");
    assert.ok(dropIn.includes(`ExecStart=${escaped}/current/locdoc\n`), dropIn);
    assert.ok(dropIn.includes(`LOCDOC_WEB=${escaped}/current/web\n`), dropIn);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
