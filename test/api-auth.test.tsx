import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

test("local owner authentication is kept in origin storage and survives unrelated cookies", async () => {
  const dom = new JSDOM("", { url: "http://127.0.0.1/" });
  Object.defineProperties(globalThis, {
    location: { value: dom.window.location, configurable: true },
    localStorage: { value: dom.window.localStorage, configurable: true },
  });
  const originalFetch = globalThis.fetch;
  const { api, ownerSession } = await import("../src/api");
  const token = "c".repeat(64);
  let received: Record<string, string> = {};
  globalThis.fetch = async (path, options) => {
    received = Object.fromEntries(new Headers(options?.headers).entries());
    return new Response(
      JSON.stringify(
        path === "/api/login" ? { ok: true, session: token } : { ok: true },
      ),
      { headers: { "Content-Type": "application/json" } },
    );
  };
  try {
    await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ key: "example" }),
    });
    assert.equal(ownerSession(), token);
    assert.equal(localStorage.getItem("locdoc.ownerSession"), token);
    dom.window.document.cookie = "locdoc_owner=planted; Path=/";
    await api("/api/config");
    assert.equal(received.authorization, `Bearer ${token}`);
    await api("/api/logout", { method: "POST" });
    assert.equal(localStorage.getItem("locdoc.ownerSession"), null);
    assert.equal(ownerSession(), "");
    await api("/api/config");
    assert.equal(received.authorization, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
});

test("public HTTPS requests use HttpOnly cookies instead of readable local owner credentials", async () => {
  const dom = new JSDOM("", { url: "https://notes.example.test/" });
  Object.defineProperties(globalThis, {
    location: { value: dom.window.location, configurable: true },
    localStorage: { value: dom.window.localStorage, configurable: true },
  });
  localStorage.setItem("locdoc.ownerSession", "unrelated-old-value");
  const originalFetch = globalThis.fetch;
  const { api, ownerSession } = await import("../src/api");
  let authorization: string | null = null;
  globalThis.fetch = async (_path, options) => {
    authorization = new Headers(options?.headers).get("Authorization");
    return new Response("{}", {
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    assert.equal(ownerSession(), "");
    await api("/api/config");
    assert.equal(authorization, null);
  } finally {
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
});

test("a kept response is offered only for its own path, and only a 304 keeps it", async () => {
  const dom = new JSDOM("", { url: "http://127.0.0.1/" });
  Object.defineProperties(globalThis, {
    location: { value: dom.window.location, configurable: true },
    localStorage: { value: dom.window.localStorage, configurable: true },
  });
  const originalFetch = globalThis.fetch;
  const { revalidate, ApiError } = await import("../src/api");
  const sent: { path: string; held: string | null; cache?: string }[] = [];
  let answer = (_path: string, _held: string | null) =>
    new Response(JSON.stringify({ entries: ["a"] }), {
      headers: { "content-type": "application/json", etag: 'W/"one"' },
    });
  globalThis.fetch = async (path, options) => {
    const held = new Headers(options?.headers).get("If-None-Match");
    sent.push({ path: String(path), held, cache: options?.cache });
    return answer(String(path), held);
  };
  try {
    const kept = await revalidate<{ entries: string[] }>("/api/tree", null);
    assert.deepEqual(kept, {
      path: "/api/tree",
      tag: 'W/"one"',
      body: { entries: ["a"] },
    });
    // Another path, such as a folder link's listing, never names it.
    await revalidate("/api/tree?token=folder", kept);
    answer = (_path, held) =>
      held === 'W/"one"'
        ? new Response(null, { status: 304, headers: { etag: 'W/"one"' } })
        : new Response("{}", {
            headers: { "content-type": "application/json" },
          });
    const again = await revalidate("/api/tree", kept);
    assert.ok(again === kept, "a 304 keeps the response it confirms");
    assert.deepEqual(
      sent.map(({ path, held, cache }) => [path, held, cache]),
      [
        ["/api/tree", null, "no-store"],
        ["/api/tree?token=folder", null, "no-store"],
        ["/api/tree", 'W/"one"', "no-store"],
      ],
    );
    // A refusal is never answered from the kept response.
    answer = () =>
      new Response(JSON.stringify({ error: "Owner access is required." }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    await assert.rejects(
      revalidate("/api/tree", kept),
      (error: unknown) => error instanceof ApiError && error.status === 403,
    );
  } finally {
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
});

test("a kept response takes in only what changed, and is asked for again whole when that does not apply", async () => {
  const dom = new JSDOM("", { url: "http://127.0.0.1:3561/" });
  Object.defineProperties(globalThis, {
    location: { value: dom.window.location, configurable: true },
    localStorage: { value: dom.window.localStorage, configurable: true },
  });
  const originalFetch = globalThis.fetch;
  const { revalidate } = await import("../src/api");
  const sent: [string | null, string | null][] = [];
  const whole = (list: number[], tag: string) =>
    new Response(JSON.stringify({ list }), {
      headers: { "content-type": "application/json", etag: tag },
    });
  const splice = (body: unknown, base: string | null, tag: string) =>
    new Response(JSON.stringify(body), {
      status: 226,
      headers: {
        "content-type": "application/json",
        etag: tag,
        im: "splice",
        "delta-base": base || "",
      },
    });
  let answer = (_held: string | null) => whole([1, 2, 3], 'W/"one"');
  globalThis.fetch = async (_path, options) => {
    const headers = new Headers(options?.headers);
    sent.push([headers.get("If-None-Match"), headers.get("A-IM")]);
    return answer(headers.get("If-None-Match"));
  };
  type List = { list: number[] };
  const changes = {
    manipulation: "splice",
    apply: (kept: List, changes: any) =>
      typeof changes?.add === "number"
        ? { list: [...kept.list, changes.add] }
        : null,
  };
  try {
    const kept = await revalidate<List>("/api/list", null, { changes });
    assert.deepEqual(sent.pop(), [null, null], "nothing held, nothing named");
    // What changed since the response held, by its tag.
    answer = (held) => splice({ add: 4 }, held, 'W/"two"');
    const next = await revalidate<List>("/api/list", kept, { changes });
    assert.deepEqual(sent.pop(), ['W/"one"', "splice"]);
    assert.deepEqual(next, {
      path: "/api/list",
      tag: 'W/"two"',
      body: { list: [1, 2, 3, 4] },
    });
    assert.deepEqual(
      kept.body.list,
      [1, 2, 3],
      "the kept response is not changed",
    );
    // A splice of another listing than the one held, or one that does not
    // apply, is never applied: the listing is asked for again whole.
    for (const unfit of [
      (held: string | null) => splice({ add: 5 }, 'W/"elsewhere"', 'W/"three"'),
      (held: string | null) => splice({ nothing: true }, held, 'W/"three"'),
    ]) {
      answer = (held) => (held ? unfit(held) : whole([9], 'W/"three"'));
      const asked = await revalidate<List>("/api/list", next, { changes });
      assert.deepEqual(asked, {
        path: "/api/list",
        tag: 'W/"three"',
        body: { list: [9] },
      });
      assert.deepEqual(sent.splice(0), [
        ['W/"two"', "splice"],
        [null, null],
      ]);
    }
    // Without a way to apply them, splices are never asked for.
    answer = () => whole([1], 'W/"four"');
    await revalidate<List>("/api/list", next);
    assert.deepEqual(sent.pop(), ['W/"two"', null]);
  } finally {
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
});

test("a document's collaboration state decodes byte for byte", async () => {
  const { decodeState } = await import("../src/api");
  const bytes = new Uint8Array(70_000).map((_, i) => (i * 7919 + 13) % 256);
  const decoded = decodeState(Buffer.from(bytes).toString("base64"));
  assert.equal(decoded.length, bytes.length);
  assert.ok(
    decoded.every((byte, i) => byte === bytes[i]),
    "every byte value survives",
  );
  assert.equal(decodeState("").length, 0);
});

test("reads recover from a brief proxy or network failure, and revalidation keeps its request identity", async () => {
  const dom = new JSDOM("", { url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    location: { value: dom.window.location, configurable: true },
    localStorage: { value: dom.window.localStorage, configurable: true },
  });
  const saved = globalThis.fetch;
  const { api, revalidate } = await import("../src/api");
  try {
    for (const failure of [502, 503, 504, "network"] as const) {
      let calls = 0;
      globalThis.fetch = async () => {
        if (++calls === 1) {
          if (failure === "network") throw new TypeError("Failed to fetch");
          return new Response("", { status: failure });
        }
        return Response.json({ opened: true });
      };
      assert.deepEqual(await api("/api/docs/fixture"), { opened: true });
      assert.equal(calls, 2);
    }
    const kept = { path: "/api/tree", tag: 'W/"one"', body: { entries: [] } };
    const offered: (string | null)[] = [];
    globalThis.fetch = async (_path, init) => {
      offered.push(new Headers(init?.headers).get("If-None-Match"));
      return new Response(null, { status: offered.length === 1 ? 502 : 304 });
    };
    assert.ok(
      (await revalidate("/api/tree", kept)) === kept,
      "a retried 304 still confirms the response held for that request",
    );
    assert.deepEqual(offered, [kept.tag, kept.tag]);
  } finally {
    globalThis.fetch = saved;
    dom.window.close();
  }
});

test("a persistent proxy failure ends after three reads and retains its HTTP status", async () => {
  const saved = globalThis.fetch;
  const { api, ApiError } = await import("../src/api");
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("<h1>Bad Gateway</h1>", { status: 502 });
  };
  try {
    await assert.rejects(
      api("/api/docs/fixture"),
      (error: unknown) =>
        error instanceof ApiError &&
        error.status === 502 &&
        /temporarily unavailable/.test(error.message),
    );
    assert.equal(calls, 3, "an unavailable server must not start a retry loop");
  } finally {
    globalThis.fetch = saved;
  }
});

test("writes and structured application refusals are never replayed", async () => {
  const saved = globalThis.fetch;
  const { api, ApiError } = await import("../src/api");
  try {
    for (const method of ["POST", "PATCH", "DELETE"]) {
      for (const failure of [502, "network"] as const) {
        let calls = 0;
        globalThis.fetch = async () => {
          calls++;
          if (failure === "network") throw new TypeError("Failed to fetch");
          return new Response("", { status: failure });
        };
        await assert.rejects(api("/api/action", { method }));
        assert.equal(calls, 1, "a lost response must not repeat a mutation");
      }
    }
    for (const status of [400, 403, 404, 409, 410, 429, 500, 502, 503, 504]) {
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        return Response.json({ error: "Refused" }, { status });
      };
      await assert.rejects(
        api("/api/docs/fixture"),
        (error: unknown) =>
          error instanceof ApiError && error.status === status,
      );
      assert.equal(calls, 1);
    }
  } finally {
    globalThis.fetch = saved;
  }
});

test("cancelling a read during backoff prevents its next request", async () => {
  const saved = globalThis.fetch;
  const { api } = await import("../src/api");
  const controller = new AbortController();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("", { status: 502 });
  };
  try {
    const pending = api("/api/docs/fixture", { signal: controller.signal });
    const cancelled = assert.rejects(pending, { name: "AbortError" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    await cancelled;
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = saved;
  }
});

test("a malformed successful response is rejected instead of becoming document data", async () => {
  const saved = globalThis.fetch;
  const { api, ApiError } = await import("../src/api");
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("<html>A proxy page</html>", { status: 200 });
  };
  try {
    await assert.rejects(
      api("/api/docs/fixture"),
      (error: unknown) =>
        error instanceof ApiError &&
        error.status === 200 &&
        /unexpected response \(200\)/.test(error.message),
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = saved;
  }
});
