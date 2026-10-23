import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

test("local owner authentication is kept in origin storage and survives unrelated cookies", async () => {
  const dom = new JSDOM("", { url: "http://127.0.0.1:3561/" });
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
  const dom = new JSDOM("", { url: "http://127.0.0.1:3561/" });
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
