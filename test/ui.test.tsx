import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";
import React, { useState } from "react";
import * as Y from "yjs";
import { countMarkdownWords } from "../src/word-count";
import { sourceComments } from "../src/comment-syntax";
import { readFileSync } from "node:fs";
import { NamePrompt } from "../src/name-prompt";

let render, renderHook, act, fireEvent, screen, waitFor, cleanup;
let WorkspaceView,
  VersionHistory,
  CommentThread,
  CommentComposer,
  RenameDocument,
  useAppearance,
  useWorkspace;
let originalFetch, dom;
const requests: { path: string; body: any }[] = [];
const held = new Map<string, () => void>();
let delayShare = false,
  delayComment = false,
  failReply = false,
  failBootstrap = false;
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
    if (failBootstrap && path === "/api/config")
      return new Response(JSON.stringify({ error: "Config unavailable" }), {
        status: 503,
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
      return response({ comments: [comment] });
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
    if (path.endsWith("/comments/c1"))
      return failReply
        ? new Response(JSON.stringify({ error: "Outage" }), { status: 503 })
        : response(comment);
    return response({});
  };
});
afterEach(() => {
  cleanup();
  requests.length = 0;
  held.clear();
  delayShare = delayComment = failReply = failBootstrap = false;
});
after(() => {
  globalThis.fetch = originalFetch;
  dom.window.close();
});

function WorkspaceFixture() {
  const appearance = useAppearance();
  const [id, setId] = useState("a");
  return (
    <WorkspaceView
      workspace={
        {
          appearance,
          id,
          async navigate(from, next, prepare) {
            await prepare();
            setId((current) => (current === from ? next : current));
            return true;
          },
          config: {
            owner: true,
            guest: "test",
            root: "/tmp/fixture",
            publicUrl: "http://localhost",
          },
          entries: Object.values(docs).map((doc: any) => ({
            path: doc.path,
            id: doc.id,
            kind: "file",
            shared: true,
          })),
          initialDocument: null,
          error: "",
          name: "Reviewer",
          setName() {},
          sidebar: true,
          setSidebar() {},
          query: "",
          setQuery() {},
          collapsed: new Set(),
          setCollapsed() {},
          scope: "all",
          setScope() {},
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
async function chooseB() {
  fireEvent.click(screen.getByRole("button", { name: "b .md", exact: true }));
  await waitFor(() => assert.equal(document.title, "b · locdoc"));
  await waitFor(() =>
    assert.ok(
      screen
        .getByRole("textbox", { name: "Markdown document" })
        .textContent.includes("b text"),
    ),
  );
}
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
      onRestore={() => {}}
    />,
  );
  await screen.findAllByRole("option", { name: /3 bytes/ });
  fireEvent.change(screen.getByLabelText("Saved version"), {
    target: { value: "old" },
  });
  await waitFor(() => assert.equal(held.has("old"), true));
  fireEvent.change(screen.getByLabelText("Saved version"), {
    target: { value: "new" },
  });
  await screen.findByText("NEW CONTENT");
  held.get("old")!();
  await waitFor(() =>
    assert.equal(
      document.querySelector(".version-preview")!.textContent,
      "NEW CONTENT",
    ),
  );
  fireEvent.click(screen.getByText("Restore this version"));
  await waitFor(() =>
    assert.ok(
      requests.some(
        (request) => request.path === "/api/docs/a/versions/new/restore",
      ),
    ),
  );
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
test("rename owns a fresh input independent of the create form", () => {
  render(
    <RenameDocument
      path="original.md"
      endpoint="/api/docs/a"
      onRename={() => {}}
    />,
  );
  const input = screen.getByLabelText("Rename document");
  fireEvent.change(input, { target: { value: "" } });
  assert.equal(input.value, "");
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
    assert.equal(profile("fountain").scrollPastEnd, true);
    act(() => {
      profile("fountain").setFontSize(16);
      profile("fountain").setLineHeight(1.4);
      profile("fountain").setPageWidth(900);
      profile("markdown").setFont("Georgia");
      profile("markdown").setParagraphSpacing(0.3);
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

test("touch zoom is blocked while single-finger scrolling remains available", async () => {
  const { protectTouchViewport } = await import("../src/touch-viewport.ts");
  const stop = protectTouchViewport(document);
  const touch = (count: number) => {
    const event = new window.Event("touchmove", { cancelable: true });
    Object.defineProperty(event, "touches", { value: Array(count).fill({}) });
    document.dispatchEvent(event);
    return event.defaultPrevented;
  };
  assert.equal(touch(1), false);
  assert.equal(touch(2), true);
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
      sourceComments(c.source).map((t) => t.messages),
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
