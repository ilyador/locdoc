import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React from "react";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { useComments } from "../src/use-comments";
import { sourceComments } from "../src/comment-syntax";
import { EditorView } from "@codemirror/view";

let dom: JSDOM;
let originalFetch: typeof fetch;
let renderHook: any,
  render: any,
  fireEvent: any,
  act: any,
  waitFor: any,
  cleanup: any;
const endpoint = (suffix: string) => `/api/docs/fixture${suffix}`;
const thread = {
  id: "one",
  name: "alex",
  body: "Original comment",
  guest: "fixture",
  quote: "Visible text.",
  anchor: null,
  created: 0,
  resolved: false,
  replies: [],
};
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

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
    "history",
    "localStorage",
    "navigator",
    "Node",
    "Element",
    "HTMLElement",
    "HTMLVideoElement",
    "MutationObserver",
    "DOMRect",
  ]) {
    Object.defineProperty(globalThis, key, {
      value: (dom.window as any)[key],
      configurable: true,
      writable: true,
    });
  }
  Object.defineProperty(globalThis, "getComputedStyle", {
    value: dom.window.getComputedStyle.bind(dom.window),
    configurable: true,
  });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    value: dom.window.requestAnimationFrame.bind(dom.window),
    configurable: true,
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    value: dom.window.cancelAnimationFrame.bind(dom.window),
    configurable: true,
  });
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  dom.window.Range.prototype.getClientRects = () => [] as any;
  dom.window.Range.prototype.getBoundingClientRect = () =>
    new dom.window.DOMRect();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  ({ renderHook, render, fireEvent, act, waitFor, cleanup } =
    await import("@testing-library/react"));
  originalFetch = globalThis.fetch;
});

test("a downgraded viewer cannot undo an earlier edit through the keyboard", async () => {
  const { MarkdownEditor } = await import("../src/editor");
  const ydoc = new Y.Doc();
  ydoc.getText("content").insert(0, "Original text");
  const awareness = new Awareness(ydoc);
  const ref = React.createRef<any>();
  const props = {
    ydoc,
    provider: { awareness } as any,
    id: "fixture",
    onChange() {},
    onComment() {},
    onUpload() {},
  };
  const page = render(<MarkdownEditor {...props} editable={true} ref={ref} />);
  try {
    act(() => ref.current.insert("Local edit. "));
    const before = ydoc.getText("content").toString();
    assert.equal(before, "Local edit. Original text");
    page.rerender(<MarkdownEditor {...props} editable={false} ref={ref} />);
    fireEvent.keyDown(page.getByRole("textbox"), {
      key: "z",
      code: "KeyZ",
      ctrlKey: true,
    });
    assert.equal(
      ydoc.getText("content").toString(),
      before,
      "Changing to view-only must disable undo as well as direct input",
    );
  } finally {
    page.unmount();
    awareness.destroy();
    ydoc.destroy();
  }
});

test("native history undo and redo respect permission changes without breaking editable history", async () => {
  const { MarkdownEditor } = await import("../src/editor");
  const ydoc = new Y.Doc();
  ydoc.getText("content").insert(0, "Original text");
  const awareness = new Awareness(ydoc);
  const ref = React.createRef<any>();
  const props = {
    ydoc,
    provider: { awareness } as any,
    id: "fixture",
    onChange() {},
    onComment() {},
    onUpload() {},
  };
  const page = render(<MarkdownEditor {...props} editable={true} ref={ref} />);
  const history = (inputType: "historyUndo" | "historyRedo") =>
    fireEvent(
      page.getByRole("textbox"),
      new dom.window.InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType,
      }),
    );
  try {
    act(() => ref.current.insert("Local edit. "));
    history("historyUndo");
    assert.equal(ydoc.getText("content").toString(), "Original text");
    page.rerender(<MarkdownEditor {...props} editable={false} ref={ref} />);
    history("historyRedo");
    assert.equal(
      ydoc.getText("content").toString(),
      "Original text",
      "Native redo must not bypass view-only permission",
    );
    page.rerender(<MarkdownEditor {...props} editable={true} ref={ref} />);
    history("historyRedo");
    assert.equal(
      ydoc.getText("content").toString(),
      "Local edit. Original text",
    );
    page.rerender(<MarkdownEditor {...props} editable={false} ref={ref} />);
    history("historyUndo");
    assert.equal(
      ydoc.getText("content").toString(),
      "Local edit. Original text",
      "Native undo must not bypass view-only permission",
    );
  } finally {
    page.unmount();
    awareness.destroy();
    ydoc.destroy();
  }
});

test("joining visible paragraphs does not erase the hidden conversation between them", async () => {
  const { MarkdownEditor } = await import("../src/editor");
  const ydoc = new Y.Doc();
  const source =
    "First paragraph.\n[[comment(alex): Keep this discussion]]\n\nSecond paragraph.";
  const text = ydoc.getText("content");
  text.insert(0, source);
  const awareness = new Awareness(ydoc);
  const ref = React.createRef<any>();
  const page = render(
    <MarkdownEditor
      ydoc={ydoc}
      provider={{ awareness } as any}
      id="fixture"
      editable={true}
      ref={ref}
      onChange={() => {}}
      onComment={() => {}}
      onUpload={() => {}}
    />,
  );
  try {
    const caret = Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(text, source.indexOf("Second")),
    );
    act(() => ref.current.locate({ start: caret, end: caret }));
    const editor = page.getByRole("textbox");
    fireEvent.keyDown(editor, { key: "Backspace", code: "Backspace" });
    fireEvent.keyDown(editor, { key: "Backspace", code: "Backspace" });
    assert.ok(
      text.toString().includes("[[comment(alex): Keep this discussion]]"),
      "Backspacing across an invisible annotation must not silently remove it",
    );
  } finally {
    page.unmount();
    awareness.destroy();
    ydoc.destroy();
  }
});

async function withEditor(
  source: string,
  run: (fixture: {
    text: Y.Text;
    page: any;
    handle: any;
    view: EditorView;
    locate: (from: number, to?: number) => void;
  }) => Promise<void> | void,
) {
  const { MarkdownEditor } = await import("../src/editor");
  const ydoc = new Y.Doc();
  const text = ydoc.getText("content");
  text.insert(0, source);
  const awareness = new Awareness(ydoc);
  const ref = React.createRef<any>();
  const page = render(
    <MarkdownEditor
      ydoc={ydoc}
      provider={{ awareness } as any}
      id="fixture"
      editable={true}
      ref={ref}
      onChange={() => {}}
      onComment={() => {}}
      onUpload={() => {}}
    />,
  );
  const locate = (from: number, to = from) =>
    act(() =>
      ref.current.locate({
        start: Y.relativePositionToJSON(
          Y.createRelativePositionFromTypeIndex(text, from),
        ),
        end: Y.relativePositionToJSON(
          Y.createRelativePositionFromTypeIndex(text, to),
        ),
      }),
    );
  try {
    await run({
      text,
      page,
      handle: ref.current,
      view: EditorView.findFromDOM(page.getByRole("textbox"))!,
      locate,
    });
  } finally {
    page.unmount();
    awareness.destroy();
    ydoc.destroy();
  }
}

test("forward and word deletion keep hidden conversations intact", async () => {
  const marker = "[[comment(alex): Keep this discussion]]";
  const source = `First paragraph.\n${marker}\n\nSecond paragraph.`;
  for (const scenario of [
    { key: "Delete", code: "Delete", from: "First paragraph.".length },
    {
      key: "Backspace",
      code: "Backspace",
      ctrlKey: true,
      from: source.indexOf("Second"),
    },
    {
      key: "Delete",
      code: "Delete",
      ctrlKey: true,
      from: "First paragraph.".length,
    },
  ]) {
    await withEditor(source, ({ text, page, locate }) => {
      locate(scenario.from);
      for (let n = 0; n < 3; n++)
        fireEvent.keyDown(page.getByRole("textbox"), scenario);
      assert.ok(text.toString().includes(marker), JSON.stringify(scenario));
    });
  }
});

test("native input deletion transactions protect collapsed cursors but respect explicit range deletion", async () => {
  const marker = "[[comment(alex): Keep this discussion]]";
  const source = `First paragraph.\n${marker}\n\nSecond paragraph.`;
  await withEditor(source, ({ text, view, locate }) => {
    const from = source.indexOf(marker);
    const to = from + marker.length + 1;
    locate(to);
    // CodeMirror's DOM observer annotates native/mobile edits as input changes.
    // Test that public transaction path as well as desktop key commands.
    act(() =>
      view.dispatch({
        changes: { from, to },
        userEvent: "input.delete",
      }),
    );
    assert.ok(text.toString().includes(marker));
    locate(0, text.length);
    act(() =>
      view.dispatch({
        changes: { from: 0, to: text.length },
        userEvent: "input.delete",
      }),
    );
    assert.equal(
      text.toString(),
      "",
      "Selecting all deliberately deletes the associated records",
    );
  });
});

test("typing a backslash at an inline hidden record boundary keeps it a conversation", async () => {
  const marker = "[[comment(alex): Keep this discussion]]";
  const source = `First paragraph.${marker} More text.`;
  await withEditor(source, ({ text, view, locate }) => {
    const from = source.indexOf(marker);
    locate(from);
    act(() =>
      view.dispatch({
        changes: { from, insert: "\\" },
        userEvent: "input.type",
      }),
    );
    assert.equal(
      sourceComments(text.toString()).length,
      1,
      "Typing visible prose must not escape an invisible record into literal Markdown",
    );
  });
});

test("inline-code formatting preserves hidden conversation syntax and CRDT marker identity", async () => {
  const marker = "[[comment(alex): Keep this discussion]]";
  const source = `Alpha${marker} omega`;
  await withEditor(source, ({ text, handle, locate }) => {
    const before = Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(text, source.indexOf(marker)),
    );
    locate(0, text.length);
    act(() => handle.wrap("`", "`"));
    assert.equal(text.toString(), `\`Alpha\`${marker}\` omega\``);
    assert.equal(sourceComments(text.toString()).length, 1);
    const after = Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(
        text,
        text.toString().indexOf(marker),
      ),
    );
    assert.deepEqual(
      after.item,
      before.item,
      "Formatting must retain the existing thread's stable CRDT identity",
    );
  });
});

test("formatting an empty selection leaves the cursor between its opening and closing markers", async () => {
  await withEditor("Alpha omega", ({ text, handle, locate, view }) => {
    locate(6);
    act(() => handle.wrap("**", "**"));
    assert.equal(text.toString(), "Alpha ****omega");
    assert.equal(view.state.selection.main.anchor, 8);
    assert.equal(view.state.selection.main.head, 8);
    act(() => handle.insert("bold"));
    assert.equal(text.toString(), "Alpha **bold**omega");
  });
});

test("formatting an ordinary selection preserves its text, selection and original CRDT items", async () => {
  await withEditor("Alpha omega", ({ text, handle, locate, view }) => {
    const before = Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(text, 0),
    );
    locate(0, 5);
    act(() => handle.wrap("**", "**"));
    assert.equal(text.toString(), "**Alpha** omega");
    assert.equal(
      view.state.sliceDoc(
        view.state.selection.main.from,
        view.state.selection.main.to,
      ),
      "Alpha",
    );
    const after = Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(text, 2),
    );
    assert.deepEqual(after.item, before.item);
  });
});

test("todo formatting retains hidden conversation identities while changing only list prefixes", async () => {
  const marker = "[[comment(alex): Keep this discussion]]";
  const source = `Alpha${marker} omega`;
  await withEditor(source, ({ text, handle, locate }) => {
    const before = Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(text, source.indexOf(marker)),
    );
    locate(0, text.length);
    act(() => handle.toggleTasks());
    assert.equal(text.toString(), `- [ ] ${source}`);
    assert.equal(sourceComments(text.toString()).length, 1);
    const after = Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(
        text,
        text.toString().indexOf(marker),
      ),
    );
    assert.deepEqual(
      after.item,
      before.item,
      "Todo formatting must not recreate the stable conversation marker",
    );
  });
});

test("link formatting keeps hidden records out of the link label and retains their identities", async () => {
  const marker = "[[comment(alex): Keep this discussion]]";
  const source = `Alpha${marker} omega`;
  await withEditor(source, ({ text, handle, locate }) => {
    const before = Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(text, source.indexOf(marker)),
    );
    locate(0, text.length);
    const selection = handle.selection();
    act(() =>
      handle.insertLink(
        "https://example.com/",
        selection.quote,
        selection.anchor,
      ),
    );
    const threads = sourceComments(text.toString());
    assert.equal(
      threads.length,
      1,
      "Link labels must not escape and expose invisible comment syntax",
    );
    const after = Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(text, threads[0].from),
    );
    assert.deepEqual(after.item, before.item);
  });
});

test("inline-code formatting cannot capture a hidden conversation when visible text contains backticks", async () => {
  const marker = "[[comment(alex): Keep this discussion]]";
  for (const prefix of ["Alpha ` code", "Alpha `", "`Alpha", "Alpha ``"]) {
    const source = `${prefix}${marker} omega`;
    assert.equal(sourceComments(source).length, 1);
    await withEditor(source, ({ text, handle, locate }) => {
      locate(0, text.length);
      act(() => handle.wrap("`", "`"));
      assert.equal(
        sourceComments(text.toString()).length,
        1,
        `Choose safe code delimiters so literal backticks cannot swallow a record: ${JSON.stringify(prefix)}`,
      );
    });
  }
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
after(() => dom.window.close());

test("a successful comment write is not held hostage by a stalled metadata read", async () => {
  let holdRead = false;
  let readStarted = false;
  let finishRead: (() => void) | undefined;
  globalThis.fetch = async (_input, init = {}) => {
    if (init.method === "POST") return response(thread);
    if (holdRead) {
      readStarted = true;
      await new Promise<void>((resolve) => (finishRead = resolve));
    }
    return response({ comments: [thread] });
  };
  const hook = renderHook(() =>
    useComments(
      endpoint,
      true,
      "Visible text.\n[[comment(alex): Original comment]]",
    ),
  );
  await waitFor(() => assert.equal(hook.result.current.comments.length, 1));
  holdRead = true;
  let settled = false;
  let mutation: Promise<unknown> | undefined;
  act(() => {
    mutation = hook.result.current
      .mutate("", { body: "Posted successfully", name: "ana" })
      .then(() => {
        settled = true;
      });
  });
  try {
    await waitFor(() => assert.ok(readStarted));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      settled,
      true,
      "A successful POST must release its form even when the follow-up GET stalls",
    );
  } finally {
    finishRead?.();
    await act(async () => mutation);
  }
});

test("deleting the last raw-file comment retries a failed metadata refresh", async () => {
  let deleted = false;
  let failed = false;
  let readsAfterDelete = 0;
  globalThis.fetch = async () => {
    if (!deleted) return response({ comments: [thread] });
    readsAfterDelete++;
    if (!failed) {
      failed = true;
      return response({ error: "Transient outage" }, 503);
    }
    return response({ comments: [] });
  };
  const hook = renderHook(
    ({ source }: { source: string }) => useComments(endpoint, true, source),
    {
      initialProps: {
        source: "Visible text.\n[[comment(alex): Original comment]]",
      },
    },
  );
  await waitFor(() => assert.equal(hook.result.current.comments.length, 1));
  deleted = true;
  hook.rerender({ source: "Visible text." });
  await waitFor(() => assert.ok(failed));
  await waitFor(
    () => {
      assert.ok(
        readsAfterDelete >= 2,
        "A failed refresh must retry even with no source comments left",
      );
      assert.equal(hook.result.current.comments.length, 0);
    },
    { timeout: 2600 },
  );
});

test("the comments poll names the threads it holds, and a 304 keeps them as they are", async () => {
  const held: (string | null)[] = [];
  let current = { tag: 'W/"one"', comments: [thread] };
  globalThis.fetch = async (_input, init = {}) => {
    const named = new Headers(init.headers).get("If-None-Match");
    held.push(named);
    if (named === current.tag)
      return new Response(null, {
        status: 304,
        headers: { etag: current.tag },
      });
    return new Response(JSON.stringify({ comments: current.comments }), {
      headers: { "content-type": "application/json", etag: current.tag },
    });
  };
  const hook = renderHook(() =>
    useComments(
      endpoint,
      true,
      "Visible text.\n[[comment(alex): Original comment]]",
    ),
  );
  await waitFor(() => assert.equal(hook.result.current.comments.length, 1));
  assert.equal(held[0], null, "the first read names no tag");
  const shown = hook.result.current.comments;
  // A tab coming back into view reads the threads again, as the poll does.
  const read = async () => {
    const count = held.length;
    await act(async () => {
      document.dispatchEvent(new window.Event("visibilitychange"));
    });
    await waitFor(() => assert.equal(held.length, count + 1));
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
  };
  await read();
  assert.equal(
    held.at(-1),
    'W/"one"',
    "the next read names the threads it holds",
  );
  assert.ok(
    hook.result.current.comments === shown,
    "a 304 keeps the threads it confirms, without a render",
  );
  current = {
    tag: 'W/"two"',
    comments: [thread, { ...thread, id: "two", body: "Another thread" }],
  };
  await read();
  assert.equal(
    hook.result.current.comments.length,
    2,
    "a changed list comes whole",
  );
  await read();
  assert.equal(held.at(-1), 'W/"two"', "and is asked for again by its own tag");
  assert.equal(hook.result.current.comments.length, 2);
});
