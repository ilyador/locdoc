import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import {
  CompletionContext,
  closeCompletion,
  currentCompletions,
  startCompletion,
} from "@codemirror/autocomplete";
import { sourceCommentLayer } from "../src/editor-comments";
import { fountainPreview } from "../src/fountain-preview";
import {
  completeFountainSpeaker,
  fountainSpeakerCompletion,
} from "../src/fountain-completion";

const cues =
  "SARA\nHello.\n\nSARA (V.O.)\nAgain.\n\nIBRAHIM ^\nHello.\n\n@McLane\nHello.\n\n@李明\nHello.\n\n";
const extensions = () => [sourceCommentLayer, fountainPreview()];
function complete(source: string, explicit = false, pos = source.length) {
  const state = EditorState.create({
    doc: source,
    selection: { anchor: pos },
    extensions: extensions(),
  });
  return completeFountainSpeaker(new CompletionContext(state, pos, explicit));
}

test("Fountain completion reuses known cues, deduplicates extensions and preserves forced names", () => {
  const result = complete(cues + "M")!;
  assert.equal(result.from, cues.length);
  assert.deepEqual(
    result.options.map(({ label }) => label),
    ["SARA", "IBRAHIM", "McLane", "李明"],
  );
  const source = cues + "  @M";
  const forced = complete(source)!;
  assert.equal(forced.from, cues.length + 3);
  const { view } = open(source);
  apply(view, forced, "McLane");
  assert.equal(view.state.doc.toString(), cues + "  @McLane");
});

test("speaker suggestions do not interrupt action continuations, dialogue, scenes or annotations", () => {
  for (const tail of [
    "An action paragraph\nSA",
    "SARA\nSA",
    "SARA\n(softly)\nSA",
    "INT. SA",
    "!SA",
    "[[SA",
    "/*\n\nSA",
    "# SA",
  ])
    assert.ok(
      complete(cues + tail) === null,
      `No cue menu for ${JSON.stringify(tail)}`,
    );
  assert.ok(
    complete(cues) === null,
    "Empty lines do not open menus by themselves",
  );
  assert.ok(
    complete(cues, true) !== null,
    "Explicit completion can list known speakers",
  );
  assert.ok(
    complete(cues + "@") !== null,
    "The forced cue marker lists known speakers",
  );
  const hidden =
    "[[comment(Reviewer): FALSE NAME]]\n\n/*\nFAKE NAME\nSpeech.\n*/\n\n";
  assert.deepEqual(
    complete(cues + hidden + "S")!.options.map((cue) => cue.label),
    ["SARA", "IBRAHIM", "McLane", "李明"],
  );
});

test("completion never replaces the remainder of a name, cue extensions or hidden records", () => {
  const source = cues + "SA (V.O.)[[comment(Reviewer): Keep this]] ^";
  const pos = cues.length + 2;
  const result = complete(source, false, pos)!;
  assert.equal(result.from, cues.length);
  const { view } = open(source);
  view.dispatch({ selection: { anchor: pos } });
  apply(view, result, "SARA");
  assert.equal(
    view.state.doc.toString(),
    cues + "SARA (V.O.)[[comment(Reviewer): Keep this]] ^",
  );
  assert.ok(complete(cues + "SARA", false, cues.length + 2) === null);
});

let dom: JSDOM;
const views: EditorView[] = [];
before(() => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true,
  });
  for (const key of [
    "window",
    "Window",
    "document",
    "navigator",
    "Node",
    "HTMLElement",
    "Element",
    "MutationObserver",
    "DOMRect",
  ])
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: dom.window[key],
    });
  for (const key of [
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "getComputedStyle",
  ])
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: dom.window[key].bind(dom.window),
    });
  dom.window.Range.prototype.getClientRects = () => [] as any;
  dom.window.Range.prototype.getBoundingClientRect = () =>
    new dom.window.DOMRect();
});
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});
after(() => dom.window.close());
function open(source: string) {
  const permission = new Compartment();
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: source,
      selection: { anchor: source.length },
      extensions: [
        ...extensions(),
        fountainSpeakerCompletion(),
        permission.of(EditorState.readOnly.of(false)),
        keymap.of(defaultKeymap),
      ],
    }),
  });
  views.push(view);
  view.focus();
  return { view, permission };
}
function apply(
  view: EditorView,
  result: NonNullable<ReturnType<typeof complete>>,
  label: string,
) {
  const option = result.options.find((cue) => cue.label === label)!;
  assert.ok(
    typeof option.apply === "function",
    "Cue acceptance must be guarded",
  );
  option.apply(view, option, result.from, view.state.selection.main.head);
}
async function suggestions(view: EditorView, labels: string[]) {
  const { waitFor } = await import("@testing-library/dom");
  await waitFor(() =>
    assert.deepEqual(
      currentCompletions(view.state).map((cue) => cue.label),
      labels,
    ),
  );
  // CodeMirror intentionally ignores keys immediately after a menu opens.
  await new Promise((resolve) => setTimeout(resolve, 80));
}
function key(view: EditorView, value: string) {
  view.contentDOM.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", {
      key: value,
      bubbles: true,
      cancelable: true,
    }),
  );
}

test("typing offers prefix matches; Tab accepts, while ordinary Enter still inserts one newline", async () => {
  const { view } = open(cues);
  view.dispatch({
    changes: { from: cues.length, insert: "Sa" },
    selection: { anchor: cues.length + 2 },
    userEvent: "input.type",
  });
  await suggestions(view, ["SARA"]);
  key(view, "Tab");
  assert.equal(view.state.doc.toString(), cues + "SARA");
  assert.equal(view.state.selection.main.head, view.state.doc.length);
  view.dispatch({
    changes: { from: cues.length, to: view.state.doc.length, insert: "Sa" },
    selection: { anchor: cues.length + 2 },
  });
  startCompletion(view);
  await suggestions(view, ["SARA"]);
  key(view, "Enter");
  assert.equal(view.state.doc.toString(), cues + "Sa\n");
});

test("arrow and Enter accept deliberately; Escape and a revoked edit permission never insert", async () => {
  const { view, permission } = open(cues + "M");
  startCompletion(view);
  await suggestions(view, ["McLane"]);
  key(view, "ArrowDown");
  key(view, "Enter");
  assert.equal(view.state.doc.toString(), cues + "@McLane");
  view.dispatch({
    changes: { from: cues.length, to: view.state.doc.length, insert: "S" },
    selection: { anchor: cues.length + 1 },
  });
  startCompletion(view);
  await suggestions(view, ["SARA"]);
  key(view, "Escape");
  assert.equal(currentCompletions(view.state).length, 0);
  startCompletion(view);
  await suggestions(view, ["SARA"]);
  view.dispatch({
    effects: permission.reconfigure(EditorState.readOnly.of(true)),
  });
  key(view, "Tab");
  assert.equal(view.state.doc.toString(), cues + "S");
  closeCompletion(view);
});

test("clicking an open speaker suggestion after permission revocation cannot edit", async () => {
  const source = cues + "M";
  const { view, permission } = open(source);
  startCompletion(view);
  await suggestions(view, ["McLane"]);
  const option = view.dom.querySelector(".cm-tooltip-autocomplete li")!;
  assert.ok(option, "Speaker menu must be visible before revocation");
  view.dispatch({
    effects: permission.reconfigure(EditorState.readOnly.of(true)),
  });
  option.dispatchEvent(
    new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true }),
  );
  assert.equal(view.state.doc.toString(), source);
});
