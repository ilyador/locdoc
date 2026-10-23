import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import React from "react";
import * as Y from "yjs";
import { EditorView } from "@codemirror/view";
import { Awareness } from "y-protocols/awareness";
import { sourceComments } from "../src/comment-syntax";
import { documentFormat } from "../src/document-format";
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

// Every displayed block, a line as in shown() and a widget, such as a table
// or figure, as its element. An empty document's placeholder is no text.
function displayed(view: EditorView) {
  const rows: string[] = [];
  const walk = (parent: Element, wrapper: string[]) => {
    for (const child of parent.children) {
      if (child.classList.contains("cm-line")) {
        const classes = [...wrapper, ...child.classList].filter(
          (name) => name !== "cm-line",
        );
        const text = [...child.childNodes]
          .filter(
            (node) =>
              !(node instanceof window.Element) ||
              !node.classList.contains("cm-placeholder"),
          )
          .map((node) => node.textContent)
          .join("");
        rows.push(`${classes.sort().join(" ")}: ${text}`);
      } else if (child.querySelector(".cm-line"))
        walk(child, [...child.classList]);
      else
        rows.push(
          [child.tagName.toLowerCase(), ...[...child.classList].sort()].join(
            ".",
          ),
        );
    }
  };
  walk(view.contentDOM, []);
  return rows;
}

const record = "[[comment(alex): note]]";

test("comments the server adds show no new line in any format, as in the shared fixtures", () => {
  const cases = JSON.parse(
    readFileSync(
      new URL("./fixtures/file-comments.json", import.meta.url),
      "utf8",
    ),
  ).filter((c: any) => c.comment);
  const formats = new Set(cases.map((c: any) => documentFormat(c.path)));
  assert.deepEqual([...formats].sort(), ["fountain", "markdown", "text"]);
  const lines = (path: string, source: string) => {
    const editor = mount(`Notes/${path}`, source);
    try {
      return displayed(editor.view);
    } finally {
      editor.close();
    }
  };
  for (const c of cases)
    assert.deepEqual(
      lines(c.path, c.comment.expected),
      lines(c.path, c.source),
      c.name,
    );
});

test("typing at the end of a line before hidden records writes on that line", () => {
  for (const [path, source] of [
    ["Notes/second.md", `Text${record}\n\n[[comment(ana): A note]]\n## Next`],
    ["Notes/table.md", `| A |\n| - |\n| x |\n\n${record}\n## Next`],
    ["Notes/end.md", `A paragraph.\n\n${record}`],
    [
      "Notes/script.fountain",
      `ALEX\nHello there.${record}\n\n[[comment(ana): A note]]\n\nBEN\nHi.`,
    ],
  ] as const) {
    const shown = mount(path, source);
    const [hidden] = sourceCommentRanges(shown.view.state);
    shown.close();
    for (const side of [hidden.from, hidden.to]) {
      const editor = mount(path, source, { editable: true });
      try {
        act(() =>
          editor.view.dispatch({
            selection: { anchor: side },
            userEvent: "select",
          }),
        );
        act(() =>
          editor.view.dispatch({
            changes: { from: side, insert: "s" },
            selection: { anchor: side + 1 },
            userEvent: "input.type",
          }),
        );
        assert.equal(
          editor.text.toString(),
          source.slice(0, hidden.from) + "s" + source.slice(hidden.from),
          `${path} at ${side}`,
        );
        assert.equal(
          sourceComments(editor.text.toString(), false).length,
          sourceComments(source, false).length,
          `${path} at ${side}: every conversation stays`,
        );
      } finally {
        editor.close();
      }
    }
  }
});

test("a table at the end of a document shows its conversation after it, and no empty line", () => {
  const table = "| One | Two |\n| --- | --- |\n| Body | Cell |";
  const source = `${table}\n\n${record}`;
  const ydoc = new Y.Doc();
  const text = ydoc.getText("content");
  text.insert(0, source);
  const at = (index: number, assoc = 0) =>
    Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(text, index, assoc),
    );
  const from = source.indexOf("Body");
  const thread = {
    id: "c1",
    name: "alex",
    body: "note",
    canResolve: true,
    quote: "Body",
    anchor: { start: at(from), end: at(from + 4, -1) },
    created: 0,
    resolved: false,
    replies: [],
  };
  const awareness = new Awareness(ydoc);
  const provider = { awareness } as any;
  const page = render(
    <MarkdownEditor
      ydoc={ydoc}
      provider={provider}
      id="table-end"
      editable={false}
      path="Notes/table.md"
      onChange={() => {}}
      onComment={() => {}}
      onUpload={() => {}}
      comments={[thread]}
    />,
  );
  try {
    const view = EditorView.findFromDOM(
      page.container.querySelector(".cm-editor")!,
    )!;
    assert.deepEqual(displayed(view), [
      "div.md-table-preview",
      "div.comment-marker-block",
    ]);
    page.rerender(
      <MarkdownEditor
        ydoc={ydoc}
        provider={provider}
        id="table-end"
        editable={false}
        path="Notes/table.md"
        onChange={() => {}}
        onComment={() => {}}
        onUpload={() => {}}
        comments={[thread]}
        activeComment="c1"
        conversation={<p>The conversation</p>}
      />,
    );
    assert.deepEqual(displayed(view), [
      "div.md-table-preview",
      "div.comment-marker-block",
      "div.inline-comment-host",
    ]);
    assert.equal(text.toString(), source);
  } finally {
    page.unmount();
    awareness.destroy();
    ydoc.destroy();
  }
});

test("a passage selected past the records that end its line still shows its marker", () => {
  // The second passage was selected to the end of the line, after the first
  // conversation's hidden record.
  const first = `[[comment(alex): First]]`;
  const source = `Text${first}\n\n[[comment(ana): Second]]\n## Next`;
  for (const path of ["Notes/markers.md", "Notes/markers.fountain"]) {
    const ydoc = new Y.Doc();
    const text = ydoc.getText("content");
    text.insert(0, source);
    const at = (index: number, assoc = 0) =>
      Y.relativePositionToJSON(
        Y.createRelativePositionFromTypeIndex(text, index, assoc),
      );
    const thread = (id: string, end: number) => ({
      id,
      name: "alex",
      body: "note",
      canResolve: true,
      quote: "Text",
      anchor: { start: at(0), end: at(end, -1) },
      created: 0,
      resolved: false,
      replies: [],
    });
    const awareness = new Awareness(ydoc);
    const page = render(
      <MarkdownEditor
        ydoc={ydoc}
        provider={{ awareness } as any}
        id="markers"
        editable={false}
        path={path}
        onChange={() => {}}
        onComment={() => {}}
        onUpload={() => {}}
        comments={[thread("c1", 4), thread("c2", 4 + first.length)]}
      />,
    );
    try {
      const markers = [
        ...page.container.querySelectorAll<HTMLElement>(".comment-marker"),
      ];
      assert.deepEqual(
        markers.map((marker) => marker.dataset.commentId).sort(),
        ["c1", "c2"],
        path,
      );
      for (const marker of markers)
        assert.equal(marker.closest(".cm-line")?.textContent, "Text", path);
    } finally {
      page.unmount();
      awareness.destroy();
      ydoc.destroy();
    }
  }
});

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

test("a line after records that follow text shows as a line of its own", () => {
  const source = `Buy milk[[comment(alex): Which brand?]]\n\n[[comment(ana): A note]]\nBuy eggs`;
  for (const [path, expected] of [
    ["Notes/list.md", ["md-block-end: Buy milk", "md-block-end: Buy eggs"]],
    [
      "Notes/list.fountain",
      [
        "fountain-action fountain-block-end fountain-line: Buy milk",
        "fountain-action fountain-block-end fountain-line: Buy eggs",
      ],
    ],
    [
      "Notes/list.txt",
      ["text-block-end: Buy milk", "text-block-end: Buy eggs"],
    ],
  ] as const) {
    const editor = mount(path, source);
    try {
      assert.deepEqual(shown(editor.view), expected, path);
      assert.equal(sourceComments(editor.text.toString()).length, 2);
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

test("the part of a line after a conversation that opens inside it keeps the line's styling", () => {
  // The app's own stylesheet decides how each part of the line looks.
  const style = document.createElement("style");
  style.textContent = readFileSync(
    new URL("../src/style.css", import.meta.url),
    "utf8",
  );
  document.head.append(style);
  const properties = [
    "font-family",
    "font-size",
    "font-style",
    "font-weight",
    "letter-spacing",
    "line-height",
    "color",
    "text-decoration",
    "text-transform",
    "background-color",
    "border-inline-start",
    "padding-inline-start",
    "padding-inline-end",
    "padding-bottom",
    "padding-block-end",
    "min-height",
  ];
  // Opens `source` with a conversation about its text up to the end of
  // `passage`, which ends inside the first line.
  const open = (path: string, source: string, passage: string) => {
    const ydoc = new Y.Doc();
    const text = ydoc.getText("content");
    text.insert(0, source);
    const at = (index: number, assoc = 0) =>
      Y.relativePositionToJSON(
        Y.createRelativePositionFromTypeIndex(text, index, assoc),
      );
    const end = source.indexOf(passage) + passage.length;
    const thread = {
      id: "c1",
      name: "alex",
      body: "note",
      canResolve: true,
      quote: passage,
      anchor: { start: at(end - passage.length), end: at(end, -1) },
      created: 0,
      resolved: false,
      replies: [],
    };
    const awareness = new Awareness(ydoc);
    const page = render(
      <MarkdownEditor
        ydoc={ydoc}
        provider={{ awareness } as any}
        id="split-line"
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
    return {
      host: page.container.querySelector(".inline-comment-host")!,
      line: (text: string) =>
        [...page.container.querySelectorAll(".cm-line")].find(
          (line) => line.textContent === text,
        )!,
      close() {
        page.unmount();
        awareness.destroy();
        ydoc.destroy();
      },
    };
  };
  const looks = (element: Element) => {
    const computed = getComputedStyle(element);
    return properties.map(
      (name) => `${name}: ${computed.getPropertyValue(name)}`,
    );
  };
  try {
    for (const [path, source, passage] of [
      [
        "Notes/split.md",
        "# A heading the conversation splits\nBody",
        "heading",
      ],
      [
        "Notes/split.md",
        "## A heading the conversation splits\nBody",
        "heading",
      ],
      ["Notes/split.md", "### A heading the conversation splits", "heading"],
      ["Notes/split.md", "#### A heading the conversation splits", "heading"],
      ["Notes/split.md", "##### A heading the conversation splits", "heading"],
      ["Notes/split.md", "###### A heading the conversation splits", "heading"],
      [
        "Notes/split.md",
        "Body text\n# A heading the conversation splits",
        "heading",
      ],
      [
        "Notes/split.md",
        "A paragraph the conversation splits\nNext",
        "paragraph",
      ],
      ["Notes/split.md", "> A quote the conversation splits\n\nNext", "quote"],
      ["Notes/split.md", "- > A quoted item the conversation splits", "item"],
      ["Notes/split.md", "```\nsome code the conversation splits\n```", "code"],
      ["Notes/split.md", "- [ ] A task the conversation splits", "task"],
      ["Notes/split.md", "- [x] A done task the conversation splits", "done"],
      [
        "Script.fountain",
        "INT. HOUSE THE CONVERSATION SPLITS - DAY\n\nAction.",
        "HOUSE",
      ],
      [
        "Script.fountain",
        "# A section the conversation splits\n\nAction.",
        "section",
      ],
      [
        "Script.fountain",
        "She waits by the door the conversation splits.\n\nMore.",
        "waits",
      ],
      ["Notes/split.txt", "A plain line the conversation splits\nNext", "line"],
    ] as const) {
      const editor = open(path, source, passage);
      const label = `${path}: ${JSON.stringify(source)}`;
      try {
        const before = editor.host.previousElementSibling!;
        const after = editor.host.nextElementSibling!;
        assert.ok(
          editor.host.hasAttribute("data-splits-line") &&
            before.classList.contains("cm-line") &&
            after.classList.contains("cm-line") &&
            /splits/i.test(after.textContent!),
          `${label}: the conversation opens inside its line`,
        );
        assert.deepEqual(looks(after), looks(before), label);
        // The space above a heading stays above its first part.
        assert.equal(getComputedStyle(after).paddingTop, "0px", label);
      } finally {
        editor.close();
      }
    }
    // A conversation between two lines splits neither: the line after a
    // heading keeps its own styling.
    const editor = open("Notes/split.md", "## Heading\nBody", "Heading");
    try {
      assert.ok(!editor.host.hasAttribute("data-splits-line"));
      const heading = getComputedStyle(editor.line("Heading"));
      const body = getComputedStyle(editor.line("Body"));
      assert.notEqual(body.fontSize, heading.fontSize);
      assert.notEqual(body.color, heading.color);
    } finally {
      editor.close();
    }
  } finally {
    style.remove();
  }
});

test("Backspace after records behind a table's or HTML block's blank line joins what a reader sees and shows no empty line", () => {
  const own = "[[comment(ana): Own]]";
  for (const [source, joined, expected, rows] of [
    [
      `| A |\n| - |\n| x |\n\n${record}\n## Next`,
      "## Next",
      `| A |\n| - |\n| x |## Next\n\n${record}`,
      // The caret shows the table's source.
      [": | A |", ": | - |", ": | x |## Next"],
    ],
    [
      `<div>\nhi\n</div>\n\n${record}\nAfter\nMore`,
      "After",
      `<div>\nhi\n</div>After\n\n${record}\nMore`,
      [": <div>", ": hi", ": </div>After", "md-block-end: More"],
    ],
    // In the block, the joined line's own records would be literal HTML or
    // a table cell's text: they go after it too, as their own conversation.
    [
      `<div>\nhi\n</div>\n\n${record}\nAfter${own}\nMore`,
      "After",
      `<div>\nhi\n</div>After\n\n${record}\n\n${own}\nMore`,
      [": <div>", ": hi", ": </div>After", "md-block-end: More"],
    ],
  ] as const) {
    const editor = mount("Notes/blocks.md", source, { editable: true });
    try {
      const at = source.indexOf(joined);
      act(() =>
        editor.view.dispatch({
          selection: { anchor: at },
          userEvent: "select",
        }),
      );
      act(() => {
        editor.view.contentDOM.dispatchEvent(
          new window.KeyboardEvent("keydown", {
            key: "Backspace",
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      const label = JSON.stringify(source);
      assert.equal(editor.text.toString(), expected, label);
      assert.equal(
        editor.view.state.selection.main.head,
        expected.indexOf(joined),
        `${label}: the caret is where the lines join`,
      );
      assert.deepEqual(shown(editor.view), rows, `${label}: no empty line`);
      assert.deepEqual(
        sourceComments(editor.text.toString(), false).map((t) => t.messages),
        sourceComments(source, false).map((t) => t.messages),
        `${label}: every conversation stays whole`,
      );
    } finally {
      editor.close();
    }
  }
});
