import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import React, { useState } from "react";
import * as Y from "yjs";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Awareness } from "y-protocols/awareness";
import {
  documentExtension,
  documentFormat,
  documentName,
  documentPath,
  formatLabel,
  isDocumentPath,
} from "../src/document-format";
import { resolveDocumentLink } from "../src/document-links";
import { uploadAttachment } from "../src/document-upload";
import { sourceComments } from "../src/comment-syntax";
import {
  sourceCommentLayer,
  sourceCommentRanges,
  visibleTextRanges,
} from "../src/editor-comments";
import { plainTextSupport } from "../src/plain-text";
import { countDocumentWords } from "../src/word-count";
import type { EditorHandle } from "../src/editor-types";

test("plain text is a third document format", () => {
  assert.equal(documentFormat("Notes/todo.txt"), "text");
  assert.equal(documentFormat("Notes/TODO.TXT"), "text");
  assert.equal(documentFormat("Notes/todo.txt.md"), "markdown");
  assert.equal(documentFormat("Notes/todo.md.txt"), "text");
  assert.equal(documentFormat("Script.fountain"), "fountain");
  assert.equal(documentName("Notes/todo.txt"), "todo");
  assert.equal(documentExtension("Notes/todo.TXT"), ".txt");
  assert.equal(documentPath("Notes/todo", "text"), "Notes/todo.txt");
  assert.equal(documentPath("Notes/todo.txt", "markdown"), "Notes/todo.txt");
  assert.equal(documentPath("Notes/todo", "markdown"), "Notes/todo.md");
  assert.equal(formatLabel("text"), "Plain text");
  for (const path of ["a.md", "b.fountain", "c.txt", "D.TXT"])
    assert.equal(isDocumentPath(path), true, path);
  for (const path of ["a.png", "b.text", "c.txt.bak", "txt"])
    assert.equal(isDocumentPath(path), false, path);
  const entries = [
    {
      id: "t",
      path: "Notes/todo.txt",
      kind: "file",
      shared: false,
      url: "/d/t",
    },
  ] as const;
  assert.equal(
    resolveDocumentLink("todo.txt", "Notes/Plan.md", [...entries]),
    "/d/t",
    "Markdown can link to a plain-text document",
  );
});

test("plain-text word counts read every visible word, not Markdown syntax", () => {
  const source =
    "# Title with ![alt](image.png) and **bold**\n[[comment(ana): hidden words here]]\n`code` [link](target.md)";
  // Title, with, alt, image.png, and, bold, code, link, target.md
  assert.equal(countDocumentWords(source, "Notes/plain.txt"), 9);
  assert.equal(
    countDocumentWords(source, "Notes/plain.md"),
    6,
    "Markdown hides media destinations and link targets",
  );
  assert.equal(countDocumentWords("", "empty.txt"), 0);
});

test("uploads never reach a plain-text document", async () => {
  const ydoc = new Y.Doc();
  ydoc.getText("content").insert(0, "notes");
  const fetches: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetches.push(String(input));
    return new Response("{}");
  }) as typeof fetch;
  try {
    for (const path of ["Notes/plain.txt", "Script.fountain"])
      await assert.rejects(
        uploadAttachment(new Blob(["png"], { type: "image/png" }) as File, {
          doc: { id: "doc", path, edit: true } as any,
          session: { id: "doc", ydoc } as any,
          editor: { current: null },
          accessQuery: "",
          setDoc: () => {},
          tell: () => {},
        }),
        /Use a Markdown document for images and videos\./,
        path,
      );
  } finally {
    globalThis.fetch = realFetch;
    ydoc.destroy();
  }
  assert.deepEqual(fetches, [], "no upload request is sent");
  assert.equal(ydoc.getText("content").toString(), "notes");
});

function layoutRows(state: EditorState) {
  const rows: number[] = [];
  for (const set of state.facet(EditorView.decorations)) {
    if (typeof set === "function") continue;
    for (let cursor = set.iter(); cursor.value; cursor.next())
      if (cursor.value.spec.class === "text-block-end") rows.push(cursor.from);
  }
  return rows.sort((a, b) => a - b).join(",");
}
function plainState(doc: string) {
  return EditorState.create({
    doc,
    extensions: [sourceCommentLayer, plainTextSupport],
  });
}

test("plain-text paragraph spacing follows visible lines through edits", () => {
  let state = plainState(
    "First line\n\n[[comment(ana): only a record]]\nSecond [[comment(ben): inline]] line\n   \nLast",
  );
  const lineStarts = (text: string) =>
    text
      .split("\n")
      .map((line, index, lines) => ({
        line,
        from: lines.slice(0, index).join("\n").length + (index ? 1 : 0),
      }))
      .filter(({ line }) =>
        line.replace(/\[\[comment\([^)]*\): [^\]]*\]\]/g, "").trim(),
      )
      .map(({ from }) => from)
      .join(",");
  assert.equal(layoutRows(state), lineStarts(state.doc.toString()));
  const edit = (spec: TransactionSpec, label: string) => {
    state = state.update(spec).state;
    assert.equal(
      layoutRows(state),
      layoutRows(plainState(state.doc.toString())),
      label,
    );
  };
  edit({ changes: { from: 0, insert: "Prefix\n" } }, "insert a line");
  edit(
    {
      changes: { from: state.doc.toString().indexOf("\n\n") + 1, insert: "x" },
    },
    "fill an empty line",
  );
  edit(
    {
      changes: {
        from: state.doc.toString().indexOf("Second"),
        to: state.doc.toString().indexOf("Second") + 7,
      },
    },
    "delete text before an inline record",
  );
  edit(
    {
      changes: {
        from: state.doc.toString().indexOf("[[comment(ana)"),
        insert: "\\",
      },
    },
    "escape a standalone record",
  );
  edit(
    { changes: { from: 0, to: state.doc.length, insert: "One\nTwo" } },
    "replace everything",
  );
});

// The lines a reader sees: hidden records and the line breaks they hide are
// gone, and each line notes whether it ends a paragraph.
function displayedLines(state: EditorState) {
  const hidden = sourceCommentRanges(state);
  const ends = new Set(
    layoutRows(state).split(",").filter(Boolean).map(Number),
  );
  const lines: string[] = [];
  for (let number = 1; number <= state.doc.lines; number++) {
    const line = state.doc.line(number);
    const text = visibleTextRanges(state, line.from, line.to)
      .map((range) => state.sliceDoc(range.from, range.to))
      .join("");
    if (hidden.some((range) => range.from < line.from && line.from <= range.to))
      lines[lines.length - 1] += text;
    else lines.push(`${ends.has(line.from) ? "paragraph" : "line"}: ${text}`);
  }
  return lines;
}

test("comments the server adds to plain text show no new line, as in the shared fixtures", () => {
  const cases = JSON.parse(
    readFileSync(
      new URL("./fixtures/file-comments.json", import.meta.url),
      "utf8",
    ),
  ).filter((c: any) => c.comment);
  assert.ok(cases.some((c: any) => documentFormat(c.path) === "text"));
  for (const c of cases) {
    const plain = documentFormat(c.path) === "text";
    const threads = sourceComments(c.comment.expected, plain);
    assert.equal(threads.length, c.threads.length + 1, c.name);
    assert.ok(
      threads.some(
        (thread) =>
          thread.messages.length === 1 &&
          thread.messages[0].name === "ana" &&
          thread.messages[0].body === "A note",
      ),
      `${c.name}: the new comment is its own conversation`,
    );
    if (plain)
      assert.deepEqual(
        displayedLines(plainState(c.comment.expected)),
        displayedLines(plainState(c.source)),
        c.name,
      );
  }
});

let dom: JSDOM;
let render: typeof import("@testing-library/react").render;
let cleanup: typeof import("@testing-library/react").cleanup;
let act: typeof import("@testing-library/react").act;
let screen: typeof import("@testing-library/react").screen;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let waitFor: typeof import("@testing-library/react").waitFor;
let WorkspaceView: typeof import("../src/app").WorkspaceView;
let useAppearance: typeof import("../src/appearance").useAppearance;
let useFileActions: typeof import("../src/file-actions").useFileActions;
let MarkdownEditor: typeof import("../src/editor").MarkdownEditor;
const sockets: any[] = [];
const requests: { path: string; method: string }[] = [];
let docs: Record<string, any> = {};
const response = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
const originalFetch = globalThis.fetch;

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
    "HTMLImageElement",
    "MutationObserver",
    "DOMRect",
    "File",
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
  dom.window.Range.prototype.getClientRects = () => [] as any;
  dom.window.Range.prototype.getBoundingClientRect = () =>
    new dom.window.DOMRect();
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as any;
  globalThis.WebSocket = class {
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = 0;
    onclose: any;
    constructor() {
      sockets.push(this);
    }
    send() {}
    close() {
      this.readyState = 3;
      this.onclose?.({});
    }
  } as any;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  ({ render, cleanup, act, screen, fireEvent, waitFor } =
    await import("@testing-library/react"));
  ({ WorkspaceView } = await import("../src/app"));
  ({ useAppearance } = await import("../src/appearance"));
  ({ useFileActions } = await import("../src/file-actions"));
  ({ MarkdownEditor } = await import("../src/editor"));
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init: RequestInit = {},
  ) => {
    const path = new URL(String(input), location.href).pathname;
    requests.push({ path, method: init.method || "GET" });
    if (path === "/api/fonts" || path === "/font-catalog.json")
      return response({ fonts: [] });
    if (path === "/api/mcp/connections") return response({ connections: [] });
    const id = path.match(/^\/api\/docs\/([^/]+)$/)?.[1];
    if (id && docs[id]) return response(docs[id]);
    if (path.endsWith("/comments")) return response({ comments: [] });
    return response({});
  }) as typeof fetch;
});
afterEach(() => {
  cleanup();
  sockets.length = 0;
  requests.length = 0;
});
after(() => {
  globalThis.fetch = originalFetch;
  dom.window.close();
});

const plainSource =
  '# Not a heading\n\n![photo](photo.png)\n\nInline ![logo](logo.png "Logo") and **bold** and [a link](Other.md).\n\n- [ ] not a task\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nAnnotated[[comment(ana): Keep this record]] text.';

function mountEditor(path: string, editable = true, source = plainSource) {
  const ydoc = new Y.Doc();
  const text = ydoc.getText("content");
  text.insert(0, source);
  const awareness = new Awareness(ydoc);
  const ref = React.createRef<EditorHandle>();
  const uploads: File[] = [];
  const props = {
    ydoc,
    provider: { awareness } as any,
    id: "plain-fixture",
    token: "media-token",
    onChange() {},
    onComment() {},
    onUpload(file: File) {
      uploads.push(file);
    },
  };
  const page = render(
    <MarkdownEditor {...props} ref={ref} path={path} editable={editable} />,
  );
  const view = EditorView.findFromDOM(
    page.container.querySelector(".cm-editor")!,
  )!;
  return {
    page,
    props,
    ref,
    text,
    view,
    uploads,
    close() {
      page.unmount();
      awareness.destroy();
      ydoc.destroy();
    },
  };
}

function assertPlainSurface(container: HTMLElement, label: string) {
  for (const selector of [
    // CodeMirror's own cursor buffers beside hidden records are images too.
    "img:not(.cm-widgetBuffer)",
    "video",
    ".embed",
    ".embed-inline",
    ".md-h1",
    ".md-strong",
    ".md-link",
    "a[data-link-url]",
    ".md-task-checkbox",
    ".md-table-preview",
    ".md-list",
  ])
    assert.equal(
      container.querySelectorAll(selector).length,
      0,
      `${label}: ${selector} must not render in plain text`,
    );
}

test("a .txt document edits as plain text, never as Markdown or media", async () => {
  for (const editable of [true, false]) {
    const fixture = mountEditor("Notes/plain.txt", editable);
    try {
      const input = fixture.page.getByRole("textbox", {
        name: "Plain text document",
      });
      assert.equal(input.getAttribute("contenteditable"), String(editable));
      assert.ok(fixture.view.dom.classList.contains("text-editor"));
      assertPlainSurface(fixture.page.container, `editable=${editable}`);
      assert.ok(
        !input.textContent!.includes("Keep this record"),
        "comment records stay hidden in plain text",
      );
      assert.ok(input.textContent!.includes("![photo](photo.png)"));
      // Moving across every line never reveals media either.
      for (let line = 1; line <= fixture.view.state.doc.lines; line++)
        act(() =>
          fixture.view.dispatch({
            selection: { anchor: fixture.view.state.doc.line(line).from },
          }),
        );
      assertPlainSurface(fixture.page.container, `after moving, ${editable}`);
    } finally {
      fixture.close();
    }
  }
});

test("renaming between Markdown and plain text switches which records are literal", async () => {
  const source = "Use `x[[comment(ana): Hidden in plain text]]` here.";
  const fixture = mountEditor("Notes/plain.txt", true, source);
  const rename = (path: string) =>
    fixture.page.rerender(
      <MarkdownEditor
        {...fixture.props}
        ref={fixture.ref}
        path={path}
        editable
      />,
    );
  const shown = () => fixture.view.contentDOM.textContent!;
  try {
    assert.ok(!shown().includes("Hidden in plain text"), "plain text hides it");
    rename("Notes/plain.md");
    assert.ok(
      shown().includes("[[comment(ana): Hidden in plain text]]"),
      "Markdown code keeps it literal",
    );
    rename("Notes/plain.txt");
    assert.ok(!shown().includes("Hidden in plain text"), "hidden again");
    assert.equal(fixture.text.toString(), source);
  } finally {
    fixture.close();
  }
});

test("renaming between Markdown and plain text switches the editing mode", async () => {
  const fixture = mountEditor("Notes/plain.md");
  try {
    act(() =>
      fixture.view.dispatch({ selection: { anchor: plainSource.length } }),
    );
    assert.ok(fixture.page.container.querySelector(".embed img"));
    assert.ok(fixture.page.container.querySelector(".embed-inline img"));
    fixture.page.rerender(
      <MarkdownEditor
        {...fixture.props}
        ref={fixture.ref}
        path="Notes/plain.txt"
        editable
      />,
    );
    assertPlainSurface(fixture.page.container, "renamed to .txt");
    assert.ok(
      EditorView.findFromDOM(
        fixture.page.container.querySelector(".cm-editor")!,
      ) === fixture.view,
      "a rename keeps the same editor and its history",
    );
    fixture.page.rerender(
      <MarkdownEditor
        {...fixture.props}
        ref={fixture.ref}
        path="Notes/plain.md"
        editable
      />,
    );
    assert.ok(fixture.page.container.querySelector(".embed img"));
    assert.equal(fixture.text.toString(), plainSource);
  } finally {
    fixture.close();
  }
});

test("plain text ignores Markdown commands and keeps hidden comment records atomic", async () => {
  const fixture = mountEditor("Notes/plain.txt");
  try {
    const before = fixture.text.toString();
    act(() => fixture.view.dispatch({ selection: { anchor: 2, head: 10 } }));
    act(() => {
      fixture.ref.current!.wrap("**", "**");
      fixture.ref.current!.wrap("## ");
      fixture.ref.current!.toggleTasks();
      fixture.ref.current!.insertTable(2, 2);
      fixture.ref.current!.insertLink(
        "/d/x",
        "x",
        fixture.ref.current!.selection().anchor,
      );
    });
    assert.equal(fixture.text.toString(), before, "no Markdown is inserted");
    const modK = new window.KeyboardEvent("keydown", {
      key: "k",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    fixture.view.contentDOM.dispatchEvent(modK);
    assert.equal(modK.defaultPrevented, false, "Mod-k opens no link picker");
    const recordEnd =
      before.indexOf("Keep this record]]") + "Keep this record]]".length;
    act(() => fixture.view.dispatch({ selection: { anchor: recordEnd } }));
    act(() => {
      fixture.view.contentDOM.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Backspace",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    assert.ok(
      fixture.text.toString().includes("[[comment(ana): Keep this record]]"),
      "Backspace after a hidden record never deletes it",
    );
  } finally {
    fixture.close();
  }
});

function WorkspaceFixture() {
  const appearance = useAppearance();
  const [id, setId] = useState("plain");
  const entries = Object.values(docs).map((doc: any) => ({
    path: doc.path,
    id: doc.id,
    kind: "file" as const,
    shared: false,
  }));
  const navigate = async (
    from: string | null,
    next: string | null,
    prepare: () => Promise<void>,
  ) => {
    await prepare();
    setId((current) => (current === from ? (next ?? current) : current));
    return true;
  };
  // The sidebar's file actions belong to the workspace.
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
          name: "Owner",
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

function makeDoc(id: string, path: string, content: string) {
  const ydoc = new Y.Doc();
  ydoc.getText("content").insert(0, content);
  return {
    id,
    path,
    owner: true,
    edit: true,
    permission: "private",
    shareUrl: null,
    usage: 0,
    content,
    modified: 0,
    hiddenMedia: [{ path: "photo.png", reason: "unapproved" }],
    state: Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString("base64"),
  };
}

test("the workspace offers plain text no formatting, media or link tools", async () => {
  docs = { plain: makeDoc("plain", "Notes/plain.txt", plainSource) };
  const page = render(<WorkspaceFixture />);
  try {
    const input = await screen.findByRole("textbox", {
      name: "Plain text document",
    });
    const formatbar = page.container.querySelector(".formatbar")!;
    assert.equal(formatbar.getAttribute("data-format"), "text");
    for (const name of [
      "Bold",
      "Italic",
      "Heading",
      "Insert link (Ctrl K)",
      "Insert local image or video",
      "Bulleted list",
      "Todo list",
    ])
      assert.equal(
        formatbar.querySelectorAll(`[aria-label="${name}"]`).length,
        0,
        `${name} is not offered for plain text`,
      );
    assert.equal(formatbar.querySelectorAll(".table-picker").length, 0);
    assert.ok(
      formatbar.querySelector('[aria-label="Add comment (Ctrl Alt M)"]'),
      "comments work in plain text",
    );
    assert.equal(
      page.container.querySelector(".markdown-tag")!.textContent,
      "Plain text",
    );
    assert.equal(page.container.querySelector(".attachment-usage"), null);
    const view = EditorView.findFromDOM(input)!;
    const file = new window.File(["png"], "pasted.png", { type: "image/png" });
    const paste = new window.Event("paste", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(paste, "clipboardData", {
      value: { files: [file], types: ["Files"], getData: () => "" },
    });
    act(() => {
      view.contentDOM.dispatchEvent(paste);
    });
    await waitFor(() =>
      assert.ok(
        page.container.textContent!.includes(
          "Use a Markdown document for images and videos.",
        ),
      ),
    );
    assert.equal(
      requests.filter((request) => request.path.endsWith("/upload")).length,
      0,
      "a pasted file is never uploaded into plain text",
    );
    assert.equal(view.state.doc.toString(), plainSource);
    fireEvent.click(screen.getByRole("button", { name: "Document options" }));
    const dialog = page.container.querySelector("dialog")!;
    await waitFor(() => assert.equal(dialog.open, true));
    assert.equal(dialog.querySelectorAll(".formatting-menu").length, 0);
    assert.equal(dialog.querySelectorAll(".attachment-info").length, 0);
    assert.ok(dialog.textContent!.includes("Download plain text"));
    assert.ok(
      dialog.textContent!.includes("Change the folder path to move."),
      "plain text can still be renamed or moved here",
    );
    assert.ok(
      !dialog.textContent!.includes("attachment links"),
      "plain text has no attachment links that a move could break",
    );
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    const loads = requests.filter(
      (request) => request.path === "/api/docs/plain",
    ).length;
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await waitFor(() => assert.equal(dialog.open, true));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.equal(
      requests.filter((request) => request.path === "/api/docs/plain").length,
      loads,
      "plain text has no media to approve for link visitors",
    );
    assert.equal(dialog.querySelector(".hidden-media"), null);
  } finally {
    page.unmount();
  }
});
