import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFountain } from "../src/fountain";
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
