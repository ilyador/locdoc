import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readlink,
  readdir,
  rename,
  copyFile,
  symlink,
  rm,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const script = resolve("scripts/deploy.sh");
const binary = resolve("target/debug/locdoc");

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
    // Defaults then resolve inside the fixture even if a guard regresses.
    HOME: root,
  };
  delete env.LOCDOC_DEPLOY_TEST_FAIL;
  const run = (args, extra = {}) =>
    spawnSync("bash", [script, ...args, "--no-restart"], {
      env: { ...env, ...extra },
      encoding: "utf8",
    });
  const current = () => readlink(join(releases, "current"));
  return { root, releases, env, run, current };
}

test("deploy script parses and documents its commands", () => {
  const syntax = spawnSync("bash", ["-n", script], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  const help = spawnSync("bash", [script, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  for (const word of [
    "rollback",
    "restore",
    "install-unit",
    "--rehearse",
    "--no-restart",
  ])
    assert.ok(help.stdout.includes(word), `usage mentions ${word}`);
  const unknown = spawnSync("bash", [script, "--bogus"], { encoding: "utf8" });
  assert.equal(unknown.status, 1);
});

test("rollback repoints current, restores it after failed checks and refuses missing releases", async () => {
  const root = await mkdtemp(join(tmpdir(), "locdoc-deploy-"));
  try {
    const { releases, env, run, current } = await fixture(root);
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

    const loop = run(["rollback", "current"]);
    assert.equal(loop.status, 1, "current is not a release name");
    assert.match(loop.stderr, /release current does not exist/);
    assert.equal(await current(), older);

    // A failure report that cannot be written (stderr closed after the first
    // line) must still restore the previous release.
    const first = `deploy: rolling back from ${older} to ${newer}\n`;
    const piped = spawnSync(
      "bash",
      [
        "-c",
        `bash "$1" rollback "$2" --no-restart 2>&1 >/dev/null | head -c ${first.length}`,
        "deploy",
        script,
        newer,
      ],
      {
        env: { ...env, LOCDOC_DEPLOY_TEST_FAIL: "activate" },
        encoding: "utf8",
      },
    );
    assert.equal(piped.stdout, first);
    assert.equal(await current(), older, "closed stderr still restores");

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

test("--no-restart refuses the default release and systemd folders", async () => {
  const root = await mkdtemp(join(tmpdir(), "locdoc-deploy-"));
  try {
    const { env } = await fixture(root);
    const run = (args, unset) => {
      const scoped = { ...env };
      delete scoped[unset];
      return spawnSync("bash", [script, ...args, "--no-restart"], {
        env: scoped,
        encoding: "utf8",
      });
    };
    const rollback = run(["rollback"], "LOCDOC_RELEASES");
    assert.equal(rollback.status, 1);
    assert.match(rollback.stderr, /needs LOCDOC_RELEASES/);
    const deploy = run([], "LOCDOC_RELEASES");
    assert.equal(deploy.status, 1);
    assert.match(deploy.stderr, /needs LOCDOC_RELEASES/);
    const install = run(["install-unit"], "XDG_CONFIG_HOME");
    assert.equal(install.status, 1);
    assert.match(install.stderr, /needs XDG_CONFIG_HOME/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function freePort() {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

// The real server on a free loopback port, over the given folders.
async function serve(state, docs) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(binary, [], {
    env: {
      ...process.env,
      LOCDOC_BIND: `127.0.0.1:${port}`,
      LOCDOC_PUBLIC_URL: base,
      LOCDOC_STATE: state,
      LOCDOC_DOCS: docs,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  for (const stream of [server.stdout, server.stderr])
    stream.on("data", (chunk) => (logs += chunk));
  const stop = async () => {
    if (server.exitCode !== null || server.signalCode !== null) return;
    server.kill("SIGINT");
    await once(server, "exit");
  };
  try {
    for (const deadline = Date.now() + 20000; ; await delay(50)) {
      if (server.exitCode !== null) throw Error(`The server exited: ${logs}`);
      if (Date.now() > deadline)
        throw Error(`The server did not start: ${logs}`);
      try {
        if ((await fetch(`${base}/api/config`)).ok) break;
      } catch {}
    }
  } catch (error) {
    await stop();
    throw error;
  }
  return { base, stop };
}

// Every entry with its size, modification time and content hash.
function fingerprint(folder) {
  const listed = spawnSync(
    "bash",
    [
      "-c",
      'cd "$1" && find . -type d | sort && find . -type f -printf "%p %s %T@\\n" | sort && find . -type f -exec sha256sum {} + | sort',
      "fingerprint",
      folder,
    ],
    { encoding: "utf8" },
  );
  assert.equal(listed.status, 0, listed.stderr);
  return listed.stdout;
}

const names = async (folder) => (await readdir(folder)).sort();

// A live workspace with a shared document at p.md that the server has opened,
// backed up as the hourly service does: the database through SQLite's backup
// API first, then the documents folder, with p.md moved to q.md between the
// two steps. The live folder changes again after the snapshot. `current` is a
// release of the binary under test.
async function restoreFixture(root) {
  const live = join(root, "live");
  const state = join(live, "state");
  const docs = join(live, "docs");
  await mkdir(state, { recursive: true });
  await mkdir(docs);
  await writeFile(join(state, "owner.key"), "restore-owner");
  await writeFile(join(docs, "p.md"), "Shared text of A\n");
  const owner = {
    Authorization: "Bearer restore-owner",
    "Content-Type": "application/json",
  };
  const server = await serve(state, docs);
  let id, token;
  try {
    const tree = await (
      await fetch(`${server.base}/api/tree`, { headers: owner })
    ).json();
    id = tree.entries.find((entry) => entry.path === "p.md").id;
    const shared = await (
      await fetch(`${server.base}/api/docs/${id}/share`, {
        method: "POST",
        headers: owner,
        body: JSON.stringify({ permission: "view" }),
      })
    ).json();
    token = shared.shareUrl.split("/").pop();
    const opened = await fetch(`${server.base}/api/docs/${id}`, {
      headers: owner,
    });
    assert.equal(opened.status, 200);
  } finally {
    await server.stop();
  }
  const snapshot = join(root, "hourly.0");
  await mkdir(join(snapshot, "state"), { recursive: true });
  const backup = spawnSync(
    "python3",
    [
      "-I",
      "-c",
      "import pathlib,sqlite3,sys; s=sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True); d=sqlite3.connect(sys.argv[2]); s.backup(d); d.close(); s.close()",
      join(state, "locdoc.sqlite"),
      join(snapshot, "state/locdoc.sqlite"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(backup.status, 0, backup.stderr);
  for (const name of ["owner.key", "root.identity"])
    await copyFile(join(state, name), join(snapshot, "state", name));
  await rename(join(docs, "p.md"), join(docs, "q.md"));
  const copied = spawnSync("cp", ["-a", docs, join(snapshot, "docs")], {
    encoding: "utf8",
  });
  assert.equal(copied.status, 0, copied.stderr);
  await writeFile(join(docs, "after.md"), "Written after the snapshot\n");

  const releases = join(root, "releases");
  const name = "20260101T000000Z-aaaaaaaaaaaa";
  await mkdir(join(releases, name, "web"), { recursive: true });
  await symlink(binary, join(releases, name, "locdoc"));
  await writeFile(
    join(releases, name, "web/index.html"),
    `<script type="module" src="/assets/index-${name}.js"></script>`,
  );
  const sum = spawnSync("sha256sum", [binary], { encoding: "utf8" });
  assert.equal(sum.status, 0, sum.stderr);
  await writeFile(
    join(releases, name, "manifest.json"),
    JSON.stringify({ release: name, binary_sha256: sum.stdout.split(" ")[0] }),
  );
  await symlink(name, join(releases, "current"));
  const env = {
    ...process.env,
    LOCDOC_RELEASES: releases,
    LOCDOC_STATE: state,
    LOCDOC_DOCS: docs,
    LOCDOC_SERVICE: "locdoc-deploy-script-test",
    XDG_CONFIG_HOME: join(root, "config"),
    HOME: root,
  };
  delete env.LOCDOC_DEPLOY_TEST_FAIL;
  const restore = (folder, extra = {}) =>
    spawnSync("bash", [script, "restore", folder, "--no-restart"], {
      env: { ...env, ...extra },
      encoding: "utf8",
    });
  return {
    live,
    state,
    docs,
    snapshot,
    id,
    token,
    restore,
    env,
    release: join(releases, name),
  };
}

// cp and mv for restore tests, first on PATH. HOLD_TOOL holds the step whose
// arguments include HOLD_MATCH until the test kills it; STEP_INTERRUPT
// interrupts the script right after that many copies and moves.
async function stepTools(root) {
  const bin = join(root, "bin");
  await mkdir(bin);
  for (const tool of ["cp", "mv"]) {
    const real = spawnSync("bash", ["-c", `command -v ${tool}`], {
      encoding: "utf8",
    }).stdout.trim();
    await writeFile(
      join(bin, tool),
      `#!/usr/bin/env bash
if [[ \${HOLD_TOOL:-} == ${tool} && "$*" == *"$HOLD_MATCH"* ]]; then
  : >"$HOLD_READY"
  exec sleep 60
fi
${real} "$@" || exit
[[ -n \${STEP_COUNT:-} ]] || exit 0
count=$(($(cat "$STEP_COUNT" 2>/dev/null || echo 0) + 1))
echo "$count" >"$STEP_COUNT"
[[ $count != "$STEP_INTERRUPT" ]] || kill -INT "$PPID"
`,
      { mode: 0o700 },
    );
  }
  return `${bin}:${process.env.PATH}`;
}

// Start a restore and kill it with all its children, as a power cut would,
// once a step signals through HOLD_READY.
async function killRestore(fixture, root, extra) {
  const ready = join(root, "held");
  const child = spawn(
    "bash",
    [script, "restore", fixture.snapshot, "--no-restart"],
    {
      env: { ...fixture.env, ...extra, HOLD_READY: ready },
      stdio: "ignore",
      detached: true,
    },
  );
  try {
    for (const deadline = Date.now() + 20000; ; await delay(50)) {
      if (child.exitCode !== null) throw Error("The restore did not hold");
      if (Date.now() > deadline) throw Error("The restore never held");
      try {
        await readFile(ready);
        break;
      } catch {}
    }
  } finally {
    process.kill(-child.pid, "SIGKILL");
    if (child.exitCode === null && child.signalCode === null)
      await once(child, "exit");
  }
}

// Normal startup on the given folders, which must refuse them at once.
async function refusedStartup(state, docs) {
  const started = spawnSync(binary, [], {
    env: {
      ...process.env,
      LOCDOC_STATE: state,
      LOCDOC_DOCS: docs,
      LOCDOC_BIND: `127.0.0.1:${await freePort()}`,
    },
    encoding: "utf8",
    timeout: 20000,
  });
  assert.equal(started.status, 1, `startup was refused: ${started.stderr}`);
  return started.stderr;
}

// `systemctl --user` for one stand-in unit, first on PATH. It runs the
// current release in the background with the unit's environment, logs each
// stop and start, and never talks to systemd.
const fakeSystemctl = `#!/usr/bin/env python3
import json, os, signal, subprocess, sys, time, uuid
from pathlib import Path

unit = Path(os.environ["FAKE_UNIT"])
current = Path(os.environ["LOCDOC_RELEASES"]) / "current"
action = sys.argv[2]

def running():
    try:
        pid = int((unit / "pid").read_text())
        status = Path(f"/proc/{pid}/stat").read_text()
    except (FileNotFoundError, ValueError):
        return None
    return None if status.rsplit(")", 1)[1].split()[0] == "Z" else pid

if action == "show":
    pid = running()
    print({
        "LoadState": "loaded",
        "NeedDaemonReload": "no",
        "ExecStart": f"{{ path={current}/locdoc ; argv[]={current}/locdoc ; }}",
        "Environment": f"LOCDOC_WEB={current}/web",
        "MainPID": pid or 0,
        "InvocationID": (unit / "invocation").read_text() if pid else "",
        "NRestarts": 0,
        "ActiveState": "active" if pid else "inactive",
    }[sys.argv[sys.argv.index("-p") + 1]])
    sys.exit(0)
with open(unit / "calls", "a") as calls:
    calls.write(action + "\\n")
if action == "stop" and (pid := running()):
    os.kill(pid, signal.SIGINT)
    while running():
        time.sleep(0.05)
elif action == "start" and not running():
    env = json.loads((unit / "env.json").read_text())
    env["LOCDOC_WEB"] = str(current / "web")
    with open(unit / "server.log", "ab") as log:
        server = subprocess.Popen(
            [str(current / "locdoc")], cwd=unit, env=env, stdin=subprocess.DEVNULL,
            stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    (unit / "pid").write_text(str(server.pid))
    (unit / "invocation").write_text(uuid.uuid4().hex)
`;

async function fakeUnit(root, fixture) {
  const unit = join(root, "unit");
  const bin = join(root, "unit-bin");
  await mkdir(unit);
  await mkdir(bin);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  await writeFile(
    join(unit, "env.json"),
    JSON.stringify({
      PATH: process.env.PATH,
      HOME: root,
      LOCDOC_STATE: fixture.state,
      LOCDOC_DOCS: fixture.docs,
      LOCDOC_BIND: `127.0.0.1:${port}`,
      LOCDOC_PUBLIC_URL: base,
    }),
  );
  await writeFile(join(bin, "systemctl"), fakeSystemctl, { mode: 0o700 });
  await writeFile(join(bin, "journalctl"), "#!/bin/sh\n", { mode: 0o700 });
  // The service's own folders, read from the running process.
  const env = {
    ...fixture.env,
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_UNIT: unit,
  };
  delete env.LOCDOC_STATE;
  delete env.LOCDOC_DOCS;
  const systemctl = (action) =>
    spawnSync(join(bin, "systemctl"), ["--user", action], {
      env,
      encoding: "utf8",
    });
  const ready = async () => {
    for (const deadline = Date.now() + 20000; ; await delay(50)) {
      if (Date.now() > deadline) throw Error("The unit did not start");
      try {
        if ((await fetch(`${base}/api/config`)).ok) return;
      } catch {}
    }
  };
  const calls = async () =>
    (await readFile(join(unit, "calls"), "utf8")).trim().split("\n");
  return { base, env, systemctl, ready, calls };
}

// Remove the restored copies a failed restore keeps next to the live data.
async function removeKeptCopies(fixture) {
  for (const name of await names(fixture.live))
    if (name.startsWith("docs.failed-restore-"))
      await rm(join(fixture.live, name), { recursive: true });
  for (const name of await names(fixture.state))
    if (name.startsWith("failed-restore-"))
      await rm(join(fixture.state, name), { recursive: true });
}

test("restore puts a snapshot in place, keeps the live data aside and follows a moved document", async () => {
  const root = await mkdtemp(join(tmpdir(), "locdoc-restore-"));
  try {
    const fixture = await restoreFixture(root);
    const snapshot = fingerprint(fixture.snapshot);
    const restored = fixture.restore(fixture.snapshot);
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(fingerprint(fixture.snapshot), snapshot, "snapshot unchanged");
    const aside = (await names(fixture.live)).find((name) =>
      name.startsWith("docs.before-restore-"),
    );
    assert.ok(aside, "the live documents folder is kept aside");
    assert.deepEqual(await names(join(fixture.live, aside)), [
      "after.md",
      "q.md",
    ]);
    assert.deepEqual(await names(fixture.docs), ["q.md"]);
    const asideState = (await names(fixture.state)).find((name) =>
      name.startsWith("before-restore-"),
    );
    assert.ok(
      (await names(join(fixture.state, asideState))).includes("locdoc.sqlite"),
    );
    for (const path of [
      join(fixture.live, aside),
      join(fixture.state, asideState),
      join(fixture.state, "restore-report.json"),
    ])
      assert.ok(restored.stderr.includes(path), `prints ${path}`);
    const report = JSON.parse(
      await readFile(join(fixture.state, "restore-report.json"), "utf8"),
    );
    assert.equal(report.completed, true);
    assert.deepEqual(report.documents, [
      {
        id: fixture.id,
        recordedPath: "p.md",
        restoredPath: "q.md",
        evidence: "content",
      },
    ]);
    // The service starts on the restored copy and the link serves A again.
    const server = await serve(fixture.state, fixture.docs);
    try {
      const opened = await (
        await fetch(`${server.base}/api/open/${fixture.token}`)
      ).json();
      assert.equal(opened.document.id, fixture.id);
      assert.equal(opened.document.content, "Shared text of A\n");
    } finally {
      await server.stop();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a restore that fails before its checks pass puts the live data back", async () => {
  // `restore` fails after the pass, before the service would start;
  // `activate` fails the checks that follow the start.
  for (const point of ["restore", "activate"]) {
    const root = await mkdtemp(join(tmpdir(), "locdoc-restore-"));
    try {
      const fixture = await restoreFixture(root);
      const live = fingerprint(fixture.live);
      const snapshot = fingerprint(fixture.snapshot);
      const failed = fixture.restore(fixture.snapshot, {
        LOCDOC_DEPLOY_TEST_FAIL: point,
      });
      assert.equal(failed.status, 1, point);
      assert.match(failed.stderr, /failure injected/);
      assert.match(failed.stderr, /put the previous data back/);
      assert.equal(
        fingerprint(fixture.snapshot),
        snapshot,
        "snapshot unchanged",
      );
      // The restored copies are kept instead of deleted; apart from them the
      // live folders are exactly as before.
      const keptDocs = (await names(fixture.live)).filter((name) =>
        name.startsWith("docs.failed-restore-"),
      );
      const keptState = (await names(fixture.state)).filter((name) =>
        name.startsWith("failed-restore-"),
      );
      assert.equal(keptDocs.length, 1, point);
      assert.equal(keptState.length, 1, point);
      assert.ok(
        (await names(join(fixture.state, keptState[0]))).includes(
          "restore-report.json",
        ),
      );
      await removeKeptCopies(fixture);
      assert.equal(fingerprint(fixture.live), live, point);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("restore restarts the unit, and stops it to put the live data back when its checks fail", async () => {
  const root = await mkdtemp(join(tmpdir(), "locdoc-restore-"));
  const units = [];
  try {
    for (const point of ["", "activate"]) {
      const folder = join(root, point || "kept");
      await mkdir(folder);
      const fixture = await restoreFixture(folder);
      const unit = await fakeUnit(folder, fixture);
      units.push(unit);
      assert.equal(unit.systemctl("start").status, 0);
      await unit.ready();
      const run = spawnSync("bash", [script, "restore", fixture.snapshot], {
        env: { ...unit.env, LOCDOC_DEPLOY_TEST_FAIL: point },
        encoding: "utf8",
      });
      await unit.ready();
      const owner = { Authorization: "Bearer restore-owner" };
      const tree = await (
        await fetch(`${unit.base}/api/tree`, { headers: owner })
      ).json();
      const paths = tree.entries.map((entry) => entry.path);
      if (!point) {
        assert.equal(run.status, 0, run.stderr);
        assert.deepEqual(await unit.calls(), ["start", "stop", "start"]);
        // The unit serves the snapshot, where only q.md exists.
        assert.ok(!paths.includes("after.md"), paths.join());
        const opened = await (
          await fetch(`${unit.base}/api/open/${fixture.token}`)
        ).json();
        assert.equal(opened.document.content, "Shared text of A\n");
      } else {
        assert.equal(run.status, 1, run.stderr);
        assert.match(run.stderr, /put the previous data back/);
        // Stopped before the data moved back, then started on it.
        assert.deepEqual(await unit.calls(), [
          "start",
          "stop",
          "start",
          "stop",
          "start",
        ]);
        assert.ok(paths.includes("after.md"), paths.join());
      }
    }
  } finally {
    for (const unit of units) unit.systemctl("stop");
    await rm(root, { recursive: true, force: true });
  }
});

test("an interrupt after any copy or move of a restore puts the live data back", async () => {
  const root = await mkdtemp(join(tmpdir(), "locdoc-restore-"));
  try {
    const fixture = await restoreFixture(root);
    const live = fingerprint(fixture.live);
    const snapshot = fingerprint(fixture.snapshot);
    const PATH = await stepTools(root);
    let completed = false;
    for (let step = 1; step < 100 && !completed; step++) {
      const run = fixture.restore(fixture.snapshot, {
        PATH,
        STEP_INTERRUPT: String(step),
        STEP_COUNT: join(root, `steps-${step}`),
      });
      // Past the last step the restore completes.
      completed = run.status === 0;
      if (completed) break;
      assert.equal(run.status, 130, `step ${step}: ${run.stderr}`);
      assert.doesNotMatch(run.stderr, /could not put everything back/);
      await removeKeptCopies(fixture);
      assert.equal(fingerprint(fixture.live), live, `step ${step}`);
      assert.equal(fingerprint(fixture.snapshot), snapshot, `step ${step}`);
    }
    assert.ok(completed, "an uninterrupted restore completes");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a killed restore leaves the live workspace or a refused one, never a new one", async () => {
  const root = await mkdtemp(join(tmpdir(), "locdoc-restore-"));
  try {
    const at = async (name) => {
      const folder = join(root, name);
      await mkdir(folder);
      return {
        folder,
        fixture: await restoreFixture(folder),
        PATH: await stepTools(folder),
      };
    };

    // While the snapshot is copied, the live data is untouched.
    const copying = await at("copying");
    await killRestore(copying.fixture, copying.folder, {
      PATH: copying.PATH,
      HOLD_TOOL: "cp",
      HOLD_MATCH: `${copying.fixture.docs}.restoring-`,
    });
    const server = await serve(copying.fixture.state, copying.fixture.docs);
    try {
      const opened = await (
        await fetch(`${server.base}/api/open/${copying.fixture.token}`)
      ).json();
      assert.equal(opened.document.id, copying.fixture.id);
      assert.equal(opened.document.content, "Shared text of A\n");
    } finally {
      await server.stop();
    }

    // With the live documents folder aside, startup refuses rather than
    // creating an empty workspace.
    const swapping = await at("swapping");
    await killRestore(swapping.fixture, swapping.folder, {
      PATH: swapping.PATH,
      HOLD_TOOL: "mv",
      HOLD_MATCH: `${swapping.fixture.docs}.restoring-`,
    });
    assert.match(
      await refusedStartup(swapping.fixture.state, swapping.fixture.docs),
      /unavailable or was replaced/,
    );
    assert.ok(!(await names(swapping.fixture.live)).includes("docs"));

    // With the live state files aside, startup refuses rather than creating
    // a new owner key and database.
    const moving = await at("moving");
    await killRestore(moving.fixture, moving.folder, {
      PATH: moving.PATH,
      HOLD_TOOL: "mv",
      HOLD_MATCH: `${moving.fixture.state}/.restoring-`,
    });
    await refusedStartup(moving.fixture.state, moving.fixture.docs);
    const left = await names(moving.fixture.state);
    assert.ok(!left.includes("owner.key") && !left.includes("locdoc.sqlite"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a restore killed in its pass keeps startup refusing a backup without root.identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "locdoc-restore-"));
  try {
    const fixture = await restoreFixture(root);
    // The state folder was lost, and the backup predates root.identity.
    await rm(fixture.state, { recursive: true });
    await rm(join(fixture.snapshot, "state/root.identity"));
    // A restore pass that is killed as it starts.
    await rm(join(fixture.release, "locdoc"));
    await writeFile(
      join(fixture.release, "locdoc"),
      '#!/usr/bin/env bash\n: >"$HOLD_READY"\nexec sleep 60\n',
      { mode: 0o700 },
    );
    await killRestore(fixture, root, {});
    assert.match(
      await refusedStartup(fixture.state, fixture.docs),
      /restore pass has not completed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restore refuses a snapshot that fails its checks and a state folder in use", async () => {
  const root = await mkdtemp(join(tmpdir(), "locdoc-restore-"));
  let holder;
  try {
    const fixture = await restoreFixture(root);
    const live = fingerprint(fixture.live);
    const damaged = join(root, "damaged");
    assert.equal(spawnSync("cp", ["-a", fixture.snapshot, damaged]).status, 0);
    const database = join(damaged, "state/locdoc.sqlite");
    const bytes = await readFile(database);
    bytes.fill(0xff, 100, 4096);
    await writeFile(database, bytes);
    const corrupt = fixture.restore(damaged);
    assert.equal(corrupt.status, 1);
    assert.match(
      corrupt.stderr,
      /locdoc\.sqlite (cannot be read|fails its check)/,
    );
    await rm(join(damaged, "state/owner.key"));
    const keyless = fixture.restore(damaged);
    assert.equal(keyless.status, 1);
    assert.match(keyless.stderr, /has no state\/owner\.key/);
    assert.equal(fingerprint(fixture.live), live, "nothing moved");

    // Another process holds the state folder: the script moves nothing, and
    // the binary fails fast in either mode.
    holder = spawn(
      "python3",
      [
        "-I",
        "-c",
        "import fcntl,sys,time; f=open(sys.argv[1],'a'); fcntl.flock(f, fcntl.LOCK_EX); print('locked', flush=True); time.sleep(60)",
        join(fixture.state, ".instance.lock"),
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    await once(holder.stdout, "data");
    const busy = fixture.restore(fixture.snapshot);
    assert.equal(busy.status, 1);
    assert.match(busy.stderr, /another Locdoc process is using/);
    for (const args of [["--restored"], []]) {
      const second = spawnSync(binary, args, {
        env: {
          ...process.env,
          LOCDOC_STATE: fixture.state,
          LOCDOC_DOCS: fixture.docs,
          LOCDOC_BIND: `127.0.0.1:${await freePort()}`,
        },
        encoding: "utf8",
        timeout: 10000,
      });
      assert.equal(second.status, 1, `${args} exits instead of waiting`);
      assert.match(
        second.stderr,
        /Another Locdoc process is using the state folder/,
      );
    }
    assert.equal(fingerprint(fixture.live), live, "nothing moved");
  } finally {
    holder?.kill();
    if (holder && holder.exitCode === null && holder.signalCode === null)
      await once(holder, "exit");
    await rm(root, { recursive: true, force: true });
  }
});
