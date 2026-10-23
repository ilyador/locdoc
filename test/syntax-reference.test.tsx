import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import React from "react";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { sourceComments } from "../src/comment-syntax";
import type { DocumentFormat } from "../src/document-format";
import type { Document, Entry } from "../src/model";
import { exampleSource, syntaxReference } from "../src/syntax-reference";

// jsdom applies no layout and only matches screen media. The cascade test
// below reads the app stylesheet with the narrow and touch rules applied.
const stylesheet = readFileSync(
  new URL("../src/style.css", import.meta.url),
  "utf8",
);
const touch = stylesheet.replace(/@media ([^{]+)\{/g, (rule, query) =>
  /pointer: coarse|max-width: 760px/.test(query) && !/min-width/.test(query)
    ? "@media screen {"
    : rule,
);

let dom: JSDOM;
let render: typeof import("@testing-library/react").render;
let cleanup: typeof import("@testing-library/react").cleanup;
let act: typeof import("@testing-library/react").act;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let MarkdownEditor: typeof import("../src/editor").MarkdownEditor;
let DocumentFooter: typeof import("../src/document-footer").DocumentFooter;
let HOVER_DELAY: number, LEAVE_DELAY: number;
let style: HTMLStyleElement;

before(async () => {
  dom = new JSDOM(
    "<!doctype html><html><head><style></style></head><body></body></html>",
    { url: "http://localhost/", pretendToBeVisual: true },
  );
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
  window.matchMedia = () =>
    ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }) as any;
  style = document.querySelector("style")!;
  // jsdom has no Popover API and never displays a [popover]. Display the ones
  // the app shows, as a browser's top layer does, so focus can enter them.
  const shown = document.createElement("style");
  shown.textContent = "[popover][data-shown] { display: block !important; }";
  document.head.append(shown);
  window.HTMLElement.prototype.showPopover = function (this: HTMLElement) {
    this.setAttribute("data-shown", "");
  };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  ({ render, cleanup, act, fireEvent } =
    await import("@testing-library/react"));
  ({ MarkdownEditor } = await import("../src/editor"));
  ({ DocumentFooter } = await import("../src/document-footer"));
  ({ HOVER_DELAY, LEAVE_DELAY } = await import("../src/format-reference"));
});
afterEach(() => {
  cleanup();
  style.textContent = "";
});
after(() => dom.window.close());

const paths: Record<DocumentFormat, string> = {
  markdown: "Notes/reference.md",
  fountain: "Notes/reference.fountain",
  text: "Notes/reference.txt",
};
const entries: Entry[] = [
  {
    id: "notes",
    path: "Notes/notes.md",
    kind: "file",
    shared: false,
    url: "/d/00000000-0000-4000-8000-000000000001",
  },
];

// Every line is away from a caret in a read-only view, so each shows its
// preview rather than its source.
function preview(source: string, format: DocumentFormat) {
  const ydoc = new Y.Doc();
  ydoc.getText("content").insert(0, source);
  const awareness = new Awareness(ydoc);
  const page = render(
    <MarkdownEditor
      ydoc={ydoc}
      provider={{ awareness } as any}
      id="reference"
      editable={false}
      path={paths[format]}
      entries={entries}
      onComment={() => {}}
      onUpload={() => {}}
    />,
  );
  const content = page.container.querySelector<HTMLElement>(".cm-content")!;
  const lines = () => Array.from(content.querySelectorAll(".cm-line"));
  return {
    content,
    lines,
    text: (index: number) => lines()[index]?.textContent ?? "",
    texts: () => lines().map((line) => line.textContent),
    line: (index: number) => lines()[index]!,
    all: (selector: string) =>
      Array.from(content.querySelectorAll<HTMLElement>(selector)),
    one: (selector: string) => content.querySelector<HTMLElement>(selector),
    close() {
      page.unmount();
      awareness.destroy();
      ydoc.destroy();
    },
  };
}
type Preview = ReturnType<typeof preview>;
function rendered(
  source: string,
  format: DocumentFormat,
  check: (view: Preview) => void,
) {
  const view = preview(source, format);
  try {
    check(view);
  } finally {
    view.close();
  }
}
const has = (element: Element | undefined, name: string) =>
  !!element?.classList.contains(name);
const wrapperOf = (view: Preview, index: number, name: string) =>
  !!view.line(index).closest(`.${name}`);

// Records read the same everywhere; what keeps one literal differs.
function commentChecks(format: DocumentFormat) {
  const plain = format === "text";
  const threads = (source: string) => sourceComments(source, plain);
  return {
    "Text[[comment(alex): Note]]": (source: string) => {
      const [thread, ...rest] = threads(source);
      assert.equal(rest.length, 0);
      assert.equal(thread.from, "Text".length, "it follows the passage");
      assert.deepEqual(
        thread.messages.map((m) => `${m.name}: ${m.body}`),
        ["alex: Note"],
      );
      rendered(source, format, (view) =>
        assert.deepEqual(view.texts(), ["Text"], "the record is hidden"),
      );
    },
    "[[comment(alex): Note]]\n[[comment(sam): Reply]]": (source: string) => {
      const found = threads(source);
      assert.equal(found.length, 1, "one conversation");
      assert.deepEqual(
        found[0].messages.map((m) => `${m.name}: ${m.body}`),
        ["alex: Note", "sam: Reply"],
      );
    },
    "[[comment(alex): One]]\n\n[[comment(sam): Two]]": (source: string) => {
      assert.deepEqual(
        threads(source).map((t) => t.messages.map((m) => m.body).join()),
        ["One", "Two"],
        "two conversations",
      );
    },
    "\\]  \\)  \\\\  \\n": (source: string) => {
      const [bracket, paren, slash, newline] = source.split(/\s+/);
      const [thread] = threads(
        `[[comment(sam${paren}): a${bracket}b${slash}c${newline}d]]`,
      );
      assert.equal(thread.messages[0].name, "sam)", ") in a name");
      assert.equal(
        thread.messages[0].body,
        "a]b\\c\nd",
        "], a backslash and a line break in a message",
      );
    },
    "\\[[comment(alex): Note]]": (source: string) => {
      assert.equal(threads(source).length, 0, "an escaped record is text");
      const code = "`[[comment(alex): Note]]`";
      const link = "[Passage [[comment(alex): Note]]](https://example.com)";
      assert.equal(
        threads(code).length + threads(link).length,
        plain ? 2 : 0,
        plain
          ? "plain text has no code or links to keep a record literal"
          : "a record in code or a link is text",
      );
    },
  };
}

const markdownChecks: Record<string, (source: string) => void> = {
  "# Heading": (source) =>
    rendered(source, "markdown", (view) => {
      assert.ok(has(view.line(0), "md-h1"));
      assert.equal(view.text(0), "Heading", "the marker is hidden");
      rendered("###### Small", "markdown", (six) =>
        assert.ok(has(six.line(0), "md-h6"), "up to six #"),
      );
    }),
  "**bold**": (source) =>
    rendered(source, "markdown", (view) => {
      assert.equal(view.one(".md-strong")?.textContent, "bold");
      assert.equal(view.text(0), "bold");
    }),
  "*italic*": (source) => {
    for (const italic of [source, "_italic_"])
      rendered(italic, "markdown", (view) => {
        assert.equal(view.one(".md-em")?.textContent, "italic", italic);
        assert.equal(view.text(0), "italic");
      });
  },
  "~~deleted~~": (source) =>
    rendered(source, "markdown", (view) => {
      assert.equal(view.one(".md-strike")?.textContent, "deleted");
      assert.equal(view.text(0), "deleted");
    }),
  "`code`": (source) =>
    rendered(source, "markdown", (view) => {
      assert.equal(view.one(".md-inline-code")?.textContent, "code");
      assert.equal(view.text(0), "code");
    }),
  "\\*not italic\\*": (source) =>
    rendered(source, "markdown", (view) => {
      assert.ok(!view.one(".md-em"), "nothing is italic");
      assert.ok(view.text(0).includes("*not italic"), "the * stays text");
    }),
  "[label](https://example.com)": (source) =>
    rendered(source, "markdown", (view) => {
      const link = view.one("a.md-link");
      assert.equal(link?.getAttribute("href"), "https://example.com/");
      assert.equal(view.text(0), "label", "only the label shows");
    }),
  "[label](notes.md)": (source) =>
    rendered(source, "markdown", (view) => {
      assert.equal(
        view.one("a.md-link")?.getAttribute("href"),
        entries[0].url,
        "the path is relative to this document",
      );
      assert.equal(view.text(0), "label");
    }),
  "https://example.com": (source) =>
    rendered(source, "markdown", (view) =>
      assert.equal(
        view.one("a.md-link")?.getAttribute("href"),
        "https://example.com/",
      ),
    ),
  "![alt text](photo.png)": (source) => {
    rendered(source, "markdown", (view) => {
      const image = view.one("figure.embed img") as HTMLImageElement | null;
      assert.equal(image?.alt, "alt text", "alone on a line: a figure");
      assert.ok(image?.src.includes("path=photo.png"), "a local file");
    });
    rendered(`Before ${source} after`, "markdown", (view) =>
      assert.ok(view.one(".embed-inline img"), "within a line: inline"),
    );
    rendered("![alt text](https://example.com/photo.png)", "markdown", (view) =>
      assert.ok(!view.one("img"), "a remote image is not shown"),
    );
  },
  "![alt text](clip.mp4)": (source) => {
    for (const video of [source, "![a](clip.webm)", "![a](clip.mov)"])
      rendered(video, "markdown", (view) =>
        assert.ok(view.one("figure.embed video"), video),
      );
  },
  "First line\nSecond line": (source) =>
    rendered(source, "markdown", (view) => {
      assert.deepEqual(view.texts(), ["First line", "Second line"]);
      assert.ok(
        view.lines().every((line) => has(line, "md-block-end")),
        "each line has paragraph spacing",
      );
    }),
  "Paragraph\n\nNext one": (source) => {
    rendered(source, "markdown", (view) => {
      assert.deepEqual(view.texts(), ["Paragraph", "", "Next one"]);
      assert.deepEqual(
        view.lines().map((line) => has(line, "md-block-end")),
        [true, false, true],
      );
    });
    rendered("- Item\n\nNext one", "markdown", (view) => {
      assert.ok(wrapperOf(view, 0, "md-list"));
      assert.ok(!wrapperOf(view, 2, "md-list"), "the list has ended");
    });
    rendered("> Quote\nStill quoted\n\nNext one", "markdown", (view) =>
      assert.deepEqual(
        view.lines().map((line) => has(line, "md-quote")),
        [true, true, false, false],
        "without a blank line the quote continues",
      ),
    );
  },
  "- Item": (source) => {
    for (const item of [source, "* Item", "+ Item"])
      rendered(item, "markdown", (view) => {
        assert.ok(wrapperOf(view, 0, "md-list"), item);
        assert.ok(view.one(".md-list-prefix"), item);
      });
  },
  "1. Item": (source) =>
    rendered(source, "markdown", (view) => {
      assert.ok(wrapperOf(view, 0, "md-list"));
      assert.equal(view.one(".md-list-prefix")?.textContent, "1. ");
    }),
  "- [ ] Task": (source) =>
    rendered(source, "markdown", (view) => {
      const box = view.one("input.md-task-checkbox") as HTMLInputElement;
      assert.equal(box?.checked, false);
      assert.equal(box?.getAttribute("aria-label"), "Task");
    }),
  "- [x] Done": (source) =>
    rendered(source, "markdown", (view) => {
      const box = view.one("input.md-task-checkbox") as HTMLInputElement;
      assert.equal(box?.checked, true);
      assert.ok(has(view.line(0), "done"));
    }),
  "- Item\n  - Nested": (source) =>
    rendered(source, "markdown", (view) => {
      const indents = view
        .all(".md-list")
        .map((list) =>
          parseFloat(list.style.getPropertyValue("--list-indent")),
        );
      assert.equal(indents.length, 2);
      assert.ok(indents[1] > indents[0], "the nested item is indented");
    }),
  "> Quote": (source) =>
    rendered(source, "markdown", (view) => {
      assert.ok(has(view.line(0), "md-quote"));
      assert.equal(view.text(0).trim(), "Quote", "the marker is hidden");
    }),
  "```\ncode\n```": (source) =>
    rendered(source, "markdown", (view) =>
      assert.deepEqual(
        view.lines().map((line) => has(line, "md-code-line")),
        [true, true, true],
      ),
    ),
  "| Tea   | Cups |\n| ----- | ---: |\n| Green |    2 |": (source) =>
    rendered(source, "markdown", (view) => {
      const cells = view.all(".md-table-preview th, .md-table-preview td");
      assert.deepEqual(
        cells.map((cell) => cell.textContent),
        ["Tea", "Cups", "Green", "2"],
      );
      assert.equal(cells[1].style.textAlign, "right", "--: aligns right");
    }),
  "---": (source) => {
    rendered(`Text\n\n${source}`, "markdown", (view) =>
      assert.ok(has(view.line(2), "md-rule")),
    );
    rendered(source, "markdown", (view) =>
      assert.ok(has(view.line(0), "md-rule")),
    );
  },
  ...commentChecks("markdown"),
};

// A Fountain line and the element it previews as.
function element(
  source: string,
  index: number,
  kind: string,
  text?: string,
  context = (line: string) => line,
) {
  rendered(context(source), "fountain", (view) => {
    assert.ok(wrapperOf(view, index, `fountain-${kind}`), `${source}: ${kind}`);
    if (text !== undefined)
      assert.equal(view.text(index).trim(), text, `${source}: shows ${text}`);
  });
}
const fountainChecks: Record<string, (source: string) => void> = {
  "INT. HOUSE - DAY": (source) => {
    for (const scene of [
      source,
      "EXT. ROOF - NIGHT",
      "EST. CITY - DAY",
      "I/E CAR - DAY",
    ])
      element(scene, 0, "scene");
    rendered(`She waits.\n${source}`, "fountain", (view) =>
      assert.ok(!wrapperOf(view, 1, "fountain-scene"), "needs a blank line"),
    );
  },
  ".FLASHBACK": (source) => element(source, 0, "scene", "FLASHBACK"),
  "She waits by the door.": (source) => element(source, 0, "action"),
  "!THE LIGHTS GO OUT.": (source) =>
    element(source, 0, "action", "THE LIGHTS GO OUT."),
  "MAYA\nWhere were you?": (source) => {
    element(source, 0, "character", "MAYA");
    element(source, 1, "dialogue", "Where were you?");
  },
  "@McKenna": (source) => {
    element(source, 0, "character", "McKenna");
    element("McKenna\nHi.", 0, "action");
  },
  "(quietly)": (source) =>
    element(source, 1, "parenthetical", "(quietly)", (line) => {
      return `MAYA\n${line}\nHello.`;
    }),
  "SAM ^": (source) =>
    rendered(`MAYA\nHello.\n\n${source}\nHi.`, "fountain", (view) => {
      assert.ok(wrapperOf(view, 3, "fountain-character"));
      assert.equal(
        view
          .line(3)
          .querySelector(".fountain-dual-marker")
          ?.textContent?.trim(),
        "^",
        "the ^ stays visible",
      );
      assert.ok(wrapperOf(view, 4, "fountain-dialogue"));
    }),
  "~Lyrics": (source) => element(source, 0, "lyric", "Lyrics"),
  "CUT TO:": (source) => {
    element(source, 2, "transition", source, (line) => {
      return `She waits.\n\n${line}\n\nINT. HOUSE - DAY`;
    });
    rendered(`She waits.\n\n${source}\nMore.`, "fountain", (view) =>
      assert.ok(!wrapperOf(view, 2, "fountain-transition")),
    );
  },
  "> FADE OUT.": (source) => element(source, 0, "transition", "FADE OUT."),
  "> THE END <": (source) => element(source, 0, "centered", "THE END"),
  "===": (source) => element(source, 0, "break"),
  "Title: The Signal\nAuthor: Sam Lee": (source) => {
    element(source, 0, "title", "The Signal");
    element(source, 1, "credit", "Sam Lee");
    rendered(`INT. HOUSE - DAY\n\n${source}`, "fountain", (view) =>
      assert.ok(!wrapperOf(view, 2, "fountain-title"), "only at the top"),
    );
  },
  "*italic*": (source) =>
    rendered(source, "fountain", (view) => {
      assert.equal(view.one(".md-em")?.textContent, "italic");
      assert.equal(view.text(0), "italic");
    }),
  "**bold**": (source) =>
    rendered(source, "fountain", (view) =>
      assert.equal(view.one(".md-strong")?.textContent, "bold"),
    ),
  "***bold italic***": (source) =>
    rendered(source, "fountain", (view) => {
      assert.equal(view.one(".md-strong")?.textContent, "bold italic");
      assert.ok(view.one(".md-em")?.textContent?.includes("bold italic"));
    }),
  _underline_: (source) =>
    rendered(source, "fountain", (view) =>
      assert.equal(view.one(".fountain-underline")?.textContent, "underline"),
    ),
  "\\*not italic\\*": (source) =>
    rendered(source, "fountain", (view) => {
      assert.ok(!view.one(".md-em"), "nothing is italic");
      assert.equal(view.text(0), "*not italic*", "the backslashes hide");
    }),
  "# Act one": (source) => {
    element(source, 0, "section", "Act one");
    element("## Scene group", 0, "section", "Scene group");
  },
  "= Synopsis": (source) => element(source, 0, "synopsis", "Synopsis"),
  "[[Note]]": (source) =>
    rendered(source, "fountain", (view) =>
      assert.equal(view.one(".fountain-note-ink")?.textContent, source),
    ),
  "/* Cut scene */": (source) =>
    rendered(source, "fountain", (view) =>
      assert.equal(view.one(".fountain-omitted-ink")?.textContent, source),
    ),
  ...commentChecks("fountain"),
};

const textChecks: Record<string, (source: string) => void> = {
  "First line\nSecond line": (source) =>
    rendered(source, "text", (view) => {
      assert.deepEqual(view.texts(), ["First line", "Second line"]);
      assert.ok(view.lines().every((line) => has(line, "text-block-end")));
    }),
  "**not bold**  # not a heading": (source) =>
    rendered(source, "text", (view) => {
      assert.equal(view.text(0), source, "exactly as typed");
      assert.equal(
        view.all(".md-strong, .md-em, .md-h1, .md-link, img").length,
        0,
      );
    }),
  ...commentChecks("text"),
};

const checks: Record<DocumentFormat, Record<string, (s: string) => void>> = {
  markdown: markdownChecks,
  fountain: fountainChecks,
  text: textChecks,
};
const examples = (format: DocumentFormat) =>
  syntaxReference[format].columns.flat().flatMap((group) => group.examples);

for (const format of ["markdown", "fountain", "text"] as const)
  test(`every ${format} reference example shows in its editor as described`, () => {
    const listed = examples(format).map(exampleSource);
    assert.equal(new Set(listed).size, listed.length, "examples are unique");
    for (const source of listed) {
      const check = checks[format][source];
      assert.ok(
        check,
        `${format} example ${JSON.stringify(source)} is checked`,
      );
      check(source);
    }
  });

function documentAt(path: string): Document {
  return {
    id: "reference",
    path,
    owner: true,
    edit: true,
    permission: "private",
    shareUrl: null,
    usage: 0,
    content: "Text",
    modified: 0,
    state: "",
  };
}
function footer(path = paths.markdown) {
  const page = render(
    <div>
      <textarea aria-label="Writing" />
      <DocumentFooter
        status="Saved to disk"
        doc={documentAt(path)}
        id="reference"
      />
    </div>,
  );
  const trigger =
    page.container.querySelector<HTMLButtonElement>(".markdown-tag")!;
  return {
    page,
    trigger,
    writing: page.container.querySelector("textarea")!,
    panel: () => page.container.querySelector<HTMLElement>(".syntax-reference"),
  };
}
const mouse = { pointerType: "mouse" };
const touchPointer = { pointerType: "touch" };
const wait = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

test("the format label names its syntax reference and shows the document's format", () => {
  for (const [format, title, group] of [
    ["markdown", "Markdown syntax", "Lists"],
    ["fountain", "Fountain syntax", "Dialogue"],
    ["text", "Plain text syntax", "Comments"],
  ] as const) {
    const view = footer(paths[format]);
    assert.equal(view.trigger.textContent, title.replace(" syntax", ""));
    assert.equal(view.trigger.getAttribute("aria-label"), title);
    assert.equal(view.trigger.getAttribute("aria-haspopup"), "dialog");
    assert.equal(view.trigger.getAttribute("aria-expanded"), "false");
    act(() => view.trigger.click());
    const panel = view.panel()!;
    assert.equal(panel.getAttribute("role"), "dialog");
    assert.equal(view.trigger.getAttribute("aria-controls"), panel.id);
    const name = document.getElementById(
      panel.getAttribute("aria-labelledby")!,
    );
    assert.equal(name?.textContent, title);
    assert.ok(
      Array.from(panel.querySelectorAll("h3")).some(
        (heading) => heading.textContent === group,
      ),
      `${format} lists ${group}`,
    );
    const shown = Array.from(panel.querySelectorAll("dt code")).map(
      (code) => code.textContent,
    );
    assert.deepEqual(shown, examples(format).map(exampleSource));
    // Examples are text, never markup or media.
    assert.equal(
      panel.querySelectorAll("a, img, video, strong, em, input").length,
      0,
    );
    cleanup();
  }
});

test("hovering opens the reference after a pause and it stays while the pointer moves onto it", async () => {
  const view = footer();
  act(() => view.writing.focus());
  fireEvent.pointerEnter(view.trigger, mouse);
  assert.ok(!view.panel(), "a passing pointer does not open it");
  await wait(HOVER_DELAY + 40);
  assert.ok(view.panel(), "a resting pointer opens it");
  assert.equal(view.trigger.getAttribute("aria-expanded"), "true");
  assert.ok(document.activeElement === view.writing, "focus stays in place");
  fireEvent.pointerLeave(view.trigger, mouse);
  fireEvent.pointerEnter(view.panel()!, mouse);
  await wait(LEAVE_DELAY + 40);
  assert.ok(view.panel(), "the pointer can move into the reference");
  fireEvent.pointerLeave(view.panel()!, mouse);
  await wait(LEAVE_DELAY + 40);
  assert.ok(!view.panel(), "leaving both closes it");
  assert.equal(view.trigger.getAttribute("aria-expanded"), "false");

  // Leaving before the pause opens nothing.
  fireEvent.pointerEnter(view.trigger, mouse);
  fireEvent.pointerLeave(view.trigger, mouse);
  await wait(HOVER_DELAY + 40);
  assert.ok(!view.panel(), "the reference is closed");

  // Pressing inside, as to select an example, keeps it open.
  fireEvent.pointerEnter(view.trigger, mouse);
  await wait(HOVER_DELAY + 40);
  fireEvent.pointerLeave(view.trigger, mouse);
  fireEvent.pointerEnter(view.panel()!, mouse);
  fireEvent.pointerDown(view.panel()!.querySelector("code")!, mouse);
  fireEvent.pointerLeave(view.panel()!, mouse);
  await wait(LEAVE_DELAY + 40);
  assert.ok(view.panel(), "a press inside keeps the reference");
  fireEvent.pointerDown(view.writing, mouse);
  assert.ok(!view.panel(), "the reference is closed");
});

test("typing, a press elsewhere or Escape closes the reference without taking the writer's focus", async () => {
  const view = footer();
  const escapes: string[] = [];
  const outer = (event: KeyboardEvent) => {
    if (event.key === "Escape") escapes.push("workspace");
  };
  window.addEventListener("keydown", outer);
  try {
    act(() => view.writing.focus());
    fireEvent.pointerEnter(view.trigger, mouse);
    await wait(HOVER_DELAY + 40);
    fireEvent.keyDown(view.writing, { key: "Shift" });
    assert.ok(view.panel(), "a modifier alone is not typing");
    fireEvent.keyDown(view.writing, { key: "a" });
    assert.ok(!view.panel(), "typing elsewhere closes it");
    assert.ok(document.activeElement === view.writing);
    await wait(HOVER_DELAY + 40);
    assert.ok(!view.panel(), "a resting pointer does not reopen it");

    act(() => view.trigger.click());
    const press = fireEvent.pointerDown(view.writing, mouse);
    assert.ok(!view.panel(), "a press elsewhere closes it");
    assert.ok(press, "the press still reaches the document");

    act(() => view.trigger.click());
    fireEvent.keyDown(view.writing, { key: "Escape" });
    assert.ok(!view.panel(), "Escape closes it");
    assert.deepEqual(escapes, [], "Escape closed only the reference");
    fireEvent.keyDown(view.writing, { key: "Escape" });
    assert.deepEqual(escapes, ["workspace"], "later Escapes reach the page");

    // An editor command that used Escape keeps the reference open.
    const command = (event: KeyboardEvent) => event.preventDefault();
    view.writing.addEventListener("keydown", command);
    act(() => view.trigger.click());
    fireEvent.keyDown(view.writing, { key: "Escape" });
    assert.ok(view.panel(), "the editor's Escape came first");
    view.writing.removeEventListener("keydown", command);
    fireEvent.keyDown(view.writing, { key: "Escape" });
    assert.ok(!view.panel(), "the reference is closed");
  } finally {
    window.removeEventListener("keydown", outer);
  }
});

// Focus that arrives by Tab, which :focus-visible tells from a press.
function tabTo(element: HTMLElement) {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Tab" });
  act(() => element.focus());
}

test("keyboard focus opens the reference; Escape returns focus to the label without reopening it", (t) => {
  // After keyboard use a browser shows focus wherever script then moves it,
  // so the label that closing refocuses matches :focus-visible.
  const matches = window.Element.prototype.matches;
  t.mock.method(
    window.Element.prototype,
    "matches",
    function (this: Element, selector: string) {
      return selector === ":focus-visible"
        ? this === document.activeElement
        : matches.call(this, selector);
    },
  );
  const view = footer();
  act(() => view.writing.focus());
  tabTo(view.trigger);
  assert.ok(view.panel(), "keyboard focus opens it");
  assert.ok(document.activeElement === view.trigger, "focus stays on it");
  const region = view.panel()!.querySelector<HTMLElement>('[role="region"]')!;
  assert.equal(region.tabIndex, 0, "a long reference scrolls by keyboard");
  tabTo(region);
  assert.ok(document.activeElement === region, "Tab moves into the reference");
  assert.ok(view.panel(), "focus can move into the reference");
  fireEvent.keyDown(region, { key: "Escape" });
  assert.ok(!view.panel(), "the reference is closed");
  assert.ok(document.activeElement === view.trigger, "focus returns");
  assert.equal(view.trigger.getAttribute("aria-expanded"), "false");

  tabTo(view.writing);
  tabTo(view.trigger);
  assert.ok(view.panel(), "focusing it again opens it");
  tabTo(view.writing);
  assert.ok(!view.panel(), "focus moving on closes it");

  tabTo(view.trigger);
  act(() => view.trigger.click());
  assert.ok(!view.panel(), "Enter or Space closes an open reference");
  act(() => view.trigger.click());
  assert.ok(view.panel(), "and opens a closed one");
  const close = view
    .panel()!
    .querySelector<HTMLButtonElement>('[aria-label="Close syntax reference"]')!;
  tabTo(close);
  assert.ok(document.activeElement === close);
  act(() => close.click());
  assert.ok(!view.panel(), "the reference is closed");
  assert.ok(document.activeElement === view.trigger, "Close returns focus");
});

test("a tap toggles the reference and touch pointers never count as hovering", async () => {
  const view = footer();
  fireEvent.pointerEnter(view.trigger, touchPointer);
  await wait(HOVER_DELAY + 40);
  assert.ok(!view.panel(), "touch has no hover");
  fireEvent.pointerDown(view.trigger, touchPointer);
  act(() => view.trigger.click());
  assert.ok(view.panel(), "a tap opens it");
  fireEvent.pointerLeave(view.trigger, touchPointer);
  fireEvent.pointerDown(view.panel()!, touchPointer);
  await wait(LEAVE_DELAY + 40);
  assert.ok(view.panel(), "scrolling or reading it keeps it open");
  act(() => view.trigger.click());
  assert.ok(!view.panel(), "a second tap closes it");
  // A mouse press on the label never moves focus off the document.
  const down = fireEvent.mouseDown(view.trigger);
  assert.equal(down, false, "the press keeps the caret where it was");
});

test("the reference sits 8px above the label, inside the viewport, in every format on a phone and on a desktop", () => {
  const original = window.HTMLElement.prototype.getBoundingClientRect;
  const computed = globalThis.getComputedStyle;
  const box = (left: number, top: number, width: number, height: number) =>
    ({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON() {},
    }) as DOMRect;
  const viewport = (width: number, height: number) => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: width,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: height,
    });
  };
  const saved = [window.innerWidth, window.innerHeight];
  let label = box(0, 0, 0, 0);
  // The panel as a browser lays it out: its width, and its content's height
  // up to its maximum.
  let content = { width: 0, height: 0 };
  const laidOut = (layer: HTMLElement) => ({
    width: content.width,
    height: Math.min(content.height, parseFloat(layer.style.maxHeight)),
  });
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains("markdown-tag")) return label;
    if (!this.classList.contains("syntax-reference"))
      return original.call(this);
    // It opens with menu-in, growing from 0.98 of its size from its bottom
    // right corner, so its first frame's box is smaller than its layout.
    const left = parseFloat(this.style.left) || 0;
    const top = parseFloat(this.style.top) || 0;
    const { width, height } = laidOut(this);
    return box(
      left + width * 0.02,
      top + height * 0.02,
      width * 0.98,
      height * 0.98,
    );
  };
  globalThis.getComputedStyle = ((element: Element, pseudo?: string) => {
    const style = computed(element, pseudo);
    if (!element.classList.contains("syntax-reference")) return style;
    const { width, height } = laidOut(element as HTMLElement);
    return new Proxy(style, {
      get(target, key) {
        if (key === "width") return `${width}px`;
        if (key === "height") return `${height}px`;
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof getComputedStyle;
  try {
    for (const [width, height, labelBox] of [
      [390, 844, box(300, 816, 66, 20)],
      [1258, 920, box(1160, 892, 76, 20)],
    ] as const)
      for (const [format, panelWidth, panelHeight] of [
        ["markdown", 800, 1600],
        ["fountain", 800, 640],
        ["text", 456, 520],
      ] as const) {
        const where = `${format} at ${width}px`;
        viewport(width, height);
        label = labelBox;
        content = {
          width: Math.min(panelWidth, width - 32),
          height: panelHeight,
        };
        const view = footer(paths[format]);
        act(() => view.trigger.click());
        const layer = view.panel()!;
        const left = parseFloat(layer.style.left);
        const top = parseFloat(layer.style.top);
        const room = parseFloat(layer.style.maxHeight);
        const shown = laidOut(layer);
        assert.ok(left >= 16, `${where}: inside the left gutter`);
        assert.ok(left + shown.width <= width - 16, `${where}: right gutter`);
        assert.ok(top >= 12, `${where}: below the top edge`);
        assert.ok(
          Math.abs(label.top - 8 - (top + shown.height)) < 0.01,
          `${where}: its bottom is 8px above the label, not ${label.top - top - shown.height}px`,
        );
        assert.ok(
          room <= height * 0.72,
          `${where}: leaves part of the document in view`,
        );
        if (width > 1000)
          assert.ok(
            Math.abs(left + shown.width - label.right) < 0.01,
            `${where}: aligned to the label's right edge`,
          );
        cleanup();
      }
  } finally {
    window.HTMLElement.prototype.getBoundingClientRect = original;
    globalThis.getComputedStyle = computed;
    viewport(saved[0], saved[1]);
  }
});

test("on phones and touch screens the format label stays in the footer", () => {
  style.textContent = touch;
  const view = footer();
  assert.notEqual(getComputedStyle(view.trigger).display, "none");
  assert.equal(
    getComputedStyle(view.page.container.querySelector(".attachment-usage")!)
      .display,
    "none",
    "attachment usage still makes room",
  );
});
