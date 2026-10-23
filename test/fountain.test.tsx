import { test } from "node:test";
import assert from "node:assert/strict";
import { Compartment, EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { parseFountain } from "../src/fountain";
import { fountainPreview, fountainScript } from "../src/fountain-preview";
import {
  documentFormat,
  documentName,
  documentPath,
} from "../src/document-format";
import { countDocumentWords } from "../src/word-count";
import { resolveDocumentLink } from "../src/document-links";

test("Fountain classifies screenplay elements without changing source positions", () => {
  const source =
    "INT. STUDIO - DAY\n\nA lamp flickers.\n\nMORGAN (V.O.)\n(quietly)\nIs anyone here?\nYes, anyone.\n\nCUT TO:\n\nEXT. STREET - NIGHT";
  const script = parseFountain(source);
  assert.deepEqual(
    script.lines.filter((l) => l.kind !== "blank").map((l) => l.kind),
    [
      "scene",
      "action",
      "character",
      "parenthetical",
      "dialogue",
      "dialogue",
      "transition",
      "scene",
    ],
  );
  for (const line of script.lines)
    assert.equal(source.slice(line.from, line.to), line.text);
});

test("forced elements, title fields and outline syntax have separate meanings", () => {
  const source =
    "Title: The Signal\nAuthor: Example Writer\nContact:\n    test@example.invalid\n\n# Act one\n= The beginning\n\n.A SMALL ROOM\n\n!ALL CAPS ACTION\n\n@McLane\nHello.\n\n> fade away\n\n> THE END <\n\n~A song\n\n===";
  const script = parseFountain(source);
  assert.deepEqual(
    script.lines.filter((l) => l.kind !== "blank").map((l) => l.kind),
    [
      "title",
      "credit",
      "metadata",
      "metadata",
      "section",
      "synopsis",
      "scene",
      "action",
      "character",
      "dialogue",
      "transition",
      "centered",
      "lyric",
      "break",
    ],
  );
  assert.equal(script.lines[0].text, "The Signal");
  assert.equal(
    script.lines.find((l) => l.kind === "centered")!.text,
    "THE END",
  );
  assert.equal(
    script.lines.find((l) => l.kind === "character")!.text,
    "McLane",
  );
});

test("notes and boneyards cannot create dialogue or alter relative offsets", () => {
  const source =
    "A signal.[[comment(Example): hidden reply]]\n\n/*\nINT. HIDDEN - DAY\nFALSE NAME\nHidden speech.\n*/\n\n[[A note\nabout a scene]]\n\n@李\nA real line.\n\n\\[[literal note]]";
  const script = parseFountain(source);
  assert.equal(script.lines.filter((l) => l.kind === "scene").length, 0);
  assert.equal(script.notes.length, 1);
  assert.equal(script.omissions.length, 1);
  assert.equal(script.lines.find((l) => l.kind === "character")!.text, "李");
  const dialogue = script.lines.find((l) => l.kind === "dialogue")!;
  assert.equal(source.slice(dialogue.from, dialogue.to), "A real line.");
  assert.equal(script.lines.at(-1)!.kind, "action");
});

test("a note ends at a blank line, and a boneyard needs its */", () => {
  const kinds = (source: string) =>
    parseFountain(source).lines.map((line) => line.kind);
  const spans = (source: string, key: "notes" | "omissions") =>
    parseFountain(source)[key].map((range) =>
      source.slice(range.from, range.to),
    );
  // A note being typed covers the rest of its paragraph, never the script.
  const typing =
    "She waits.[[Check this\nand this\n\nMAYA\nHello.\n\nEXT. ROOF - NIGHT";
  assert.deepEqual(spans(typing, "notes"), ["[[Check this\nand this"]);
  assert.deepEqual(kinds(typing), [
    "action",
    "note",
    "blank",
    "character",
    "dialogue",
    "blank",
    "scene",
  ]);
  // A line of two spaces keeps the note going; a ]] past a blank line
  // closes nothing.
  assert.deepEqual(spans("[[One\n  \nTwo]]\n\nMAYA\nHi.", "notes"), [
    "[[One\n  \nTwo]]",
  ]);
  for (const gap of ["\n\n", "\n \n", "\n\t\n"])
    assert.deepEqual(
      spans(`[[One${gap}MAYA\nHi.]]`, "notes"),
      ["[[One"],
      JSON.stringify(gap),
    );
  assert.equal(kinds("[[One\n\nMAYA\nHi.]]")[2], "character");
  assert.deepEqual(spans("A [[short]] note.\n\n[[Own line]]", "notes"), [
    "[[short]]",
    "[[Own line]]",
  ]);
  // A /* without a */ is text, and the script after it keeps its elements.
  const opened = "/* Cut from here\n\nINT. HOUSE - DAY\n\nMAYA\nHello.";
  assert.deepEqual(spans(opened, "omissions"), []);
  assert.deepEqual(kinds(opened), [
    "action",
    "blank",
    "scene",
    "blank",
    "character",
    "dialogue",
  ]);
  // A closed boneyard spans paragraphs; a later unclosed one is text.
  const closed =
    "/*\nINT. HIDDEN - DAY\n\nHIDDEN\nWords.\n*/\n\n/* Again\n\nMAYA\nHi.";
  assert.deepEqual(spans(closed, "omissions"), [
    "/*\nINT. HIDDEN - DAY\n\nHIDDEN\nWords.\n*/",
  ]);
  assert.deepEqual(kinds(closed).slice(-4), [
    "action",
    "blank",
    "character",
    "dialogue",
  ]);
});

test("Hebrew scene headings start with פנים. or חוץ., and a Hebrew cue needs @", () => {
  for (const heading of [
    "פנים. בית - יום",
    "חוץ. רחוב - לילה",
    "פנים/חוץ. מכונית - יום",
    "חוץ/פנים. מרפסת - ערב",
    "פנים./חוץ. רכב - לילה",
  ])
    assert.equal(
      parseFountain(`היא מחכה.\n\n${heading}\n\nהדלת נפתחת.`).lines[2].kind,
      "scene",
      heading,
    );
  // Without the period these are ordinary words, and a heading needs the
  // blank line before it.
  for (const action of [
    "פנים רבות בקהל.",
    "חוץ מזה, הכול שקט.",
    "פנימה.",
    "חוצה את הכביש.",
  ])
    assert.equal(parseFountain(action).lines[0].kind, "action", action);
  assert.equal(
    parseFountain("היא מחכה.\nפנים. בית - יום").lines[1].kind,
    "action",
  );
  // Hebrew has no capitals: only @ makes a cue, and a name alone is action.
  const script = parseFountain("@מאיה\nאיפה היית?\n\nמאיה\nאיפה היית?");
  assert.deepEqual(
    script.lines.map((line) => line.kind),
    ["character", "dialogue", "blank", "action", "action"],
  );
  assert.equal(script.lines[0].text, "מאיה");
});

test("dual dialogue preserves its source marker and both speakers", () => {
  const script = parseFountain(
    "MORGAN\nHello.\n\nLEE ^\n(softly)\nHello too.\n\nANA ^\nAnother line.",
  );
  assert.equal(script.lines[0].kind, "character");
  assert.equal(script.lines[3].kind, "character");
  assert.ok(script.lines[3].suffix);
  assert.equal(script.lines[5].kind, "dialogue");
  assert.equal(script.lines[8].kind, "dialogue");
});

test("in-progress cues and parentheticals format while typing without capturing prose", () => {
  assert.equal(parseFountain("MORGAN\n").lines[0].kind, "character");
  assert.equal(parseFountain("MORGAN\n").lines[1].kind, "dialogue");
  assert.equal(parseFountain("MORGAN\n\n").lines[0].kind, "action");
  assert.equal(parseFountain("23\nNo cue").lines[0].kind, "action");
  assert.equal(
    parseFountain("Action continues\nMORE ACTION\nNo cue").lines[1].kind,
    "action",
  );
  assert.equal(parseFountain("MORGAN\n(soft").lines[1].kind, "parenthetical");
});

test("active Fountain cues preview before dialogue in the middle of a script", () => {
  const source = "An action.\n\nSARA\n\n\n# Next section";
  assert.equal(parseFountain(source).lines[2].kind, "action");
  assert.equal(parseFountain(source, 2).lines[2].kind, "character");
  const afterEnter = parseFountain(source, 3);
  assert.equal(afterEnter.lines[2].kind, "character");
  assert.equal(afterEnter.lines[3].kind, "dialogue");
  assert.equal(parseFountain(source, 4).lines[2].kind, "action");
  for (const [text, line, expected] of [
    ["An action.\nSARA\n\n# Next section", 1, "action"],
    ["SARA\nHello.\nSARA\n\n# Next section", 2, "dialogue"],
    ["[[SARA]]\n\n# Next section", 0, "note"],
    ["/*\nSARA\n*/\n\n# Next section", 1, "omitted"],
  ] as const)
    assert.equal(parseFountain(text, line).lines[line].kind, expected);
});

test("automatic speaker formatting requires two leading capitals, including while drafting", () => {
  for (const name of ["S", "É", "Sa", "sA", "S A", "S1"])
    for (const source of [name, `${name}\n`, `${name}\nSpeech.`])
      for (const editingLine of [undefined, 0, 1])
        assert.equal(
          parseFountain(source, editingLine).lines[0].kind,
          "action",
          `No automatic cue for ${name}`,
        );
  for (const name of ["SA", "ÉV", "@S", "@李"])
    assert.equal(parseFountain(`${name}\nSpeech.`).lines[0].kind, "character");
  for (const name of ["S", "SA"])
    for (const editingLine of [2, 3])
      assert.equal(
        parseFountain(`Action.\n\n${name}\n\n# Next`, editingLine).lines[2]
          .kind,
        name === "SA" ? "character" : "action",
      );
});

test("Fountain cue drafting follows focus and permissions without reparsing within a line", () => {
  const source = "An action.\n\nSARA\n\n\n# Next section";
  const cue = source.indexOf("SARA");
  const access = new Compartment();
  let state = EditorState.create({
    doc: source,
    selection: { anchor: cue },
    extensions: [
      fountainPreview(),
      access.of(EditorState.readOnly.of(false)),
      EditorState.allowMultipleSelections.of(true),
    ],
  });
  const script = () => state.facet(fountainScript)!;
  const focus = (focused: boolean) => {
    state = state.update({
      effects: state
        .facet(EditorView.focusChangeEffect)
        .flatMap((effect) => effect(state, focused) ?? []),
    }).state;
  };
  assert.equal(script().lines[2].kind, "action");
  focus(true);
  assert.equal(script().lines[2].kind, "character");
  const withinCue = script();
  state = state.update({ selection: { anchor: cue + 2 } }).state;
  assert.ok(
    script() === withinCue,
    "Moving within one cue must reuse the parsed script",
  );
  state = state.update({ selection: { anchor: cue + 5 } }).state;
  assert.equal(script().lines[2].kind, "character");
  assert.equal(script().lines[3].kind, "dialogue");
  focus(false);
  assert.equal(script().lines[2].kind, "action");
  assert.equal(script().lines[3].kind, "blank");
  focus(true);
  state = state.update({
    effects: access.reconfigure(EditorState.readOnly.of(true)),
  }).state;
  assert.equal(script().lines[2].kind, "action");
  state = state.update({
    effects: access.reconfigure(EditorState.readOnly.of(false)),
  }).state;
  assert.equal(script().lines[2].kind, "character");
  state = state.update({
    selection: EditorSelection.create([
      EditorSelection.cursor(0),
      EditorSelection.cursor(cue + 5),
    ]),
  }).state;
  assert.equal(script().lines[2].kind, "action");
  assert.equal(state.doc.toString(), source);
});

test("a new configuration, or a selection the preview does not reveal, keeps the parsed script and its layout", () => {
  const source = "INT. HOUSE - DAY\n\nMAYA\nWhere were *you*?\n\n> THE END <";
  const preview = new Compartment();
  const access = new Compartment();
  let state = EditorState.create({
    doc: source,
    extensions: [
      preview.of(fountainPreview()),
      access.of(EditorState.readOnly.of(false)),
    ],
  });
  const script = state.facet(fountainScript);
  const layout = () => [
    ...state.facet(EditorView.decorations),
    ...state.facet(EditorView.blockWrappers),
  ];
  const opened = layout();
  const kept = (label: string) => {
    assert.ok(state.facet(fountainScript) === script, `${label}: script`);
    const now = layout();
    assert.equal(now.length, opened.length, `${label}: layers`);
    assert.ok(
      now.every((set, i) => set === opened[i]),
      `${label}: the layout is the same`,
    );
  };
  // An editor applies its preview and permissions again as it mounts.
  state = state.update({
    effects: preview.reconfigure(fountainPreview()),
  }).state;
  kept("the same preview again");
  state = state.update({
    effects: access.reconfigure(EditorState.readOnly.of(false)),
  }).state;
  kept("the same permission again");
  state = state.update({ selection: { anchor: source.indexOf("you") } }).state;
  kept("a selection in an editor without focus");
  state = state.update({
    effects: access.reconfigure(EditorState.readOnly.of(true)),
  }).state;
  kept("read-only without focus");
  state = state.update({ changes: { from: 0, insert: "!" } }).state;
  assert.ok(state.facet(fountainScript) !== script, "an edit parses again");
});

test("file labels, names, document links and counts understand Fountain", () => {
  assert.equal(documentFormat("Story.FOUNTAIN"), "fountain");
  assert.equal(documentName("Drafts/Story.FOUNTAIN"), "Story");
  assert.equal(
    documentPath("Drafts/Story", "fountain"),
    "Drafts/Story.fountain",
  );
  assert.equal(documentPath("Story.fountain", "markdown"), "Story.fountain");
  assert.equal(
    resolveDocumentLink("../Story.fountain", "Notes/idea.md", [
      {
        kind: "file",
        id: "a",
        path: "Story.fountain",
        url: "/d/a",
        shared: false,
      },
    ]),
    "/d/a",
  );
  assert.equal(
    countDocumentWords(
      "Title: Signal\n\n!Hello world.\n\n[[Hidden note]]\n\n/* Hidden words */\n\n# Outline\n= Hidden synopsis",
      "Story.fountain",
    ),
    3,
  );
});
