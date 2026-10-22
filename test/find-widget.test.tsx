import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React from "react";
import * as Y from "yjs";
import { EditorView } from "@codemirror/view";
import {
  getSearchQuery,
  replaceAll,
  replaceNext,
  searchPanelOpen,
} from "@codemirror/search";
import { Awareness } from "y-protocols/awareness";
import type { EditorHandle } from "../src/editor-types";

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

function mount(source: string, path = "Notes/find.md", editable = true) {
  const ydoc = new Y.Doc();
  const text = ydoc.getText("content");
  text.insert(0, source);
  const awareness = new Awareness(ydoc);
  const ref = React.createRef<EditorHandle>();
  const props = {
    ydoc,
    provider: { awareness } as any,
    id: "find-fixture",
    onChange() {},
    onComment() {},
    onUpload() {},
  };
  const page = render(
    <MarkdownEditor {...props} ref={ref} path={path} editable={editable} />,
  );
  const view = EditorView.findFromDOM(
    page.container.querySelector(".cm-editor")!,
  )!;
  const key = (
    target: Element,
    key: string,
    modifiers: Partial<
      Pick<KeyboardEventInit, "ctrlKey" | "shiftKey" | "altKey">
    > = {},
  ) => {
    const event = new window.KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...modifiers,
    });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  };
  const widget = () =>
    page.container.querySelector<HTMLElement>(".find-widget");
  const control = <T extends HTMLElement>(selector: string) =>
    widget()!.querySelector<T>(selector)!;
  return {
    page,
    props,
    ref,
    text,
    view,
    key,
    widget,
    control,
    find: () => control<HTMLInputElement>('input[name="search"]'),
    count: () => control(".find-count").textContent,
    type(input: HTMLInputElement, value: string) {
      act(() => {
        input.value = value;
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
    },
    click(selector: string) {
      act(() => control<HTMLButtonElement>(selector).click());
    },
    selections: () =>
      view.state.selection.ranges.map((range) =>
        view.state.sliceDoc(range.from, range.to),
      ),
    close() {
      page.unmount();
      awareness.destroy();
      ydoc.destroy();
    },
  };
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

test("the find widget keeps every search command and its keyboard behaviour", async () => {
  const source = "alpha beta alpha\nGamma alpha ALPHA\nalphabet";
  const fixture = mount(source);
  try {
    fixture.key(fixture.view.contentDOM, "f", { ctrlKey: true });
    assert.ok(fixture.widget(), "Mod-f opens the find widget");
    assert.equal(fixture.widget()!.getAttribute("role"), "search");
    assert.ok(
      document.activeElement === fixture.find(),
      "the find field takes focus",
    );
    assert.equal(fixture.find().getAttribute("main-field"), "true");
    fixture.type(fixture.find(), "alpha");
    await settle();
    assert.equal(fixture.count(), "1 of 5", "typing selects the first match");
    assert.deepEqual(fixture.selections(), ["alpha"]);
    assert.equal(fixture.view.state.selection.main.from, 0);
    fixture.key(fixture.find(), "Enter");
    await settle();
    assert.equal(fixture.view.state.selection.main.from, 11);
    assert.equal(fixture.count(), "2 of 5");
    fixture.key(fixture.find(), "Enter", { shiftKey: true });
    await settle();
    assert.equal(fixture.view.state.selection.main.from, 0);
    fixture.click('[aria-label="Previous match (Shift+Enter)"]');
    await settle();
    assert.equal(fixture.view.state.selection.main.from, 35);
    fixture.click('[aria-label="Next match (Enter)"]');
    await settle();
    assert.equal(fixture.count(), "1 of 5");

    fixture.click('[aria-label="Match case"]');
    await settle();
    assert.equal(
      fixture.control('[aria-label="Match case"]').getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(getSearchQuery(fixture.view.state).caseSensitive, true);
    assert.equal(fixture.count(), "1 of 4");
    fixture.click('[aria-label="Match whole word"]');
    await settle();
    assert.equal(getSearchQuery(fixture.view.state).wholeWord, true);
    assert.equal(fixture.count(), "1 of 3");

    fixture.click('[aria-label="Select all matches"]');
    assert.deepEqual(fixture.selections(), ["alpha", "alpha", "alpha"]);

    fixture.click('[aria-label="Use regular expression"]');
    fixture.type(fixture.find(), "(");
    await settle();
    assert.equal(fixture.count(), "Invalid expression");
    assert.equal(
      fixture.control<HTMLButtonElement>('[aria-label="Next match (Enter)"]')
        .disabled,
      true,
    );
    fixture.type(fixture.find(), "G\\w+a");
    await settle();
    assert.equal(fixture.count(), "1 of 1");
    assert.deepEqual(fixture.selections(), ["Gamma"]);
    fixture.type(fixture.find(), "missing");
    await settle();
    assert.equal(fixture.count(), "No matches");
    assert.ok(fixture.widget()!.classList.contains("no-matches"));

    let escaped = 0;
    const listener = () => escaped++;
    window.addEventListener("keydown", listener);
    try {
      fixture.key(fixture.find(), "Escape");
    } finally {
      window.removeEventListener("keydown", listener);
    }
    assert.equal(fixture.widget(), null, "Escape closes the widget");
    assert.equal(searchPanelOpen(fixture.view.state), false);
    assert.equal(escaped, 0, "Escape is not passed on to the workspace");
    assert.ok(
      fixture.view.hasFocus ||
        document.activeElement === fixture.view.contentDOM,
    );
  } finally {
    fixture.close();
  }
});

test("Mod-f seeds the query from the selection and the count follows edits", async () => {
  const fixture = mount("one two one");
  try {
    act(() => fixture.view.dispatch({ selection: { anchor: 4, head: 7 } }));
    fixture.key(fixture.view.contentDOM, "f", { ctrlKey: true });
    await settle();
    assert.equal(fixture.find().value, "two");
    assert.equal(fixture.count(), "1 of 1");
    act(() =>
      fixture.view.dispatch({
        changes: { from: fixture.view.state.doc.length, insert: " two two" },
      }),
    );
    await waitFor(() => assert.equal(fixture.count(), "1 of 3"));
    fixture.key(fixture.find(), "f", { ctrlKey: true });
    assert.ok(document.activeElement === fixture.find());
    fixture.click('[aria-label="Close find (Escape)"]');
    assert.equal(fixture.widget(), null);
  } finally {
    fixture.close();
  }
});

test("replace edits visible text only and is offered only while editing is allowed", async () => {
  const source = "foo [[comment(ana): foo record]] foo\nfoo";
  const fixture = mount(source);
  try {
    fixture.key(fixture.view.contentDOM, "f", { ctrlKey: true });
    const replaceRow = fixture.control(".find-replace");
    const disclosure = fixture.control<HTMLButtonElement>(".find-disclosure");
    assert.equal(replaceRow.hidden, true, "replace starts collapsed");
    assert.equal(disclosure.getAttribute("aria-expanded"), "false");
    fixture.type(fixture.find(), "foo");
    await settle();
    assert.equal(
      fixture.count(),
      "1 of 3",
      "hidden comment text never matches",
    );
    fixture.click(".find-disclosure");
    assert.equal(replaceRow.hidden, false);
    assert.equal(disclosure.getAttribute("aria-expanded"), "true");
    const replaceField = fixture.control<HTMLInputElement>(
      'input[name="replace"]',
    );
    assert.ok(document.activeElement === replaceField);
    fixture.type(replaceField, "bar");
    fixture.key(replaceField, "Enter");
    assert.equal(
      fixture.text.toString(),
      "bar [[comment(ana): foo record]] foo\nfoo",
      "Enter in the replace field replaces the current match",
    );
    fixture.click(".find-replace-all");
    assert.equal(
      fixture.text.toString(),
      "bar [[comment(ana): foo record]] bar\nbar",
      "Replace all keeps the hidden record intact",
    );

    fixture.page.rerender(
      <MarkdownEditor
        {...fixture.props}
        ref={fixture.ref}
        path="Notes/find.md"
        editable={false}
      />,
    );
    assert.equal(disclosure.hidden, true, "read-only views cannot replace");
    assert.equal(replaceRow.hidden, true);
    act(() => fixture.view.dispatch({ selection: { anchor: 0 } }));
    fixture.type(fixture.find(), "bar");
    fixture.type(replaceField, "baz");
    const text = fixture.text.toString();
    act(() => {
      replaceNext(fixture.view);
      replaceAll(fixture.view);
    });
    fixture.key(replaceField, "Enter");
    assert.equal(fixture.text.toString(), text, "read-only text is unchanged");
    fixture.key(fixture.find(), "Enter");
    await settle();
    assert.equal(fixture.count(), "2 of 3", "finding still works read-only");

    fixture.page.rerender(
      <MarkdownEditor
        {...fixture.props}
        ref={fixture.ref}
        path="Notes/find.md"
        editable
      />,
    );
    assert.equal(disclosure.hidden, false);
    assert.equal(replaceRow.hidden, false, "the replace preference returns");
  } finally {
    fixture.close();
  }
});

test("a command that uses up the last match leaves focus in its own row", async () => {
  const fixture = mount("foo and foo");
  try {
    fixture.key(fixture.view.contentDOM, "f", { ctrlKey: true });
    fixture.type(fixture.find(), "foo");
    await settle();
    // The replace row's disclosure is remembered for the tab.
    if (fixture.control(".find-replace").hidden)
      fixture.click(".find-disclosure");
    const replaceField = fixture.control<HTMLInputElement>(
      'input[name="replace"]',
    );
    fixture.type(replaceField, "bar");
    const all = fixture.control<HTMLButtonElement>(".find-replace-all");
    act(() => {
      all.focus();
      all.click();
    });
    assert.equal(fixture.text.toString(), "bar and bar");
    await waitFor(() => assert.equal(fixture.count(), "No matches"));
    assert.equal(all.disabled, true, "nothing is left to replace");
    assert.ok(
      document.activeElement === replaceField,
      "Replace all hands focus to the replace field, not the page",
    );

    fixture.type(fixture.find(), "bar");
    await settle();
    const next = fixture.control<HTMLButtonElement>(
      '[aria-label="Next match (Enter)"]',
    );
    act(() => next.focus());
    // A collaborator's edit removes the last match under a focused command.
    act(() =>
      fixture.view.dispatch({
        changes: { from: 0, to: fixture.view.state.doc.length, insert: "baz" },
      }),
    );
    await waitFor(() => assert.equal(fixture.count(), "No matches"));
    assert.equal(next.disabled, true);
    assert.ok(
      document.activeElement === fixture.find(),
      "a find command hands focus to the find field",
    );
  } finally {
    fixture.close();
  }
});

test("Alt-g adds the next visible occurrence, Sublime-style, even when read-only", async () => {
  const source =
    "word other word [[comment(ana): word]] wordy word\nwords word";
  for (const editable of [true, false]) {
    const fixture = mount(source, "Notes/plain.txt", editable);
    try {
      act(() => fixture.view.dispatch({ selection: { anchor: 2 } }));
      fixture.key(fixture.view.contentDOM, "g", { altKey: true });
      assert.deepEqual(fixture.selections(), ["word"], "selects the word");
      fixture.key(fixture.view.contentDOM, "g", { altKey: true });
      fixture.key(fixture.view.contentDOM, "g", { altKey: true });
      fixture.key(fixture.view.contentDOM, "g", { altKey: true });
      const ranges = fixture.view.state.selection.ranges.map((r) => r.from);
      assert.deepEqual(
        ranges,
        [
          0,
          source.indexOf("word other") + 11,
          source.lastIndexOf("word\n"),
          source.lastIndexOf("word"),
        ],
        "whole-word occurrences outside the hidden record",
      );
      const event = fixture.key(fixture.view.contentDOM, "g", { altKey: true });
      assert.equal(event.defaultPrevented, true);
      assert.equal(fixture.view.state.selection.ranges.length, 4);
      assert.equal(fixture.text.toString(), source, "selection never edits");
    } finally {
      fixture.close();
    }
  }
  const fixture = mount(source);
  try {
    // A partial-word selection matches inside longer words, still never
    // inside the hidden record.
    act(() => fixture.view.dispatch({ selection: { anchor: 0, head: 3 } }));
    fixture.key(fixture.view.contentDOM, "d", { ctrlKey: true });
    fixture.key(fixture.view.contentDOM, "d", { ctrlKey: true });
    assert.deepEqual(fixture.selections(), ["wor", "wor", "wor"]);
    act(() =>
      fixture.view.dispatch(fixture.view.state.replaceSelection("ter")),
    );
    assert.equal(
      fixture.text.toString(),
      "terd other terd [[comment(ana): word]] terdy word\nwords word",
      "typing over Mod-d occurrences keeps the record intact",
    );
  } finally {
    fixture.close();
  }
});
