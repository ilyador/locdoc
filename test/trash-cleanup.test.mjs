import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";

const client = resolve("scripts/clean-trash.mjs");
const installer = resolve("scripts/install-service.mjs");

async function run(script, env, args = []) {
  const child = spawn(process.execPath, [script, ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (data) => {
      output = (output + data).slice(-4000);
    });
  const [code] = await once(child, "exit");
  return { code, output };
}

test("trash cleanup authenticates locally, reports its result and refuses redirects", async () => {
  const root = await mkdtemp(join(tmpdir(), "locdoc-cleanup-client-"));
  const key = "synthetic-cleanup-owner";
  let requests = 0,
    redirect = false;
  const server = createServer((request, response) => {
    requests++;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/api/trash/cleanup");
    assert.equal(request.headers.authorization, `Bearer ${key}`);
    if (redirect) response.writeHead(302, { Location: "/must-not-follow" });
    else response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true, items: 2, folders: 3 }));
  });
  try {
    await writeFile(join(root, "owner.key"), key);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const env = {
      LOCDOC_STATE: root,
      LOCDOC_LOCAL_URL: `http://127.0.0.1:${server.address().port}`,
    };
    const success = await run(client, env);
    assert.equal(success.code, 0, success.output);
    assert.match(success.output, /2 expired item\(s\), 3 empty folder\(s\)/);
    assert.ok(
      !success.output.includes(key),
      "credentials must never be logged",
    );
    redirect = true;
    const failure = await run(client, env);
    assert.equal(failure.code, 1);
    assert.equal(requests, 2, "a redirect never receives the owner key");
    assert.ok(
      !failure.output.includes(key),
      "errors must never log credentials",
    );
  } finally {
    server.close();
    server.closeAllConnections();
    await rm(root, { recursive: true, force: true });
  }
});

test("trash cleanup refuses public addresses before reading a key or making a request", async () => {
  for (const url of ["https://127.0.0.1:3477", "http://example.test:3477"]) {
    const result = await run(client, {
      LOCDOC_LOCAL_URL: url,
      LOCDOC_STATE: "/does-not-exist",
    });
    assert.equal(result.code, 1);
    assert.match(result.output, /must be a loopback HTTP address/);
  }
});

test("installing the daily cleanup preserves the existing Locdoc service", async () => {
  const root = await mkdtemp(join(tmpdir(), "locdoc-cleanup-unit-"));
  const units = join(root, "systemd/user");
  try {
    await mkdir(units, { recursive: true });
    await writeFile(join(units, "locdoc.service"), "existing service\n");
    const result = await run(installer, { XDG_CONFIG_HOME: root }, [
      "--trash-cleanup",
      "--no-start",
    ]);
    assert.equal(result.code, 0, result.output);
    assert.equal(
      await readFile(join(units, "locdoc.service"), "utf8"),
      "existing service\n",
    );
    const service = await readFile(
      join(units, "locdoc-trash-cleanup.service"),
      "utf8",
    );
    const timer = await readFile(
      join(units, "locdoc-trash-cleanup.timer"),
      "utf8",
    );
    assert.match(service, /Requires=locdoc.service/);
    assert.ok(service.includes(client), "the job runs the checked-in script");
    assert.match(timer, /OnCalendar=\*-\*-\* 04:15:00/);
    assert.match(timer, /Persistent=true/);
    const again = await run(installer, { XDG_CONFIG_HOME: root }, [
      "--trash-cleanup",
      "--no-start",
    ]);
    assert.equal(
      again.code,
      1,
      "an existing job requires explicit replacement",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
