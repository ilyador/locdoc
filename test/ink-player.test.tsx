import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { JSDOM } from "jsdom";
import React from "react";
import * as Y from "yjs";
import type { InkRequest, InkResult } from "../src/ink-runtime";

let dom: JSDOM;
let render: typeof import("@testing-library/react").render;
let act: typeof import("@testing-library/react").act;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let cleanup: typeof import("@testing-library/react").cleanup;
let InkPlayer: typeof import("../src/ink-player").InkPlayer;
const workers: FakeWorker[] = [];
class FakeWorker {
  onmessage: ((event: { data: InkResult }) => void) | null = null;
  onerror: (() => void) | null = null;
  messages: InkRequest[] = [];
  terminated = false;
  constructor() {
    workers.push(this);
  }
  postMessage(message: InkRequest) {
    this.messages.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  reply(text: string, choices = ["Continue"]) {
    this.onmessage?.({
      data: { turns: [{ text }], choices, messages: [], history: [] },
    });
  }
}
before(async () => {
  dom = new JSDOM("<html><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  for (const key of [
    "window",
    "document",
    "navigator",
    "location",
    "localStorage",
    "HTMLElement",
    "Node",
  ])
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: dom.window[key],
    });
  globalThis.Worker = FakeWorker as any;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  ({ render, act, fireEvent, cleanup } =
    await import("@testing-library/react"));
  ({ InkPlayer } = await import("../src/ink-player"));
});
afterEach(() => {
  cleanup();
  workers.length = 0;
});
after(() => dom.window.close());

test("renaming a story invalidates the previous preview even when source is unchanged", async () => {
  const doc = new Y.Doc();
  const text = doc.getText("content");
  text.insert(0, "Hello");
  const view = (path: string) => (
    <InkPlayer
      text={text}
      path={path}
      entries={[]}
      accessQuery=""
      onClose={() => {}}
    />
  );
  const page = render(view("First/story.ink"));
  await act(async () => {
    await delay(450);
  });
  act(() => workers[0].reply("Old location"));
  page.rerender(view("Second/story.ink"));
  assert.equal(
    page
      .getByRole("button", { name: "Continue" })
      .getAttribute("aria-disabled"),
    "true",
  );
  act(() => workers[0].reply("Late old location"));
  assert.ok(!page.queryByText("Late old location"));
  await act(async () => {
    await delay(450);
  });
  const request = workers[1].messages[0];
  assert.equal(request.type === "compile" && request.path, "Second/story.ink");
  act(() => workers[1].reply("New location"));
  assert.ok(page.queryByText("New location"));
  page.unmount();
  doc.destroy();
});

test("typing invalidates choices immediately and ignores an older worker's reply", async () => {
  const doc = new Y.Doc();
  const text = doc.getText("content");
  text.insert(0, "Old story");
  const page = render(
    <InkPlayer
      text={text}
      path="story.ink"
      entries={[]}
      accessQuery=""
      onClose={() => {}}
    />,
  );
  await act(async () => {
    await delay(450);
  });
  const first = workers[0];
  act(() => first.reply("Old output"));
  const choice = page.getByRole("button", { name: "Continue" });
  act(() => text.insert(0, "New "));
  assert.equal(choice.getAttribute("aria-disabled"), "true");
  fireEvent.click(choice);
  assert.equal(
    first.messages.length,
    1,
    "a stale choice never reaches the runtime",
  );
  assert.ok(first.terminated);
  act(() => first.reply("Obsolete output"));
  assert.ok(!page.queryByText("Obsolete output"));
  await act(async () => {
    await delay(450);
  });
  act(() => workers[1].reply('<img src="x">'));
  assert.ok(page.queryByText('<img src="x">'), "output is literal text");
  assert.equal(page.container.querySelectorAll("img").length, 0);
  fireEvent.click(page.getByRole("button", { name: "Continue" }));
  fireEvent.click(page.getByRole("button", { name: "Continue" }));
  assert.equal(
    workers[1].messages.length,
    2,
    "double clicks advance only once",
  );
  page.unmount();
  assert.ok(workers[1].terminated, "closing stops execution");
  doc.destroy();
});

test("restart discards the old worker and compile failures can be retried", async () => {
  const doc = new Y.Doc();
  const text = doc.getText("content");
  text.insert(0, "Hello");
  const page = render(
    <InkPlayer
      text={text}
      path="story.ink"
      entries={[]}
      accessQuery=""
      onClose={() => {}}
    />,
  );
  await act(async () => {
    await delay(450);
  });
  act(() => workers[0].onerror?.());
  assert.ok(page.getByText(/preview stopped/));
  fireEvent.click(page.getByRole("button", { name: "Restart story" }));
  assert.ok(workers[0].terminated);
  await act(async () => {
    await delay(450);
  });
  const request = workers[1].messages[0];
  assert.equal(request.type, "compile");
  assert.deepEqual(request.type === "compile" ? request.history : null, []);
  act(() => workers[1].reply("Hello again", []));
  assert.ok(page.queryByText("End of story"));
  assert.ok(!page.queryByText(/preview stopped/));
  page.unmount();
  doc.destroy();
});

test("keyboard choices move to the new passage, while recompiles keep the writer's focus", async () => {
  const doc = new Y.Doc();
  const text = doc.getText("content");
  text.insert(0, "Hello");
  const page = render(
    <>
      <input aria-label="Writing" />
      <InkPlayer
        text={text}
        path="story.ink"
        entries={[]}
        accessQuery=""
        onClose={() => {}}
      />
    </>,
  );
  await act(async () => {
    await delay(450);
  });
  act(() => workers[0].reply("Hello"));
  const choice = page.getByRole("button", { name: "Continue" });
  choice.focus();
  fireEvent.click(choice);
  act(() =>
    workers[0].onmessage?.({
      data: {
        turns: [
          { text: "Hello" },
          { text: "Continue", choice: true },
          { text: "A new room." },
        ],
        choices: ["Open the window"],
        messages: [],
        history: ["Continue"],
      },
    }),
  );
  assert.ok(
    document.activeElement === page.getByText("A new room."),
    "the new passage receives keyboard focus",
  );
  const writing = page.getByRole("textbox", { name: "Writing" });
  writing.focus();
  act(() => text.insert(0, "Changed "));
  await act(async () => {
    await delay(450);
  });
  act(() => workers[1].reply("Updated passage"));
  assert.ok(
    document.activeElement === writing,
    "live preview never steals the writer's focus",
  );
  const nextChoice = page.getByRole("button", { name: "Continue" });
  nextChoice.focus();
  fireEvent.click(nextChoice);
  writing.focus();
  act(() => workers[1].reply("Another passage"));
  assert.ok(
    document.activeElement === writing,
    "a delayed choice response cannot take back focus",
  );
  page.unmount();
  doc.destroy();
});
