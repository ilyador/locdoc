import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { JSDOM } from "jsdom";
import { EditorView } from "@codemirror/view";

let dom: JSDOM;
let render: typeof import("@testing-library/react").render;
let cleanup: typeof import("@testing-library/react").cleanup;
let act: typeof import("@testing-library/react").act;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let waitFor: typeof import("@testing-library/react").waitFor;
let VersionHistory: typeof import("../src/version-history").VersionHistory;
let HistoryPreview: typeof import("../src/history-preview").HistoryPreview;
const savedFetch = globalThis.fetch;
const endpoint = (suffix: string) => `/api/docs/fixture${suffix}`;
const props = {
  endpoint,
  documentId: "fixture",
  path: "fixture.md",
  onClose() {},
  onRestore() {},
};
const version = {
  content: "# Draft\n\nThe red fox.",
  previous: { id: "old", created: 100, content: "# Draft\n\nThe blue fox." },
};

before(async () => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  for (const key of [
    "window",
    "Window",
    "document",
    "location",
    "localStorage",
    "navigator",
    "Node",
    "Element",
    "HTMLElement",
    "MutationObserver",
    "DOMRect",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ])
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: [
        "getComputedStyle",
        "requestAnimationFrame",
        "cancelAnimationFrame",
      ].includes(key)
        ? dom.window[key].bind(dom.window)
        : dom.window[key],
    });
  dom.window.Range.prototype.getClientRects = () => [] as any;
  dom.window.Range.prototype.getBoundingClientRect = () =>
    new dom.window.DOMRect();
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as any;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  ({ render, cleanup, act, fireEvent, waitFor } =
    await import("@testing-library/react"));
  ({ VersionHistory } = await import("../src/version-history"));
  ({ HistoryPreview } = await import("../src/history-preview"));
});
afterEach(() => {
  cleanup();
  globalThis.fetch = savedFetch;
});
after(() => dom.window.close());

function respond() {
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const path = String(input);
    calls.push(path);
    return Response.json(
      path.endsWith("/versions")
        ? {
            versions: [
              { id: "new", created: 200, bytes: 25 },
              { id: "old", created: 100, bytes: 26 },
            ],
          }
        : path.endsWith("/old")
          ? { content: "Old version", previous: null }
          : version,
    );
  };
  return calls;
}
const view = (host: HTMLElement) =>
  EditorView.findFromDOM(host.querySelector(".cm-content")!)!;

test("the latest snapshot opens automatically with formatted, read-only additions and removals", async () => {
  const calls = respond();
  const page = render(<VersionHistory {...props} />);
  await waitFor(() =>
    assert.ok(page.container.querySelector(".cm-changedText")),
  );
  assert.equal(
    page.container
      .querySelector('[data-version-id="new"]')
      ?.getAttribute("aria-current"),
    "true",
  );
  assert.deepEqual(calls, [endpoint("/versions"), endpoint("/versions/new")]);
  assert.equal(view(page.container).state.doc.toString(), version.content);
  assert.equal(view(page.container).state.readOnly, true);
  assert.equal(
    page
      .getByLabelText("Saved version content")
      .getAttribute("contenteditable"),
    "false",
  );
  assert.equal(page.container.querySelector(".md-h1")?.textContent, "Draft");
  assert.match(
    page.container.querySelector(".cm-changedText")!.textContent!,
    /red/,
  );
  assert.match(
    page.container.querySelector(".cm-deletedText")!.textContent!,
    /blue/,
  );
  fireEvent.click(page.getByRole("checkbox", { name: "Show changes" }));
  await waitFor(() =>
    assert.equal(page.container.querySelector(".cm-deletedText"), null),
  );
  assert.equal(view(page.container).state.doc.toString(), version.content);
  assert.equal(
    calls.length,
    2,
    "changing presentation never reloads or restores the document",
  );
});

test("date navigation works from the keyboard and the first snapshot has no invented baseline", async () => {
  respond();
  const page = render(<VersionHistory {...props} />);
  await waitFor(() => assert.ok(page.container.querySelector(".cm-content")));
  const latest = page.container.querySelector<HTMLButtonElement>(
    '[data-version-id="new"]',
  )!;
  act(() => latest.focus());
  fireEvent.keyDown(latest, { key: "ArrowDown" });
  await waitFor(() =>
    assert.equal(view(page.container).state.doc.toString(), "Old version"),
  );
  const oldest = page.container.querySelector<HTMLButtonElement>(
    '[data-version-id="old"]',
  )!;
  assert.ok(
    document.activeElement === oldest,
    "date navigation keeps focus on its date button",
  );
  assert.equal(oldest.getAttribute("aria-current"), "true");
  assert.ok(page.getByText("Earliest saved version"));
  assert.equal(page.queryByRole("checkbox", { name: "Show changes" }), null);
});

test("a pending restore keeps its date and focus, and a late completion cannot close another document", async () => {
  respond();
  const read = globalThis.fetch;
  let finish!: (response: Response) => void;
  const writes: string[] = [];
  globalThis.fetch = async (input, init) =>
    init?.method === "POST"
      ? (writes.push(String(input)),
        new Promise<Response>((resolve) => {
          finish = resolve;
        }))
      : read(input, init);
  let restored = 0;
  const page = render(
    <VersionHistory
      {...props}
      onRestore={() => {
        restored++;
      }}
    />,
  );
  await waitFor(() => assert.ok(page.container.querySelector(".cm-content")));
  const button = page.getByRole("button", { name: "Restore this version" });
  act(() => button.focus());
  fireEvent.click(button);
  fireEvent.click(page.container.querySelector('[data-version-id="old"]')!);
  fireEvent.click(button);
  assert.equal(button.getAttribute("aria-disabled"), "true");
  assert.ok(
    document.activeElement === button,
    "pending work never disables the focused button",
  );
  assert.deepEqual(writes, [endpoint("/versions/new/restore")]);
  await act(async () =>
    finish(Response.json({ error: "Storage unavailable" }, { status: 503 })),
  );
  assert.ok(
    page.getByRole("alert").textContent?.includes("Storage unavailable"),
  );
  assert.equal(
    page.container
      .querySelector('[data-version-id="new"]')
      ?.getAttribute("aria-current"),
    "true",
  );
  fireEvent.click(button);
  page.unmount();
  await act(async () => finish(Response.json({ ok: true })));
  assert.equal(
    restored,
    0,
    "an old restore completion never acts on a later document",
  );
});

test("comment records stay hidden while literal syntax examples survive historical comparisons", async () => {
  const example = "`[[comment(ana): literal example]]`";
  const content = `Visible words. [[comment(ana): new private comment]]\n\n${example}`;
  const original = `Visible words. [[comment(ilya): old private comment]]\n\n${example}`;
  const page = render(
    <div className="history-preview-scroll">
      <HistoryPreview
        documentId="fixture"
        path="fixture.md"
        content={content}
        original={original}
      />
    </div>,
  );
  const source = view(page.container).state.doc.toString();
  assert.ok(
    source.includes(example),
    "literal code examples are readable history text",
  );
  assert.ok(
    !source.includes("private comment"),
    "hidden comment metadata never becomes deleted prose",
  );
  assert.equal(page.container.querySelector(".cm-deletedText"), null);
});

test("long historical documents remain virtualized and retain the complete selected source", async () => {
  const original = Array.from(
    { length: 5000 },
    (_, n) =>
      `Paragraph ${n} has a sentence with some words for this long document.\n`,
  ).join("\n");
  const content = original.replace(
    "Paragraph 4000 has a sentence",
    "Paragraph 4000 has a revised sentence",
  );
  const page = render(
    <div className="history-preview-scroll">
      <HistoryPreview
        documentId="fixture"
        path="fixture.md"
        content={content}
        original={original}
      />
    </div>,
  );
  await waitFor(() =>
    assert.ok(page.container.querySelector(".cm-changedText")),
  );
  assert.ok(
    view(page.container).state.doc.toString() === content,
    "the preview retains the complete snapshot",
  );
  assert.ok(
    page.container.querySelectorAll(".cm-line").length < 200,
    "only the visible history lines are rendered",
  );
});
