import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React from "react";
import type { Document, HiddenMedia } from "../src/model";

let dom: JSDOM;
let render: typeof import("@testing-library/react").render;
let screen: typeof import("@testing-library/react").screen;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let waitFor: typeof import("@testing-library/react").waitFor;
let act: typeof import("@testing-library/react").act;
let cleanup: typeof import("@testing-library/react").cleanup;
let DocumentSharePanel: typeof import("../src/workspace-panels").DocumentSharePanel;
const originalFetch = globalThis.fetch;
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
type Request = { url: string; method: string; body?: any };
let requests: Request[] = [];
let respond: (request: Request) => Promise<Response> | Response;

before(async () => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
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
  ({ render, screen, fireEvent, waitFor, act, cleanup } =
    await import("@testing-library/react"));
  ({ DocumentSharePanel } = await import("../src/workspace-panels"));
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init: RequestInit = {},
  ) => {
    const request = {
      url: String(input),
      method: init.method || "GET",
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    requests.push(request);
    if (request.url.endsWith("/mcp"))
      return response({
        mcpAllowed: false,
        mcpDirect: false,
        mcpInherited: false,
      });
    const answer = respond(request);
    if (init.signal) {
      const signal = init.signal;
      return await new Promise<Response>((resolve, reject) => {
        signal.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
        Promise.resolve(answer).then(resolve, reject);
      });
    }
    return answer;
  }) as typeof fetch;
});
afterEach(() => {
  cleanup();
  requests = [];
});
after(() => {
  globalThis.fetch = originalFetch;
  dom.window.close();
});

function makeDoc(id: string, path = `Notes/${id}.md`, owner = true): Document {
  return {
    id,
    path,
    owner,
    edit: true,
    permission: "view",
    shareUrl: `http://localhost/s/${id}`,
    usage: 0,
    content: "",
    modified: 0,
    state: "",
    mediaToken: "media-token",
  };
}
function panel(doc: Document) {
  return (
    <DocumentSharePanel
      doc={doc}
      filename={doc.path}
      name="Owner"
      onChange={async () => {}}
      onShareFolder={() => {}}
    />
  );
}
const loads = (id: string) =>
  requests.filter(
    (request) => request.method === "GET" && request.url === `/api/docs/${id}`,
  ).length;

test("hidden images list their reason and are shown to link visitors on request", async () => {
  const hidden: HiddenMedia[] = [
    { path: "pics/a.png", reason: "unapproved" },
    { path: "pics/b.png", reason: "unapproved" },
    { path: "pics/c.png", reason: "unapproved" },
    { path: "gone.png", reason: "missing" },
  ];
  let share: (request: Request) => Response = () =>
    response({ ok: true, shared: [], refused: [] });
  respond = (request) =>
    request.method === "POST"
      ? share(request)
      : response({ ...makeDoc("doc-a"), hiddenMedia: hidden });
  render(panel(makeDoc("doc-a")));
  await screen.findByRole("heading", { name: "Hidden from link visitors" });
  assert.ok(screen.getByText("pics/a.png"));
  assert.equal(screen.getAllByText("Not approved for link visitors").length, 3);
  assert.ok(screen.getByText("File not found"));
  assert.equal(
    screen.queryByRole("button", { name: "Show gone.png to link visitors" }),
    null,
    "a missing file cannot be approved",
  );
  const thumbnail = document.querySelector<HTMLImageElement>(
    "img.hidden-media-thumb",
  )!;
  const url = new URL(thumbnail.src);
  assert.equal(url.pathname, "/api/docs/doc-a/media");
  assert.equal(url.searchParams.get("path"), "pics/a.png");
  assert.equal(url.searchParams.get("token"), "media-token");
  assert.equal(thumbnail.alt, "");

  let release: () => void = () => {};
  share = () => response({ ok: true, shared: ["pics/a.png"], refused: [] });
  const gate = new Promise<void>((resolve) => (release = resolve));
  const previous = share;
  share = (request) =>
    gate.then(() => previous(request)) as unknown as Response;
  const show = screen.getByRole("button", {
    name: "Show a.png to link visitors",
  }) as HTMLButtonElement;
  show.focus();
  fireEvent.click(show);
  await waitFor(() => assert.equal(show.getAttribute("aria-disabled"), "true"));
  assert.equal(show.textContent, "Showing…");
  assert.ok(
    document.activeElement === show,
    "a request in flight keeps keyboard focus on its button",
  );
  fireEvent.click(show);
  const post = requests.find((request) => request.method === "POST")!;
  assert.equal(post.url, "/api/docs/doc-a/media/share");
  assert.deepEqual(post.body, { paths: ["pics/a.png"] });
  assert.equal(
    requests.filter((request) => request.method === "POST").length,
    1,
    "a busy button sends nothing more",
  );
  await act(async () => release());
  await waitFor(() => assert.equal(screen.queryByText("pics/a.png"), null));
  assert.equal(
    screen.getByRole("status").textContent,
    "Link visitors can now see this image.",
  );
  assert.ok(
    document.activeElement ===
      screen.getByRole("button", { name: "Show b.png to link visitors" }),
    "focus moves to the next image instead of leaving the dialog",
  );

  share = (request) =>
    response({
      ok: true,
      shared: ["pics/c.png"],
      refused: request.body.paths
        .filter((path: string) => path !== "pics/c.png")
        .map((path: string) => ({ path, reason: "outside" })),
    });
  fireEvent.click(screen.getByRole("button", { name: "Show all" }));
  await waitFor(() =>
    assert.ok(screen.getByText("Not shown: Outside your documents folder")),
  );
  assert.deepEqual(requests.at(-1)!.body, {
    paths: ["pics/b.png", "pics/c.png"],
  });
  assert.equal(screen.queryByText("pics/c.png"), null);
  assert.equal(
    screen.getByRole("status").textContent,
    "Link visitors can now see this image. One image could not be shown.",
  );

  share = () => response({ error: "Media approval is unavailable." }, 503);
  const retry = screen.getByRole("button", {
    name: "Show b.png to link visitors",
  }) as HTMLButtonElement;
  fireEvent.click(retry);
  await waitFor(() =>
    assert.equal(
      screen.getByRole("alert").textContent,
      "Media approval is unavailable.",
    ),
  );
  assert.equal(
    retry.getAttribute("aria-disabled"),
    null,
    "a failed request can be retried",
  );
  assert.ok(screen.getByText("pics/b.png"));
});

test("each listed reason reads as it is, and only an unapproved image offers Show", async () => {
  const hidden: HiddenMedia[] = [
    { path: "../../outside.png", reason: "outside" },
    { path: ".dot/secret.png", reason: "hidden" },
    { path: "../.locdoc-trash/item/old.png", reason: "trash" },
    { path: ".trash/binned.png", reason: "trash" },
    { path: "state/cover.png", reason: "state" },
    { path: "big.png", reason: "too-large" },
    { path: "notes.png", reason: "unsupported" },
    { path: "pics\\win.png", reason: "invalid" },
    { path: "gone.png", reason: "missing" },
    { path: "photo.png", reason: "unapproved" },
  ];
  respond = () => response({ ...makeDoc("doc-l"), hiddenMedia: hidden });
  render(panel(makeDoc("doc-l")));
  await screen.findByText("photo.png");
  // Some of them nobody can see, the owner included.
  assert.ok(
    screen.getByText("People opening the link cannot see these images."),
  );
  const rows = Array.from(
    document.querySelectorAll(".hidden-media-item"),
    (row) =>
      [
        row.querySelector(".hidden-media-path")!.textContent,
        row.querySelector(".hidden-media-reason")!.textContent,
        row.querySelector("button")?.textContent || "",
        row.querySelector("img")?.getAttribute("src") ? "thumbnail" : "icon",
      ].join("|"),
  );
  assert.deepEqual(rows, [
    "../../outside.png|Outside your documents folder||icon",
    ".dot/secret.png|In a hidden file or folder||thumbnail",
    "../.locdoc-trash/item/old.png|In a trash folder||icon",
    ".trash/binned.png|In a trash folder||icon",
    "state/cover.png|In Locdoc's state folder||icon",
    "big.png|Over the 5 MB image or 20 MB video limit||icon",
    "notes.png|Not an image or video Locdoc can show||icon",
    "pics\\win.png|Not a file path Locdoc can open||icon",
    "gone.png|File not found||icon",
    "photo.png|Not approved for link visitors|Show to link visitors|thumbnail",
  ]);
  // Only files the owner can see are requested as thumbnails. Locdoc
  // serves its state folder and trash folders to nobody: their requests
  // would only be refused.
  assert.deepEqual(
    Array.from(
      document.querySelectorAll<HTMLImageElement>("img.hidden-media-thumb"),
      (image) => new URL(image.src).searchParams.get("path"),
    ),
    [".dot/secret.png", "photo.png"],
  );
  assert.equal(screen.queryByRole("button", { name: "Show all" }), null);
});

test("each refusal the server sends reads as its reason", async () => {
  const hidden: HiddenMedia[] = [
    { path: "pics/gone.png", reason: "unapproved" },
    { path: "pics/huge.jpg", reason: "unapproved" },
    { path: "pics/odd.png", reason: "unapproved" },
    { path: "pics/.dot.png", reason: "unapproved" },
    { path: "pics/big.png", reason: "unapproved" },
    { path: "pics/binned.png", reason: "unapproved" },
  ];
  const reasons: Record<string, string> = {
    "pics/gone.png": "unreferenced",
    "pics/huge.jpg": "unsupported",
    "pics/odd.png": "<b>new code</b>",
    "pics/.dot.png": "hidden",
    "pics/big.png": "too-large",
    // Moved into a trash folder since the list was loaded.
    "pics/binned.png": "trash",
  };
  respond = (request) =>
    request.method === "POST"
      ? response({
          ok: true,
          shared: [],
          refused: request.body.paths.map((path: string) => ({
            path,
            reason: reasons[path],
          })),
        })
      : response({ ...makeDoc("doc-r"), hiddenMedia: hidden });
  render(panel(makeDoc("doc-r")));
  fireEvent.click(await screen.findByRole("button", { name: "Show all" }));
  await screen.findByText("Not shown: No longer in this document");
  assert.ok(
    screen.getByText("Not shown: Not an image or video Locdoc can show"),
  );
  assert.ok(screen.getByText("Not shown: In a hidden file or folder"));
  assert.ok(screen.getByText("Not shown: In a trash folder"));
  assert.ok(
    screen.getByText("Not shown: Over the 5 MB image or 20 MB video limit"),
  );
  // An unknown reason is inert text, never markup.
  assert.ok(screen.getByText("Not shown: <b>new code</b>"));
  assert.equal(document.querySelector(".hidden-media b"), null);
});

test("a hidden-image answer for another document is never shown", async () => {
  const held = new Map<string, () => void>();
  respond = (request) => {
    const id = request.url.split("/")[3];
    const body = {
      ...makeDoc(id),
      hiddenMedia: [{ path: `${id}-only.png`, reason: "unapproved" }],
    };
    if (request.method === "POST")
      return new Promise<Response>((resolve) =>
        held.set(`post-${id}`, () =>
          resolve(
            response({ ok: true, shared: request.body.paths, refused: [] }),
          ),
        ),
      );
    if (id === "doc-a" && !held.has("doc-a-loaded"))
      return new Promise<Response>((resolve) => {
        held.set("doc-a-loaded", () => {});
        held.set("doc-a", () => resolve(response(body)));
      });
    return response(body);
  };
  const page = render(panel(makeDoc("doc-a")));
  await waitFor(() => assert.ok(held.has("doc-a")));
  page.rerender(panel(makeDoc("doc-b")));
  await screen.findByText("doc-b-only.png");
  await act(async () => held.get("doc-a")!());
  assert.equal(screen.queryByText("doc-a-only.png"), null);
  assert.ok(screen.getByText("doc-b-only.png"));

  fireEvent.click(
    screen.getByRole("button", {
      name: "Show doc-b-only.png to link visitors",
    }),
  );
  await waitFor(() => assert.ok(held.has("post-doc-b")));
  page.rerender(panel(makeDoc("doc-a")));
  await screen.findByText("doc-a-only.png");
  await act(async () => held.get("post-doc-b")!());
  assert.ok(
    screen.getByText("doc-a-only.png"),
    "a late approval never changes the next document's list",
  );
  assert.equal(screen.queryByRole("status")?.textContent || "", "");
});

test("only the owner's Markdown documents check for hidden images", async () => {
  respond = (request) =>
    response({
      ...makeDoc(request.url.split("/")[3]),
      hiddenMedia: [{ path: "photo.png", reason: "unapproved" }],
    });
  for (const doc of [
    makeDoc("visitor", "visitor.md", false),
    makeDoc("script", "Script.fountain"),
    makeDoc("plain", "Notes/plain.txt"),
  ]) {
    const page = render(panel(doc));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assert.equal(loads(doc.id), 0, `${doc.path} does not load hidden media`);
    assert.equal(document.querySelector(".hidden-media"), null);
    page.unmount();
  }
  render(panel(makeDoc("owner")));
  await screen.findByText("photo.png");
  assert.equal(loads("owner"), 1);
});

test("a failed hidden-image check keeps the share dialog usable", async () => {
  respond = () => response({ error: "Unavailable" }, 503);
  render(panel(makeDoc("doc-a")));
  await screen.findByText(
    "Could not check which images link visitors can see.",
  );
  assert.ok(screen.getByLabelText("Link access"));
});
