import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React from "react";
import * as Y from "yjs";
import { EditorView } from "@codemirror/view";
import { Awareness } from "y-protocols/awareness";
import { sourceCommentRanges } from "../src/editor-comments";

let dom: JSDOM;
let render: typeof import("@testing-library/react").render;
let cleanup: typeof import("@testing-library/react").cleanup;
let act: typeof import("@testing-library/react").act;
let MarkdownEditor: typeof import("../src/editor").MarkdownEditor;

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
  dom.window.Range.prototype.getClientRects = () => [] as any;
  dom.window.Range.prototype.getBoundingClientRect = () =>
    new dom.window.DOMRect();
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as any;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  ({ render, cleanup, act } = await import("@testing-library/react"));
  ({ MarkdownEditor } = await import("../src/editor"));
});
afterEach(() => cleanup());
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
  const page = render(
    <MarkdownEditor
      ydoc={ydoc}
      provider={{ awareness } as any}
      id="record-lines"
      editable={false}
      path={path}
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

// Each displayed line as "its classes and its wrapper's: its text". A
// conversation shows as "conversation".
function shown(view: EditorView) {
  const rows: string[] = [];
  const walk = (parent: Element, wrapper: string[]) => {
    for (const child of parent.children) {
      if (child.classList.contains("inline-comment-host"))
        rows.push("conversation");
      else if (child.classList.contains("cm-line")) {
        const classes = [...wrapper, ...child.classList].filter(
          (name) => name !== "cm-line",
        );
        rows.push(`${classes.sort().join(" ")}: ${child.textContent}`);
      } else if (child instanceof window.HTMLDivElement)
        walk(child, [...child.classList]);
    }
  };
  walk(view.contentDOM, []);
  return rows;
}

const record = "[[comment(alex): note]]";

test("a Markdown line after a comment record on its own line keeps its own styling", () => {
  for (const [source, expected] of [
    [
      `Paragraph.\n${record}\n# Heading`,
      ["md-block-end: Paragraph.", "md-h1: Heading"],
    ],
    [
      `Paragraph.\n${record}\n> A quote\n> continued`,
      [
        "md-block-end: Paragraph.",
        "md-block-end md-quote:  A quote",
        "md-block-end md-quote:  continued",
      ],
    ],
    [
      `Paragraph.\n${record}\n\`\`\`\ncode\n\`\`\``,
      [
        "md-block-end: Paragraph.",
        "md-code-line: ```",
        "md-code-line: code",
        "md-code-line: ```",
      ],
    ],
    [
      `Paragraph.\n${record}\n- [ ] A task`,
      ["md-block-end: Paragraph.", "md-block-end md-list md-task:  A task"],
    ],
    [
      `Paragraph.\n${record}\n- An item\n  - Nested`,
      [
        "md-block-end: Paragraph.",
        "md-block-end md-list: - An item",
        "md-block-end md-list:   - Nested",
      ],
    ],
    [
      `Paragraph.\n${record}\n[[comment(ana): reply]]\nThe same paragraph.`,
      ["md-block-end: Paragraph.", "md-block-end: The same paragraph."],
    ],
    [
      `Paragraph.\n${record}\n[[comment(ana): reply]] continues`,
      ["md-block-end: Paragraph.", "md-block-end:  continues"],
    ],
    // A record that lazily continues a quote or a list item stays inside it,
    // and the heading after it is no part of either.
    [
      `> A quote\n${record}\n# Heading`,
      ["md-block-end md-quote:  A quote", "md-h1: Heading"],
    ],
    [
      `- An item\n${record}\n# Heading`,
      ["md-block-end md-list: - An item", "md-h1: Heading"],
    ],
    [`${record}\n## Heading`, ["md-h2: Heading"]],
  ] as const) {
    const editor = mount("Notes/records.md", source);
    try {
      assert.deepEqual(shown(editor.view), expected, JSON.stringify(source));
      assert.equal(editor.text.toString(), source);
    } finally {
      editor.close();
    }
  }
});

test("Fountain and plain text lines after a comment record on its own line keep their styling", () => {
  for (const [path, source, expected] of [
    [
      "Script.fountain",
      `Action line.\n${record}\n[[comment(ana): reply]] More action.`,
      [
        "fountain-action fountain-block-end fountain-line: Action line.",
        "fountain-action fountain-block-end fountain-line:  More action.",
      ],
    ],
    [
      "Notes/plain.txt",
      `Buy milk\n${record}\nBuy eggs`,
      ["text-block-end: Buy milk", "text-block-end: Buy eggs"],
    ],
    ["Notes/plain.txt", `${record}\nBuy eggs`, ["text-block-end: Buy eggs"]],
  ] as const) {
    const editor = mount(path, source);
    try {
      assert.deepEqual(shown(editor.view), expected, `${path}: ${source}`);
    } finally {
      editor.close();
    }
  }
});

test("a conversation beside a record on its own line opens before the line the record shows", () => {
  for (const [path, source, expected] of [
    [
      "Notes/conversation.md",
      `Paragraph.\n${record}\n# Heading`,
      ["md-block-end: Paragraph.", "conversation", "md-h1: Heading"],
    ],
    [
      "Notes/conversation.txt",
      `Paragraph.\n${record}\nNext line`,
      [
        "text-block-end: Paragraph.",
        "conversation",
        "text-block-end: Next line",
      ],
    ],
    [
      "Notes/conversation.fountain",
      `Paragraph.\n${record}\nMore action.`,
      [
        "fountain-action fountain-block-end fountain-line: Paragraph.",
        "conversation",
        "fountain-action fountain-block-end fountain-line: More action.",
      ],
    ],
  ] as const) {
    const ydoc = new Y.Doc();
    const text = ydoc.getText("content");
    text.insert(0, source);
    const position = (index: number, assoc = 0) =>
      Y.relativePositionToJSON(
        Y.createRelativePositionFromTypeIndex(text, index, assoc),
      );
    const thread = {
      id: "c1",
      name: "alex",
      body: "note",
      guest: "owner",
      quote: "Paragraph.",
      anchor: { start: position(0), end: position(10, -1) },
      created: 0,
      resolved: false,
      replies: [],
    };
    const awareness = new Awareness(ydoc);
    const page = render(
      <MarkdownEditor
        ydoc={ydoc}
        provider={{ awareness } as any}
        id="record-conversation"
        editable={false}
        path={path}
        onChange={() => {}}
        onComment={() => {}}
        onUpload={() => {}}
        comments={[thread]}
        activeComment="c1"
        conversation={<p>The conversation</p>}
      />,
    );
    try {
      const view = EditorView.findFromDOM(
        page.container.querySelector(".cm-editor")!,
      )!;
      assert.deepEqual(shown(view), expected, path);
    } finally {
      page.unmount();
      awareness.destroy();
      ydoc.destroy();
    }
  }
});

test("a caret on either side of a record's line reveals the line it shows, and the record stays whole", () => {
  const source = `Paragraph.\n${record}\n# Heading`;
  const editor = mount("Notes/caret.md", source, { editable: true });
  try {
    const [hidden] = sourceCommentRanges(editor.view.state);
    assert.deepEqual(
      [hidden.from, hidden.to],
      [source.indexOf(record), source.indexOf("# Heading")],
      "the record hides its line and line break",
    );
    for (const anchor of [hidden.from, hidden.to]) {
      act(() =>
        editor.view.dispatch({ selection: { anchor }, userEvent: "select" }),
      );
      assert.deepEqual(
        shown(editor.view),
        ["md-block-end: Paragraph.", "md-h1: # Heading"],
        `caret at ${anchor}`,
      );
    }
    act(() =>
      editor.view.dispatch({ selection: { anchor: 0 }, userEvent: "select" }),
    );
    assert.deepEqual(shown(editor.view), [
      "md-block-end: Paragraph.",
      "md-h1: Heading",
    ]);
    act(() =>
      editor.view.dispatch({
        changes: { from: hidden.from, insert: "New " },
        selection: { anchor: hidden.from + 4 },
        userEvent: "input.type",
      }),
    );
    assert.equal(
      editor.text.toString(),
      `Paragraph.\n${record}\nNew # Heading`,
      "typing beside the record writes after it, never inside it",
    );
  } finally {
    editor.close();
  }
});
