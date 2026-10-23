import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import React from "react";
import * as Y from "yjs";
import { EditorView } from "@codemirror/view";
import { Awareness } from "y-protocols/awareness";
import { textDirection } from "../src/bidi";
import type { EditorHandle } from "../src/editor-types";

// An image description shown in place of a picture is isolated (bidi.ts).
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

test("the first strong character of a text decides its direction", () => {
  assert.equal(textDirection("שמן זית:"), "rtl");
  assert.equal(textDirection("English paragraph, שלום"), "ltr");
  assert.equal(textDirection("2024 — “ככה התשוקה"), "rtl");
  assert.equal(textDirection("123 456 · !?"), null);
  assert.equal(textDirection("\u{200F}English after a mark"), "rtl");
  assert.equal(textDirection("\u{05B0}\u{05B4} niqqud is not strong"), "ltr");
});

test("Markdown lines whose first visible strong character is Hebrew read right to left", () => {
  const source = [
    "# כותרת ראשית",
    "English paragraph with שלום inside.",
    "- [x] קרם לחות",
    "- [ ] An English task",
    "[2024](https://example.com/page) שלום",
    "![photo](Notes/photo.png) תמונה בשורה",
    "",
    "English again",
    "",
    "[[comment(alex): note]] שורה עם תגובה",
    "> ציטוט בעברית",
    "1. שלב ראשון",
  ].join("\n");
  const editor = mount("Notes/mixed.md", source);
  try {
    assert.equal(
      editor.view.state.facet(EditorView.perLineTextDirection),
      true,
      "CodeMirror reads each line's direction for caret motion and selection",
    );
    // A document opens rendered, so the heading on line 1 hides its marker.
    assert.deepEqual(lines(editor.view), [
      "rtl: כותרת ראשית",
      "ltr: English paragraph with שלום inside.",
      "rtl:  קרם לחות",
      "ltr:  An English task",
      "rtl: 2024 שלום",
      "rtl:  תמונה בשורה",
      "rtl: (blank)",
      "ltr: English again",
      "ltr: (blank)",
      "rtl:  שורה עם תגובה",
      "rtl:  ציטוט בעברית",
      "rtl: 1. שלב ראשון",
    ]);
    // Typing changes a line's direction as its first strong character does.
    act(() =>
      editor.view.dispatch({
        changes: { from: source.indexOf("English again"), insert: "עכשיו " },
      }),
    );
    assert.equal(lines(editor.view)[7], "rtl: עכשיו English again");
    assert.equal(lines(editor.view)[8], "rtl: (blank)");
  } finally {
    editor.close();
  }
});

test("a Hebrew line after a comment record on its own line reads right to left", () => {
  const editor = mount(
    "Notes/comment.md",
    "English line\n[[comment(alex): A note]]\nשורה אחרי התגובה\nEnglish line again",
  );
  try {
    assert.deepEqual(
      lines(editor.view).filter((line) => !line.endsWith("(blank)")),
      ["ltr: English line", "rtl: שורה אחרי התגובה", "ltr: English line again"],
    );
  } finally {
    editor.close();
  }
});

test("Hebrew after a reply on the line below its record reads right to left", () => {
  const editor = mount(
    "Notes/comment.md",
    "English line\n[[comment(alex): A note]]\n[[comment(ana): A reply]] שורה אחרי התגובה\nEnglish line again",
  );
  try {
    assert.deepEqual(lines(editor.view), [
      "ltr: English line",
      "rtl:  שורה אחרי התגובה",
      "ltr: English line again",
    ]);
  } finally {
    editor.close();
  }
});

test("Fountain and plain text lines follow the text they show", () => {
  const fountain = mount(
    "Script.fountain",
    [
      "Title: ככה התשוקה",
      "Author: alex",
      "",
      ".פנים. דירה בתל אביב - לילה",
      "",
      "@דנה",
      "(בשקט)",
      "אתה שומע את זה?",
      "",
      "INT. KITCHEN - NIGHT",
    ].join("\n"),
  );
  try {
    const shown = lines(fountain.view);
    assert.ok(
      shown.some((line) => line.startsWith("rtl:") && line.includes("ככה")),
      "A title page key such as Title: is not the line's text",
    );
    // Title page keys are hidden away from the caret.
    for (const text of ["alex", "INT. KITCHEN - NIGHT"])
      assert.ok(
        shown.some((line) => line === `ltr: ${text}`),
        `${text} stays left to right`,
      );
    for (const text of ["פנים. דירה", "דנה", "(בשקט)", "אתה שומע"])
      assert.ok(
        shown.some((line) => line.startsWith("rtl:") && line.includes(text)),
        `${text} reads right to left`,
      );
  } finally {
    fountain.close();
  }
  const plain = mount(
    "Notes/plain.txt",
    "- [x] עברית\n[[comment(alex): note]] שלום\nPlain English",
  );
  try {
    assert.deepEqual(lines(plain.view), [
      "ltr: - [x] עברית",
      "rtl:  שלום",
      "ltr: Plain English",
    ]);
  } finally {
    plain.close();
  }
});

test("a line keeps its direction after a conversation that opens inside it", () => {
  // The app's own stylesheet decides how the part after the conversation reads.
  const style = document.createElement("style");
  style.textContent = readFileSync(
    new URL("../src/style.css", import.meta.url),
    "utf8",
  );
  document.head.append(style);
  const hebrew =
    " פרח גדול, אפשר לראות בו כל עלה כותרת, אפשר לחוש כל עלה, אפשר לעקוב אחר הרעש של הבקיעה.";
  const english =
    "A long English paragraph, which the conversation splits, goes on after it.";
  // Opens `source` with a conversation about its text from the second
  // character to `end`, posted or still being written.
  const open = (
    path: string,
    source: string,
    end: number,
    editable: boolean,
    draft: boolean,
  ) => {
    const ydoc = new Y.Doc();
    const content = ydoc.getText("content");
    content.insert(0, source);
    const at = (index: number, assoc = 0) =>
      Y.relativePositionToJSON(
        Y.createRelativePositionFromTypeIndex(content, index, assoc),
      );
    const anchor = { start: at(1), end: at(end, -1) };
    const thread = {
      id: "c1",
      body: "A note",
      name: "alex",
      canResolve: true,
      quote: source.slice(1, end),
      anchor,
      created: 0,
      resolved: false,
      replies: [],
    };
    const awareness = new Awareness(ydoc);
    const page = render(
      <MarkdownEditor
        ydoc={ydoc}
        provider={{ awareness } as any}
        id="rtl-split"
        editable={editable}
        path={path}
        comments={draft ? [] : [thread]}
        activeComment={draft ? null : "c1"}
        commentDraft={draft ? { quote: thread.quote, anchor } : null}
        conversation={<p>The conversation</p>}
        onChange={() => {}}
        onComment={() => {}}
        onUpload={() => {}}
      />,
    );
    const host = page.container.querySelector(".inline-comment-host")!;
    const line = (text: string) =>
      [...page.container.querySelectorAll(".cm-line")].find(
        (line) => line.textContent === text,
      )!;
    return {
      host,
      line,
      close() {
        page.unmount();
        awareness.destroy();
        ydoc.destroy();
      },
    };
  };
  try {
    for (const [path, editable, draft] of [
      ["Notes/art.md", true, true],
      ["Notes/art.md", true, false],
      // A visitor on a view link.
      ["Notes/art.md", false, false],
      ["Script.fountain", true, true],
      ["Script.fountain", false, false],
      ["Notes/art.txt", true, true],
      ["Notes/art.txt", false, false],
    ] as const)
      for (const [text, direction] of [
        [hebrew, "rtl"],
        [english, "ltr"],
      ] as const) {
        const label = `${path}, ${editable ? "editor" : "visitor"}, ${draft ? "new comment" : "posted"}, ${direction}`;
        // The next line reads its own way, whatever the split line does.
        const editor = open(
          path,
          `${text}\nAn English line after it`,
          text.indexOf(",") + 1,
          editable,
          draft,
        );
        try {
          const before = editor.host.previousElementSibling!;
          const after = editor.host.nextElementSibling!;
          assert.ok(
            before.classList.contains("cm-line") &&
              after.classList.contains("cm-line") &&
              after.textContent!.endsWith("."),
            `${label}: the conversation opens inside its line`,
          );
          assert.deepEqual(
            [
              getComputedStyle(before).direction,
              getComputedStyle(after).direction,
            ],
            [direction, direction],
            label,
          );
          assert.equal(
            getComputedStyle(editor.line("An English line after it")).direction,
            "ltr",
            label,
          );
        } finally {
          editor.close();
        }
      }
    // A conversation between two lines splits neither: the English line
    // after it keeps its own direction.
    const editor = open(
      "Notes/art.md",
      `${hebrew}\nAn English line`,
      hebrew.length,
      true,
      true,
    );
    try {
      assert.ok(
        editor.host.nextElementSibling === editor.line("An English line"),
      );
      assert.equal(
        getComputedStyle(editor.line("An English line")).direction,
        "ltr",
      );
    } finally {
      editor.close();
    }
  } finally {
    style.remove();
  }
});

test("tables, figures and their comment markers take the direction of their text", () => {
  const table =
    "| שם | תפקיד | הערה |\n| --- | :--- | :---: |\n| דנה | מפתחת | English note |";
  const source = `${table}\n\n| Name | Role |\n| --- | --- |\n| Alex | designer |\n\n![תמונה של שמן](Notes/oil.png)\n\nסוף.`;
  const ydoc = new Y.Doc();
  const text = ydoc.getText("content");
  text.insert(0, source);
  const at = (index: number) =>
    Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(text, index),
    );
  const comment = {
    id: "table-comment",
    body: "הערה על הטבלה",
    name: "alex",
    canResolve: true,
    quote: "דנה",
    anchor: {
      start: at(table.indexOf("דנה")),
      end: at(table.indexOf("דנה") + 3),
    },
    created: 0,
    resolved: false,
    replies: [],
  };
  const awareness = new Awareness(ydoc);
  const page = render(
    <MarkdownEditor
      ydoc={ydoc}
      provider={{ awareness } as any}
      id="rtl-fixture"
      editable={false}
      path="Notes/tables.md"
      comments={[comment]}
      onChange={() => {}}
      onComment={() => {}}
      onUpload={() => {}}
    />,
  );
  try {
    const tables = Array.from(
      page.container.querySelectorAll<HTMLElement>(".md-table-preview"),
    );
    assert.deepEqual(
      tables.map((wrap) => wrap.getAttribute("dir") || "inherit"),
      ["rtl", "ltr"],
      "A Hebrew table runs its columns from the right; an English one does not",
    );
    assert.deepEqual(
      Array.from(tables[0].querySelectorAll("th, td"), (cell) =>
        [
          cell.textContent,
          cell.getAttribute("dir"),
          (cell as HTMLElement).style.textAlign,
        ].join(" "),
      ),
      [
        "שם rtl start",
        "תפקיד rtl left",
        "הערה rtl center",
        "דנה rtl start",
        "מפתחת rtl left",
        "English note ltr center",
      ],
      "Cells read in their own direction; a column without colons starts where its text starts",
    );
    const figure = page.container.querySelector<HTMLElement>("figure.embed")!;
    assert.equal(figure.getAttribute("dir"), "rtl");
    const marker = page.container.querySelector<HTMLElement>(
      ".comment-marker-block",
    )!;
    assert.equal(
      marker.getAttribute("dir"),
      "rtl",
      "The marker of a Hebrew table sits at its left, end edge",
    );
    // An image the server will not serve shows its description, isolated
    // beside the interface's own words.
    const image = figure.querySelector("img")!;
    act(() => {
      image.dispatchEvent(new window.Event("error"));
    });
    assert.equal(
      figure.querySelector(".media-missing")!.textContent,
      `${FSI}תמונה של שמן${PDI}`,
    );
  } finally {
    page.unmount();
    awareness.destroy();
    ydoc.destroy();
  }
});

test("quotes, tasks, transitions and edge controls mirror on right-to-left lines", () => {
  const stylesheet = readFileSync(
    new URL("../src/style.css", import.meta.url),
    "utf8",
  );
  // jsdom has no layout, so read the declarations each part of a line gets.
  const rule = (selector: string) => {
    const start = stylesheet.indexOf(`\n${selector} {`);
    assert.ok(start >= 0, selector);
    return stylesheet.slice(start, stylesheet.indexOf("}", start));
  };
  const physical =
    /(?:padding|margin|border)-(?:left|right)|\b(?:left|right):|text-align: (?:left|right)|margin: \S+ \S+ \S+ \S+/;
  for (const [selector, logical] of [
    [
      ".md-quote",
      /padding-inline-start: 14px[^;]*;[^]*border-inline-start: 1px/,
    ],
    [".md-task-toggle", /margin-inline: -3px 7px/],
    [".fountain-transition > .cm-line", /text-align: end/],
    [".comment-marker-block .comment-marker", /inset-inline-end: 0/],
    [".embed-edit", /inset-inline-end: 9px/],
  ] as const) {
    assert.match(rule(selector), logical, selector);
    assert.doesNotMatch(rule(selector), physical, selector);
  }
});
