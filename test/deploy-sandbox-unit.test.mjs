import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const script = resolve("scripts/deploy.sh");

// `systemctl --user` for a unit whose ExecStart is FAKE_EXEC_START. install-unit only
// reloads the units and reads four properties, so nothing is started.
const fakeSystemctl = `#!/bin/sh
[ "$2" = daemon-reload ] && exit 0
property=
while [ $# -gt 0 ]; do
  [ "$1" = -p ] && property=$2
  shift
done
case $property in
  LoadState) echo loaded ;;
  NeedDaemonReload) echo no ;;
  ExecStart) echo "$FAKE_EXEC_START" ;;
  Environment) echo "LOCDOC_WEB=$LOCDOC_RELEASES/current/web" ;;
esac
`;

// Runs `deploy.sh install-unit` against a unit that starts with the given command line.
// `execStart` gets the test's home and releases folders and returns systemd's ExecStart value.
async function installUnit(execStart) {
  const root = await mkdtemp(join(tmpdir(), "locdoc-unit-check-"));
  try {
    const releases = join(root, "releases");
    const bin = join(root, "bin");
    await mkdir(join(releases, "r1"), { recursive: true });
    await symlink("r1", join(releases, "current"));
    await mkdir(bin);
    await mkdir(join(root, "tmp"));
    await writeFile(join(bin, "systemctl"), fakeSystemctl, { mode: 0o700 });
    return spawnSync("bash", [script, "install-unit"], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        HOME: root,
        TMPDIR: join(root, "tmp"),
        XDG_CONFIG_HOME: join(root, "config"),
        LOCDOC_RELEASES: releases,
        LOCDOC_SERVICE: "locdoc-unit-check-test",
        FAKE_EXEC_START: execStart(root, releases),
      },
      encoding: "utf8",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("install-unit accepts a unit that starts the release directly", async () => {
  const run = await installUnit(
    (home, releases) =>
      `{ path=${releases}/current/locdoc ; argv[]=${releases}/current/locdoc ; ignore_errors=no ; }`,
  );

  assert.equal(run.status, 0, run.stderr);
});

test("install-unit accepts a unit that starts the release inside its sandbox", async () => {
  const run = await installUnit(
    (home) =>
      `{ path=${home}/.local/bin/sixbox-sandbox ; argv[]=${home}/.local/bin/sixbox-sandbox locdoc ; ignore_errors=no ; }`,
  );

  assert.equal(run.status, 0, run.stderr);
});

test("install-unit refuses a unit that starts something else", async () => {
  const run = await installUnit(
    () => "{ path=/usr/bin/env ; argv[]=/usr/bin/env locdoc ; ignore_errors=no ; }",
  );

  assert.equal(run.status, 1);
  assert.match(run.stderr, /must run .*\/current\/locdoc/);
});

test("install-unit refuses the sandbox launcher when it starts another service", async () => {
  const run = await installUnit(
    (home) =>
      `{ path=${home}/.local/bin/sixbox-sandbox ; argv[]=${home}/.local/bin/sixbox-sandbox playparty ; ignore_errors=no ; }`,
  );

  assert.equal(run.status, 1);
  assert.match(run.stderr, /must run .*\/current\/locdoc/);
});
