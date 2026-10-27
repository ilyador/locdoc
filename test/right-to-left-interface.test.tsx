import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React from "react";
import * as Y from "yjs";
import { EditorView } from "@codemirror/view";
import { openSearchPanel } from "@codemirror/search";
import { Awareness } from "y-protocols/awareness";
import { isolate, isolateName, isolatePath } from "../src/bidi";
import type { EditorHandle } from "../src/editor-types";
import { fileApi } from "./fixtures/file-api.ts";

// The isolates that keep a name in its own direction inside a sentence.
const FSI = "\u{2068}";
const PDI = "\u{2069}";

let dom: JSDOM;
let render: typeof import("@testing-library/react").render;
let cleanup: typeof import("@testing-library/react").cleanup;
let act: typeof import("@testing-library/react").act;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let waitFor: typeof import("@testing-library/react").waitFor;
let screen: typeof import("@testing-library/react").screen;
let MarkdownEditor: typeof import("../src/editor").MarkdownEditor;
let originalFetch: typeof fetch;

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
    "HTMLInputElement",
    "HTMLVideoElement",
    "HTMLImageElement",
    "MutationObserver",
    "DOMRect",
    "Event",
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
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  originalFetch = globalThis.fetch;
  ({ render, cleanup, act, fireEvent, waitFor, screen } =
    await import("@testing-library/react"));
  ({ MarkdownEditor } = await import("../src/editor"));
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  for (const key of ["locdoc.sidebarView", "locdoc.document"])
    localStorage.removeItem(key);
});
after(() => dom.window.close());

function mount(
  path: string,
  source: string,
  props: Partial<React.ComponentProps<typeof MarkdownEditor>> = {},
) {
  const ydoc = new Y.Doc();
  const text = ydoc.getText("content");
  text.insert(0, source);
  const awareness = new Awareness(ydoc);
  const ref = React.createRef<EditorHandle>();
  const page = render(
    <MarkdownEditor
      ydoc={ydoc}
      provider={{ awareness } as any}
      id="rtl-fixture"
      editable={true}
      path={path}
      ref={ref}
      onChange={() => {}}
      onComment={() => {}}
      onUpload={() => {}}
      {...props}
    />,
  );
  const view = EditorView.findFromDOM(
    page.container.querySelector(".cm-editor")!,
  )!;
  return {
    page,
    text,
    view,
    close() {
      page.unmount();
      awareness.destroy();
      ydoc.destroy();
    },
  };
}

// Each rendered line as "direction: text", with a blank line as "(blank)".
function lines(view: EditorView) {
  return Array.from(
    view.contentDOM.querySelectorAll<HTMLElement>(".cm-line"),
    (line) =>
      `${line.getAttribute("dir") || "ltr"}: ${line.textContent || "(blank)"}`,
  );
}

test("names and paths inside sentences keep their own direction", () => {
  assert.equal(isolate("Plan.md"), "Plan.md", "English text is unchanged");
  assert.equal(isolate("שמן זית"), `${FSI}שמן זית${PDI}`);
  assert.equal(
    isolateName("שמן זית.md"),
    `${FSI}שמן זית${PDI}.md`,
    "The extension stays after the title, as the sidebar shows it",
  );
  assert.equal(
    isolatePath("Notes/ארכיון/אוכל/שמן זית.md"),
    `Notes/${FSI}ארכיון${PDI}/${FSI}אוכל${PDI}/${FSI}שמן זית${PDI}.md`,
    "Each folder keeps its place in the path",
  );
});

// A rendered path with each isolated part in brackets: what follows a bracket
// reads after that part, left to right like the interface.
const isolated = (element: Element) =>
  Array.from(element.childNodes, (node) =>
    node.nodeName === "BDI" ? `[${node.textContent}]` : node.textContent,
  ).join("");

test("a Hebrew file name keeps its extension after it wherever a path is shown", async () => {
  const { PathText } = await import("../src/ui");
  const { DocumentOptions } = await import("../src/workspace-panels");
  const { RemovedDocumentRecovery } =
    await import("../src/removed-document-recovery");
  const path = "Notes/Art/“ככה התשוקה - כמו חדר נפתח.md";
  const shown = (element: React.ReactElement) => {
    const page = render(<span data-path="">{element}</span>);
    const text = isolated(page.container.querySelector("[data-path]")!);
    page.unmount();
    return text;
  };
  assert.equal(
    shown(<PathText path={path} separator="/" />),
    "[Notes]/[Art]/[“ככה התשוקה - כמו חדר נפתח].md",
    "The extension is outside the name's isolate, after it",
  );
  assert.equal(
    shown(<PathText path="Notes/תמונות/צילום מסך.PNG" />),
    "[Notes] / [תמונות] / [צילום מסך].PNG",
    "An image keeps its extension after its name too",
  );
  assert.equal(
    shown(<PathText path="Notes/גרסה 2.0" />),
    "[Notes] / [גרסה 2.0]",
    "A dot inside a name is part of it",
  );
  assert.equal(shown(<PathText path="Notes/Plan.md" />), "Notes / Plan.md");

  // Document options names the open document by its path.
  const options = render(
    <DocumentOptions
      doc={{ id: "x", path, owner: false, edit: false, usage: 0 } as any}
      format="markdown"
      endpoint="/api/docs/x"
      formatting={null}
      onDownload={() => {}}
      onHistory={() => {}}
      onRename={() => {}}
    />,
  );
  assert.equal(
    isolated(options.container.querySelector(".dialog-description")!),
    "[Notes]/[Art]/[“ככה התשוקה - כמו חדר נפתח].md",
  );
  options.unmount();

  // Removed document recovery lists documents by their last paths.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify([{ id: "gone", path, removed: 1 }]), {
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  const recovery = render(<RemovedDocumentRecovery />);
  fireEvent.click(recovery.getByText("Removed document recovery"));
  const row = await waitFor(() => {
    const element = recovery.container.querySelector(
      ".removed-recovery-row > span",
    );
    assert.ok(element, "The removed document is listed");
    return element;
  });
  assert.equal(isolated(row), "[Notes]/[Art]/[“ככה התשוקה - כמו חדר נפתח].md");
  recovery.unmount();
});

test("Hebrew comments, the composer and the find fields read in their own direction", async () => {
  const { CommentThread, CommentComposer } = await import("../src/comments");
  const thread = render(
    <CommentThread
      comment={{
        id: "c1",
        body: "הערה בעברית עם English באמצע",
        name: "alex",
        canResolve: true,
        quote: null,
        anchor: null,
        created: 0,
        resolved: false,
        replies: [{ body: "Reply in English", name: "דנה", created: 0 }],
      }}
      onResolve={() => {}}
      canResolve={true}
      onReply={async () => true}
      busy={false}
    />,
  );
  const messages = Array.from(
    thread.container.querySelectorAll(".comment-message"),
  );
  assert.deepEqual(
    messages.map((message) => message.getAttribute("dir")),
    ["auto", "auto"],
  );
  assert.deepEqual(
    messages.map(
      (message) => message.querySelector(".comment-name bdi")?.textContent,
    ),
    ["alex", "דנה"],
    "A name is isolated, so it neither sets the message's direction nor takes its colon",
  );
  thread.unmount();
  const composer = render(
    <CommentComposer onSubmit={async () => true} onCancel={() => {}} />,
  );
  assert.equal(
    composer.container.querySelector("textarea")!.getAttribute("dir"),
    "auto",
  );
  composer.unmount();

  const editor = mount("Notes/find.md", "שלום עולם\nHello world");
  try {
    act(() => {
      openSearchPanel(editor.view);
    });
    assert.deepEqual(
      Array.from(
        editor.page.container.querySelectorAll(".find-input"),
        (input) => input.getAttribute("dir"),
      ),
      ["auto", "auto"],
    );
  } finally {
    editor.close();
  }
});

test("Hebrew names keep their own direction in the sidebar, breadcrumbs, fields and notifications", async () => {
  const { useWorkspace } = await import("../src/workspace");
  const { DocumentSidebar } = await import("../src/document-sidebar");
  const { FileActionToast } = await import("../src/workspace-feedback");
  const { DocumentTopbar } = await import("../src/document-topbar");
  const api = fileApi([
    "Notes/",
    "Notes/ארכיון/",
    "Notes/ארכיון/אוכל/",
    "Notes/ארכיון/אוכל/שמן זית.md",
    "a.md",
  ]);
  globalThis.fetch = api.fetch as typeof fetch;
  localStorage.setItem("locdoc.sidebarView", "date");
  let workspace: ReturnType<typeof useWorkspace>;
  function Sidebar() {
    workspace = useWorkspace();
    return (
      <>
        <DocumentSidebar
          entries={workspace.entries}
          id={workspace.id}
          query={workspace.query}
          view={workspace.sidebarView}
          setView={workspace.setSidebarView}
          expanded={workspace.expanded}
          toggleFolder={() => {}}
          choose={() => {}}
          fileActions={workspace.files}
          prepare={async () => {}}
        />
        <FileActionToast files={workspace.files} />
      </>
    );
  }
  const page = render(<Sidebar />);
  const hebrew = "Notes/ארכיון/אוכל/שמן זית.md";
  const row = () =>
    page.container.querySelector<HTMLElement>(
      `[role="treeitem"][data-path="${hebrew}"]`,
    )!;
  await waitFor(() => assert.ok(row(), "The Hebrew document is listed"));
  assert.equal(row().querySelector(".doc-title")!.getAttribute("dir"), "auto");
  assert.equal(row().querySelector(".doc-title")!.textContent, "שמן זית");
  const folders = row().querySelector("small")!;
  assert.equal(folders.textContent, "Notes / ארכיון / אוכל");
  assert.deepEqual(
    Array.from(folders.querySelectorAll("bdi"), (part) => part.textContent),
    ["Notes", "ארכיון", "אוכל"],
    "Each folder is isolated, so Hebrew folders keep their order",
  );
  assert.equal(
    page.container
      .querySelector('[data-path="a.md"] small')
      ?.querySelector("bdi") ?? null,
    null,
    "An English path stays plain text",
  );
  // Renaming opens a name field that follows the direction of its text.
  act(() =>
    workspace.files.startRename(
      workspace.entries.find((entry) => entry.path === hebrew)!,
      "date",
    ),
  );
  const field = row().querySelector("input")!;
  assert.equal(field.getAttribute("dir"), "auto");
  fireEvent.change(field, { target: { value: "שמן קנולה" } });
  assert.equal(
    row().querySelector(".tree-edit-message")!.textContent,
    `Saved as ${FSI}שמן קנולה${PDI}.md`,
  );
  fireEvent.keyDown(field, { key: "Escape" });
  // A deletion names the document in its notification without letting the
  // name reorder the sentence.
  row().focus();
  fireEvent.keyDown(row(), { key: "Delete" });
  await waitFor(() =>
    assert.equal(
      page.container.querySelector(".toast-message")?.textContent,
      `${FSI}שמן זית${PDI}.md moved to Recently deleted.`,
    ),
  );
  page.unmount();

  const top = render(
    <DocumentTopbar
      doc={null}
      path={hebrew}
      filename="שמן זית"
      people={[]}
      sidebar={true}
      openSidebar={() => {}}
      commentsOpen={false}
      toggleComments={() => {}}
    />,
  );
  assert.deepEqual(
    Array.from(
      top.container.querySelectorAll(".crumb-folder bdi"),
      (part) => part.textContent,
    ),
    ["Notes", "ארכיון", "אוכל"],
  );
  assert.equal(
    top.container
      .querySelector(".crumb-current .doc-title")!
      .getAttribute("dir"),
    "auto",
  );
  top.unmount();
});

test("dialogs isolate Hebrew names and paths, and their fields follow typed text", async () => {
  const { RenameDocument } = await import("../src/rename-document");
  const { NamePrompt } = await import("../src/name-prompt");
  const { DocumentSharePanel } = await import("../src/workspace-panels");
  const { LinkPicker } = await import("../src/link-picker");
  const { VersionHistory } = await import("../src/version-history");
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input), location.href).pathname;
    const body = path.endsWith("/versions")
      ? { versions: [{ id: "v1", created: 1, bytes: 10 }] }
      : path.endsWith("/versions/v1")
        ? { content: "שורה בעברית\nEnglish line" }
        : path.endsWith("/mcp")
          ? { mcpAllowed: false, mcpDirect: false, mcpInherited: false }
          : {};
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const rename = render(
    <RenameDocument
      path="Notes/שמן זית.md"
      endpoint="/api/docs/x"
      onRename={() => {}}
    />,
  );
  assert.equal(
    rename.getByLabelText("Rename or move document").getAttribute("dir"),
    "auto",
  );
  rename.unmount();
  const prompt = render(<NamePrompt onChoose={() => {}} />);
  assert.equal(prompt.getByLabelText("Your name").getAttribute("dir"), "auto");
  prompt.unmount();
  const share = render(
    <DocumentSharePanel
      doc={
        {
          id: "x",
          path: "Notes/שמן זית.md",
          owner: false,
          edit: true,
          permission: "private",
          shareUrl: null,
          usage: 0,
          content: "",
        } as any
      }
      filename="שמן זית"
      name="alex"
      onChange={async () => {}}
      onShareFolder={() => {}}
    />,
  );
  assert.equal(
    share.container.querySelector(".dialog-description bdi")?.textContent,
    "שמן זית",
  );
  share.unmount();
  const picker = render(
    <LinkPicker
      entries={[
        {
          id: "oil",
          path: "Notes/ארכיון/שמן זית.md",
          kind: "file",
          shared: true,
          url: "/d/oil",
        },
      ]}
      selection=""
      onInsert={() => {}}
    />,
  );
  assert.equal(picker.getByRole("combobox").getAttribute("dir"), "auto");
  const result = picker.getByRole("option");
  assert.equal(result.querySelector("strong")!.getAttribute("dir"), "auto");
  assert.equal(
    isolated(result.querySelector("small")!),
    "[Notes]/[ארכיון]/[שמן זית].md",
  );
  picker.unmount();
  const history = render(
    <VersionHistory
      endpoint={(suffix) => `/api/docs/x${suffix}`}
      documentId="x"
      path="x.md"
      onClose={() => {}}
      onRestore={() => {}}
    />,
  );
  await waitFor(() =>
    assert.ok(history.container.querySelector('[data-version-id="v1"]')),
  );
  fireEvent.click(history.container.querySelector('[data-version-id="v1"]')!);
  await waitFor(() =>
    assert.equal(
      EditorView.findFromDOM(
        history.container.querySelector(".version-preview .cm-content")!,
      )?.state.doc.toString(),
      "שורה בעברית\nEnglish line",
    ),
  );
  assert.equal(
    history.container.querySelector(".version-preview")!.getAttribute("dir"),
    "auto",
    "Each line of a version preview reads in its own direction",
  );
  history.unmount();
});
