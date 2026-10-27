import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React from "react";
import * as Y from "yjs";
import { EditorView } from "@codemirror/view";
import { Awareness } from "y-protocols/awareness";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { keyboardCaretScroll } from "../src/editor-scroll";

let dom: JSDOM;
let render: typeof import("@testing-library/react").render;
let cleanup: typeof import("@testing-library/react").cleanup;
let act: typeof import("@testing-library/react").act;
let waitFor: typeof import("@testing-library/react").waitFor;
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
    "HTMLVideoElement",
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
  ({ render, cleanup, act, waitFor } = await import("@testing-library/react"));
  ({ MarkdownEditor } = await import("../src/editor"));
});
afterEach(() => cleanup());
after(() => dom.window.close());

async function finishFrame() {
  await act(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
}

// A document as Locdoc opens it: the editor has no focus, and its caret sits
// at the start of the document, where nobody placed it.
function open(source: string, path = "Writing/Plot.md", inPane = false) {
  const ydoc = new Y.Doc();
  const text = ydoc.getText("content");
  text.insert(0, source);
  const awareness = new Awareness(ydoc);
  const props = {
    ydoc,
    provider: { awareness } as any,
    editable: true,
    id: "engagement-fixture",
    path,
    onComment() {},
    onUpload() {},
  };
  const page = render(
    inPane ? (
      <div className="writing-pane">
        <MarkdownEditor {...props} />
      </div>
    ) : (
      <MarkdownEditor {...props} />
    ),
  );
  const content = page.container.querySelector<HTMLElement>(".cm-content")!;
  const view = EditorView.findFromDOM(content)!;
  assert.equal(view.state.selection.main.head, 0);
  assert.equal(view.hasFocus, false);
  return {
    page,
    props,
    text,
    view,
    // The visible text, which holds source only where the preview reveals it.
    shown: () => content.textContent!,
    figure: () => content.querySelector<HTMLElement>(".embed"),
    line: (selector: string) => content.querySelector(selector)?.textContent,
    close() {
      page.unmount();
      awareness.destroy();
      ydoc.destroy();
    },
  };
}

// The production example: an image alone on the first line, then a heading.
const plot =
  "![Reference image](_attachments/Plot-reference.jpg)\n## Story\n- A first beat.\n- A second beat.";
const imageSource = "![Reference image](_attachments/Plot-reference.jpg)";

test("all document formats use the keyboard's pane-only caret scrolling", () => {
  const [handler] = EditorState.create({
    extensions: keyboardCaretScroll,
  }).facet(EditorView.scrollHandler);
  for (const path of ["Page.md", "Scene.fountain", "Notes.txt"]) {
    const doc = open("Writing", path);
    try {
      assert.ok(
        doc.view.state.facet(EditorView.scrollHandler).includes(handler),
        "the editor must install keyboard caret scrolling",
      );
    } finally {
      doc.close();
    }
  }
});

test("touch selection preserves Markdown layout and native callouts until typing resumes", () => {
  const source =
    "# First heading\n\nA **bold passage** to copy.\n\n## Next heading";
  const doc = open(source);
  try {
    const content = doc.view.contentDOM;
    const heading = content.querySelector(".md-h1");
    const bold = content.querySelector(".md-strong");
    const touch = new window.Event("pointerdown", { bubbles: true });
    Object.defineProperty(touch, "pointerType", { value: "touch" });
    act(() => content.dispatchEvent(touch));
    act(() => {
      doc.view.focus();
      doc.view.dispatch({
        selection: {
          anchor: source.indexOf("bold"),
          head: source.indexOf("** to"),
        },
        userEvent: "select.pointer",
      });
    });
    assert.equal(doc.line(".md-h1"), "First heading");
    assert.ok(
      content.querySelector(".md-h1") === heading,
      "heading keeps its DOM",
    );
    assert.ok(
      content.querySelector(".md-strong") === bold,
      "selected text keeps its DOM",
    );
    const callout = new window.Event("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    content.dispatchEvent(callout);
    assert.equal(callout.defaultPrevented, false);
    assert.equal(doc.text.toString(), source);
    act(() =>
      doc.view.dispatch({
        selection: { anchor: source.indexOf("Next") },
        userEvent: "select.pointer",
      }),
    );
    assert.equal(
      doc.line(".md-h2"),
      "Next heading",
      "moving a native caret reveals no markers",
    );
    act(() =>
      doc.view.dispatch({
        changes: { from: source.indexOf("Next"), insert: "A " },
        selection: { anchor: source.indexOf("Next") + 2 },
        userEvent: "input.type",
      }),
    );
    assert.equal(
      doc.line(".md-h2"),
      "## A Next heading",
      "an actual edit resumes live source",
    );
  } finally {
    doc.close();
  }
});

for (const [path, source, selector, revealed] of [
  ["Page.md", "## A heading\n\nA **bold passage**.", ".md-h2", "## A heading"],
  [
    "Scene.fountain",
    ".INT. ROOM - DAY\n\nAn action.",
    ".fountain-scene",
    ".INT. ROOM - DAY",
  ],
] as const)
  test(`a completed touch tap reveals ${path} source without requiring an edit`, async () => {
    const doc = open(source, path);
    try {
      const touch = (type: string) => {
        const event = new window.Event(type, { bubbles: true });
        Object.defineProperty(event, "pointerType", { value: "touch" });
        act(() => doc.view.contentDOM.dispatchEvent(event));
      };
      touch("pointerdown");
      await act(async () => {
        doc.view.focus();
        doc.view.dispatch({
          selection: { anchor: 5 },
          userEvent: "select.pointer",
        });
      });
      assert.ok(
        doc.line(selector) !== revealed,
        "the preview stays stable while placing the native caret",
      );
      touch("pointerup");
      act(() =>
        doc.view.contentDOM.dispatchEvent(
          new window.MouseEvent("click", { bubbles: true }),
        ),
      );
      await waitFor(() =>
        assert.equal(
          doc.line(selector),
          revealed,
          "a settled tap reveals source at its caret",
        ),
      );
      assert.equal(
        doc.text.toString(),
        source,
        "revealing source never edits the file",
      );
    } finally {
      doc.close();
    }
  });

for (const selected of [false, true])
  test(`a touch click waits for the native caret after ${selected ? "a range" : "a caret"} before revealing source`, async () => {
    const source = "## First heading\n\nA paragraph.\n\n## Second heading";
    const doc = open(source);
    try {
      const touch = new window.Event("pointerdown", { bubbles: true });
      Object.defineProperty(touch, "pointerType", { value: "touch" });
      act(() => doc.view.contentDOM.dispatchEvent(touch));
      await act(async () => {
        doc.view.focus();
        doc.view.dispatch({
          selection: { anchor: 0, head: selected ? 5 : 0 },
          userEvent: "select.pointer",
        });
      });
      const caret = source.indexOf("Second");
      const point = doc.view.domAtPos(caret);
      act(() => {
        window.getSelection()!.collapse(point.node, point.offset);
        doc.view.contentDOM.dispatchEvent(
          new window.MouseEvent("click", { bubbles: true }),
        );
      });
      assert.equal(
        doc.view.state.selection.main.head,
        selected ? 5 : 0,
        "the editor has not read the native caret yet",
      );
      assert.equal(
        doc.line(".md-h2"),
        "First heading",
        "a late native selection must not reveal the old caret's source",
      );
      await act(async () => {
        document.dispatchEvent(new window.Event("selectionchange"));
      });
      assert.equal(
        doc.view.state.selection.main.head,
        caret,
        "CodeMirror reads the original native caret",
      );
      await waitFor(() => {
        const headings = [
          ...doc.view.contentDOM.querySelectorAll(".md-h2"),
        ].map((line) => line.textContent);
        assert.deepEqual(headings, ["First heading", "## Second heading"]);
      });
      assert.equal(doc.text.toString(), source);
    } finally {
      doc.close();
    }
  });

test("a touch click preserves a native range even before the editor has read it", async () => {
  const source = "A **bold passage** to copy.";
  const doc = open(source);
  try {
    const touch = new window.Event("pointerdown", { bubbles: true });
    Object.defineProperty(touch, "pointerType", { value: "touch" });
    act(() => doc.view.contentDOM.dispatchEvent(touch));
    await act(async () => {
      doc.view.focus();
      doc.view.dispatch({
        selection: { anchor: 0 },
        userEvent: "select.pointer",
      });
    });
    const start = doc.view.domAtPos(source.indexOf("bold"));
    const end = doc.view.domAtPos(source.indexOf(" passage"));
    const shown = doc.shown();
    act(() => {
      window
        .getSelection()!
        .setBaseAndExtent(start.node, start.offset, end.node, end.offset);
      doc.view.contentDOM.dispatchEvent(
        new window.MouseEvent("click", { bubbles: true }),
      );
    });
    assert.equal(
      doc.view.state.selection.main.empty,
      true,
      "the editor has not read the native range yet",
    );
    await finishFrame();
    assert.equal(
      doc.shown(),
      shown,
      "native word selection keeps the same preview geometry",
    );
    assert.equal(window.getSelection()!.toString(), "bold");
  } finally {
    doc.close();
  }
});

test("a native text selection keeps its preview and word DOM when a touch click arrives", async () => {
  const source = "## A heading\n\nA **bold passage** to copy.";
  const doc = open(source);
  try {
    const bold = doc.view.contentDOM.querySelector(".md-strong");
    const touch = new window.Event("pointerdown", { bubbles: true });
    Object.defineProperty(touch, "pointerType", { value: "touch" });
    act(() => doc.view.contentDOM.dispatchEvent(touch));
    act(() => {
      doc.view.focus();
      doc.view.dispatch({
        selection: {
          anchor: source.indexOf("bold"),
          head: source.indexOf(" passage"),
        },
        userEvent: "select.pointer",
      });
    });
    const shown = doc.shown();
    act(() =>
      doc.view.contentDOM.dispatchEvent(
        new window.MouseEvent("click", { bubbles: true }),
      ),
    );
    await finishFrame();
    assert.equal(doc.shown(), shown);
    assert.ok(
      doc.view.contentDOM.querySelector(".md-strong") === bold,
      "native range selection keeps its word DOM",
    );
  } finally {
    doc.close();
  }
});

for (const resume of ["typing", "arrow", "mouse", "tap"] as const)
  test(`resuming with ${resume} hides the old touch-held Markdown block`, async () => {
    // A short document reparses together and can conceal a stale decoration.
    // Keep the two selections in separate, reusable parser fragments.
    const source = Array.from(
      { length: 800 },
      (_, n) =>
        `## Heading ${n}\n\nParagraph ${n} has **some words** to read and edit.\n`,
    ).join("\n");
    const doc = open(source);
    try {
      assert.ok(
        ensureSyntaxTree(doc.view.state, source.length, 2000),
        "the long fixture must parse completely",
      );
      act(() => doc.view.dispatch({}));
      const heading = source.indexOf("Heading 10\n");
      const paragraph = source.indexOf("Paragraph 80 ");
      const headingMarkersHidden = () => {
        let hidden = false;
        for (const set of doc.view.state.facet(EditorView.decorations)) {
          if (typeof set === "function") continue;
          set.between(heading - 3, heading, (from, to) => {
            if (from === heading - 3 && to === heading) hidden = true;
          });
        }
        return hidden;
      };
      act(() => {
        doc.view.focus();
        doc.view.dispatch({
          selection: { anchor: heading },
          userEvent: "select.pointer",
        });
      });
      assert.equal(headingMarkersHidden(), false);
      const pointer = (type: "touch" | "mouse") => {
        const event = new window.Event("pointerdown", { bubbles: true });
        Object.defineProperty(event, "pointerType", { value: type });
        act(() => doc.view.contentDOM.dispatchEvent(event));
      };
      pointer("touch");
      act(() =>
        doc.view.dispatch({
          selection: { anchor: paragraph },
          userEvent: "select.pointer",
        }),
      );
      assert.equal(
        headingMarkersHidden(),
        false,
        "native selection keeps the previous preview layout stable",
      );
      if (resume === "typing")
        act(() =>
          doc.view.dispatch({
            changes: { from: paragraph, insert: "New " },
            selection: { anchor: paragraph + 4 },
            userEvent: "input.type",
          }),
        );
      else if (resume === "arrow")
        act(() =>
          doc.view.contentDOM.dispatchEvent(
            new window.KeyboardEvent("keydown", {
              key: "ArrowRight",
              bubbles: true,
            }),
          ),
        );
      else if (resume === "mouse") pointer("mouse");
      else {
        act(() =>
          doc.view.contentDOM.dispatchEvent(
            new window.MouseEvent("click", { bubbles: true }),
          ),
        );
        await finishFrame();
      }
      assert.equal(
        headingMarkersHidden(),
        true,
        "leaving native selection must refresh the formerly revealed block",
      );
      const expected =
        resume === "typing"
          ? source.slice(0, paragraph) + "New " + source.slice(paragraph)
          : source;
      assert.ok(
        doc.text.toString() === expected,
        "preview changes must preserve collaborative text",
      );
    } finally {
      doc.close();
    }
  });

test("touch selection preserves Fountain markers and word nodes through focus changes", () => {
  const source = ".INT. ROOM - DAY\n\n@MAYA\nA **bold passage** to copy.";
  const doc = open(source, "Scene.fountain");
  try {
    const content = doc.view.contentDOM;
    const shown = doc.shown();
    const bold = content.querySelector(".md-strong");
    const touch = new window.Event("pointerdown", { bubbles: true });
    Object.defineProperty(touch, "pointerType", { value: "touch" });
    act(() => content.dispatchEvent(touch));
    act(() => {
      doc.view.focus();
      doc.view.dispatch({
        selection: {
          anchor: source.indexOf("bold"),
          head: source.indexOf("** to"),
        },
        userEvent: "select.pointer",
      });
    });
    assert.equal(doc.shown(), shown);
    assert.ok(
      content.querySelector(".md-strong") === bold,
      "word DOM survives native selection",
    );
    act(() => content.blur());
    assert.equal(
      doc.shown(),
      shown,
      "blur does not reshape a held native selection",
    );
    assert.equal(doc.text.toString(), source);
  } finally {
    doc.close();
  }
});

test("the first formatting-button tap preserves the selected passage for linking", async () => {
  const { FormattingTools } = await import("../src/formatting-tools");
  const doc = open("A selected passage.");
  const calls: string[] = [];
  const tools = render(
    <FormattingTools
      format="markdown"
      editable
      busy={false}
      onEdit={() => {}}
      onUpload={() => {}}
      onComment={() => {}}
      onLink={() => {
        const { from, to } = doc.view.state.selection.main;
        calls.push(doc.view.state.sliceDoc(from, to));
      }}
    />,
  );
  try {
    act(() => {
      doc.view.focus();
      doc.view.dispatch({
        selection: { anchor: 2, head: 10 },
        userEvent: "select.pointer",
      });
    });
    const button = tools.container.querySelector<HTMLButtonElement>(
      '[aria-label^="Insert link"]',
    )!;
    const down = new window.MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    act(() => button.dispatchEvent(down));
    assert.equal(
      down.defaultPrevented,
      true,
      "the toolbar must not take native focus",
    );
    assert.ok(
      document.activeElement === doc.view.contentDOM,
      "editor retains focus",
    );
    act(() => button.click());
    assert.deepEqual(calls, ["selected"]);
    assert.equal(doc.text.toString(), "A selected passage.");
  } finally {
    tools.unmount();
    doc.close();
  }
});

test("editor commands activate once on release, support keyboard clicks, and cancel a drag", async () => {
  const { EditorCommandButton } = await import("../src/editor-command-button");
  const original = Object.getOwnPropertyDescriptor(window, "PointerEvent");
  Object.defineProperty(window, "PointerEvent", {
    value: window.MouseEvent,
    configurable: true,
  });
  let calls = 0;
  const props = {
    run: () => {
      calls++;
    },
    children: "Command",
  };
  const page = render(<EditorCommandButton {...props} />);
  const button = page.container.querySelector("button")!;
  button.getBoundingClientRect = () => new DOMRect(0, 0, 32, 32);
  const pointer = (type: string) => {
    const event = new window.MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 10,
      clientY: 10,
      relatedTarget: document.body,
    });
    Object.defineProperty(event, "pointerId", { value: 7 });
    act(() => button.dispatchEvent(event));
    return event;
  };
  try {
    assert.equal(pointer("pointerdown").defaultPrevented, true);
    assert.equal(calls, 0);
    pointer("pointerup");
    assert.equal(calls, 1, "release works without a compatibility click");
    act(() =>
      button.dispatchEvent(
        new window.MouseEvent("click", { bubbles: true, detail: 1 }),
      ),
    );
    assert.equal(calls, 1, "the later pointer click cannot run twice");
    act(() => button.click());
    assert.equal(calls, 2, "keyboard and assistive activation still work");
    pointer("pointerdown");
    pointer("pointerout");
    pointer("pointerup");
    assert.equal(calls, 2, "dragging off the button cancels the press");
    pointer("pointerdown");
    pointer("pointercancel");
    pointer("pointerup");
    assert.equal(calls, 2);
    pointer("pointerdown");
    page.rerender(<EditorCommandButton {...props} disabled />);
    pointer("pointerup");
    assert.equal(calls, 2, "disabling a pending command cancels it");
  } finally {
    page.unmount();
    if (original) Object.defineProperty(window, "PointerEvent", original);
    else Reflect.deleteProperty(window, "PointerEvent");
  }
});

test("touch links open on click, without a hover or a first tap to arm them", () => {
  const doc = open("[A page](https://example.test/)");
  const opened: string[] = [];
  doc.page.rerender(
    <MarkdownEditor
      {...doc.props}
      onLink={(target) => opened.push(target.url)}
    />,
  );
  try {
    const link = doc.view.contentDOM.querySelector("a[data-link-url]")!;
    const over = new window.Event("pointerover", { bubbles: true });
    Object.defineProperty(over, "pointerType", { value: "touch" });
    act(() => link.dispatchEvent(over));
    assert.equal(
      opened.length,
      0,
      "a touch must not be treated as mouse hover",
    );
    const click = new window.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    act(() => link.dispatchEvent(click));
    assert.equal(click.defaultPrevented, true);
    assert.deepEqual(opened, ["https://example.test/"]);
  } finally {
    doc.close();
  }
});

test("keyboard resizing reveals the current caret once and leaves native ranges alone", async (t) => {
  const originalObserver = globalThis.ResizeObserver;
  const clientHeight = Object.getOwnPropertyDescriptor(
    window.Element.prototype,
    "clientHeight",
  )!;
  let height = 500;
  const observers: {
    target?: Element;
    callback: () => void;
    disconnected: boolean;
  }[] = [];
  Object.defineProperty(window.Element.prototype, "clientHeight", {
    configurable: true,
    get() {
      return this.classList.contains("writing-pane") ? height : 0;
    },
  });
  globalThis.ResizeObserver = class {
    item: (typeof observers)[number];
    constructor(callback: () => void) {
      this.item = { callback, disconnected: false };
      observers.push(this.item);
    }
    observe(target: Element) {
      this.item.target = target;
    }
    unobserve() {}
    disconnect() {
      this.item.disconnected = true;
    }
  } as any;
  let doc: ReturnType<typeof open> | undefined;
  try {
    doc = open("A passage to edit.", "Page.md", true);
    act(() => {
      doc!.view.focus();
      doc!.view.dispatch({ selection: { anchor: 5 } });
    });
    document.documentElement.setAttribute("data-keyboard-open", "");
    const resize = observers.find((item) =>
      item.target?.classList.contains("writing-pane"),
    )!;
    assert.ok(resize, "the editor observes its actual writing pane");
    const originalDispatch = doc.view.dispatch;
    const dispatch = t.mock.method(doc.view, "dispatch");
    const requests = () =>
      dispatch.mock.calls.flatMap((call) => {
        const spec = call.arguments[0] as any;
        return spec?.effects?.value?.range
          ? [spec.effects.value.range.head]
          : [];
      });
    height = 300;
    resize.callback();
    height = 280;
    resize.callback();
    await waitFor(() => assert.deepEqual(requests(), [5]));
    act(() => originalDispatch({ selection: { anchor: 2, head: 8 } }));
    height = 260;
    resize.callback();
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    assert.equal(
      requests().length,
      1,
      "native text selection must not be scrolled by the app",
    );
    doc.close();
    doc = undefined;
    assert.equal(resize.disconnected, true);
  } finally {
    doc?.close();
    document.documentElement.removeAttribute("data-keyboard-open");
    globalThis.ResizeObserver = originalObserver;
    Object.defineProperty(
      window.Element.prototype,
      "clientHeight",
      clientHeight,
    );
  }
});

test("an image on the first line renders at open and shows its source once clicked", () => {
  const doc = open(plot);
  try {
    const image = doc.figure()?.querySelector("img");
    assert.ok(
      image,
      "the first-line image must render when the document opens",
    );
    assert.equal(image.getAttribute("alt"), "Reference image");
    assert.ok(!doc.shown().includes("!["), "no image source shows at open");
    assert.equal(doc.line(".cm-line.md-h2"), "Story");
    // A click on the image line, as CodeMirror dispatches it.
    act(() =>
      doc.view.dispatch({
        selection: { anchor: 3 },
        userEvent: "select.pointer",
      }),
    );
    assert.ok(doc.figure() === null, "the clicked image shows its source");
    assert.ok(doc.shown().includes(imageSource));
    assert.equal(doc.line(".cm-line.md-h2"), "Story");
  } finally {
    doc.close();
  }
});

test("Edit Markdown on a first-line image reveals its source", () => {
  const doc = open(plot);
  try {
    const edit = doc.figure()?.querySelector<HTMLButtonElement>(".embed-edit");
    assert.ok(edit, "the rendered image must offer Edit Markdown");
    act(() => edit.click());
    assert.equal(doc.view.state.selection.main.head, 0);
    assert.ok(doc.figure() === null, "Edit Markdown must reveal the source");
    assert.ok(doc.shown().includes(imageSource));
  } finally {
    doc.close();
  }
});

test("a heading on the first line renders at open and focusing the editor reveals it", async () => {
  const doc = open("# Written in Sand\n\nThe first paragraph.");
  try {
    assert.equal(
      doc.line(".cm-line.md-h1"),
      "Written in Sand",
      "the heading marker must stay hidden at open",
    );
    act(() => doc.view.focus());
    await waitFor(() =>
      assert.equal(doc.line(".cm-line.md-h1"), "# Written in Sand"),
    );
  } finally {
    doc.close();
  }
});

test("typing a dash below text does not make a heading or rewrite the source", () => {
  const source = "Motivation questions\n";
  const doc = open(source);
  try {
    act(() =>
      doc.view.dispatch({
        changes: { from: source.length, insert: "-" },
        selection: { anchor: source.length + 1 },
        userEvent: "input.type",
      }),
    );
    assert.equal(doc.line(".md-h2"), undefined);
    assert.equal(
      doc.text.toString(),
      source + "-",
      "typing retains exact bytes",
    );
    assert.equal(doc.line(".cm-line"), "Motivation questions");
    assert.ok(doc.shown().includes("-"), "the dash remains visible");
    act(() =>
      doc.view.dispatch({
        changes: { from: source.length + 1, insert: " First question" },
        userEvent: "input.type",
      }),
    );
    assert.ok(
      doc.page.container.querySelector(".md-list"),
      "a bullet still works",
    );
  } finally {
    doc.close();
  }
});

test("underline-style headings stay disabled when opening or reading Markdown", () => {
  for (const marker of ["-", "--", "---", "=", "==", "====="]) {
    const source = `Story\n${marker}\n\n## Explicit heading`;
    const doc = open(source);
    try {
      assert.equal(
        doc.line(".md-h1"),
        undefined,
        "equals never underlines a title",
      );
      assert.equal(
        doc.line(".md-h2"),
        "Explicit heading",
        "only # creates the heading",
      );
      assert.equal(doc.line(".cm-line"), "Story");
      assert.equal(doc.text.toString(), source);
      assert.equal(
        doc.page.container.querySelectorAll(".md-rule").length,
        marker === "---" ? 1 : 0,
        "three dashes still draw a divider",
      );
      if (marker !== "---") assert.ok(doc.shown().includes(marker));
    } finally {
      doc.close();
    }
  }
});

test("Locdoc's own selections and remote edits reveal nothing; typing does", () => {
  const doc = open("Some **bold** words.\n\nA second paragraph.");
  try {
    assert.ok(!doc.shown().includes("**"), "emphasis renders at open");
    act(() => doc.view.dispatch({ selection: { anchor: 7 } }));
    act(() => doc.text.insert(doc.text.length, " Remote words."));
    assert.ok(doc.shown().includes("Remote words."));
    assert.ok(
      !doc.shown().includes("**"),
      "a selection without a user event and a remote edit reveal nothing",
    );
    act(() =>
      doc.view.dispatch({
        changes: { from: 7, insert: "very " },
        selection: { anchor: 12 },
        userEvent: "input.type",
      }),
    );
    assert.ok(
      doc.shown().includes("Some **very bold** words."),
      "typing reveals the source where the caret is",
    );
  } finally {
    doc.close();
  }
});

test("find reveals the line of each match it selects", () => {
  const doc = open(
    "![Sand map](_media/map.png)\n\nPlain prose.\n\n## Sand dunes\n\nMore.",
  );
  try {
    assert.ok(doc.figure(), "the first-line image renders at open");
    act(() => {
      doc.view.contentDOM.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "f",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    const field = doc.page.container.querySelector<HTMLInputElement>(
      '.find-widget input[name="search"]',
    );
    assert.ok(field, "Mod-f opens the find widget");
    act(() => {
      field.value = "Sand";
      field.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    const selected = () => {
      const { from, to } = doc.view.state.selection.main;
      return `${from}:${doc.view.state.sliceDoc(from, to)}`;
    };
    assert.equal(selected(), "2:Sand", "find selects the first match");
    assert.ok(doc.figure() === null, "the match inside the image shows");
    assert.ok(doc.shown().includes("![Sand map](_media/map.png)"));
    assert.equal(doc.line(".cm-line.md-h2"), "Sand dunes");
    act(() => {
      field.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    assert.equal(selected().split(":")[1], "Sand", "Enter steps to the next");
    assert.ok(doc.figure(), "the image renders again once find moves on");
    assert.equal(doc.line(".cm-line.md-h2"), "## Sand dunes");
  } finally {
    doc.close();
  }
});

test("a new editor lays its document out once as it opens, and still applies later changes", (t) => {
  // Every view binds its dispatch as it is built, from the prototype.
  const dispatch = t.mock.method(EditorView.prototype, "dispatch");
  const doc = open(
    "INT. HOUSE - DAY\n\nMAYA\nWhere were you?",
    "Writing/Plot.fountain",
  );
  try {
    assert.equal(
      dispatch.mock.callCount(),
      0,
      "its configuration is current and it has no comments to show",
    );
    // A permission change applies in the commit that shows it.
    doc.page.rerender(<MarkdownEditor {...doc.props} editable={false} />);
    assert.equal(doc.view.state.readOnly, true);
    // A rename changes its format.
    doc.page.rerender(
      <MarkdownEditor {...doc.props} editable={false} path="Writing/Plot.md" />,
    );
    assert.ok(
      doc.page.container.querySelector('[aria-label="Markdown document"]'),
    );
    // Comments that arrive show, and leave when they go.
    const comment = {
      id: "c1",
      body: "A note",
      name: "alex",
      canResolve: true,
      quote: null,
      anchor: null,
      created: 0,
      resolved: false,
      replies: [],
    };
    doc.page.rerender(
      <MarkdownEditor
        {...doc.props}
        editable={false}
        path="Writing/Plot.md"
        comments={[comment]}
      />,
    );
    assert.ok(doc.page.container.querySelector(".comment-marker"));
    doc.page.rerender(
      <MarkdownEditor
        {...doc.props}
        editable={false}
        path="Writing/Plot.md"
        comments={[]}
      />,
    );
    assert.equal(doc.page.container.querySelector(".comment-marker"), null);
    assert.equal(dispatch.mock.callCount(), 4, "one for each change");
  } finally {
    doc.close();
  }
});

test("a new preview configuration keeps the user's engagement", () => {
  const doc = open("# Title\n\nSee [the other](Other.md).");
  try {
    act(() =>
      doc.view.dispatch({
        selection: { anchor: 3 },
        userEvent: "select.pointer",
      }),
    );
    assert.equal(doc.line(".cm-line.md-h1"), "# Title");
    // Sidebar metadata refreshes reconfigure the preview with new entries.
    doc.page.rerender(
      <MarkdownEditor
        {...doc.props}
        entries={[
          {
            id: "other",
            path: "Writing/Other.md",
            kind: "file",
            shared: false,
            url: "/d/other",
          },
        ]}
      />,
    );
    assert.ok(
      doc.page.container.querySelector('a.md-link[href="/d/other"]'),
      "the preview must use the new entries",
    );
    assert.equal(
      doc.line(".cm-line.md-h1"),
      "# Title",
      "the line the user is on stays revealed",
    );
  } finally {
    doc.close();
  }
});
