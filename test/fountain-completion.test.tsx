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
  const result = complete(cues + "MC")!;
  assert.equal(result.from, cues.length);
  assert.deepEqual(
    result.options.map(({ label }) => label),
    ["SARA", "IBRAHIM", "McLane", "李明"],
  );
  const source = cues + "  @MC";
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
    "# SA",
  ])
    assert.ok(
      complete(cues + tail) === null,
      `No cue menu for ${JSON.stringify(tail)}`,
    );
  const omitted = cues + "/*\n\nSA";
  assert.ok(
    complete(omitted + "\n*/", false, omitted.length) === null,
    "No cue menu inside a boneyard",
  );
  assert.ok(
    complete(omitted) !== null,
    "An /* without a */ is text, so the script after it keeps its cues",
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
    complete(cues + "@", true) !== null,
    "The forced cue marker lists known speakers",
  );
  const hidden =
    "[[comment(Reviewer): FALSE NAME]]\n\n/*\nFAKE NAME\nSpeech.\n*/\n\n";
  assert.deepEqual(
    complete(cues + hidden + "SA")!.options.map((cue) => cue.label),
    ["SARA", "IBRAHIM", "McLane", "李明"],
  );
});

test("automatic speaker suggestions require two leading capital letters, or a name after @", () => {
  for (const prefix of ["", "S", "Sa", "sa", "sA", "word SA", "@", "@ ", "@-"])
    assert.ok(
      complete(cues + prefix) === null,
      `No automatic menu for ${JSON.stringify(prefix)}`,
    );
  for (const prefix of ["SA", "  SA", "@SA", "SAra", "@S", "@Mc", "@m", "@李"])
    assert.ok(
      complete(cues + prefix) !== null,
      `Automatic menu for ${JSON.stringify(prefix)}`,
    );
  assert.ok(
    complete(cues + "ÉVA\nHello.\n\nÉV") !== null,
    "Accented capitals also count",
  );
  assert.ok(
    complete(cues + "Sa", true) !== null,
    "Explicit speaker selection stays available",
  );
});

// A Hebrew script: no capitals, so its cues start with @.
const hebrew = "@מאיה\nאיפה היית?\n\n@דוד\nבבית.\n\n@מיכל\nגם אני.\n\n";

test("a name typed after @ gets automatic suggestions in any script, while Hebrew action does not", () => {
  const labels = (source: string) =>
    complete(source)?.options.map((option) => option.label);
  assert.deepEqual(labels(hebrew + "@מ"), ["מאיה", "דוד", "מיכל"]);
  assert.equal(complete(hebrew + "@מ")!.from, hebrew.length + 1);
  assert.deepEqual(labels(hebrew + "  @מאי"), ["מאיה", "דוד", "מיכל"]);
  // Hebrew without @ is action, however a line starts.
  for (const prefix of ["מ", "מאיה", "דוד הולך", "  מ", "@"])
    assert.ok(
      complete(hebrew + prefix) === null,
      `No automatic menu for ${JSON.stringify(prefix)}`,
    );
  assert.ok(
    complete(hebrew + "מ", true) !== null,
    "Ctrl+Space still lists the speakers",
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

test("standalone annotations preserve a cue boundary without creating one after prose or dialogue", () => {
  const annotations = [
    "[[A script note]]\n",
    "[[comment(Reviewer): Keep this]]\n",
    "/*\nAn omitted section.\n*/\n",
  ];
  for (const annotation of annotations) {
    assert.ok(
      complete(cues + annotation + "SA") !== null,
      "Annotations after a blank line must preserve speaker completion",
    );
    for (const preceding of ["An action line.\n", "SARA\nHello.\n"])
      assert.ok(
        complete(cues + preceding + annotation + "SA") === null,
        "Annotations must not create a new cue boundary",
      );
  }
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

test("typing a numbered speaker prefix retains its suggestions through the hash", async () => {
  const source = cues + "GUARD #1\nHalt.\n\n";
  const { view } = open(source);
  view.dispatch({
    changes: { from: source.length, insert: "GUARD" },
    selection: { anchor: source.length + 5 },
    userEvent: "input.type",
  });
  await suggestions(view, ["GUARD #1"]);
  view.dispatch({
    changes: { from: view.state.doc.length, insert: " #" },
    selection: { anchor: view.state.doc.length + 2 },
    userEvent: "input.type",
  });
  await suggestions(view, ["GUARD #1"]);
  assert.ok(
    complete(source + "GUARD #") !== null,
    "A numbered speaker prefix must also open completion directly",
  );
  key(view, "Tab");
  assert.equal(view.state.doc.toString(), source + "GUARD #1");
});

test("typing offers prefix matches; Tab accepts, while ordinary Enter still inserts one newline", async () => {
  const { view } = open(cues);
  view.dispatch({
    changes: { from: cues.length, insert: "SA" },
    selection: { anchor: cues.length + 2 },
    userEvent: "input.type",
  });
  await suggestions(view, ["SARA"]);
  key(view, "Tab");
  assert.equal(view.state.doc.toString(), cues + "SARA");
  assert.equal(view.state.selection.main.head, view.state.doc.length);
  view.dispatch({
    changes: { from: cues.length, to: view.state.doc.length, insert: "SA" },
    selection: { anchor: cues.length + 2 },
  });
  startCompletion(view);
  await suggestions(view, ["SARA"]);
  key(view, "Enter");
  assert.equal(view.state.doc.toString(), cues + "SA\n");
});

test("automatic speaker suggestions close when the two-capital prefix is removed", async () => {
  const { view } = open(cues);
  view.dispatch({
    changes: { from: cues.length, insert: "SA" },
    selection: { anchor: cues.length + 2 },
    userEvent: "input.type",
  });
  await suggestions(view, ["SARA"]);
  view.dispatch({
    changes: { from: cues.length + 1, to: cues.length + 2 },
    selection: { anchor: cues.length + 1 },
    userEvent: "delete.backward",
  });
  await suggestions(view, []);
  view.dispatch({
    changes: { from: cues.length + 1, insert: "A" },
    selection: { anchor: cues.length + 2 },
    userEvent: "input.type",
  });
  await suggestions(view, ["SARA"]);
  view.dispatch({
    changes: { from: cues.length + 1, to: cues.length + 2, insert: "a" },
    userEvent: "input.type",
  });
  await suggestions(view, []);
});

test("typing a Hebrew name after @ suggests the script's speakers, and Tab accepts one", async () => {
  const { view } = open(hebrew);
  const type = (text: string) => {
    const at = view.state.selection.main.head;
    view.dispatch({
      changes: { from: at, insert: text },
      selection: { anchor: at + text.length },
      userEvent: "input.type",
    });
  };
  // No list opens for an @ alone, nor for Hebrew action.
  const none = async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(currentCompletions(view.state).length, 0);
  };
  type("@");
  await none();
  type("מ");
  await suggestions(view, ["מאיה", "מיכל"]);
  type("א");
  await suggestions(view, ["מאיה"]);
  // Deleting the name back to its @ closes the list.
  view.dispatch({
    changes: { from: hebrew.length + 1, to: view.state.doc.length },
    selection: { anchor: hebrew.length + 1 },
    userEvent: "delete.backward",
  });
  await suggestions(view, []);
  type("ד");
  await suggestions(view, ["דוד"]);
  key(view, "Tab");
  assert.equal(view.state.doc.toString(), hebrew + "@דוד");
  type("\nשלום.\n\n");
  type("מ");
  await none();
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
