import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";
import React, { useState } from "react";
import * as Y from "yjs";
import { EditorView } from "@codemirror/view";
import { countMarkdownWords } from "../src/word-count";
import { sourceComments } from "../src/comment-syntax";
import { documentFormat } from "../src/document-format";
import { readFileSync } from "node:fs";
import { NamePrompt } from "../src/name-prompt";
import {
  createEncoder,
  writeVarUint,
  writeVarString,
  writeVarUint8Array,
  toUint8Array,
} from "lib0/encoding";

let render, renderHook, act, fireEvent, screen, waitFor, cleanup;
let WorkspaceView,
  useFileActions,
  VersionHistory,
  CommentThread,
  CommentComposer,
  RenameDocument,
  useAppearance,
  useWorkspace;
let originalFetch, dom;
const sockets: any[] = [];
const requests: { path: string; body: any }[] = [];
const held = new Map<string, () => void>();
let delayShare = false,
  delayComment = false,
  failReply = false,
  failBootstrap = false,
  failCreate = false,
  secondComment = false;
let docs;
const response = (body) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
const makeDoc = (id: string) => {
  const ydoc = new Y.Doc();
  ydoc.getText("content").insert(0, `${id} text`);
  return {
    id,
    path: `${id}.md`,
    owner: true,
    edit: true,
    permission: "edit",
    shareUrl: `http://localhost/s/${id}`,
    usage: 0,
    content: `${id} text`,
    modified: 0,
    state: Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString("base64"),
  };
};
const comment = {
  id: "c1",
  name: "Reviewer",
  body: "Existing comment",
  guest: "test",
  quote: null,
  anchor: null,
  created: 0,
  resolved: false,
  replies: [],
};

before(async () => {
  dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
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
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ]) {
    Object.defineProperty(globalThis, key, {
      value:
        typeof dom.window[key] === "function" &&
        [
          "getComputedStyle",
          "requestAnimationFrame",
          "cancelAnimationFrame",
        ].includes(key)
          ? dom.window[key].bind(dom.window)
          : dom.window[key],
      configurable: true,
      writable: true,
    });
  }
  window.matchMedia = () =>
    ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }) as any;
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  window.Range.prototype.getClientRects = () => [] as any;
  window.Range.prototype.getBoundingClientRect = () => new window.DOMRect();
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    unobserve() {}
    disconnect() {}
  } as any;
  globalThis.WebSocket = class {
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = 0;
    constructor() {
      sockets.push(this);
    }
    send() {}
    close() {
      this.readyState = 3;
      this.onclose?.({});
    }
    onclose;
  } as any;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  ({ render, renderHook, act, fireEvent, screen, waitFor, cleanup } =
    await import("@testing-library/react"));
  ({ WorkspaceView } = await import("../src/app.tsx"));
  ({ useFileActions } = await import("../src/file-actions.ts"));
  ({ VersionHistory } = await import("../src/version-history.tsx"));
  ({ CommentThread, CommentComposer } = await import("../src/comments.tsx"));
  ({ RenameDocument } = await import("../src/rename-document.tsx"));
  ({ useAppearance } = await import("../src/appearance.tsx"));
  ({ useWorkspace } = await import("../src/workspace.ts"));
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const path = new URL(String(input), location.href).pathname;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, body });
    if (path === "/api/fonts" || path === "/font-catalog.json")
      return response({ fonts: [] });
    if (path === "/api/mcp/connections") return response({ connections: [] });
    if (failBootstrap && path === "/api/config")
      return new Response(JSON.stringify({ error: "Config unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    if (/^\/api\/docs\/[ab]$/.test(path))
      return response(docs[path.split("/").pop()!]);
    if (path.endsWith("/share")) {
      const id = path.split("/")[3];
      const result = {
        permission: body.permission,
        shareUrl:
          body.permission === "private" ? null : `http://localhost/s/${id}`,
      };
      Object.assign(docs[id], result);
      if (delayShare)
        await new Promise<void>((resolve) => held.set("share", resolve));
      return response(result);
    }
    if (path.endsWith("/comments")) {
      if (init.method === "POST") {
        if (delayComment)
          await new Promise<void>((resolve) => held.set("comment", resolve));
        return response({ ...comment, body: body.body });
      }
      return response({
        comments: secondComment
          ? [comment, { ...comment, id: "c2", body: "Second comment" }]
          : [comment],
      });
    }
    if (path.endsWith("/versions"))
      return response({
        versions: [
          { id: "old", created: 1, bytes: 3 },
          { id: "new", created: 2, bytes: 3 },
        ],
      });
    if (path.includes("/versions/")) {
      const id = path.split("/").pop();
      if (id === "old")
        await new Promise<void>((resolve) => held.set("old", resolve));
      return response({
        content: id === "old" ? "OLD CONTENT" : "NEW CONTENT",
      });
    }
    if (path === "/api/files" && failCreate)
      return new Response(JSON.stringify({ error: "Disk full" }), {
        status: 507,
      });
    if (path.endsWith("/comments/c1"))
      return failReply
        ? new Response(JSON.stringify({ error: "Outage" }), { status: 503 })
        : response(comment);
    return response({});
  };
});
afterEach(() => {
  cleanup();
  sockets.length = 0;
  requests.length = 0;
  held.clear();
  delayShare =
    delayComment =
    failReply =
    failBootstrap =
    failCreate =
    secondComment =
      false;
});
after(() => {
  globalThis.fetch = originalFetch;
  dom.window.close();
});

function WorkspaceFixture() {
  const appearance = useAppearance();
  const [id, setId] = useState("a");
  const entries = Object.values(docs).map((doc: any) => ({
    path: doc.path,
    id: doc.id,
    kind: "file",
    shared: true,
  }));
  const navigate = async (from, next, prepare) => {
    await prepare();
    setId((current) => (current === from ? next : current));
    return true;
  };
  const files = useFileActions({
    owner: true,
    root: "/tmp/fixture",
    entries,
    patchEntries() {},
    async loadTree() {},
    currentId: () => id,
    navigate,
    setExpanded() {},
    view: "date",
    setView() {},
    setQuery() {},
    setSidebar() {},
  });
  return (
    <WorkspaceView
      workspace={
        {
          appearance,
          id,
          navigate,
          files,
          config: {
            owner: true,
            guest: "test",
            root: "/tmp/fixture",
            publicUrl: "http://localhost",
          },
          entries,
          initialDocument: null,
          error: "",
          name: "Reviewer",
          async saveName(name: string) {
            return name;
          },
          sidebar: true,
          setSidebar() {},
          sidebarWidth: null,
          setSidebarWidth() {},
          query: "",
          setQuery() {},
          expanded: new Set(),
          setExpanded() {},
          sidebarView: "date",
          setSidebarView() {},
          async loadTree() {},
        } as any
      }
    />
  );
}
async function openWorkspace() {
  docs = { a: makeDoc("a"), b: makeDoc("b") };
  render(<WorkspaceFixture />);
  await screen.findByRole("textbox", { name: "Markdown document" });
}

test("the visible footer delays remote save progress but immediately shows completion and recovery", async () => {
  await openWorkspace();
  const socket = sockets.at(-1);
  assert.ok(socket, "a document socket must exist");
  const receive = (
    encode: (encoder: ReturnType<typeof createEncoder>) => void,
  ) => {
    const encoder = createEncoder();
    encode(encoder);
    socket.onmessage({ data: toUint8Array(encoder) });
  };
  const status = (value: string) =>
    receive((encoder) => {
      writeVarUint(encoder, 121);
      writeVarString(encoder, value);
    });
  await act(async () => {
    socket.readyState = 1;
    socket.onopen();
    receive((encoder) => {
      writeVarUint(encoder, 0);
      writeVarUint(encoder, 1);
      writeVarUint8Array(encoder, Buffer.from(docs.a.state, "base64"));
    });
    status("0");
  });
  const footer = document.querySelector(".document-status")!;
  await waitFor(() => assert.equal(footer.textContent, "Saved to disk"), {
    timeout: 3500,
  });
  for (let n = 0; n < 24; n++) {
    await act(async () => {
      status("2");
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    assert.equal(footer.textContent, "Saved to disk");
    await act(async () => {
      status("0");
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    assert.equal(footer.textContent, "Saved to disk");
  }
  await act(async () => status("2"));
  await waitFor(() => assert.equal(footer.textContent, "Saving…"), {
    timeout: 3500,
  });
  await act(async () => status("0"));
  assert.equal(footer.textContent, "Saved to disk");
  // Recovery must cancel an already scheduled progress label; a late timer
  // must never hide it or suggest that the document is saving normally.
  await act(async () => status("2"));
  await act(async () => status("3"));
  assert.equal(footer.textContent, "Recovery needed");
  assert.equal(footer.classList.contains("has-warning"), true);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 2100));
  });
  assert.equal(footer.textContent, "Recovery needed");
  assert.equal(
    screen
      .getByRole("textbox", { name: "Markdown document" })
      .getAttribute("contenteditable"),
    "false",
  );
});
async function chooseB() {
  fireEvent.click(screen.getByRole("treeitem", { name: "b .md", exact: true }));
  await waitFor(() => assert.equal(document.title, "b · locdoc"));
  await waitFor(() =>
    assert.ok(
      screen
        .getByRole("textbox", { name: "Markdown document" })
        .textContent.includes("b text"),
    ),
  );
}
test("primary formatting preserves selection and is never duplicated in document options", async () => {
  const { EditorView } = await import("@codemirror/view");
  for (const extension of ["md", "fountain"]) {
    docs = { a: makeDoc("a"), b: makeDoc("b") };
    docs.a.path = `a.${extension}`;
    const page = render(<WorkspaceFixture />);
    try {
      const input = await screen.findByRole("textbox", {
        name: extension === "md" ? "Markdown document" : "Fountain screenplay",
      });
      const view = EditorView.findFromDOM(input)!;
      await waitFor(() => assert.equal(view.state.doc.toString(), "a text"));
      act(() => view.dispatch({ selection: { anchor: 0, head: 6 } }));
      fireEvent.click(
        screen.getByRole("button", { name: "Italic", exact: true }),
      );
      await waitFor(() => assert.equal(view.state.doc.toString(), "*a text*"));
      if (extension === "fountain") {
        act(() => view.dispatch({ selection: { anchor: 1, head: 7 } }));
        fireEvent.click(
          screen.getByRole("button", { name: "Underline", exact: true }),
        );
        await waitFor(() =>
          assert.equal(view.state.doc.toString(), "*_a text_*"),
        );
      }
      fireEvent.click(screen.getByRole("button", { name: "Document options" }));
      const dialog = page.container.querySelector("dialog")!;
      await waitFor(() => assert.equal(dialog.open, true));
      assert.equal(
        dialog.querySelectorAll(
          '[aria-label="Bold"], [aria-label="Italic"], [aria-label="Underline"], [data-comment-control]',
        ).length,
        0,
      );
      if (extension === "fountain")
        assert.equal(dialog.querySelectorAll(".formatting-menu").length, 0);
      assert.ok(
        EditorView.findFromDOM(input) === view,
        "Formatting and document options must retain the editor",
      );
    } finally {
      page.unmount();
    }
  }
});
test("overflow-only formatting edits the retained selection and closes document options", async () => {
  const { EditorView } = await import("@codemirror/view");
  await openWorkspace();
  const input = screen.getByRole("textbox", { name: "Markdown document" });
  const view = EditorView.findFromDOM(input)!;
  act(() => view.dispatch({ selection: { anchor: 0, head: 6 } }));
  fireEvent.click(screen.getByRole("button", { name: "Document options" }));
  const dialog = document.querySelector("dialog")!;
  fireEvent.click(dialog.querySelector('[aria-label="Heading"]')!);
  await waitFor(() => assert.equal(view.state.doc.toString(), "## a text"));
  await waitFor(() => assert.equal(dialog.open, false));
  assert.ok(
    EditorView.findFromDOM(input) === view,
    "Overflow must retain the editor",
  );
});
test("appearance adjusts the live document without a modal or replacing its editor", async () => {
  const { EditorView } = await import("@codemirror/view");
  const saved = ["locdoc.writing.markdown", "locdoc.theme"].map((key) => [
    key,
    localStorage.getItem(key),
  ]);
  const oldTheme = document.documentElement.getAttribute("data-theme");
  docs = { a: makeDoc("a"), b: makeDoc("b") };
  const page = render(<WorkspaceFixture />);
  try {
    const input = await screen.findByRole("textbox", {
      name: "Markdown document",
    });
    const view = EditorView.findFromDOM(input)!;
    act(() => view.dispatch({ selection: { anchor: 1, head: 3 } }));
    const trigger = screen.getByRole("button", {
      name: "Fonts and appearance",
      exact: true,
    });
    fireEvent.click(trigger);
    await screen.findByRole("complementary", { name: "Appearance" });
    assert.equal(page.container.querySelector("dialog")?.open, false);
    fireEvent.change(screen.getByLabelText("Document font"), {
      target: { value: "Courier Prime" },
    });
    fireEvent.change(screen.getByRole("slider", { name: "Text size" }), {
      target: { value: "22" },
    });
    // The document's appearance applies to its part of the workspace.
    const app = page.container.querySelector<HTMLElement>(".workspace")!;
    assert.equal(app.style.getPropertyValue("--doc-size"), "22px");
    assert.ok(
      app.style.getPropertyValue("--doc-font").includes("Courier Prime"),
    );
    fireEvent.click(screen.getByRole("tab", { name: "Layout" }));
    fireEvent.change(screen.getByRole("slider", { name: "Line height" }), {
      target: { value: "1.55" },
    });
    assert.equal(app.style.getPropertyValue("--doc-line-height"), "1.55");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Layout" }), {
      key: "ArrowRight",
    });
    assert.equal(
      screen.getByRole("tab", { name: "Theme" }).getAttribute("aria-selected"),
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Dark", exact: true }));
    assert.equal(document.documentElement.dataset.theme, "dark");
    assert.ok(
      EditorView.findFromDOM(input) === view,
      "Live adjustments must retain the editor",
    );
    assert.equal(view.state.doc.toString(), "a text");
    assert.equal(view.state.selection.main.from, 1);
    assert.equal(view.state.selection.main.to, 3);
    fireEvent.click(screen.getByRole("button", { name: "Close appearance" }));
    assert.ok(
      page.container.querySelector(".appearance-panel") === null,
      "Appearance closes without leaving a panel",
    );
    assert.ok(
      document.activeElement === trigger,
      "Closing appearance returns focus to its trigger",
    );
  } finally {
    page.unmount();
    for (const [key, value] of saved)
      value === null
        ? localStorage.removeItem(key!)
        : localStorage.setItem(key!, value!);
    oldTheme === null
      ? document.documentElement.removeAttribute("data-theme")
      : document.documentElement.setAttribute("data-theme", oldTheme);
  }
});
test("workspace settings hand off to nonmodal appearance and other dialogs still open", async () => {
  const { within } = await import("@testing-library/react");
  await openWorkspace();
  fireEvent.click(document.querySelector(".profile")!);
  const settings = screen.getByRole("dialog", { name: "Your workspace" });
  fireEvent.click(
    within(settings).getByRole("button", { name: "Fonts and appearance" }),
  );
  await screen.findByRole("complementary", { name: "Appearance" });
  assert.equal(settings.open, false);
  fireEvent.click(screen.getByRole("button", { name: "Share", exact: true }));
  assert.ok(
    document.querySelector(".appearance-panel") === null,
    "Opening a modal removes the appearance column",
  );
  assert.ok(screen.getByRole("dialog", { name: "Share document" }).open);
});
test("paragraph spacing is adjustable and resettable in each writing profile", async () => {
  const { AppearancePanel } = await import("../src/appearance.tsx");
  const previous = new Map(Object.entries(localStorage));
  function Profile({ format }: { format: "markdown" | "fountain" }) {
    const appearance = useAppearance();
    return (
      <AppearancePanel
        owner
        value={appearance.forFormat(format)}
        onClose={() => {}}
      />
    );
  }
  try {
    localStorage.clear();
    for (const format of ["markdown", "fountain"] as const) {
      const other = format === "markdown" ? "fountain" : "markdown";
      localStorage.setItem(
        `locdoc.writing.${other}`,
        JSON.stringify({ paragraphSpacing: 0.6 }),
      );
      const page = render(<Profile format={format} />);
      try {
        fireEvent.click(page.getByRole("tab", { name: "Layout" }));
        const slider = page.getByRole("slider", { name: "Paragraph spacing" });
        fireEvent.change(slider, { target: { value: "0.4" } });
        assert.equal(slider.value, "0.4");
        assert.equal(
          JSON.parse(localStorage.getItem(`locdoc.writing.${format}`)!)
            .paragraphSpacing,
          0.4,
        );
        assert.equal(
          JSON.parse(localStorage.getItem(`locdoc.writing.${other}`)!)
            .paragraphSpacing,
          0.6,
        );
        const reset = page.getByRole("button", {
          name: "Reset size & spacing",
        });
        assert.equal(reset.disabled, false);
        fireEvent.click(reset);
        assert.equal(slider.value, "0.15");
        assert.equal(reset.disabled, true);
        assert.equal(
          JSON.parse(localStorage.getItem(`locdoc.writing.${other}`)!)
            .paragraphSpacing,
          0.6,
        );
      } finally {
        page.unmount();
      }
    }
  } finally {
    localStorage.clear();
    for (const [key, value] of previous) localStorage.setItem(key, value);
  }
});
test("late sharing response cannot change the next document's permissions", async () => {
  await openWorkspace();
  delayShare = true;
  fireEvent.click(screen.getByRole("button", { name: "Share", exact: true }));
  fireEvent.change(screen.getByLabelText("Link access"), {
    target: { value: "private" },
  });
  await waitFor(() => assert.equal(held.has("share"), true));
  fireEvent.click(screen.getByLabelText("Close dialog"));
  await chooseB();
  held.get("share")!();
  fireEvent.click(screen.getByRole("button", { name: "Share", exact: true }));
  await waitFor(() =>
    assert.equal(screen.getByLabelText("Link access").value, "edit"),
  );
  assert.equal(docs.b.permission, "edit");
});
test("a completed comment from A leaves B's new comment draft intact", async () => {
  await openWorkspace();
  delayComment = true;
  fireEvent.click(screen.getByLabelText("Add comment (Ctrl Alt M)"));
  fireEvent.change(screen.getByLabelText("New comment"), {
    target: { value: "Posted from A" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Post", exact: true }));
  await waitFor(() => assert.equal(held.has("comment"), true));
  await chooseB();
  fireEvent.click(screen.getByLabelText("Add comment (Ctrl Alt M)"));
  fireEvent.change(screen.getByLabelText("New comment"), {
    target: { value: "Unsaved B draft" },
  });
  held.get("comment")!();
  await waitFor(() =>
    assert.equal(screen.getByLabelText("New comment").value, "Unsaved B draft"),
  );
});
test("cancel closes a comment without posting and restores writing focus", async () => {
  await openWorkspace();
  fireEvent.click(screen.getByLabelText("Add comment (Ctrl Alt M)"));
  fireEvent.change(screen.getByLabelText("New comment"), {
    target: { value: "Discard this comment" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Cancel comment" }));
  assert.ok(
    screen.queryByLabelText("New comment") === null,
    "Comment composer should be closed.",
  );
  assert.ok(
    document.activeElement ===
      screen.getByRole("textbox", { name: "Markdown document" }),
    "Focus should return to the editor.",
  );
  assert.equal(
    requests.filter((r) => r.path.endsWith("/comments") && r.body).length,
    0,
  );
  fireEvent.click(screen.getByLabelText("Add comment (Ctrl Alt M)"));
  assert.equal(screen.getByLabelText("New comment").value, "");
});
test("outside clicks collapse a conversation while its controls and scrolling keep it open", async () => {
  await openWorkspace();
  fireEvent.click(await screen.findByRole("button", { name: "Open comment" }));
  const region = screen.getByRole("region", { name: "Comment conversation" });
  fireEvent.click(screen.getByText("Existing comment"));
  fireEvent.click(screen.getByLabelText("Comment actions"));
  assert.ok(region.isConnected);
  const editor = screen.getByRole("textbox", { name: "Markdown document" });
  fireEvent.pointerDown(editor, { pointerType: "touch" });
  fireEvent.wheel(editor);
  assert.ok(region.isConnected, "Scrolling is not an outside click");
  fireEvent.click(editor);
  assert.ok(!screen.queryByRole("region", { name: "Comment conversation" }));
  assert.equal(
    screen.getByLabelText("Toggle comments").getAttribute("aria-expanded"),
    "false",
  );
  fireEvent.click(screen.getByRole("button", { name: "Open comment" }));
  assert.ok(screen.getByRole("region", { name: "Comment conversation" }));
  fireEvent.click(screen.getByRole("button", { name: "Close comment" }));
  assert.ok(!screen.queryByRole("region", { name: "Comment conversation" }));
});
test("a dismissed reply retains its text when its passage is reopened", async () => {
  await openWorkspace();
  fireEvent.click(await screen.findByRole("button", { name: "Open comment" }));
  fireEvent.click(screen.getByRole("button", { name: "Reply", exact: true }));
  fireEvent.change(screen.getByLabelText("Reply to comment"), {
    target: { value: "Keep my unfinished reply" },
  });
  fireEvent.click(screen.getByRole("textbox", { name: "Markdown document" }));
  assert.ok(!screen.queryByLabelText("Reply to comment"));
  fireEvent.click(screen.getByRole("button", { name: "Open comment" }));
  assert.equal(
    screen.getByLabelText("Reply to comment").value,
    "Keep my unfinished reply",
  );
  assert.equal(
    requests.filter((r) => r.path.endsWith("/comments/c1") && r.body).length,
    0,
  );
});
test("a dismissed new comment resumes its original passage and text from either comment control", async () => {
  await openWorkspace();
  fireEvent.click(screen.getByLabelText("Add comment (Ctrl Alt M)"));
  fireEvent.change(screen.getByLabelText("New comment"), {
    target: { value: "Keep my unfinished comment" },
  });
  fireEvent.click(screen.getByRole("textbox", { name: "Markdown document" }));
  assert.ok(!screen.queryByLabelText("New comment"));
  fireEvent.click(screen.getByLabelText("Toggle comments"));
  assert.equal(
    screen.getByLabelText("New comment").value,
    "Keep my unfinished comment",
  );
  fireEvent.click(screen.getByLabelText("Toggle comments"));
  assert.ok(!screen.queryByLabelText("New comment"));
  fireEvent.click(screen.getByLabelText("Add comment (Ctrl Alt M)"));
  assert.equal(
    screen.getByLabelText("New comment").value,
    "Keep my unfinished comment",
  );
  fireEvent.click(screen.getByRole("button", { name: "Post", exact: true }));
  await waitFor(() =>
    assert.ok(screen.queryByRole("button", { name: "Reply", exact: true })),
  );
  const posts = requests.filter((r) => r.path.endsWith("/comments") && r.body);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.body, "Keep my unfinished comment");
  assert.equal(posts[0].body.quote, "a text");
});
test("dismissing an in-flight comment neither reopens it nor allows a duplicate post on resume", async () => {
  await openWorkspace();
  delayComment = true;
  fireEvent.click(screen.getByLabelText("Add comment (Ctrl Alt M)"));
  fireEvent.change(screen.getByLabelText("New comment"), {
    target: { value: "Posting in the background" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Post", exact: true }));
  await waitFor(() => assert.ok(held.has("comment")));
  const editor = screen.getByRole("textbox", { name: "Markdown document" });
  fireEvent.click(editor);
  fireEvent.click(screen.getByLabelText("Add comment (Ctrl Alt M)"));
  assert.ok(screen.getByLabelText("New comment").disabled);
  assert.ok(screen.getByRole("button", { name: "Post", exact: true }).disabled);
  fireEvent.click(editor);
  await act(async () => held.get("comment")!());
  assert.ok(!screen.queryByRole("region", { name: "Comment conversation" }));
  fireEvent.click(screen.getByLabelText("Add comment (Ctrl Alt M)"));
  assert.equal(screen.getByLabelText("New comment").value, "");
  assert.equal(
    requests.filter((r) => r.path.endsWith("/comments") && r.body).length,
    1,
  );
});
test("comment navigation steps through the document's threads in order", async () => {
  secondComment = true;
  await openWorkspace();
  await screen.findAllByRole("button", { name: "Open comment" });
  fireEvent.click(screen.getByLabelText("Toggle comments"));
  assert.ok(screen.getByText("Existing comment"));
  assert.equal(
    screen.getByRole("button", { name: "Previous comment" }).disabled,
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "Next comment" }));
  assert.ok(screen.getByText("Second comment"));
  assert.ok(!screen.queryByText("Existing comment"));
  assert.equal(
    screen.getByRole("button", { name: "Next comment" }).disabled,
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "Previous comment" }));
  assert.ok(screen.getByText("Existing comment"));
});
test("cancel reply clears its draft without changing the posted conversation", () => {
  let cancellations = 0;
  const submitted: string[] = [];
  render(
    <CommentThread
      comment={comment}
      onResolve={() => {}}
      canResolve={false}
      busy={false}
      onCancel={() => cancellations++}
      onReply={async (body) => {
        submitted.push(body);
        return true;
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Reply", exact: true }));
  const input = screen.getByLabelText("Reply to comment");
  fireEvent.change(input, { target: { value: "Discard this reply" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel reply" }));
  assert.ok(
    !screen.queryByLabelText("Reply to comment"),
    "Reply field is collapsed",
  );
  assert.equal(cancellations, 1);
  assert.deepEqual(submitted, []);
  assert.ok(screen.getByText("Existing comment"));
  fireEvent.click(screen.getByRole("button", { name: "Reply", exact: true }));
  assert.equal(screen.getByLabelText("Reply to comment").value, "");
});
test("the latest version selection owns both its preview and restore target", async () => {
  render(
    <VersionHistory
      endpoint={(suffix) => `/api/docs/a${suffix}`}
      documentId="a"
      path="a.md"
      onClose={() => {}}
      onRestore={() => {}}
    />,
  );
  await waitFor(() =>
    assert.ok(document.querySelector('[data-version-id="old"]')),
  );
  fireEvent.click(document.querySelector('[data-version-id="old"]')!);
  await waitFor(() => assert.equal(held.has("old"), true));
  fireEvent.click(document.querySelector('[data-version-id="new"]')!);
  await screen.findByText("NEW CONTENT");
  held.get("old")!();
  await waitFor(() =>
    assert.equal(
      document.querySelector(".version-preview")!.textContent,
      "NEW CONTENT",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Restore this version" }));
  await waitFor(() =>
    assert.ok(
      requests.some(
        (request) => request.path === "/api/docs/a/versions/new/restore",
      ),
    ),
  );
});
test("browsing history preserves the live editor, its draft, caret, scroll and connection", async () => {
  await openWorkspace();
  const content = screen.getByRole("textbox", { name: "Markdown document" });
  const editor = EditorView.findFromDOM(content)!;
  const pane = content.closest(".writing-pane") as HTMLElement;
  const socket = sockets.at(-1);
  act(() =>
    editor.dispatch({
      changes: { from: 1, insert: " pending" },
      selection: { anchor: 9 },
      userEvent: "input.type",
    }),
  );
  pane.scrollTop = 120;
  const source = editor.state.doc.toString();
  const caret = editor.state.selection.main.head;
  fireEvent.click(screen.getByRole("button", { name: "Document options" }));
  fireEvent.click(screen.getByRole("button", { name: "Version history" }));
  await screen.findByRole("region", { name: "Version history" });
  assert.equal(content.closest("main")!.getAttribute("aria-hidden"), "true");
  assert.equal(content.closest("main")!.hasAttribute("inert"), true);
  assert.ok(
    EditorView.findFromDOM(content) === editor,
    "history keeps the live editor mounted",
  );
  assert.ok(
    sockets.at(-1) === socket,
    "historical previews never create a collaboration connection",
  );
  fireEvent.click(screen.getByRole("button", { name: "Back to document" }));
  await screen.findByRole("textbox", { name: "Markdown document" });
  assert.ok(
    EditorView.findFromDOM(content) === editor,
    "returning reuses the original editor",
  );
  assert.equal(editor.state.doc.toString(), source);
  assert.equal(editor.state.selection.main.head, caret);
  assert.equal(pane.scrollTop, 120);
});
test("a failed comment can retry without double-posting or losing its text", async () => {
  const submitted: string[] = [];
  let finish: (success: boolean) => void;
  render(
    <CommentComposer
      onSubmit={(body) => {
        submitted.push(body);
        return new Promise<boolean>((resolve) => (finish = resolve));
      }}
    />,
  );
  const input = screen.getByLabelText("New comment");
  fireEvent.change(input, { target: { value: "Keep this thought" } });
  fireEvent.submit(input.closest("form"));
  fireEvent.submit(input.closest("form"));
  assert.deepEqual(submitted, ["Keep this thought"]);
  assert.equal(
    screen.getByRole("button", { name: "Cancel comment" }).disabled,
    true,
  );
  await act(async () => finish(false));
  assert.equal(input.value, "Keep this thought");
  fireEvent.click(screen.getByRole("button", { name: "Post", exact: true }));
  assert.deepEqual(submitted, ["Keep this thought", "Keep this thought"]);
  await act(async () => finish(true));
  assert.equal(input.value, "");
});
test("an older mutation response cannot erase a newer collaborator reply", async () => {
  const previousFetch = globalThis.fetch;
  let latest = { ...comment, replies: [] as any[] };
  let finish: (() => void) | undefined;
  globalThis.fetch = async (input, init = {}) => {
    const path = new URL(String(input), location.href).pathname;
    if (path.endsWith("/comments/c1") && init.method === "PATCH") {
      const saved = {
        ...comment,
        replies: [{ name: "Reviewer", body: "My reply", created: 0 }],
      };
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return response(saved);
    }
    if (path.endsWith("/comments") && (!init.method || init.method === "GET"))
      return response({ comments: [latest] });
    return previousFetch(input, init);
  };
  try {
    await openWorkspace();
    fireEvent.click(
      await screen.findByRole("button", { name: "Open comment" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reply", exact: true }));
    fireEvent.change(screen.getByLabelText("Reply to comment"), {
      target: { value: "My reply" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Post", exact: true }));
    await waitFor(() => assert.ok(finish));
    latest = {
      ...comment,
      replies: [
        { name: "Reviewer", body: "My reply", created: 0 },
        { name: "Ana", body: "Newer collaborator reply", created: 0 },
      ],
    };
    fireEvent(document, new window.Event("visibilitychange"));
    await screen.findByText("Newer collaborator reply");
    await act(async () => finish!());
    await waitFor(() =>
      assert.ok(screen.queryByRole("button", { name: "Reply", exact: true })),
    );
    assert.ok(
      screen.queryByText("Newer collaborator reply"),
      "An old HTTP reply must not replace the newer conversation snapshot",
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("a failed reply preserves the text for retry", async () => {
  failReply = true;
  render(
    <CommentThread
      comment={comment}
      onResolve={() => {}}
      canResolve={false}
      busy={false}
      onReply={async (body) =>
        (
          await fetch("/api/docs/a/comments/c1", {
            method: "PATCH",
            body: JSON.stringify({ body }),
          })
        ).ok
      }
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Reply", exact: true }));
  fireEvent.change(screen.getByLabelText("Reply to comment"), {
    target: { value: "Keep this reply" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Post", exact: true }));
  await waitFor(() =>
    assert.equal(
      screen.getByLabelText("Reply to comment").value,
      "Keep this reply",
    ),
  );
});
test("an upload rejects oversized media and updates only the document that started it", async () => {
  const { uploadAttachment } = await import("../src/document-upload.ts");
  const previousFetch = globalThis.fetch;
  const uploads: string[] = [];
  globalThis.fetch = async (input) => {
    uploads.push(new URL(String(input), location.href).pathname);
    return response({ path: "media/photo.png", usage: 42 });
  };
  try {
    const ydoc = new Y.Doc();
    ydoc.getText("content").insert(0, "Intro");
    const events: string[] = [];
    let update: ((doc: any) => any) | undefined;
    const session = (id: string) =>
      ({
        id,
        ydoc,
        drafts: { flush: async () => events.push("flush") },
        retain: () => () => events.push("release"),
      }) as any;
    const options = (id: string) => ({
      doc: makeDoc("a") as any,
      session: session(id),
      editor: { current: null },
      accessQuery: "",
      setDoc: (next: any) => (update = next),
      tell: (message: string) => events.push(message),
    });
    const image = (bytes: number, type = "image/png") =>
      new File([new Uint8Array(bytes)], "photo[1].png", { type });
    await uploadAttachment(image(1), options("b"));
    await assert.rejects(
      uploadAttachment(image(5e6 + 1), options("a")),
      /Images must be 5 MB or smaller\./,
    );
    await assert.rejects(
      uploadAttachment(image(20e6 + 1, "video/mp4"), options("a")),
      /Videos must be 20 MB or smaller\./,
    );
    assert.deepEqual(uploads, []);
    assert.deepEqual(events, []);
    await uploadAttachment(image(1), options("a"));
    assert.deepEqual(uploads, ["/api/docs/a/upload"]);
    assert.equal(
      ydoc.getText("content").toString(),
      "Intro\n![photo1.png](media/photo.png)\n",
    );
    assert.deepEqual(events, ["flush", "Image saved to a.md.", "release"]);
    const later = makeDoc("b");
    assert.ok(update!(later) === later, "A later document keeps its usage");
    assert.equal(update!(makeDoc("a")).usage, 42);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
test("rename owns a fresh input independent of the create form", () => {
  render(
    <RenameDocument
      path="original.md"
      endpoint="/api/docs/a"
      onRename={() => {}}
    />,
  );
  const input = screen.getByLabelText("Rename or move document");
  fireEvent.change(input, { target: { value: "" } });
  assert.equal(input.value, "");
  assert.match(
    document.querySelector(".rename-form .field-help")!.textContent!,
    /Relative attachment links may need updating\./,
    "a Markdown move warns about its relative attachment links",
  );
});

test("opening the root restores the selected document URL without adding a history entry", async () => {
  const fetchBefore = globalThis.fetch;
  const previousUrl = location.href;
  const remembered = localStorage.getItem("locdoc.document");
  globalThis.fetch = async (input) =>
    String(input) === "/api/config"
      ? response({ owner: true, root: "/tmp/fixture", guest: "test" })
      : response({
          entries: [
            { id: "a", path: "a.md", kind: "file" },
            { id: "b", path: "b.md", kind: "file" },
          ],
        });
  try {
    for (const saved of ["b", null]) {
      history.replaceState(null, "", "/");
      if (saved) localStorage.setItem("locdoc.document", saved);
      else localStorage.removeItem("locdoc.document");
      const length = history.length;
      const hook = renderHook(() => useWorkspace());
      try {
        await waitFor(() => {
          assert.equal(hook.result.current.id, saved || "a");
          assert.equal(location.pathname, `/d/${saved || "a"}`);
          assert.equal(hook.result.current.entries.length, 2);
        });
        assert.equal(history.length, length);
      } finally {
        hook.unmount();
      }
    }
  } finally {
    globalThis.fetch = fetchBefore;
    history.replaceState(null, "", previousUrl);
    if (remembered) localStorage.setItem("locdoc.document", remembered);
    else localStorage.removeItem("locdoc.document");
  }
});

test("a signed-out browser with a remembered document can open owner login instead of waiting for the document", async () => {
  const fetchBefore = globalThis.fetch;
  const previousUrl = location.href;
  const remembered = localStorage.getItem("locdoc.document");
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const path = String(input);
    calls.push(path);
    return response(
      path === "/api/config"
        ? { owner: false, root: "", guest: "test", publicUrl: location.origin }
        : { fonts: [] },
    );
  };
  function SignedOut() {
    return <WorkspaceView workspace={useWorkspace()} />;
  }
  history.replaceState(null, "", "/");
  localStorage.setItem("locdoc.document", "b");
  try {
    render(<SignedOut />);
    const open = await screen.findByRole("button", { name: "Open workspace" });
    assert.equal(
      screen.queryByRole("status", { name: "Opening document" }),
      null,
    );
    assert.equal(
      calls.some((path) => path.startsWith("/api/docs/")),
      false,
    );
    fireEvent.click(open);
    assert.ok(screen.getByLabelText("Owner API key"));
    assert.equal(
      document.querySelector("dialog[open]")?.getAttribute("aria-labelledby"),
      "panel-title",
    );
    assert.equal(
      localStorage.getItem("locdoc.document"),
      "b",
      "login preserves the remembered document",
    );
  } finally {
    cleanup();
    globalThis.fetch = fetchBefore;
    history.replaceState(null, "", previousUrl);
    if (remembered) localStorage.setItem("locdoc.document", remembered);
    else localStorage.removeItem("locdoc.document");
  }
});

test("root URL restoration preserves an owner ticket until bootstrap redeems it", async () => {
  const fetchBefore = globalThis.fetch;
  const previousUrl = location.href;
  const remembered = localStorage.getItem("locdoc.document");
  let redeemed;
  globalThis.fetch = async (input, init) => {
    if (String(input) === "/api/redeem") {
      redeemed = JSON.parse(String(init.body)).ticket;
      return new Promise<Response>(() => {});
    }
    return response({});
  };
  history.replaceState(null, "", "/#ticket=owner-opening-ticket");
  localStorage.setItem("locdoc.document", "b");
  const hook = renderHook(() => useWorkspace());
  try {
    await waitFor(() => assert.equal(redeemed, "owner-opening-ticket"));
    assert.equal(location.pathname, "/d/b");
    assert.equal(location.hash, "");
  } finally {
    hook.unmount();
    globalThis.fetch = fetchBefore;
    history.replaceState(null, "", previousUrl);
    if (remembered) localStorage.setItem("locdoc.document", remembered);
    else localStorage.removeItem("locdoc.document");
  }
});

test("the latest navigation wins while drafts finish storing", async () => {
  localStorage.setItem("locdoc.document", "a");
  const { result } = renderHook(() => useWorkspace());
  let resolveOld, resolveNew, oldRequest, newRequest;
  const oldReady = new Promise<void>((resolve) => (resolveOld = resolve));
  const newReady = new Promise<void>((resolve) => (resolveNew = resolve));
  act(() => {
    oldRequest = result.current.navigate("a", "b", () => oldReady);
    newRequest = result.current.navigate("a", "c", () => newReady);
  });
  await act(async () => {
    resolveNew();
    assert.equal(await newRequest, true);
  });
  assert.equal(result.current.id, "c");
  await act(async () => {
    resolveOld();
    assert.equal(await oldRequest, false);
  });
  assert.equal(result.current.id, "c");
});

test("a tree listing older than a local change or a newer listing cannot replace it", async () => {
  const fetchBefore = globalThis.fetch;
  const listings: ((response: Response) => void)[] = [];
  globalThis.fetch = async (input) =>
    String(input) === "/api/config"
      ? response({ owner: true, root: "/tmp/fixture", guest: "test" })
      : String(input) === "/api/tree"
        ? new Promise<Response>((resolve) => listings.push(resolve))
        : response({});
  const tree = (path: string) =>
    response({ entries: [{ id: "a", path, kind: "file", shared: false }] });
  const hook = renderHook(() => useWorkspace());
  try {
    await waitFor(() => assert.equal(listings.length, 1));
    await act(async () => listings.shift()!(tree("a.md")));
    await waitFor(() =>
      assert.equal(hook.result.current.entries[0]?.path, "a.md"),
    );
    // A listing starts, then a file action changes the tree before it answers.
    let stale;
    act(() => {
      stale = hook.result.current.loadTree();
    });
    act(() =>
      hook.result.current.patchEntries((entries) =>
        entries.map((entry) => ({ ...entry, path: "renamed.md" })),
      ),
    );
    await act(async () => {
      listings.shift()!(tree("a.md"));
      await stale;
    });
    assert.equal(hook.result.current.entries[0].path, "renamed.md");
    // An older listing that answers last cannot replace a newer one.
    let older, newer;
    act(() => {
      older = hook.result.current.loadTree();
      newer = hook.result.current.loadTree();
    });
    const [first, second] = listings.splice(0);
    await act(async () => {
      second(tree("newer.md"));
      await newer;
    });
    await act(async () => {
      first(tree("older.md"));
      await older;
    });
    assert.equal(hook.result.current.entries[0].path, "newer.md");
  } finally {
    hook.unmount();
    globalThis.fetch = fetchBefore;
  }
});

test("an old document's completed action cannot redirect later navigation", async () => {
  localStorage.setItem("locdoc.document", "a");
  const { result } = renderHook(() => useWorkspace());
  await act(async () => {
    await result.current.navigate("a", "b", async () => {});
  });
  let prepared = false;
  await act(async () => {
    assert.equal(
      await result.current.navigate("a", "created-late", async () => {
        prepared = true;
      }),
      false,
    );
  });
  assert.equal(prepared, false);
  assert.equal(result.current.id, "b");
});

test("paste and drop use the current permission after a viewer becomes an editor", async () => {
  const { MarkdownEditor } = await import("../src/editor.tsx");
  const { Awareness } = await import("y-protocols/awareness");
  const ydoc = new Y.Doc();
  ydoc.getText("content").insert(0, "Existing text");
  const awareness = new Awareness(ydoc);
  const uploads = [];
  const props = {
    ydoc,
    provider: { awareness } as any,
    id: "a",
    onChange() {},
    onComment() {},
    onUpload(file) {
      uploads.push(file);
    },
  };
  const page = render(<MarkdownEditor {...props} editable={false} />);
  const file = new File(["pixel"], "pixel.png", { type: "image/png" });
  fireEvent.paste(page.getByRole("textbox"), {
    clipboardData: {
      files: [file],
      getData() {
        return "";
      },
    },
  });
  assert.equal(uploads.length, 0);
  page.rerender(<MarkdownEditor {...props} editable={true} />);
  fireEvent.paste(page.getByRole("textbox"), {
    clipboardData: {
      files: [file],
      getData() {
        return "";
      },
    },
  });
  fireEvent.drop(page.getByRole("textbox"), {
    dataTransfer: {
      files: [file],
      getData() {
        return "";
      },
    },
  });
  assert.equal(uploads.length, 2);
  page.unmount();
  awareness.destroy();
  ydoc.destroy();
});

test("bootstrap failures settle on an error instead of an indefinite loading state", async () => {
  failBootstrap = true;
  const { result } = renderHook(() => useWorkspace());
  await waitFor(() => assert.equal(result.current.error, "Config unavailable"));
  assert.equal(result.current.config?.owner, false);
  assert.notEqual(result.current.config, null);
});

test("sidebar choices survive reopening on desktop and mobile", async () => {
  const previous = localStorage.getItem("locdoc.sidebar");
  const width = window.innerWidth;
  try {
    for (const deviceWidth of [1200, 390]) {
      window.innerWidth = deviceWidth;
      localStorage.removeItem("locdoc.sidebar");
      const initial = deviceWidth > 760;
      for (const expected of [initial, !initial, initial]) {
        const hook = renderHook(() => useWorkspace());
        try {
          // Restoration is synchronous, before bootstrap or the first paint.
          assert.equal(hook.result.current.sidebar, expected);
          await waitFor(() =>
            assert.notEqual(hook.result.current.config, null),
          );
          act(() => hook.result.current.setSidebar(!expected));
          assert.equal(hook.result.current.sidebar, !expected);
        } finally {
          hook.unmount();
        }
      }
    }
  } finally {
    window.innerWidth = width;
    if (previous === null) localStorage.removeItem("locdoc.sidebar");
    else localStorage.setItem("locdoc.sidebar", previous);
  }
});

test("device font defaults and explicit sizes survive resizing and reopening", async () => {
  const previous = new Map(Object.entries(localStorage));
  const width = window.innerWidth;
  try {
    localStorage.clear();
    Object.defineProperty(window, "innerWidth", {
      value: 390,
      writable: true,
      configurable: true,
    });
    const page = renderHook(() => useAppearance());
    assert.equal(page.result.current.forFormat("markdown").fontSize, 12);
    act(() => page.result.current.forFormat("markdown").setFontSize(10));
    act(() => {
      window.innerWidth = 1024;
      window.dispatchEvent(new window.Event("resize"));
    });
    assert.equal(page.result.current.forFormat("markdown").fontSize, 15);
    act(() => {
      window.innerWidth = 1440;
      window.dispatchEvent(new window.Event("resize"));
    });
    assert.equal(page.result.current.forFormat("markdown").fontSize, 18);
    act(() => {
      window.innerWidth = 390;
      window.dispatchEvent(new window.Event("resize"));
    });
    assert.equal(page.result.current.forFormat("markdown").fontSize, 10);
    page.unmount();
    const reopened = renderHook(() => useAppearance());
    assert.equal(reopened.result.current.forFormat("markdown").fontSize, 10);
    reopened.unmount();
  } finally {
    window.innerWidth = width;
    localStorage.clear();
    for (const [key, value] of previous) localStorage.setItem(key, value);
  }
});

test("MCP consent identifies the callback origin and never approves access automatically", async () => {
  const { McpAuthorization, authorizationRedirect } =
    await import("../src/mcp-authorization");
  const original = globalThis.fetch;
  const mutations: { request: string; allow: boolean }[] = [];
  const previews: string[] = [];
  // Signed handles are opaque base64url text with a "." before their MAC.
  const handle = "mcp_q_eyJ2IjoxfQ-_09.Zm9v-_bar";
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === "POST") {
      mutations.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ error: "Connection failed" }), {
        status: 503,
      });
    }
    previews.push(String(url));
    return response({
      clientName: "ChatGPT <script>bad()</script>",
      redirectUri: "https://callback.example.test/oauth/complete",
      scopes: ["locdoc:read", "locdoc:write"],
    });
  };
  const page = render(<McpAuthorization request={handle} />);
  try {
    await page.findByText("https://callback.example.test");
    assert.ok(page.getByText("ChatGPT <script>bad()</script>"));
    assert.equal(page.container.querySelectorAll("script").length, 0);
    assert.equal(mutations.length, 0);
    assert.equal(
      new URL(previews[0], "http://localhost").searchParams.get("request"),
      handle,
    );
    fireEvent.click(page.getByRole("button", { name: "Allow access" }));
    await page.findByRole("alert");
    assert.deepEqual(mutations, [{ request: handle, allow: true }]);
    assert.equal(
      page.getByRole("button", { name: "Allow access" }).disabled,
      false,
    );
    fireEvent.click(page.getByRole("button", { name: "Cancel" }));
    await waitFor(() => assert.equal(mutations.length, 2));
    assert.equal(mutations[1].allow, false);
    for (const url of [
      "https://chatgpt.example.test/oauth/callback",
      "http://127.0.0.2:6551/callback",
      "http://[::1]:6551/callback",
    ])
      assert.equal(authorizationRedirect(url), url);
    for (const url of [
      "javascript:alert(1)",
      "http://remote.example.test/callback",
      "https://user:password@callback.example.test/",
    ])
      assert.throws(() => authorizationRedirect(url), /invalid redirect/);
  } finally {
    page.unmount();
    globalThis.fetch = original;
  }
});

test("MCP consent shows an OAuth error's description, or its code without one", async () => {
  const { McpAuthorization } = await import("../src/mcp-authorization");
  const original = globalThis.fetch;
  const failures = [
    {
      error: "invalid_request",
      error_description:
        "This connection request expired. Start connecting again from the app.",
    },
    { error: "server_error" },
  ];
  globalThis.fetch = async (_url, init = {}) => {
    if (init.method === "POST")
      return new Response(JSON.stringify(failures.shift()), { status: 400 });
    return response({
      clientName: "ChatGPT",
      redirectUri: "https://callback.example.test/oauth/complete",
      scopes: ["locdoc:read"],
    });
  };
  const page = render(<McpAuthorization request="mcp_q_e30.Zm9v" />);
  try {
    await page.findByText("https://callback.example.test");
    fireEvent.click(page.getByRole("button", { name: "Allow access" }));
    const alert = await page.findByRole("alert");
    assert.equal(
      alert.textContent,
      "This connection request expired. Start connecting again from the app.",
    );
    fireEvent.click(page.getByRole("button", { name: "Allow access" }));
    await waitFor(() =>
      assert.equal(page.getByRole("alert").textContent, "server_error"),
    );
  } finally {
    page.unmount();
    globalThis.fetch = original;
  }
});

test("disconnecting an MCP connection keeps it visible on failure and removes it only after success", async () => {
  const { McpConnections } = await import("../src/mcp-authorization");
  const original = globalThis.fetch;
  let fail = true;
  globalThis.fetch = async (_url, init = {}) => {
    if (init.method === "POST")
      return fail
        ? new Response(JSON.stringify({ error: "Storage unavailable" }), {
            status: 503,
          })
        : response({ ok: true });
    return response({
      connections: [
        {
          id: "connection",
          clientName: "A connected app",
          scopes: ["locdoc:read"],
          created: 0,
        },
      ],
    });
  };
  const page = render(
    <McpConnections publicUrl="https://notes.example.test" />,
  );
  try {
    await page.findByText("A connected app");
    assert.ok(page.getByText("https://notes.example.test/mcp"));
    fireEvent.click(page.getByRole("button", { name: "Disconnect" }));
    await page.findByRole("alert");
    assert.ok(page.getByText("A connected app"));
    fail = false;
    fireEvent.click(page.getByRole("button", { name: "Disconnect" }));
    await waitFor(() =>
      assert.ok(
        page.queryByText("A connected app") === null,
        "Disconnected application should disappear",
      ),
    );
  } finally {
    page.unmount();
    globalThis.fetch = original;
  }
});

test("writing profiles migrate Markdown and isolate Fountain across tabs and reopening", async () => {
  const previous = new Map(Object.entries(localStorage));
  const width = window.innerWidth;
  try {
    window.innerWidth = 1440;
    localStorage.clear();
    localStorage.setItem("locdoc.typography", "jetbrains-v1");
    localStorage.setItem("locdoc.font", "Lora");
    localStorage.setItem(
      "locdoc.fontSizes",
      JSON.stringify({ desktop: 21, phone: 11 }),
    );
    localStorage.setItem("locdoc.lineHeight", "1.6");
    localStorage.setItem("locdoc.pageWidth", "780");
    const page = renderHook(() => useAppearance());
    const profile = (format: "markdown" | "fountain") =>
      page.result.current.forFormat(format);
    assert.equal(profile("markdown").font, "Lora");
    assert.equal(profile("markdown").fontSize, 21);
    assert.equal(profile("markdown").lineHeight, 1.6);
    assert.equal(profile("markdown").pageWidth, 780);
    assert.equal(profile("fountain").font, "Courier Prime");
    assert.equal(profile("fountain").fontSize, 18);
    assert.equal(profile("fountain").lineHeight, 1.85);
    assert.equal(profile("fountain").pageWidth, null);
    assert.equal(profile("markdown").paragraphSpacing, 0.15);
    assert.equal(profile("fountain").paragraphSpacing, 0.15);
    assert.equal(profile("fountain").scrollPastEnd, true);
    act(() => {
      profile("fountain").setFontSize(16);
      profile("fountain").setLineHeight(1.4);
      profile("fountain").setPageWidth(900);
      profile("markdown").setFont("Georgia");
      profile("markdown").setParagraphSpacing(0.3);
      profile("fountain").setParagraphSpacing(0.5);
      profile("fountain").setScrollPastEnd(false);
    });
    assert.equal(profile("markdown").fontSize, 21);
    assert.equal(profile("markdown").lineHeight, 1.6);
    assert.equal(profile("markdown").pageWidth, 780);
    assert.equal(profile("fountain").font, "Courier Prime");
    const fromOtherTab = JSON.stringify({
      font: "JetBrains Mono",
      sizes: { desktop: 13 },
      lineHeight: 1.5,
      pageWidth: 650,
      paragraphSpacing: 0.25,
      scrollPastEnd: true,
    });
    act(() => {
      localStorage.setItem("locdoc.writing.markdown", fromOtherTab);
      window.dispatchEvent(
        new window.StorageEvent("storage", {
          key: "locdoc.writing.markdown",
          newValue: fromOtherTab,
          storageArea: localStorage,
        }),
      );
    });
    assert.equal(profile("markdown").font, "JetBrains Mono");
    assert.equal(profile("markdown").fontSize, 13);
    assert.equal(profile("fountain").fontSize, 16);
    assert.equal(profile("fountain").lineHeight, 1.4);
    assert.equal(profile("fountain").pageWidth, 900);
    assert.equal(profile("markdown").paragraphSpacing, 0.25);
    assert.equal(profile("markdown").scrollPastEnd, true);
    assert.equal(profile("fountain").scrollPastEnd, false);
    assert.equal(profile("fountain").paragraphSpacing, 0.5);
    page.unmount();
    const reopened = renderHook(() => useAppearance());
    assert.equal(reopened.result.current.forFormat("markdown").fontSize, 13);
    assert.equal(
      reopened.result.current.forFormat("fountain").font,
      "Courier Prime",
    );
    assert.equal(reopened.result.current.forFormat("fountain").fontSize, 16);
    assert.equal(reopened.result.current.forFormat("fountain").lineHeight, 1.4);
    assert.equal(reopened.result.current.forFormat("fountain").pageWidth, 900);
    assert.equal(
      reopened.result.current.forFormat("fountain").paragraphSpacing,
      0.5,
    );
    assert.equal(
      reopened.result.current.forFormat("fountain").scrollPastEnd,
      false,
    );
    assert.equal(
      reopened.result.current.forFormat("markdown").paragraphSpacing,
      0.25,
    );
    reopened.unmount();
  } finally {
    window.innerWidth = width;
    localStorage.clear();
    for (const [key, value] of previous) localStorage.setItem(key, value);
  }
});

test("an inline reply remains mounted while collaborative edits move its passage", async () => {
  const { MarkdownEditor } = await import("../src/editor.tsx");
  const { Awareness } = await import("y-protocols/awareness");
  const ydoc = new Y.Doc();
  const text = ydoc.getText("content");
  const original =
    "Before\nCommented passage continues within the same paragraph\nAfter";
  text.insert(0, original);
  const thread = {
    ...comment,
    anchor: {
      start: Y.relativePositionToJSON(
        Y.createRelativePositionFromTypeIndex(text, 7),
      ),
      end: Y.relativePositionToJSON(
        Y.createRelativePositionFromTypeIndex(text, 24),
      ),
    },
  };
  const awareness = new Awareness(ydoc);
  const page = render(
    <MarkdownEditor
      ydoc={ydoc}
      provider={{ awareness } as any}
      editable
      id="inline-test"
      onChange={() => {}}
      onComment={() => {}}
      onUpload={() => {}}
      comments={[thread]}
      activeComment="c1"
      conversation={
        <div className="inline-conversation">
          <textarea aria-label="Inline reply draft" />
        </div>
      }
    />,
  );
  const input = await screen.findByLabelText("Inline reply draft");
  const host = input.closest(".inline-comment-host");
  assert.equal(host.previousElementSibling.textContent, "Commented passage");
  assert.equal(
    host.nextElementSibling.textContent,
    " continues within the same paragraph",
  );
  const icon = screen.getByRole("button", {
    name: "Close comment",
    exact: true,
  });
  assert.equal(icon.textContent, "");
  assert.ok(icon.closest(".cm-line"));
  assert.ok(
    document.querySelector(".comment-marker-line") === null,
    "The separate comment indicator should be absent.",
  );
  assert.equal(text.toString(), original);
  fireEvent.change(input, { target: { value: "Keep this unsent reply" } });
  act(() => text.insert(0, "New introduction\n"));
  await waitFor(() =>
    assert.ok(
      document
        .querySelector(".cm-content")!
        .textContent!.includes("New introduction"),
    ),
  );
  assert.ok(
    screen.getByLabelText("Inline reply draft") === input,
    "Inline field remains mounted",
  );
  assert.equal(input.value, "Keep this unsent reply");
  assert.ok(input.closest(".cm-content .inline-comment-host"));
  act(() => text.delete(0, text.length));
  assert.ok(
    screen.getByLabelText("Inline reply draft") === input,
    "Inline field remains mounted",
  );
  assert.equal(input.value, "Keep this unsent reply");
  page.unmount();
  awareness.destroy();
  ydoc.destroy();
});

test("the app shell follows keyboard viewport changes and releases its listeners", async () => {
  const { protectTouchViewport } = await import("../src/touch-viewport.ts");
  const descriptor = Object.getOwnPropertyDescriptor(window, "visualViewport");
  const viewport = Object.assign(new window.EventTarget(), {
    height: 844,
    offsetTop: 0,
  });
  Object.defineProperty(window, "visualViewport", {
    value: viewport,
    configurable: true,
  });
  const style = document.documentElement.style;
  const height = style.getPropertyValue("--app-viewport-height");
  const top = style.getPropertyValue("--app-viewport-top");
  style.setProperty("--app-viewport-height", "900px");
  style.setProperty("--app-viewport-top", "3px");
  const stop = protectTouchViewport(document);
  try {
    assert.equal(style.getPropertyValue("--app-viewport-height"), "844px");
    viewport.height = 466;
    viewport.offsetTop = 12;
    viewport.dispatchEvent(new window.Event("resize"));
    assert.equal(style.getPropertyValue("--app-viewport-height"), "466px");
    assert.equal(style.getPropertyValue("--app-viewport-top"), "12px");
    viewport.offsetTop = 0;
    viewport.dispatchEvent(new window.Event("scroll"));
    assert.equal(style.getPropertyValue("--app-viewport-top"), "0px");
    stop();
    viewport.height = 300;
    viewport.dispatchEvent(new window.Event("resize"));
    assert.equal(style.getPropertyValue("--app-viewport-height"), "900px");
    assert.equal(style.getPropertyValue("--app-viewport-top"), "3px");
  } finally {
    stop();
    if (descriptor) Object.defineProperty(window, "visualViewport", descriptor);
    else Reflect.deleteProperty(window, "visualViewport");
    if (height) style.setProperty("--app-viewport-height", height);
    else style.removeProperty("--app-viewport-height");
    if (top) style.setProperty("--app-viewport-top", top);
    else style.removeProperty("--app-viewport-top");
  }
});

test("native selection and clipboard gestures remain available while pinch zoom is blocked", async () => {
  const { protectTouchViewport } = await import("../src/touch-viewport.ts");
  const stop = protectTouchViewport(document);
  const touch = (count: number) => {
    const event = new window.Event("touchmove", { cancelable: true });
    Object.defineProperty(event, "touches", { value: Array(count).fill({}) });
    document.dispatchEvent(event);
    return event.defaultPrevented;
  };
  assert.equal(touch(1), false);
  assert.equal(touch(2), false);
  assert.equal(touch(3), false);
  const gesture = new window.Event("gesturestart", { cancelable: true });
  document.dispatchEvent(gesture);
  assert.equal(gesture.defaultPrevented, true);
  stop();
  assert.equal(touch(2), false);
});

test("task checkboxes update Markdown, respect permission changes, and ignore code", async () => {
  const { MarkdownEditor } = await import("../src/editor.tsx");
  const { Awareness } = await import("y-protocols/awareness");
  const ydoc = new Y.Doc();
  const text = ydoc.getText("content");
  text.insert(
    0,
    "Intro\n- [ ] Write the draft\n- [x] Read the notes\n\n```md\n- [ ] Not a task\n```\n",
  );
  const awareness = new Awareness(ydoc);
  const props = {
    ydoc,
    provider: { awareness } as any,
    id: "tasks",
    onChange() {},
    onComment() {},
    onUpload() {},
  };
  const page = render(<MarkdownEditor {...props} editable />);
  assert.equal(screen.getAllByRole("checkbox").length, 2);
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Write the draft" }).closest("label"),
  );
  assert.ok(text.toString().includes("- [x] Write the draft"));
  page.rerender(<MarkdownEditor {...props} editable={false} />);
  assert.equal(
    screen.getByRole("checkbox", { name: "Write the draft" }).disabled,
    true,
  );
  page.unmount();
  awareness.destroy();
  ydoc.destroy();
});

test("wrapped list prefixes preserve nested markers, task controls and native source editing", async () => {
  const { MarkdownEditor } = await import("../src/editor.tsx");
  const { EditorView } = await import("@codemirror/view");
  const { Awareness } = await import("y-protocols/awareness");
  const ydoc = new Y.Doc();
  const text = ydoc.getText("content");
  const source = [
    "Intro",
    "- Bulleted content that can wrap onto several display lines",
    "  - Nested bullet content that can wrap onto several display lines",
    "",
    "10. Ordered content that can wrap onto several display lines",
    "\t- Tabbed nested content that can wrap onto several display lines",
    "",
    "- [ ] Task content that can wrap onto several display lines",
    "  - [x] Nested task content that can wrap onto several display lines",
    "",
    "- - Same-line nested content that can wrap onto several display lines",
    "",
    "---",
    "",
    "```md",
    "- [ ] Literal code",
    "```",
  ].join("\n");
  text.insert(0, source);
  const awareness = new Awareness(ydoc);
  const page = render(
    <MarkdownEditor
      ydoc={ydoc}
      provider={{ awareness } as any}
      editable
      id="wrapped-lists"
      onChange={() => {}}
      onComment={() => {}}
      onUpload={() => {}}
    />,
  );
  const lines = [...page.container.querySelectorAll<HTMLElement>(".md-list")];
  assert.equal(lines.length, 7);
  assert.deepEqual(
    lines.map((line) => line.style.getPropertyValue("--list-indent")),
    ["2ch", "4ch", "4ch", "6ch", "calc(1ch + 28px)", "calc(3ch + 28px)", "4ch"],
  );
  for (const line of lines)
    assert.equal(line.querySelectorAll(".md-list-prefix").length, 1);
  const nestedTask = screen.getByRole("checkbox", {
    name: "Nested task content that can wrap onto several display lines",
  });
  assert.ok(
    nestedTask.closest(".md-list-prefix")?.textContent?.startsWith("  "),
  );
  assert.equal(
    page.container.querySelectorAll(".md-code-line .md-list-prefix").length,
    0,
  );
  assert.equal(text.toString(), source);
  fireEvent.click(nestedTask.closest("label"));
  assert.equal(
    text.toString(),
    source.replace("  - [x] Nested task", "  - [ ] Nested task"),
  );

  const view = EditorView.findFromDOM(
    page.container.querySelector(".cm-editor")!,
  )!;
  const bullet = source.indexOf("- Bulleted");
  const markerText =
    lines[0].querySelector(".md-list-prefix")!.firstChild!.firstChild!;
  assert.equal(view.posAtDOM(markerText, 0), bullet);
  act(() =>
    view.dispatch({
      changes: { from: bullet, to: bullet + 1, insert: "10." },
      selection: { anchor: bullet + 3 },
    }),
  );
  assert.ok(text.toString().startsWith("Intro\n10. Bulleted"));
  assert.equal(
    page.container
      .querySelector<HTMLElement>(".md-list")!
      .style.getPropertyValue("--list-indent"),
    "4ch",
  );
  assert.equal(view.state.selection.main.head, bullet + 3);
  page.unmount();
  awareness.destroy();
  ydoc.destroy();
});

test("expanded comments retain list indentation across fragments without indenting the conversation or next line", async () => {
  const { MarkdownEditor } = await import("../src/editor.tsx");
  const { Awareness } = await import("y-protocols/awareness");
  for (const suffix of [
    " A deliberately long continuation that wraps several times",
    "",
  ]) {
    const ydoc = new Y.Doc();
    const text = ydoc.getText("content");
    const source =
      "- Another[[comment(alex): A note inside a wrapped item.]]" +
      suffix +
      "\n\nA separate paragraph";
    text.insert(0, source);
    const awareness = new Awareness(ydoc);
    const thread = {
      ...comment,
      anchor: {
        start: Y.relativePositionToJSON(
          Y.createRelativePositionFromTypeIndex(text, 2),
        ),
        end: Y.relativePositionToJSON(
          Y.createRelativePositionFromTypeIndex(text, 9, -1),
        ),
      },
    };
    const props = {
      ydoc,
      provider: { awareness } as any,
      editable: true,
      id: "list-comment",
      onChange() {},
      onComment() {},
      onUpload() {},
      comments: [thread],
    };
    const page = render(
      <MarkdownEditor
        {...props}
        activeComment="c1"
        conversation={<textarea aria-label="List comment reply" />}
      />,
    );
    const input = await screen.findByLabelText("List comment reply");
    const host = input.closest(".inline-comment-host")!;
    const wrapper = page.container.querySelector<HTMLElement>(".md-list")!;
    assert.equal(wrapper.style.getPropertyValue("--list-indent"), "2ch");
    if (suffix) {
      assert.ok(
        host.parentElement === wrapper,
        "Comment should remain inside its list wrapper.",
      );
      assert.equal(host.previousElementSibling?.textContent, "- Another");
      assert.equal(host.nextElementSibling?.textContent, suffix);
      assert.ok(host.nextElementSibling?.classList.contains("cm-line"));
      assert.equal(wrapper.querySelectorAll(":scope > .cm-line").length, 2);
      assert.equal(wrapper.querySelectorAll(".md-list-prefix").length, 1);
    } else {
      assert.ok(
        host.parentElement === page.container.querySelector(".cm-content"),
        "Comment should remain directly inside the editor content.",
      );
      assert.equal(wrapper.querySelectorAll(":scope > .cm-line").length, 1);
    }
    const paragraph = [...page.container.querySelectorAll(".cm-line")].find(
      (line) => line.textContent === "A separate paragraph",
    )!;
    assert.ok(
      paragraph.closest(".md-list") === null,
      "Separate paragraph should not inherit a list wrapper.",
    );
    assert.equal(text.toString(), source);
    page.rerender(<MarkdownEditor {...props} activeComment={null} />);
    assert.equal(
      page.container.querySelectorAll(".md-list > .cm-line").length,
      1,
    );
    assert.equal(text.toString(), source);
    page.unmount();
    awareness.destroy();
    ydoc.destroy();
  }
});

test("link insertion retains its collaborative selection while a picker is open", async () => {
  const { MarkdownEditor } = await import("../src/editor.tsx");
  const { Awareness } = await import("y-protocols/awareness");
  const ydoc = new Y.Doc();
  const text = ydoc.getText("content");
  text.insert(0, "Draft");
  const awareness = new Awareness(ydoc);
  const ref = React.createRef<any>();
  const page = render(
    <MarkdownEditor
      ref={ref}
      ydoc={ydoc}
      provider={{ awareness } as any}
      editable
      id="links"
      onChange={() => {}}
      onComment={() => {}}
      onUpload={() => {}}
    />,
  );
  const anchor = {
    start: Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(text, 0),
    ),
    end: Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(text, 5),
    ),
  };
  act(() => text.insert(0, "Before "));
  act(() =>
    ref.current.insertLink("https://example.com/a_(b)", "Draft", anchor),
  );
  assert.equal(text.toString(), "Before [Draft](<https://example.com/a_(b)>)");
  assert.equal(
    page.container.querySelector("a[data-link-url]")?.getAttribute("href"),
    "https://example.com/a_(b)",
  );
  page.unmount();
  awareness.destroy();
  ydoc.destroy();
});

test("keyboard link selection stays visible in a long result list", async () => {
  const { LinkPicker } = await import("../src/link-picker.tsx");
  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.id === "link-results") return new DOMRect(0, 0, 320, 88);
    if (this.getAttribute("role") === "option") {
      const index = Number(this.id.replace("link-result-", ""));
      return new DOMRect(
        0,
        index * 44 - this.parentElement!.scrollTop,
        320,
        44,
      );
    }
    return original.call(this);
  };
  const chosen: string[] = [];
  const entries = Array.from({ length: 20 }, (_, i) => ({
    id: String(i),
    kind: "file" as const,
    path: `Notes ${i}.md`,
    url: `https://locdoc.test/d/${i}`,
    shared: false,
  }));
  const page = render(
    <LinkPicker
      entries={entries}
      selection=""
      onInsert={(url) => chosen.push(url)}
    />,
  );
  try {
    const input = screen.getByRole("combobox");
    for (let i = 0; i < 12; i++) fireEvent.keyDown(input, { key: "ArrowDown" });
    assert.equal(input.getAttribute("aria-activedescendant"), "link-result-12");
    assert.equal(document.getElementById("link-results")!.scrollTop, 11 * 44);
    fireEvent.submit(input.closest("form"));
    assert.deepEqual(chosen, ["https://locdoc.test/d/12"]);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    assert.equal(input.getAttribute("aria-activedescendant"), "link-result-11");
  } finally {
    page.unmount();
    HTMLElement.prototype.getBoundingClientRect = original;
  }
});

test("standalone safe-area height differences cannot shorten the shell or survive keyboard dismissal", async () => {
  const { protectTouchViewport } = await import("../src/touch-viewport.ts");
  const vvDescriptor = Object.getOwnPropertyDescriptor(
    window,
    "visualViewport",
  );
  const standaloneDescriptor = Object.getOwnPropertyDescriptor(
    navigator,
    "standalone",
  );
  const getRect = HTMLElement.prototype.getBoundingClientRect;
  const computed = window.getComputedStyle;
  const viewport = Object.assign(new window.EventTarget(), {
    height: 751,
    offsetTop: 0,
  });
  Object.defineProperty(window, "visualViewport", {
    value: viewport,
    configurable: true,
  });
  Object.defineProperty(navigator, "standalone", {
    value: true,
    configurable: true,
  });
  HTMLElement.prototype.getBoundingClientRect = function () {
    return this.hasAttribute("data-viewport-gauge")
      ? new DOMRect(0, 0, 0, 844)
      : getRect.call(this);
  };
  window.getComputedStyle = function (element, pseudo) {
    return element.hasAttribute("data-viewport-gauge")
      ? ({ paddingTop: "59px", paddingBottom: "34px" } as CSSStyleDeclaration)
      : computed.call(window, element, pseudo);
  };
  const input = document.createElement("textarea");
  document.body.appendChild(input);
  const style = document.documentElement.style;
  const previousHeight = style.getPropertyValue("--app-viewport-height"),
    previousTop = style.getPropertyValue("--app-viewport-top");
  let stop: (() => void) | undefined;
  try {
    stop = protectTouchViewport(document);
    assert.equal(
      document.documentElement.hasAttribute("data-standalone"),
      true,
    );
    assert.equal(style.getPropertyValue("--app-viewport-height"), "844px");
    assert.ok(!document.documentElement.hasAttribute("data-keyboard-open"));
    input.focus();
    assert.equal(style.getPropertyValue("--app-viewport-height"), "844px");
    viewport.height = 750.5;
    viewport.dispatchEvent(new window.Event("resize"));
    assert.equal(style.getPropertyValue("--app-viewport-height"), "844px");
    viewport.height = 466;
    viewport.offsetTop = 12;
    viewport.dispatchEvent(new window.Event("resize"));
    assert.equal(style.getPropertyValue("--app-viewport-height"), "466px");
    assert.ok(document.documentElement.hasAttribute("data-keyboard-open"));
    assert.equal(style.getPropertyValue("--app-viewport-top"), "12px");
    // Safari can dismiss its keyboard while the editor remains focused.
    viewport.height = 751;
    viewport.offsetTop = 0;
    viewport.dispatchEvent(new window.Event("resize"));
    assert.ok(
      document.activeElement === input,
      "Reply opens a focused writing field",
    );
    assert.equal(style.getPropertyValue("--app-viewport-height"), "844px");
    assert.ok(!document.documentElement.hasAttribute("data-keyboard-open"));
    assert.equal(style.getPropertyValue("--app-viewport-top"), "");
    // Moving focus away must also release a keyboard override immediately.
    viewport.height = 466;
    viewport.dispatchEvent(new window.Event("resize"));
    input.blur();
    assert.equal(style.getPropertyValue("--app-viewport-height"), "844px");
    stop();
    stop = undefined;
    assert.ok(
      document.querySelector("[data-viewport-gauge]") === null,
      "Viewport gauge should be removed during cleanup.",
    );
    assert.equal(
      document.documentElement.hasAttribute("data-standalone"),
      false,
    );
  } finally {
    stop?.();
    input.remove();
    HTMLElement.prototype.getBoundingClientRect = getRect;
    window.getComputedStyle = computed;
    if (vvDescriptor)
      Object.defineProperty(window, "visualViewport", vvDescriptor);
    else Reflect.deleteProperty(window, "visualViewport");
    if (standaloneDescriptor)
      Object.defineProperty(navigator, "standalone", standaloneDescriptor);
    else Reflect.deleteProperty(navigator, "standalone");
    if (previousHeight)
      style.setProperty("--app-viewport-height", previousHeight);
    else style.removeProperty("--app-viewport-height");
    if (previousTop) style.setProperty("--app-viewport-top", previousTop);
    else style.removeProperty("--app-viewport-top");
  }
});

test("a reply stays compact until used and collapses after posting", async () => {
  const posted: string[] = [];
  render(
    <CommentThread
      comment={comment}
      canResolve={false}
      onResolve={() => {}}
      busy={false}
      onReply={async (body) => {
        posted.push(body);
        return true;
      }}
    />,
  );
  assert.ok(
    !screen.queryByLabelText("Reply to comment"),
    "Reply field is collapsed",
  );
  assert.ok(
    screen.queryByRole("button", { name: "Post", exact: true }) === null,
    "Post button should be absent while the reply is collapsed.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Reply", exact: true }));
  const input = screen.getByLabelText("Reply to comment");
  assert.ok(
    document.activeElement === input,
    "Reply opens a focused writing field",
  );
  assert.ok(screen.getByRole("button", { name: "Post", exact: true }).disabled);
  fireEvent.change(input, { target: { value: "A quick reply" } });
  fireEvent.click(screen.getByRole("button", { name: "Post", exact: true }));
  await waitFor(() =>
    assert.ok(
      !screen.queryByLabelText("Reply to comment"),
      "Posted reply collapses",
    ),
  );
  assert.deepEqual(posted, ["A quick reply"]);
  assert.ok(
    screen.queryByRole("button", { name: "Post", exact: true }) === null,
    "Post button should be absent while the reply is collapsed.",
  );
  assert.ok(screen.getByRole("button", { name: "Reply", exact: true }));
});

test("table and local-media comments stay outside their rendered block", async () => {
  const { MarkdownEditor } = await import("../src/editor.tsx");
  const { Awareness } = await import("y-protocols/awareness");
  for (const [content, phrase] of [
    [
      "Before\n\n| One | Two |\n| --- | --- |\n| Body | Cell |\n\nAfter",
      "Body",
    ],
    ["Before\n\n![A local image](_media/example.png)\n\nAfter", "local"],
  ]) {
    const ydoc = new Y.Doc(),
      text = ydoc.getText("content");
    text.insert(0, content);
    const from = content.indexOf(phrase),
      to = from + phrase.length;
    const thread = {
      ...comment,
      anchor: {
        start: Y.relativePositionToJSON(
          Y.createRelativePositionFromTypeIndex(text, from),
        ),
        end: Y.relativePositionToJSON(
          Y.createRelativePositionFromTypeIndex(text, to),
        ),
      },
    };
    const awareness = new Awareness(ydoc);
    const page = render(
      <MarkdownEditor
        ydoc={ydoc}
        provider={{ awareness } as any}
        editable
        id="block-comment-test"
        onChange={() => {}}
        onComment={() => {}}
        onUpload={() => {}}
        comments={[thread]}
        activeComment="c1"
        conversation={<textarea aria-label="Block reply" />}
      />,
    );
    const input = await screen.findByLabelText("Block reply");
    const host = input.closest(".inline-comment-host");
    assert.ok(
      host.previousElementSibling.classList.contains("comment-marker-block"),
    );
    assert.ok(screen.getByRole("button", { name: "Close comment" }));
    assert.equal(text.toString(), content);
    page.unmount();
    awareness.destroy();
    ydoc.destroy();
  }
});

test("word count measures reading content instead of Markdown control syntax", () => {
  for (const [source, expected] of [
    ["# Collab Ideas\n\n-", 2],
    ["## **One**\n\n- [x] Done\n- [ ] Pending\n\n1. Next\n\n---", 4],
    [
      '**Bold** and [linked words](https://example.test/path "a hidden title")',
      4,
    ],
    [
      '![an image caption](_media/a-photo.png)\n\n[reference]: https://example.test "Hidden title"',
      0,
    ],
    ["Read [this][ref].\n\n[ref]: https://example.test", 2],
    ["```rust\nlet value = 2;\n```", 3],
    ["Hello, world! Café déjà vu.", 5],
    ["#\n-\n*\n\n", 0],
  ] as const)
    assert.equal(countMarkdownWords(source), expected, source);
});

test(
  "sidebar refreshes retain the Markdown parser state in a long document",
  { timeout: 10000 },
  async () => {
    const { MarkdownEditor } = await import("../src/editor.tsx");
    const { EditorView } = await import("@codemirror/view");
    const { forceParsing, syntaxTree } = await import("@codemirror/language");
    const { Awareness } = await import("y-protocols/awareness");
    const ydoc = new Y.Doc(),
      awareness = new Awareness(ydoc);
    const source = "## A section\n\nA paragraph with **emphasis**.\n\n".repeat(
      100,
    );
    ydoc.getText("content").insert(0, source);
    const props = {
      ydoc,
      provider: { awareness } as any,
      editable: true,
      id: "long-preview",
      path: "long.md",
      onChange() {},
      onComment() {},
      onUpload() {},
    };
    const page = render(<MarkdownEditor {...props} entries={[]} />);
    try {
      const view = EditorView.findFromDOM(
        page.container.querySelector(".cm-editor")!,
      )!;
      await act(async () => {
        forceParsing(view, source.length, 500);
      });
      const parsed = syntaxTree(view.state);
      assert.equal(parsed.length, source.length);
      page.rerender(
        <MarkdownEditor
          {...props}
          entries={[
            { id: "another", path: "another.md", kind: "file", shared: false },
          ]}
        />,
      );
      assert.ok(
        syntaxTree(view.state) === parsed,
        "Sidebar refresh discarded the parsed Markdown tree.",
      );
    } finally {
      page.unmount();
      awareness.destroy();
      ydoc.destroy();
    }
  },
);

test("Markdown gaps separate single-newline text blocks while keeping list continuations, headings and code tight", async () => {
  const { MarkdownEditor } = await import("../src/editor.tsx");
  const { Awareness } = await import("y-protocols/awareness");
  const ydoc = new Y.Doc(),
    awareness = new Awareness(ydoc);
  const source =
    "A paragraph\ncontinued on the next source line.\n\nAnother paragraph.\n\n- One item\n  continued on the next source line.\n- Two items\n\n## Heading\n\n```text\nCode\n```";
  ydoc.getText("content").insert(0, source);
  const page = render(
    <MarkdownEditor
      ydoc={ydoc}
      provider={{ awareness } as any}
      editable
      id="gaps"
      path="gaps.md"
      onChange={() => {}}
      onComment={() => {}}
      onUpload={() => {}}
    />,
  );
  const ends = [...page.container.querySelectorAll(".md-block-end")];
  assert.equal(ends.length, 5);
  assert.deepEqual(
    ends.map((el) => el.textContent),
    [
      "A paragraph",
      "continued on the next source line.",
      "Another paragraph.",
      "  continued on the next source line.",
      "- Two items",
    ],
  );
  assert.equal(
    page.container.querySelectorAll(
      ".md-h2.md-block-end, .md-code-line.md-block-end",
    ).length,
    0,
  );
  assert.equal(ydoc.getText("content").toString(), source);
  page.unmount();
  awareness.destroy();
  ydoc.destroy();
});

test("Markdown gaps cover nested, ordered, task and multi-paragraph list items without doubling", async () => {
  const { MarkdownEditor } = await import("../src/editor.tsx");
  const { Awareness } = await import("y-protocols/awareness");
  const ydoc = new Y.Doc(),
    awareness = new Awareness(ydoc);
  const source =
    "- Parent\n  continuation\n  - Child\n    - Deep\n  - Sibling\n- Next\n\n1. Ordered parent\n   1. Ordered child\n\n- [ ] Task parent\n  - [x] Task child\n\n- First paragraph\n\n  Second paragraph";
  ydoc.getText("content").insert(0, source);
  const page = render(
    <MarkdownEditor
      ydoc={ydoc}
      provider={{ awareness } as any}
      editable
      id="nested-gaps"
      path="nested.md"
      onChange={() => {}}
      onComment={() => {}}
      onUpload={() => {}}
    />,
  );
  try {
    const ends = [...page.container.querySelectorAll(".md-block-end")];
    const expected = [
      "continuation",
      "Child",
      "Deep",
      "Sibling",
      "Next",
      "Ordered parent",
      "Ordered child",
      "Task parent",
      "Task child",
      "First paragraph",
      "Second paragraph",
    ];
    assert.equal(ends.length, expected.length);
    expected.forEach((text, index) =>
      assert.ok(ends[index].textContent!.trim().endsWith(text), text),
    );
    assert.ok(
      ends.every(
        (el) =>
          el.className.split(/\s+/).filter((c) => c === "md-block-end")
            .length === 1,
      ),
    );
    assert.equal(ydoc.getText("content").toString(), source);
  } finally {
    page.unmount();
    awareness.destroy();
    ydoc.destroy();
  }
});

test("Enter immediately spaces source paragraphs in Markdown and Fountain without adding blank lines", async () => {
  const { MarkdownEditor } = await import("../src/editor.tsx");
  const { EditorView } = await import("@codemirror/view");
  const { insertNewline } = await import("@codemirror/commands");
  const { Awareness } = await import("y-protocols/awareness");
  const first = "An action begins.",
    second = "Another action follows.";
  for (const extension of ["md", "fountain"]) {
    const ydoc = new Y.Doc(),
      awareness = new Awareness(ydoc);
    ydoc.getText("content").insert(0, first + second);
    const page = render(
      <MarkdownEditor
        ydoc={ydoc}
        provider={{ awareness } as any}
        editable
        id={`enter-gap-${extension}`}
        path={`gap.${extension}`}
        onComment={() => {}}
        onUpload={() => {}}
      />,
    );
    try {
      const view = EditorView.findFromDOM(
        page.container.querySelector(".cm-editor")!,
      )!;
      await act(async () => {
        view.dispatch({ selection: { anchor: first.length } });
        assert.equal(insertNewline(view), true);
      });
      const selector =
        extension === "md" ? ".md-block-end" : ".fountain-block-end";
      assert.deepEqual(
        [...page.container.querySelectorAll(selector)].map(
          (line) => line.textContent,
        ),
        [first, second],
      );
      assert.equal(ydoc.getText("content").toString(), `${first}\n${second}`);
      await act(async () => {
        view.dispatch({ selection: { anchor: view.state.doc.length } });
        assert.equal(insertNewline(view), true);
      });
      assert.equal(ydoc.getText("content").toString(), `${first}\n${second}\n`);
      assert.equal(page.container.querySelectorAll(selector).length, 2);
      const last = page.container.querySelectorAll(".cm-line");
      assert.equal(
        last[last.length - 1].classList.contains(selector.slice(1)),
        false,
      );
    } finally {
      page.unmount();
      awareness.destroy();
      ydoc.destroy();
    }
  }
});

test("Fountain paragraph gaps keep cues, parentheticals, blank lines and hidden comments tight", async () => {
  const { MarkdownEditor } = await import("../src/editor.tsx");
  const { EditorView } = await import("@codemirror/view");
  const { insertNewline } = await import("@codemirror/commands");
  const { Awareness } = await import("y-protocols/awareness");
  const source =
    "INT. STUDIO - DAY\n\nA light comes on.\n[[comment(ana): A hidden comment]]\nAnother light follows.\n\n[[comment(ana): A cue comment]]\n@ANA\n(softly)\nFirst speech.Second speech.\n\n~A song\n\n> A centered thought <";
  const ydoc = new Y.Doc(),
    awareness = new Awareness(ydoc);
  ydoc.getText("content").insert(0, source);
  const page = render(
    <MarkdownEditor
      ydoc={ydoc}
      provider={{ awareness } as any}
      editable
      id="fountain-gap-groups"
      path="gaps.fountain"
      onComment={() => {}}
      onUpload={() => {}}
    />,
  );
  try {
    const view = EditorView.findFromDOM(
      page.container.querySelector(".cm-editor")!,
    )!;
    await act(async () => {
      view.dispatch({
        selection: { anchor: source.indexOf("Second speech.") },
      });
      assert.equal(insertNewline(view), true);
    });
    assert.deepEqual(
      [...page.container.querySelectorAll(".fountain-block-end")].map((line) =>
        line.textContent!.trim(),
      ),
      [
        "A light comes on.",
        "Another light follows.",
        "First speech.",
        "Second speech.",
        "A song",
        "A centered thought",
      ],
    );
    assert.equal(
      page.container.querySelectorAll(
        ".fountain-character > .fountain-block-end, .fountain-parenthetical > .fountain-block-end, .fountain-blank > .fountain-block-end, .fountain-note > .fountain-block-end, .fountain-scene > .fountain-block-end",
      ).length,
      0,
    );
    assert.equal(
      page.container.querySelector(".fountain-character")!.textContent,
      "ANA",
    );
    assert.equal(
      ydoc.getText("content").toString(),
      source.replace(
        "First speech.Second speech.",
        "First speech.\nSecond speech.",
      ),
    );
  } finally {
    page.unmount();
    awareness.destroy();
    ydoc.destroy();
  }
});

test("double-bracket notes keep uniform styling beside the caret in both formats and real Markdown links remain links", async () => {
  const { MarkdownEditor } = await import("../src/editor.tsx");
  const { EditorView } = await import("@codemirror/view");
  const { Awareness } = await import("y-protocols/awareness");
  for (const path of ["notes.md", "notes.fountain"]) {
    const ydoc = new Y.Doc(),
      awareness = new Awareness(ydoc);
    const source = "[[a note]]\n\n[Real link](https://example.com/)\n";
    ydoc.getText("content").insert(0, source);
    const page = render(
      <MarkdownEditor
        ydoc={ydoc}
        provider={{ awareness } as any}
        editable
        id="brackets"
        path={path}
        onChange={() => {}}
        onComment={() => {}}
        onUpload={() => {}}
      />,
    );
    try {
      const view = EditorView.findFromDOM(
        page.container.querySelector(".cm-editor")!,
      )!;
      for (const position of [1, 2]) {
        act(() => {
          view.focus();
          view.dispatch({ selection: { anchor: position } });
        });
        assert.equal(
          page.container.querySelectorAll(
            ".cm-matchingBracket, .cm-nonmatchingBracket",
          ).length,
          0,
        );
        const note = page.container.querySelector(
          path.endsWith(".md") ? ".md-literal-brackets" : ".fountain-note-ink",
        );
        assert.equal(note?.textContent, "[[a note]]");
      }
      if (path.endsWith(".md"))
        assert.equal(
          page.container.querySelector("a.md-link")?.getAttribute("href"),
          "https://example.com/",
        );
      assert.equal(ydoc.getText("content").toString(), source);
    } finally {
      page.unmount();
      awareness.destroy();
      ydoc.destroy();
    }
  }
});

test("Fountain previews stay editable, preserve comments and survive format/permission changes", async () => {
  const { MarkdownEditor } = await import("../src/editor.tsx");
  const { EditorView } = await import("@codemirror/view");
  const { Awareness } = await import("y-protocols/awareness");
  const ydoc = new Y.Doc(),
    awareness = new Awareness(ydoc);
  const source =
    "Title: A Signal\n\nINT. STUDIO - DAY\n\n@Morgan[[comment(Example): Keep this record]]\nA **quiet** signal.\n\nLEE ^\n    (softly)  [[comment(Example): Keep the pause]]\nI hear it.\n\nA lamp glows with _warmth_.";
  ydoc.getText("content").insert(0, source);
  const ref = React.createRef<any>();
  const props = {
    ydoc,
    provider: { awareness } as any,
    id: "fountain",
    onChange() {},
    onComment() {},
    onUpload() {},
    ref,
  };
  const page = render(
    <MarkdownEditor {...props} path="Signal.fountain" editable />,
  );
  assert.ok(page.getByRole("textbox", { name: "Fountain screenplay" }));
  assert.equal(
    page.container.querySelectorAll(".fountain-dual-marker").length,
    1,
  );
  assert.ok(page.container.querySelector(".fountain-scene"));
  assert.ok(page.container.querySelector(".fountain-underline"));
  assert.equal(ydoc.getText("content").toString(), source);
  const view = EditorView.findFromDOM(
    page.container.querySelector(".cm-editor")!,
  )!;
  await act(async () => {
    view.focus();
    view.dispatch({ selection: { anchor: source.indexOf("@Morgan") + 3 } });
  });
  assert.ok(
    page.container
      .querySelector(".fountain-character")!
      .textContent!.includes("@Morgan"),
  );
  const beforeComment = sourceComments(ydoc.getText("content").toString())[0];
  const commentPosition = Y.createRelativePositionFromTypeIndex(
    ydoc.getText("content"),
    beforeComment.from + 10,
  );
  await act(async () => {
    ref.current.formatFountain("centered");
  });
  assert.equal(
    sourceComments(ydoc.getText("content").toString())[0].messages[0].body,
    "Keep this record",
  );
  assert.ok(
    ydoc
      .getText("content")
      .toString()
      .includes("> Morgan <[[comment(Example): Keep this record]]"),
  );
  assert.equal(
    Y.createAbsolutePositionFromRelativePosition(commentPosition, ydoc)!.index,
    sourceComments(ydoc.getText("content").toString())[0].from + 10,
  );
  const pause = sourceComments(ydoc.getText("content").toString())[1];
  const pausePosition = Y.createRelativePositionFromTypeIndex(
    ydoc.getText("content"),
    pause.from + 10,
  );
  await act(async () => {
    view.dispatch({
      selection: {
        anchor: ydoc.getText("content").toString().indexOf("softly"),
      },
    });
    ref.current.formatFountain("action");
  });
  assert.ok(
    ydoc
      .getText("content")
      .toString()
      .includes("    !softly  [[comment(Example): Keep the pause]]"),
  );
  assert.equal(
    Y.createAbsolutePositionFromRelativePosition(pausePosition, ydoc)!.index,
    sourceComments(ydoc.getText("content").toString())[1].from + 10,
  );
  const text = ydoc.getText("content").toString();
  page.rerender(
    <MarkdownEditor {...props} path="Signal.fountain" editable={false} />,
  );
  await act(async () => {
    ref.current.formatFountain("action");
  });
  assert.equal(ydoc.getText("content").toString(), text);
  page.rerender(<MarkdownEditor {...props} path="Signal.md" editable />);
  assert.ok(page.getByRole("textbox", { name: "Markdown document" }));
  assert.equal(page.container.querySelectorAll(".fountain-line").length, 0);
  assert.equal(ydoc.getText("content").toString(), text);
  page.unmount();
  awareness.destroy();
  ydoc.destroy();
});

test("Fountain speaker completion survives sidebar refreshes and accepts into collaborative text", async () => {
  const { MarkdownEditor } = await import("../src/editor.tsx");
  const { EditorView } = await import("@codemirror/view");
  const { currentCompletions } = await import("@codemirror/autocomplete");
  const { Awareness } = await import("y-protocols/awareness");
  const ydoc = new Y.Doc(),
    text = ydoc.getText("content"),
    awareness = new Awareness(ydoc);
  const source = "SARA\nHello.\n\n@Morgan\nAgain.\n\n\n\nEXT. YARD - DAY";
  const position = source.indexOf("\n\n\n\n") + 2;
  text.insert(0, source);
  const props = {
    ydoc,
    provider: { awareness } as any,
    editable: true,
    id: "fountain-completion-refresh",
    path: "Completion.fountain",
    onChange() {},
    onComment() {},
    onUpload() {},
  };
  const page = render(<MarkdownEditor {...props} entries={[]} />);
  try {
    const view = EditorView.findFromDOM(
      page.container.querySelector(".cm-editor")!,
    )!;
    await act(async () => {
      view.focus();
      view.dispatch({
        changes: { from: position, insert: "SA" },
        selection: { anchor: position + 2 },
        userEvent: "input.type",
      });
    });
    await waitFor(() =>
      assert.deepEqual(
        currentCompletions(view.state).map(({ label }) => label),
        ["SARA"],
      ),
    );
    page.rerender(
      <MarkdownEditor
        {...props}
        entries={[
          { id: "other", path: "Other.md", kind: "file", shared: false },
        ]}
      />,
    );
    assert.ok(
      EditorView.findFromDOM(page.container.querySelector(".cm-editor")!) ===
        view,
      "Sidebar metadata must retain the editor instance",
    );
    assert.deepEqual(
      currentCompletions(view.state).map(({ label }) => label),
      ["SARA"],
    );
    // CodeMirror intentionally ignores acceptance just after opening a menu.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      fireEvent.keyDown(view.contentDOM, { key: "Tab" });
    });
    assert.equal(
      text.toString(),
      source.slice(0, position) + "SARA" + source.slice(position),
    );
    assert.equal(view.state.doc.toString(), text.toString());
  } finally {
    page.unmount();
    awareness.destroy();
    ydoc.destroy();
  }
});

test("speaker formatting starts at two capitals and resets after backspace while drafting", async () => {
  const { MarkdownEditor } = await import("../src/editor.tsx");
  const { EditorView } = await import("@codemirror/view");
  const { fountainScript } = await import("../src/fountain-preview");
  const { Awareness } = await import("y-protocols/awareness");
  const ydoc = new Y.Doc(),
    text = ydoc.getText("content"),
    awareness = new Awareness(ydoc);
  const source = "SARA\nHello.\n\n\n\nEXT. YARD - DAY";
  const position = source.indexOf("\n\n\n\n") + 2;
  text.insert(0, source);
  const page = render(
    <MarkdownEditor
      ydoc={ydoc}
      provider={{ awareness } as any}
      editable
      id="fountain-live-speaker"
      path="Rehearsal.fountain"
      onChange={() => {}}
      onComment={() => {}}
      onUpload={() => {}}
    />,
  );
  try {
    const view = EditorView.findFromDOM(
      page.container.querySelector(".cm-editor")!,
    )!;
    await act(async () => {
      view.focus();
      view.dispatch({
        changes: { from: position, insert: "S" },
        selection: { anchor: position + 1 },
        userEvent: "input.type",
      });
    });
    assert.equal(
      view.state.facet(fountainScript)!.lines[
        view.state.doc.lineAt(position).number - 1
      ].kind,
      "action",
      "One capital must stay ordinary text",
    );
    await act(async () => {
      view.dispatch({
        changes: { from: position + 1, insert: "A" },
        selection: { anchor: position + 2 },
        userEvent: "input.type",
      });
    });
    assert.ok(
      [...page.container.querySelectorAll(".fountain-character")].some(
        (node) => node.textContent === "SA",
      ),
      "Two capitals must trigger speaker formatting",
    );
    await act(async () => {
      view.dispatch({
        changes: { from: position + 1, to: position + 2 },
        selection: { anchor: position + 1 },
        userEvent: "delete.backward",
      });
    });
    assert.equal(
      view.state.facet(fountainScript)!.lines[
        view.state.doc.lineAt(position).number - 1
      ].kind,
      "action",
      "Deleting back to one capital must restore ordinary text",
    );
    await act(async () => {
      view.dispatch({
        changes: { from: position + 1, insert: "ARA" },
        selection: { anchor: position + 4 },
        userEvent: "input.type",
      });
    });
    await waitFor(() =>
      assert.equal(
        [...page.container.querySelectorAll(".fountain-character")].filter(
          (node) => node.textContent === "SARA",
        ).length,
        2,
        "A new all-caps speaker must format before any dialogue has been typed",
      ),
    );
    await act(async () => {
      fireEvent.keyDown(view.contentDOM, { key: "Enter" });
    });
    const current = view.state.doc.lineAt(view.state.selection.main.head);
    assert.equal(
      view.state.facet(fountainScript)!.lines[current.number - 1].kind,
      "dialogue",
      "The blank line after a new cue must remain ready for dialogue",
    );
    assert.equal(
      text.toString(),
      source.slice(0, position) + "SARA\n" + source.slice(position),
      "Drafting presentation must preserve the exact source line breaks",
    );
  } finally {
    page.unmount();
    awareness.destroy();
    ydoc.destroy();
  }
});

test("Fountain speaker pointer acceptance writes to Yjs and respects a revoked edit permission", async () => {
  const { MarkdownEditor } = await import("../src/editor.tsx");
  const { EditorView } = await import("@codemirror/view");
  const { currentCompletions } = await import("@codemirror/autocomplete");
  const { Awareness } = await import("y-protocols/awareness");
  const ydoc = new Y.Doc(),
    text = ydoc.getText("content"),
    awareness = new Awareness(ydoc);
  const source = "@Morgan\nHello.\n\nSARA\nAgain.\n\n";
  text.insert(0, source);
  const props = {
    ydoc,
    provider: { awareness } as any,
    id: "fountain-completion-permission",
    path: "Completion.fountain",
    onChange() {},
    onComment() {},
    onUpload() {},
  };
  const page = render(<MarkdownEditor {...props} editable />);
  try {
    const view = EditorView.findFromDOM(
      page.container.querySelector(".cm-editor")!,
    )!;
    async function typePrefix() {
      await act(async () => {
        view.focus();
        view.dispatch({
          changes: { from: source.length, insert: "MO" },
          selection: { anchor: source.length + 2 },
          userEvent: "input.type",
        });
      });
      await waitFor(() =>
        assert.deepEqual(
          currentCompletions(view.state).map(({ label }) => label),
          ["Morgan"],
        ),
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
      });
      const option = page.container.querySelector(
        ".cm-tooltip-autocomplete li",
      );
      assert.ok(option, "The known speaker must have a visible menu item");
      return option;
    }
    const option = await typePrefix();
    await act(async () => {
      fireEvent.mouseDown(option);
    });
    assert.equal(text.toString(), source + "@Morgan");
    await act(async () => {
      view.dispatch({
        changes: { from: source.length, to: view.state.doc.length },
        selection: { anchor: source.length },
      });
    });
    const revokedOption = await typePrefix();
    page.rerender(<MarkdownEditor {...props} editable={false} />);
    await act(async () => {
      fireEvent.mouseDown(revokedOption);
      fireEvent.keyDown(view.contentDOM, { key: "Tab" });
    });
    assert.equal(text.toString(), source + "MO");
    assert.equal(view.state.doc.toString(), text.toString());
  } finally {
    page.unmount();
    awareness.destroy();
    ydoc.destroy();
  }
});

test("choosing the Fountain Character element immediately offers known speakers", async () => {
  const { MarkdownEditor } = await import("../src/editor.tsx");
  const { EditorView } = await import("@codemirror/view");
  const { currentCompletions } = await import("@codemirror/autocomplete");
  const { Awareness } = await import("y-protocols/awareness");
  const ydoc = new Y.Doc(),
    text = ydoc.getText("content"),
    awareness = new Awareness(ydoc);
  const source = "SARA\nHello.\n\n@Morgan\nAgain.\n\n";
  text.insert(0, source);
  const ref = React.createRef<any>();
  const page = render(
    <MarkdownEditor
      ref={ref}
      ydoc={ydoc}
      provider={{ awareness } as any}
      editable
      id="fountain-character-element-completion"
      path="Completion.fountain"
      onChange={() => {}}
      onComment={() => {}}
      onUpload={() => {}}
    />,
  );
  try {
    const view = EditorView.findFromDOM(
      page.container.querySelector(".cm-editor")!,
    )!;
    await act(async () => {
      view.dispatch({ selection: { anchor: source.length } });
      ref.current.formatFountain("character");
    });
    assert.equal(text.toString(), source + "@");
    await waitFor(() =>
      assert.deepEqual(
        currentCompletions(view.state).map(({ label }) => label),
        ["Morgan", "SARA"],
      ),
    );
  } finally {
    page.unmount();
    awareness.destroy();
    ydoc.destroy();
  }
});

test("measured viewport and footer visibility survive keyboard resize, rotation and Done", async () => {
  const { protectTouchViewport } = await import("../src/touch-viewport");
  const vv = Object.getOwnPropertyDescriptor(window, "visualViewport");
  const standalone = Object.getOwnPropertyDescriptor(navigator, "standalone");
  const rect = HTMLElement.prototype.getBoundingClientRect;
  const computed = window.getComputedStyle;
  const width = window.innerWidth;
  try {
    for (const profile of [
      {
        full: 844,
        top: 59,
        bottom: 34,
        visible: 751,
      },
      { full: 812, top: 0, bottom: 0, visible: 812 },
      { full: 844, top: 0, bottom: 0, visible: 844 },
    ]) {
      window.innerWidth = 390;
      const viewport = Object.assign(new window.EventTarget(), {
        height: profile.visible,
        offsetTop: 0,
      });
      Object.defineProperty(window, "visualViewport", {
        value: viewport,
        configurable: true,
      });
      Object.defineProperty(navigator, "standalone", {
        value: true,
        configurable: true,
      });
      HTMLElement.prototype.getBoundingClientRect = function () {
        if (!this.hasAttribute("data-viewport-gauge")) return rect.call(this);
        return new DOMRect(0, 0, 0, profile.full);
      };
      window.getComputedStyle = function (element, pseudo) {
        return element.hasAttribute("data-viewport-gauge")
          ? ({
              paddingTop: profile.top + "px",
              paddingBottom: profile.bottom + "px",
            } as CSSStyleDeclaration)
          : computed.call(window, element, pseudo);
      };
      const input = document.createElement("textarea");
      document.body.append(input);
      const stop = protectTouchViewport(document),
        root = document.documentElement;
      try {
        assert.equal(
          root.style.getPropertyValue("--app-viewport-height"),
          `${profile.full}px`,
        );
        assert.ok(!root.hasAttribute("data-keyboard-open"));
        input.focus();
        assert.ok(!root.hasAttribute("data-keyboard-open"));
        viewport.height = 466;
        viewport.dispatchEvent(new window.Event("resize"));
        assert.ok(root.hasAttribute("data-keyboard-open"));
        // Chrome may resize CSS units too; that must not become the idle height.
        profile.full = 430;
        viewport.height = 430;
        viewport.dispatchEvent(new window.Event("resize"));
        assert.ok(root.hasAttribute("data-keyboard-open"));
        // Rotating with an open content-resizing keyboard still hides the footer.
        window.innerWidth = 844;
        profile.full = 250;
        profile.top = profile.bottom = 0;
        viewport.height = 250;
        window.dispatchEvent(new window.Event("resize"));
        assert.ok(root.hasAttribute("data-keyboard-open"));
        profile.full = 390;
        viewport.height = 390;
        viewport.dispatchEvent(new window.Event("resize"));
        assert.ok(document.activeElement === input);
        assert.ok(!root.hasAttribute("data-keyboard-open"));
        assert.equal(
          root.style.getPropertyValue("--app-viewport-height"),
          "390px",
        );
        input.blur();
      } finally {
        stop();
        input.remove();
      }
      assert.ok(
        document.querySelector("[data-viewport-gauge]") === null,
        "Viewport gauge should be removed during cleanup.",
      );
      assert.ok(!root.hasAttribute("data-keyboard-open"));
    }
  } finally {
    window.innerWidth = width;
    HTMLElement.prototype.getBoundingClientRect = rect;
    window.getComputedStyle = computed;
    if (vv) Object.defineProperty(window, "visualViewport", vv);
    else Reflect.deleteProperty(window, "visualViewport");
    if (standalone) Object.defineProperty(navigator, "standalone", standalone);
    else Reflect.deleteProperty(navigator, "standalone");
  }
});

test("file comment syntax matches the backend fixtures and does not count as prose", () => {
  assert.equal(
    countMarkdownWords("wor[[comment(alex): note]]\n[[comment(ana): reply]]d"),
    1,
  );
  assert.equal(
    countMarkdownWords(
      "wor[[comment(alex): note]]\n\n[[comment(ana): separate]]d",
    ),
    1,
  );
  const cases = JSON.parse(
    readFileSync(
      new URL("./fixtures/file-comments.json", import.meta.url),
      "utf8",
    ),
  );
  for (const c of cases)
    assert.deepEqual(
      sourceComments(c.source, documentFormat(c.path) === "text").map(
        (t) => t.messages,
      ),
      c.threads,
      c.name,
    );
  assert.equal(
    countMarkdownWords(
      "Two words[[comment(alex): excluded text]]\n[[comment(ana): excluded reply]]",
    ),
    2,
  );
});

test("a shared visitor chooses a nonempty name without email or losing keyboard focus", () => {
  const chosen: string[] = [];
  render(<NamePrompt onChoose={(name) => chosen.push(name)} />);
  const input = screen.getByLabelText("Your name");
  assert.ok(document.activeElement === input, "Name field receives focus");
  assert.equal(screen.getByRole("button", { name: "Continue" }).disabled, true);
  assert.equal(
    screen.getByRole("link", { name: "Owner login" }).getAttribute("href"),
    "/",
    "the owner can leave the guest name prompt and enter their key",
  );
  const event = new window.Event("cancel", { cancelable: true });
  document.querySelector(".name-dialog")!.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  fireEvent.change(input, { target: { value: "  ana  " } });
  fireEvent.submit(input.closest("form"));
  assert.deepEqual(chosen, ["ana"]);
});

test("raw comment records are hidden from the editor without hiding code examples", async () => {
  const { MarkdownEditor } = await import("../src/editor");
  const { Awareness } = await import("y-protocols/awareness");
  const ydoc = new Y.Doc(),
    text = ydoc.getText("content");
  const raw =
    "Before[[comment(alex): private note]]\n[[comment(ana): reply]]\n\n[[comment(alex): a separate thread]] after.\n\n`[[comment(ana): literal]]`";
  text.insert(0, raw);
  const awareness = new Awareness(ydoc);
  const page = render(
    <MarkdownEditor
      ydoc={ydoc}
      provider={{ awareness } as any}
      editable
      id="source-comment-test"
      onChange={() => {}}
      onComment={() => {}}
      onUpload={() => {}}
    />,
  );
  await waitFor(() => assert.ok(document.querySelector(".cm-content")));
  const visible = document.querySelector(".cm-content")!.textContent!;
  assert.ok(visible.includes("Before") && visible.includes(" after."));
  assert.ok(
    !visible.includes("private note") && !visible.includes("[[comment(alex)"),
  );
  assert.ok(visible.includes("[[comment(ana): literal]]"));
  assert.equal(text.toString(), raw);
  page.unmount();
  awareness.destroy();
  ydoc.destroy();
});

test("the owner uses the configured name even when an old browser stored You", async () => {
  const fetchBefore = globalThis.fetch;
  localStorage.setItem("locdoc.name", "You");
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), location.href).pathname;
    if (path === "/api/config")
      return response({
        owner: true,
        ownerName: "alex",
        root: "/tmp/docs",
        guest: "owner",
        publicUrl: location.origin,
      });
    if (path === "/api/tree") return response({ entries: [] });
    return fetchBefore(input, init);
  };
  try {
    const hook = renderHook(() => useWorkspace());
    await waitFor(() => assert.equal(hook.result.current.name, "alex"));
    assert.equal(hook.result.current.needsName, false);
    hook.unmount();
  } finally {
    globalThis.fetch = fetchBefore;
  }
});

test("a saved owner name reaches the server, presence and new comments at once; a failed save keeps the field", async () => {
  const { createDecoder, readVarUint, readVarUint8Array } =
    await import("lib0/decoding");
  const { Awareness, applyAwarenessUpdate } =
    await import("y-protocols/awareness");
  const fetchBefore = globalThis.fetch;
  const previousUrl = location.href;
  const remembered = localStorage.getItem("locdoc.document");
  let profileFails = true;
  globalThis.fetch = async (input, init = {}) => {
    const path = new URL(String(input), location.href).pathname;
    if (path === "/api/config")
      return response({
        owner: true,
        ownerName: "alex",
        root: "/tmp/docs",
        guest: "owner",
        publicUrl: location.origin,
      });
    if (path === "/api/tree")
      return response({
        entries: [{ id: "a", path: "a.md", kind: "file", modified: 1 }],
      });
    if (path === "/api/profile") {
      const body = JSON.parse(String(init.body));
      requests.push({ path, body });
      return profileFails
        ? new Response(JSON.stringify({ error: "Storage is busy." }), {
            status: 503,
          })
        : response({ name: body.name });
    }
    return fetchBefore(input, init);
  };
  docs = { a: makeDoc("a") };
  history.replaceState(null, "", "/");
  localStorage.setItem("locdoc.document", "a");
  function Live() {
    return <WorkspaceView workspace={useWorkspace()} />;
  }
  const page = render(<Live />);
  try {
    await screen.findByRole("textbox", { name: "Markdown document" });
    // Presence leaves through the document socket once it is connected.
    const socket = sockets.at(-1);
    const sent: Uint8Array[] = [];
    socket.send = (data: Uint8Array) => sent.push(new Uint8Array(data));
    await act(async () => {
      socket.readyState = socket.OPEN = 1;
      socket.onopen();
    });
    const presence = () =>
      sent.flatMap((data) => {
        const decoder = createDecoder(data);
        if (readVarUint(decoder) !== 1) return [];
        const remote = new Awareness(new Y.Doc());
        applyAwarenessUpdate(remote, readVarUint8Array(decoder), null);
        const names = [...remote.getStates().values()].map(
          (state) => state.user?.name,
        );
        remote.destroy();
        return names;
      });
    const profile = () => page.container.querySelector(".profile strong")!;
    await waitFor(() => assert.equal(profile().textContent, "alex"));
    fireEvent.click(page.container.querySelector(".profile")!);
    const field = screen.getByLabelText(
      "Your display name",
    ) as HTMLInputElement;
    const save = screen.getByRole("button", { name: "Save" });
    assert.equal(field.value, "alex");
    assert.equal(
      save.getAttribute("aria-disabled"),
      "true",
      "nothing to save yet",
    );
    fireEvent.change(field, { target: { value: "  Ilya  " } });
    fireEvent.click(save);
    await screen.findByText("Storage is busy.");
    assert.equal(field.value, "  Ilya  ", "a failed save keeps the text");
    assert.equal(profile().textContent, "alex");
    assert.deepEqual(
      requests.filter((r) => r.path === "/api/profile").map((r) => r.body),
      [{ name: "Ilya" }],
      "the name is checked like a presence name before it is sent",
    );
    profileFails = false;
    fireEvent.click(save);
    await waitFor(() => assert.equal(profile().textContent, "Ilya"));
    assert.equal(field.value, "Ilya");
    assert.equal(screen.queryByText("Storage is busy."), null);
    await waitFor(() => assert.equal(presence().at(-1), "Ilya"));
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Add comment (Ctrl Alt M)" }),
    );
    fireEvent.change(await screen.findByLabelText("New comment"), {
      target: { value: "Named at once" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Post" }));
    await waitFor(() =>
      assert.equal(
        requests.find((r) => r.path === "/api/docs/a/comments" && r.body?.body)
          ?.body.name,
        "Ilya",
      ),
    );
  } finally {
    page.unmount();
    globalThis.fetch = fetchBefore;
    history.replaceState(null, "", previousUrl);
    if (remembered) localStorage.setItem("locdoc.document", remembered);
    else localStorage.removeItem("locdoc.document");
  }
});

test("an owner tab coming back shows a name chosen elsewhere, unless a newer save follows", async () => {
  const fetchBefore = globalThis.fetch;
  let ownerName = "alex";
  let holdConfig = false;
  const held: (() => void)[] = [];
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), location.href).pathname;
    if (path === "/api/config") {
      const value = ownerName;
      if (holdConfig) await new Promise<void>((resolve) => held.push(resolve));
      return response({
        owner: true,
        ownerName: value,
        root: "/tmp/docs",
        guest: "owner",
        publicUrl: location.origin,
      });
    }
    if (path === "/api/tree") return response({ entries: [] });
    if (path === "/api/profile")
      return response({ name: JSON.parse(String(init.body)).name });
    return fetchBefore(input, init);
  };
  const hook = renderHook(() => useWorkspace());
  try {
    await waitFor(() => assert.equal(hook.result.current.name, "alex"));
    ownerName = "Ilya";
    await act(async () => {
      window.dispatchEvent(new window.Event("focus"));
    });
    await waitFor(() => assert.equal(hook.result.current.name, "Ilya"));
    // A read that started before this tab saved must not undo the save.
    ownerName = "Stale";
    holdConfig = true;
    await act(async () => {
      window.dispatchEvent(new window.Event("focus"));
    });
    await act(async () => {
      assert.equal(await hook.result.current.saveName(" Bea "), "Bea");
    });
    await act(async () => {
      held.splice(0).forEach((release) => release());
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(hook.result.current.name, "Bea");
  } finally {
    hook.unmount();
    globalThis.fetch = fetchBefore;
  }
});

// An owner workspace whose name /api/config reports, saved by PATCH
// /api/profile once `release` lets each save finish.
function nameWorkspace(first: string) {
  const fetchBefore = globalThis.fetch;
  const workspace = {
    owner: first,
    saves: [] as string[],
    held: [] as (() => void)[],
    restore: () => {
      globalThis.fetch = fetchBefore;
    },
    release: () =>
      act(async () => workspace.held.splice(0).forEach((done) => done())),
    // Another tab saves a name, and this one comes back into view.
    comeBack: (name: string) =>
      act(async () => {
        workspace.owner = name;
        window.dispatchEvent(new window.Event("focus"));
      }),
  };
  globalThis.fetch = async (input, init = {}) => {
    const path = new URL(String(input), location.href).pathname;
    if (path === "/api/config")
      return response({
        owner: true,
        ownerName: workspace.owner,
        root: "/tmp/docs",
        guest: "owner",
        publicUrl: location.origin,
      });
    if (path === "/api/tree") return response({ entries: [] });
    if (path === "/api/profile") {
      const { name } = JSON.parse(String(init.body));
      workspace.saves.push(name);
      await new Promise<void>((resolve) => workspace.held.push(resolve));
      workspace.owner = name;
      return response({ name });
    }
    return fetchBefore(input, init);
  };
  function Live() {
    return <WorkspaceView workspace={useWorkspace()} />;
  }
  return { workspace, page: render(<Live />) };
}

async function openDisplayName(page: ReturnType<typeof render>, name: string) {
  const profile = () => page.container.querySelector(".profile strong")!;
  await waitFor(() => assert.equal(profile().textContent, name));
  fireEvent.click(page.container.querySelector(".profile")!);
  const field = screen.getByLabelText("Your display name") as HTMLInputElement;
  const save = screen.getByRole("button", {
    name: "Save",
  }) as HTMLButtonElement;
  return {
    profile,
    field,
    save,
    // Whether Save does nothing, whichever way it says so.
    blocked: () =>
      save.disabled || save.getAttribute("aria-disabled") === "true",
  };
}

test("an open display name field shows a name chosen elsewhere until something is typed", async () => {
  const { workspace, page } = nameWorkspace("Alex Second");
  try {
    const { profile, field, blocked } = await openDisplayName(
      page,
      "Alex Second",
    );
    assert.ok(blocked(), "nothing to save yet");
    await workspace.comeBack("Alex Third");
    await waitFor(() => assert.equal(profile().textContent, "Alex Third"));
    assert.equal(field.value, "Alex Third", "the field shows the new name");
    assert.ok(blocked(), "Save would put the old name back");
    // What is typed here stays when another name arrives.
    fireEvent.change(field, { target: { value: "Alex Fourth" } });
    await workspace.comeBack("Alex Fifth");
    await waitFor(() => assert.equal(profile().textContent, "Alex Fifth"));
    assert.equal(field.value, "Alex Fourth");
    assert.ok(!blocked());
    fireEvent.submit(field.form!);
    await waitFor(() => assert.equal(workspace.held.length, 1));
    await workspace.release();
    await waitFor(() => assert.equal(profile().textContent, "Alex Fourth"));
    assert.ok(blocked());
    // Once saved, the field follows the name again.
    await workspace.comeBack("Alex Sixth");
    await waitFor(() => assert.equal(profile().textContent, "Alex Sixth"));
    assert.equal(field.value, "Alex Sixth");
    assert.ok(blocked());
    assert.deepEqual(workspace.saves, ["Alex Fourth"]);
  } finally {
    page.unmount();
    workspace.restore();
  }
});

test("saving the display name keeps keyboard focus in Your workspace", async () => {
  const { workspace, page } = nameWorkspace("Alex");
  try {
    const { profile, field, save, blocked } = await openDisplayName(
      page,
      "Alex",
    );
    // A browser moves focus out of the dialog, to the page, from a field or
    // button that becomes disabled.
    const focusable = () => !field.disabled && !save.disabled;
    fireEvent.change(field, { target: { value: "Ilya" } });
    field.focus();
    fireEvent.submit(field.form!);
    await waitFor(() => assert.equal(workspace.held.length, 1));
    assert.equal(save.textContent, "Saving…");
    assert.ok(focusable(), "focus can stay while the name saves");
    assert.ok(field.readOnly && blocked(), "nothing to change meanwhile");
    assert.ok(document.activeElement === field, "focus stays in the field");
    fireEvent.submit(field.form!);
    await workspace.release();
    await waitFor(() => assert.equal(profile().textContent, "Ilya"));
    assert.ok(focusable(), "focus can stay once the name is saved");
    assert.ok(blocked() && !field.readOnly);
    assert.ok(document.activeElement === field, "focus is still in the field");
    fireEvent.submit(field.form!);
    assert.deepEqual(workspace.saves, ["Ilya"], "Enter saves nothing more");
  } finally {
    page.unmount();
    workspace.restore();
  }
});

test("a guest's name saved in Settings stays in this browser and follows the presence rules", async () => {
  const fetchBefore = globalThis.fetch;
  const stored = localStorage.getItem("locdoc.guestName");
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), location.href).pathname;
    if (path === "/api/config")
      return response({ owner: false, root: "", guest: "g", publicUrl: "" });
    return fetchBefore(input, init);
  };
  try {
    localStorage.setItem("locdoc.guestName", "First name");
    const first = renderHook(() => useWorkspace());
    await waitFor(() =>
      assert.equal(first.result.current.config?.owner, false),
    );
    assert.equal(first.result.current.name, "First name");
    await act(async () => {
      await assert.rejects(first.result.current.saveName(" \u0007 "));
    });
    assert.equal(localStorage.getItem("locdoc.guestName"), "First name");
    await act(async () => {
      assert.equal(await first.result.current.saveName("  Ana\u0007  "), "Ana");
    });
    assert.equal(first.result.current.name, "Ana");
    assert.equal(localStorage.getItem("locdoc.guestName"), "Ana");
    assert.ok(
      !requests.some((request) => request.path === "/api/profile"),
      "a guest's name is never sent as the owner's",
    );
    first.unmount();
    const reloaded = renderHook(() => useWorkspace());
    assert.equal(reloaded.result.current.name, "Ana", "kept after a reload");
    reloaded.unmount();
  } finally {
    globalThis.fetch = fetchBefore;
    if (stored === null) localStorage.removeItem("locdoc.guestName");
    else localStorage.setItem("locdoc.guestName", stored);
  }
});

test("trailing source comments do not create another empty heading fragment", async () => {
  const { MarkdownEditor } = await import("../src/editor");
  const { Awareness } = await import("y-protocols/awareness");
  const ydoc = new Y.Doc(),
    text = ydoc.getText("content");
  const heading = "# Heading";
  text.insert(0, heading + "[[comment(alex): A note]]\n\nBody after heading.");
  const awareness = new Awareness(ydoc);
  const thread = {
    ...comment,
    anchor: {
      start: Y.relativePositionToJSON(
        Y.createRelativePositionFromTypeIndex(text, 0),
      ),
      end: Y.relativePositionToJSON(
        Y.createRelativePositionFromTypeIndex(text, heading.length, -1),
      ),
    },
  };
  const page = render(
    <MarkdownEditor
      ydoc={ydoc}
      provider={{ awareness } as any}
      editable
      id="heading-comment"
      onChange={() => {}}
      onComment={() => {}}
      onUpload={() => {}}
      comments={[thread]}
      activeComment="c1"
      conversation={<p>Heading conversation</p>}
    />,
  );
  await screen.findByText("Heading conversation");
  assert.equal(document.querySelectorAll(".cm-line.md-h1").length, 1);
  assert.ok(
    document
      .querySelector(".cm-content")!
      .textContent!.includes("Body after heading."),
  );
  page.unmount();
  awareness.destroy();
  ydoc.destroy();
});
