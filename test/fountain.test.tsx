import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ChangeSet,
  Compartment,
  EditorSelection,
  EditorState,
  Text,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  sourceCommentLayer,
  sourceCommentRanges,
} from "../src/editor-comments";
import {
  editFountain,
  moveEditingLine,
  parseFountain,
  type FountainScript,
} from "../src/fountain";
import { fountainPreview, fountainScript } from "../src/fountain-preview";
import { FountainSpeakerColors } from "../src/fountain-speaker-colors";
import {
  documentFormat,
  documentName,
  documentPath,
} from "../src/document-format";
import { countDocumentWords } from "../src/word-count";
import { resolveDocumentLink } from "../src/document-links";

const speakerHue = (wrapper: { attributes: { [key: string]: string } }) =>
  Number(wrapper.attributes.style.split(":")[1]);

test("speaker hues are distinct, cue extensions share them, and source stays inert", () => {
  const colors = new FountainSpeakerColors();
  const names = [
    "SARA",
    "IBRAHIM",
    "ZE'EV",
    "ANA",
    "MAYA",
    "BEN",
    "LEE",
    "MORGAN",
  ];
  const hues = names.map((name) => speakerHue(colors.wrapper(name)));
  assert.equal(new Set(hues).size, names.length);
  for (let i = 0; i < hues.length; i++)
    for (let j = i + 1; j < hues.length; j++)
      assert.ok(
        180 - Math.abs(Math.abs(hues[i] - hues[j]) - 180) >= 20,
        "A small cast gets separated hues",
      );
  const sara = hues[0];
  for (const cue of ["SARA (V.O.)", "SARA (CONT'D) ^", "@Sara", "  SARA  "])
    assert.equal(speakerHue(colors.wrapper(cue)), sara);
  assert.equal(
    speakerHue(colors.wrapper("@מאיה")),
    speakerHue(colors.wrapper("מאיה (O.S.)")),
  );
  const hostile = colors.wrapper('<script>alert("x")</script>');
  assert.deepEqual(Object.keys(hostile.attributes).sort(), ["class", "style"]);
  assert.ok(
    Number.isFinite(speakerHue(hostile)),
    "Only a numeric hue enters the style",
  );
});

test("speaker colors survive reordering and reopening without storing unfinished names", () => {
  const saved = new Map<string, string>();
  let writes = 0;
  const storage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => {
      writes++;
      saved.set(key, value);
    },
  };
  const colors = new FountainSpeakerColors("script", storage);
  const sara = speakerHue(colors.wrapper("SARA"));
  const ben = speakerHue(colors.wrapper("BEN"));
  colors.flush();
  assert.equal(writes, 1);
  for (const prefix of ["MA", "MAY", "MAYA"]) colors.wrapper(prefix, false);
  colors.flush();
  assert.equal(writes, 1);
  const reopened = new FountainSpeakerColors("script", storage);
  reopened.wrapper("ANA");
  assert.equal(speakerHue(reopened.wrapper("BEN (O.S.)")), ben);
  assert.equal(speakerHue(reopened.wrapper("SARA")), sara);
  reopened.flush();
  const third = new FountainSpeakerColors("script", storage);
  assert.equal(
    speakerHue(third.wrapper("ANA")),
    speakerHue(reopened.wrapper("ANA")),
  );
  third.flush();
  assert.equal(writes, 2);
  assert.equal(JSON.parse(saved.get("locdoc.speakerColors.script")!).length, 3);
});

test("unavailable or invalid color storage never blocks the screenplay", () => {
  const blocked = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("full");
    },
  };
  const colors = new FountainSpeakerColors("script", blocked);
  const first = speakerHue(colors.wrapper("SARA"));
  colors.flush();
  assert.equal(speakerHue(colors.wrapper("SARA")), first);
  for (const saved of [
    "not json",
    "{}",
    '[["SARA",null],["BEN",999],["LEE",20],["MAYA",20]]',
  ]) {
    const palette = new FountainSpeakerColors("script", {
      getItem: () => saved,
      setItem: () => {},
    });
    const hues = ["SARA", "BEN", "LEE", "MAYA"].map((name) =>
      speakerHue(palette.wrapper(name)),
    );
    assert.equal(new Set(hues).size, 4);
    assert.ok(
      hues.every((hue) => Number.isFinite(hue) && hue >= 0 && hue < 360),
    );
  }
});

test("a pasted cast and later cue edits reuse the same speaker wrappers", () => {
  let state = EditorState.create({
    doc: "SARA\nHello.\n",
    extensions: fountainPreview(),
  });
  const cues = () => {
    const result: { text: string; hue: number }[] = [];
    for (const set of state.facet(EditorView.blockWrappers))
      set.between(0, state.doc.length, (from, to, wrapper) => {
        if (wrapper.attributes.class.includes("fountain-character"))
          result.push({
            text: state.sliceDoc(from, to),
            hue: speakerHue(wrapper),
          });
      });
    return result;
  };
  const original = cues()[0].hue;
  state = state.update({ changes: { from: 0, insert: "BEN\nHi.\n\n" } }).state;
  assert.equal(cues().find((c) => c.text === "SARA")!.hue, original);
  state = state.update({
    selection: { anchor: 0 },
    effects: state
      .facet(EditorView.focusChangeEffect)
      .flatMap((effect) => effect(state, true) ?? []),
  }).state;
  const source =
    "MAYA\nHi.\n\nANA\nHello.\n\nMAYA (V.O.)\nAgain.\n\nSARA\nGoodbye.";
  state = state.update({
    changes: { from: 0, to: state.doc.length, insert: source },
    selection: { anchor: 2 },
  }).state;
  const cast = cues();
  assert.equal(cast[0].hue, cast[2].hue);
  assert.equal(cast[3].hue, original);
  assert.equal(state.doc.toString(), source);
});

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

// A script as short lines of text: each line's kind, place, text and
// markers, then its notes and omissions.
function scriptRows(script: FountainScript) {
  return [
    ...script.lines.map(
      (line) =>
        `${line.kind} ${line.from}-${line.to} ${JSON.stringify(line.text)} ` +
        `[${line.markers.map((m) => `${m.from}-${m.to}`).join(" ")}] ` +
        `${line.markers.indexOf(line.prefix!)} ${line.markers.indexOf(line.suffix!)}`,
    ),
    `notes ${script.notes.map((r) => `${r.from}-${r.to}`).join(" ")}`,
    `omissions ${script.omissions.map((r) => `${r.from}-${r.to}`).join(" ")}`,
  ];
}

// The decorations and block wrappers a state shows, as short lines of text.
function layoutRows(state: EditorState) {
  const rows: string[] = [];
  for (const set of state.facet(EditorView.decorations))
    if (typeof set !== "function")
      set.between(0, state.doc.length, (from, to, value) => {
        rows.push(
          `${from}-${to} ${value.startSide} ${JSON.stringify(value.spec)}`,
        );
      });
  for (const set of state.facet(EditorView.blockWrappers))
    set.between(0, state.doc.length, (from, to, value) => {
      rows.push(
        `${from}-${to} ${value.tagName} ${JSON.stringify(value.attributes)}`,
      );
    });
  return rows.sort();
}

// Compares two lists of rows by their first difference.
function sameRows(actual: string[], expected: string[], label: string) {
  const index = actual.findIndex((row, i) => row !== expected[i]);
  if (index >= 0 || actual.length !== expected.length)
    assert.equal(
      actual[index] ?? `(${actual.length} rows)`,
      expected[index] ?? `(${expected.length} rows)`,
      `${label}: row ${index}`,
    );
}

const tricky = [
  "Title: The Signal\nAuthor: Example Writer\n\nINT. STUDIO - DAY\n\nA lamp flickers.\n\nMORGAN (V.O.)\n(quietly)\nIs anyone here?\n\nLEE ^\nYes.\n\nCUT TO:\n\nEXT. STREET - NIGHT",
  "An action.\n\nSARA\n\n\n# Next section\n\nBEN\nHi.\n  \nStill Ben.",
  "@מאיה\nאיפה היית?\n\nפנים. בית - יום\n\nמאיה\nבבית.",
  "She waits.[[comment(alex): Too long?]]\n[[comment(ana): No]]\n\nMAYA\nHello.[[A note\nthat goes on]]\n\n/*\nCUT\nSCENE\n*/\n\nBEN\n*Bye* _now_ \\*.",
  "> THE END <\n\n~A song\n~Another\n\n===\n\n.FORCED SCENE\n\n!LOUD ACTION\n\nMAYA\n",
];

test("a caret on another line reads the lines it changes as a full parse does", () => {
  for (const source of tricky) {
    const count = source.split("\n").length;
    const lines = [undefined, ...Array.from({ length: count }, (_, i) => i)];
    for (const before of lines)
      for (const after of lines) {
        const label = `${JSON.stringify(source.slice(0, 30))} from ${before} to ${after}`;
        const script = parseFountain(source, before);
        const moved = moveEditingLine(script, before, after)!;
        sameRows(
          scriptRows(moved.script),
          scriptRows(parseFountain(source, after)),
          label,
        );
        if (!moved.lines.length)
          assert.ok(moved.script === script, `${label}: the same script`);
      }
  }
});

test("an edit of ordinary text reads the lines it changes as a full parse does", () => {
  for (const source of tricky) {
    const doc = Text.of(source.split("\n"));
    const count = doc.lines;
    for (let at = 0; at <= source.length; at++)
      for (const change of [
        { from: at, insert: "x" },
        { from: at, insert: " " },
        { from: at, insert: "A" },
        { from: at, insert: "\n" },
        { from: at, insert: "\n\n" },
        { from: at, insert: "MAYA\nHi." },
        { from: at, to: Math.min(at + 1, source.length) },
        { from: at, to: Math.min(at + 3, source.length) },
      ]) {
        const changes = ChangeSet.of([change], source.length);
        const after = changes.apply(doc);
        const line = after.lineAt(at).number - 1;
        for (const [before, editing] of [
          [undefined, undefined],
          [doc.lineAt(at).number - 1, line],
          [(line + 2) % count, line],
        ] as const) {
          const updated = editFountain(
            parseFountain(source, before),
            changes,
            doc,
            after,
            before,
            editing,
          );
          if (!updated) continue;
          sameRows(
            scriptRows(updated.script),
            scriptRows(parseFountain(after.toString(), editing)),
            `${JSON.stringify(source.slice(0, 30))}: ${JSON.stringify(change)}, editing ${before} then ${editing}`,
          );
        }
      }
  }
});

test("moving the caret and typing lay out a script as a fresh layout does", () => {
  const focus = (state: EditorState, focused: boolean) =>
    state.update({
      effects: state
        .facet(EditorView.focusChangeEffect)
        .flatMap((effect) => effect(state, focused) ?? []),
    }).state;
  for (const source of tricky) {
    let state = focus(
      EditorState.create({
        doc: source,
        extensions: [sourceCommentLayer, fountainPreview()],
      }),
      true,
    );
    const check = (label: string) => {
      // Replacing the whole text lays the script out afresh.
      const fresh = state.update({
        changes: {
          from: 0,
          to: state.doc.length,
          insert: state.doc.toString(),
        },
        selection: state.selection,
      }).state;
      sameRows(
        scriptRows(state.facet(fountainScript)!),
        scriptRows(fresh.facet(fountainScript)!),
        `${label}: script`,
      );
      sameRows(layoutRows(state), layoutRows(fresh), `${label}: layout`);
    };
    const type = (insert: string) => {
      const at = state.selection.main.head;
      state = state.update({
        changes: { from: at, insert },
        selection: { anchor: at + insert.length },
        userEvent: "input.type",
      }).state;
    };
    const backspace = () => {
      const at = state.selection.main.head;
      state = state.update({
        changes: { from: at - 1, to: at },
        selection: { anchor: at - 1 },
        userEvent: "delete.backward",
      }).state;
    };
    for (let n = 1; n <= source.split("\n").length; n++) {
      // A caret is never inside the records a line ends with.
      const end = state.doc.line(n).to;
      if (
        sourceCommentRanges(state).some(
          (range) => range.from < end && end < range.to,
        )
      )
        continue;
      state = state.update({
        selection: { anchor: end },
        userEvent: "select",
      }).state;
      check(`caret on line ${n}`);
      type(n % 2 ? "x" : "A");
      check(`typing on line ${n}`);
      backspace();
      check(`deleting on line ${n}`);
      // A new line, its first letters, and joining it back.
      type("\n");
      check(`a new line after line ${n}`);
      type("SA");
      check(`typing a new line after line ${n}`);
      backspace();
      backspace();
      backspace();
      check(`joining the new line after line ${n}`);
      assert.equal(state.doc.toString(), source, `line ${n}`);
    }
    state = focus(state, false);
    check("without focus");
  }
});

test("moving the caret and typing in a long script read only the lines they change", () => {
  const scenes = Array.from(
    { length: 400 },
    (_, i) =>
      `INT. ROOM ${i} - DAY\n\nMaya waits by the door, *quietly*.\n\nMAYA\n(softly)\nWhere were you?${i % 50 ? "" : "[[comment(alex): Too blunt?]]"}\n\nBEN ^\nOut.\n\n`,
  );
  const source = `Title: A Long Script\n\n${scenes.join("")}[[A note]]\n\n/*\nCut\n*/`;
  let state = EditorState.create({
    doc: source,
    extensions: [sourceCommentLayer, fountainPreview()],
  });
  state = state.update({
    effects: state
      .facet(EditorView.focusChangeEffect)
      .flatMap((effect) => effect(state, true) ?? []),
  }).state;
  const opened = state.facet(fountainScript)!;
  const type = (insert: string) => {
    const at = state.selection.main.head;
    state = state.update({
      changes: { from: at, insert },
      selection: { anchor: at + insert.length },
      userEvent: "input.type",
    }).state;
  };
  // Moving the caret, and typing on lines with text, never serialize the
  // script to parse it again.
  const original = Text.prototype.toString;
  let wholeScriptReads = 0;
  Text.prototype.toString = function () {
    if (this.length > 10000) wholeScriptReads++;
    return original.call(this);
  };
  try {
    for (let n = 1500; n < 1560; n++) {
      state = state.update({
        selection: { anchor: state.doc.line(n).to },
        userEvent: "select",
      }).state;
      if (state.doc.line(n).text.trim()) type("a");
    }
  } finally {
    Text.prototype.toString = original;
  }
  assert.equal(wholeScriptReads, 0, "no step serialized the script");
  // New lines too read only the lines around them.
  type("\n");
  type("MAYA");
  type("\n");
  type("Here.");
  const script = state.facet(fountainScript)!;
  assert.ok(
    script.lines[100] === opened.lines[100],
    "a line far before the edits keeps its parse",
  );
  sameRows(
    scriptRows(script),
    scriptRows(
      parseFountain(
        state.doc.toString(),
        state.doc.lineAt(state.selection.main.head).number - 1,
      ),
    ),
    "the script reads as a full parse",
  );
});
