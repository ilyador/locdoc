import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";
import React from "react";
import type { Document } from "../src/model";

let dom: JSDOM;
let cache: typeof import("../src/offline-cache");
let api: typeof import("../src/api");
let panels: typeof import("../src/workspace-panels");
let files: typeof import("../src/offline-files");
let db: typeof import("../src/offline-db");
let library: typeof import("@testing-library/react");
const fetchBefore = globalThis.fetch;
let requests: string[] = [];

before(async () => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://unsent.example.test/",
  });
  for (const key of [
    "window",
    "document",
    "location",
    "localStorage",
    "navigator",
    "Node",
    "Element",
    "HTMLElement",
    "HTMLInputElement",
    "MutationObserver",
  ])
    Object.defineProperty(globalThis, key, {
      value: dom.window[key],
      configurable: true,
      writable: true,
    });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  library = await import("@testing-library/react");
  cache = await import("../src/offline-cache");
  api = await import("../src/api");
  panels = await import("../src/workspace-panels");
  files = await import("../src/offline-files");
  db = await import("../src/offline-db");
  await cache.cacheRead("/api/config", {
    owner: true,
    root: "/fixture/docs",
    guest: "fixture",
    publicUrl: location.origin,
    offlineScope: crypto.randomUUID(),
  });
});
afterEach(() => {
  library.cleanup();
  globalThis.fetch = fetchBefore;
});
after(() => dom.window.close());

const owned = (id: string, path: string) =>
  ({
    id,
    path,
    owner: true,
    edit: true,
    permission: "private",
    shareUrl: null,
  }) as Document;
const panel = (doc: Document) => (
  <panels.DocumentSharePanel
    doc={doc}
    filename={doc.path}
    name="Owner"
    onChange={async () => assert.fail("an unsent document cannot be shared")}
    onShareFolder={() => {}}
  />
);

test("a document the server has not accepted yet says so instead of failing as not found", async () => {
  // The server refuses every request, as it does while an earlier queued
  // change keeps failing: the new document then exists only in this browser.
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return new Response(
      JSON.stringify({ error: "The file operation failed." }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  };
  const created = await api.api<{ id: string }>(
    "/api/files",
    api.send("POST", { path: "Unsent.md", kind: "file" }),
  );
  // The open document is the one this browser made, as the editor reads it.
  const doc = await api.api<Document>(`/api/docs/${created.id}`);
  requests = [];
  library.render(panel(doc));
  assert.match(
    library.screen.getByRole("status").textContent!,
    /has not reached the server yet/,
  );
  assert.equal(
    library.screen.queryByRole("switch", { name: "Allow MCP" }),
    null,
  );
  assert.equal(library.screen.queryByLabelText("Link access"), null);
  assert.deepEqual(
    requests.filter((url) => url.includes(`/api/docs/${created.id}`)),
    [],
    "nothing is asked of a server that does not know the document",
  );
  // The server accepts the document: the controls take the message's place.
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        mcpAllowed: false,
        mcpDirect: false,
        mcpInherited: false,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  for (const entry of await files.queuedFiles())
    await db.offlineDelete("commands", entry.key);
  await library.act(async () => {
    window.dispatchEvent(new window.Event("locdoc-offline-files"));
  });
  await library.waitFor(() =>
    assert.ok(library.screen.getByRole("switch", { name: "Allow MCP" })),
  );
  assert.equal(library.screen.queryByRole("status"), null);
});

test("a document the server knows keeps its sharing controls", async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        mcpAllowed: false,
        mcpDirect: false,
        mcpInherited: false,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  library.render(panel(owned(crypto.randomUUID(), "Known.md")));
  assert.ok(
    library.screen.getByLabelText("Link access"),
    "a known document's controls show at once, with no empty moment",
  );
  await library.waitFor(() =>
    assert.ok(library.screen.getByRole("switch", { name: "Allow MCP" })),
  );
  assert.ok(library.screen.getByLabelText("Link access"));
  assert.equal(library.screen.queryByRole("status"), null);
});
