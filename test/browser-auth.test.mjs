import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { freePort } from "./fixtures/free-port.mjs";

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
// Another local server's origin: the same host on another port.
const otherOrigin = `http://127.0.0.1:${port === 65535 ? port - 1 : port + 1}`;
const key = "browser-auth-synthetic-owner";
let dir,
  server,
  logs = "";
async function request(
  path,
  { headers = {}, body, method = body ? "POST" : "GET" } = {},
) {
  const options = {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(5000),
  };
  // Node's fetch normalizes Host; the raw HTTP request is intentional for
  // verifying reverse-proxy authority and legacy public-cookie migration.
  const response = headers.Host
    ? await new Promise((resolve, reject) => {
        const req = httpRequest(base + path, options, (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const responseHeaders = new Headers();
            for (const [key, value] of Object.entries(res.headers))
              for (const entry of Array.isArray(value) ? value : [value])
                if (entry !== undefined) responseHeaders.append(key, entry);
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode,
                headers: responseHeaders,
              }),
            );
          });
        });
        req.on("error", reject);
        req.end(options.body);
      })
    : await fetch(base + path, options);
  const data = await response
    .clone()
    .json()
    .catch(() => null);
  return { response, data };
}
const owner = { Authorization: `Bearer ${key}` };
const bearer = (session) => ({ Authorization: `Bearer ${session}` });

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "locdoc-browser-auth-"));
  await mkdir(join(dir, "state"));
  await writeFile(join(dir, "state/owner.key"), key);
  server = spawn("./target/debug/locdoc", [], {
    env: {
      ...process.env,
      LOCDOC_BIND: `127.0.0.1:${port}`,
      LOCDOC_DOCS: join(dir, "docs"),
      LOCDOC_STATE: join(dir, "state"),
      LOCDOC_PUBLIC_URL: "https://notes.example.test",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  server.stderr.on("data", (bytes) => {
    logs = (logs + bytes).slice(-4000);
  });
  for (let n = 0; n < 250; n++) {
    if (server.exitCode !== null) throw Error(logs);
    try {
      if ((await request("/api/config")).response.ok) return;
    } catch {}
    await delay(20);
  }
  throw Error("Browser-auth fixture did not start");
});
after(async () => {
  server?.kill("SIGINT");
  if (server?.exitCode === null) await once(server, "exit");
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("browser responses prohibit inline and dynamically evaluated scripts", async () => {
  const { response } = await request("/api/config");
  const policy = response.headers.get("content-security-policy");
  assert.ok(policy, "Every browser response needs an enforced CSP");
  const directives = new Map(
    policy
      .split(";")
      .filter((entry) => entry.trim())
      .map((entry) => {
        const [name, ...values] = entry.trim().split(/\s+/);
        return [name, values];
      }),
  );
  assert.deepEqual(directives.get("script-src"), ["'self'"]);
  for (const override of ["script-src-elem", "script-src-attr"])
    if (directives.has(override))
      assert.deepEqual(
        directives.get(override),
        ["'none'"],
        `${override} must not weaken script-src`,
      );
  assert.deepEqual(directives.get("object-src"), ["'none'"]);
  assert.deepEqual(directives.get("base-uri"), ["'self'"]);
});

test("local owner sessions survive planted cookies and are never themselves cookies", async () => {
  for (const Host of [
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ]) {
    const config = await request("/api/config", { headers: { Host } });
    assert.equal(config.response.status, 200);
    const guest = config.response.headers
      .getSetCookie()
      .find((value) => value.startsWith("locdoc_guest="));
    assert.doesNotMatch(guest, /; Secure/);
  }
  const login = await request("/api/login", {
    body: { key },
    headers: { Origin: base },
  });
  assert.equal(login.response.status, 200);
  assert.match(login.data.session, /^[a-f0-9]{64}$/);
  assert.equal(login.response.headers.get("set-cookie"), null);
  const planted = {
    Cookie: "locdoc_owner=garbage; __Host-locdoc_owner=garbage",
  };
  assert.equal(
    (
      await request("/api/config", {
        headers: { ...bearer(login.data.session), ...planted },
      })
    ).data.owner,
    true,
  );
  assert.equal(
    (
      await request("/api/config", {
        headers: {
          Cookie: `locdoc_owner=${login.data.session}; __Host-locdoc_owner=${login.data.session}`,
        },
      })
    ).data.owner,
    false,
  );
  assert.equal(
    (
      await request("/api/logout", {
        headers: {
          ...bearer(login.data.session),
          Origin: otherOrigin,
        },
        body: {},
      })
    ).response.status,
    403,
  );
  assert.equal(
    (await request("/api/config", { headers: bearer(login.data.session) })).data
      .owner,
    true,
  );
});

test("public owner sessions use host-only secure cookies and migrate valid old cookies", async () => {
  const headers = {
    Host: "notes.example.test",
    Origin: "https://notes.example.test",
  };
  const login = await request("/api/login", { headers, body: { key } });
  assert.equal(login.response.status, 200);
  assert.equal(login.data.session, undefined);
  const setCookies = login.response.headers.getSetCookie();
  const secured = setCookies.find((value) =>
    value.startsWith("__Host-locdoc_owner="),
  );
  assert.match(secured, /; Secure/);
  assert.match(secured, /; HttpOnly/);
  assert.match(secured, /; Path=\//);
  assert.doesNotMatch(secured, /Domain=/i);
  const value = secured.match(/^__Host-locdoc_owner=([^;]+)/)[1];
  const legacy = await request("/api/config", {
    headers: { ...headers, Cookie: `locdoc_owner=${value}` },
  });
  assert.equal(legacy.data.owner, true);
  const replacement = legacy.response.headers
    .getSetCookie()
    .find((v) => v.startsWith("__Host-locdoc_owner="))
    .match(/^__Host-locdoc_owner=([^;]+)/)[1];
  assert.notEqual(replacement, value);
  assert.equal(
    (
      await request("/api/config", {
        headers: { ...headers, Cookie: `locdoc_owner=${value}` },
      })
    ).data.owner,
    false,
  );
  const duplicate = await request("/api/config", {
    headers: {
      ...headers,
      Cookie: `__Host-locdoc_owner=junk; __Host-locdoc_owner=${replacement}`,
    },
  });
  assert.equal(duplicate.data.owner, true);
  assert.equal(
    (
      await request("/api/config", {
        headers: {
          Cookie: `locdoc_owner=${value}; __Host-locdoc_owner=${value}`,
        },
      })
    ).data.owner,
    false,
  );
  assert.equal(
    (await request("/api/config", { headers: bearer(value) })).data.owner,
    false,
  );
  assert.equal(
    (
      await request("/api/config", {
        headers: {
          Host: "other.example.test",
          Cookie: `locdoc_owner=${value}`,
        },
      })
    ).response.status,
    403,
  );
});

test("local WebSockets authenticate outside URLs and stop accepting edits after logout", async () => {
  const login = await request("/api/login", { body: { key } });
  const created = await request("/api/files", {
    headers: owner,
    body: { kind: "file", path: "socket.md" },
  });
  const socket = new WebSocket(
    `${base.replace("http", "ws")}/ws/${created.data.id}?client=plain-text-v2`,
    [`locdoc-session.${login.data.session}`],
    { headers: { Origin: base } },
  );
  try {
    await once(socket, "open");
    assert.equal(socket.protocol, `locdoc-session.${login.data.session}`);
    assert.ok(!socket.url.includes(login.data.session));
    const logout = await request("/api/logout", {
      headers: bearer(login.data.session),
      body: {},
    });
    assert.equal(logout.response.status, 200);
    const closed = once(socket, "close");
    socket.send(new Uint8Array([0, 0, 1, 0]));
    await Promise.race([
      closed,
      delay(3000).then(() => {
        throw Error("Revoked local owner socket remained open");
      }),
    ]);
  } finally {
    socket.terminate();
  }
});

test("private local media has document-only capabilities revoked with its session", async () => {
  const login = await request("/api/login", { body: { key } });
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFlsAAAAASUVORK5CYII=",
    "base64",
  );
  await writeFile(join(dir, "docs/image.png"), png);
  await writeFile(join(dir, "docs/unembedded.png"), png);
  await writeFile(join(dir, "docs/media.md"), "![Image](image.png)\n");
  const tree = await request("/api/tree", { headers: owner });
  const id = tree.data.entries.find((entry) => entry.path === "media.md").id;
  const document = await request(`/api/docs/${id}`, {
    headers: bearer(login.data.session),
  });
  const token = document.data.mediaToken;
  assert.match(token, /^m1\./);
  const media = (path) =>
    `/api/docs/${id}/media?${new URLSearchParams({ path, token })}`;
  assert.equal((await request(media("image.png"))).response.status, 200);
  assert.equal((await request(media("unembedded.png"))).response.status, 403);
  assert.equal(
    (await request(`/api/docs/${id}?token=${encodeURIComponent(token)}`))
      .response.status,
    403,
  );
  const other = await request("/api/files", {
    headers: owner,
    body: { kind: "file", path: "other.md" },
  });
  assert.equal(
    (
      await request(
        `/api/docs/${other.data.id}/media?${new URLSearchParams({ path: "image.png", token })}`,
      )
    ).response.status,
    403,
  );
  await request("/api/logout", {
    headers: bearer(login.data.session),
    body: {},
  });
  assert.equal((await request(media("image.png"))).response.status, 403);
});

test("comment responses expose permission, not cross-document author identifiers or request records", async () => {
  const cookie = `locdoc_guest=${"a".repeat(64)}`;
  const outsider = `locdoc_guest=${"b".repeat(64)}`;
  for (const filename of ["private-author-one.md", "private-author-two.md"]) {
    const created = await request("/api/files", {
      headers: owner,
      body: { kind: "file", path: filename },
    });
    const shared = await request(`/api/docs/${created.data.id}/share`, {
      headers: owner,
      body: { permission: "view" },
    });
    const token = shared.data.shareUrl.split("/").pop();
    const endpoint = `/api/docs/${created.data.id}/comments?token=${token}`;
    const added = await request(endpoint, {
      headers: { Cookie: cookie },
      body: { name: "Example", body: "A note", requestId: crypto.randomUUID() },
    });
    assert.equal(added.response.status, 200);
    for (const value of [
      added.data,
      ...(await request(endpoint, { headers: { Cookie: outsider } })).data
        .comments,
    ]) {
      assert.equal(value.guest, undefined);
      assert.equal(value.requestId, undefined);
      assert.equal(value.replyRequests, undefined);
    }
    assert.equal(added.data.canResolve, true);
    assert.equal(
      (await request(endpoint, { headers: { Cookie: outsider } })).data
        .comments[0].canResolve,
      false,
    );
    assert.equal(
      (await request(endpoint, { headers: { Cookie: cookie } })).data
        .comments[0].canResolve,
      true,
    );
  }
});
