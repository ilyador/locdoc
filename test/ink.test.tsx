import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { CompletionContext } from "@codemirror/autocomplete";
import {
  documentFormat,
  documentExtension,
  documentName,
  documentPath,
  isDocumentPath,
  nameParts,
} from "../src/document-format";
import { completeInk } from "../src/ink-preview";
import { InkRuntime } from "../src/ink-runtime";
import { inkPath, inkSource, prepareInk } from "../src/ink-source";
import { loadInkProject } from "../src/ink-project";
import { countDocumentWords } from "../src/word-count";
import type { Entry } from "../src/model";

const story =
  "VAR key = false\nThe gate is shut.\n* [Take the key]\n~ key = true\nYou pick it up.\n-> gate\n* [Leave]\n-> END\n=== gate ===\n{key: The gate opens.|Locked.}\n-> END";
const compile = (runtime: InkRuntime, source = story, history: string[] = []) =>
  runtime.run({
    type: "compile",
    path: "story.ink",
    files: { "story.ink": source },
    history,
  });

test("Ink names retain their extension, format and title through file actions", () => {
  assert.equal(documentFormat("Stories/שלום.INK"), "ink");
  assert.equal(documentExtension("story.INK"), ".ink");
  assert.equal(documentName("Stories/story.ink"), "story");
  assert.equal(documentPath("Stories/story", "ink"), "Stories/story.ink");
  assert.equal(documentPath("story.ink", "markdown"), "story.ink");
  assert.deepEqual(nameParts("שלום.ink"), ["שלום", ".ink"]);
  assert.ok(isDocumentPath("story.ink"));
  assert.ok(!isDocumentPath("story.ink.json"));
});

test("real Ink choices, variables and diverts play, replay and restart", () => {
  const runtime = new InkRuntime();
  let result = compile(runtime);
  assert.deepEqual(result.messages, []);
  assert.deepEqual(result.choices, ["Take the key", "Leave"]);
  result = runtime.run({ type: "choose", index: 0 });
  assert.ok(result.turns.some((turn) => turn.text === "The gate opens."));
  assert.equal(result.choices.length, 0);
  assert.deepEqual(result.history, ["Take the key"]);
  result = compile(
    runtime,
    story.replace("opens.", "swings open."),
    result.history,
  );
  assert.ok(result.turns.some((turn) => turn.text === "The gate swings open."));
  result = compile(
    runtime,
    story.replace("Take the key", "Break the lock"),
    result.history,
  );
  assert.deepEqual(
    result.history,
    [],
    "a changed branch waits for a new choice",
  );
  assert.deepEqual(result.choices, ["Break the lock", "Leave"]);
  result = compile(runtime);
  assert.equal(result.turns.length, 1, "restart clears the transcript");
});

test("Ink errors, invalid choices and loops are bounded and recoverable", () => {
  const runtime = new InkRuntime();
  assert.ok(
    compile(runtime, "-> missing").messages.some(
      (message) => message.severity === "error",
    ),
  );
  assert.deepEqual(compile(runtime).choices, ["Take the key", "Leave"]);
  assert.ok(
    runtime
      .run({ type: "choose", index: 9 })
      .messages.some((message) => message.severity === "error"),
  );
  const loop = compile(runtime, "-> loop\n=== loop ===\n-> loop");
  assert.ok(
    loop.messages.some((message) => /limit/.test(message.text)),
    "a divert-only loop yields and stops",
  );
  assert.deepEqual(compile(runtime).choices, ["Take the key", "Leave"]);
});

test("story output keeps HTML inert and never binds external code", () => {
  const runtime = new InkRuntime();
  assert.equal(
    compile(runtime, '<img src=x onerror="alert(1)">\n-> END').turns[0].text,
    '<img src=x onerror="alert(1)">',
  );
  assert.ok(
    compile(runtime, "EXTERNAL secret()\n~ secret()\n-> END").messages.some(
      (message) => message.severity === "error",
    ),
  );
});

test("include resolution reads only listed files, handles nesting and preserves compiler lines", async () => {
  const paths = ["Stories/chapters/first.ink", "Stories/end.ink"];
  const entries = paths.map((path, i) => ({
    path,
    kind: "file",
    id: String(i),
  })) as Entry[];
  const read: string[] = [];
  const files = await loadInkProject(
    "Stories/main.ink",
    "INCLUDE chapters/first.ink // chapter\n-> start",
    entries,
    async (id) => {
      read.push(id);
      return {
        content:
          id === "0"
            ? "INCLUDE ../end.ink\n=== start ===\nHello.\n-> end"
            : "=== end ===\nGoodbye.\n-> END",
      };
    },
  );
  const result = new InkRuntime().run({
    type: "compile",
    path: "Stories/main.ink",
    files,
    history: [],
  });
  assert.deepEqual(result.messages, []);
  assert.deepEqual(
    result.turns.map((turn) => turn.text),
    ["Hello.", "Goodbye."],
  );
  assert.deepEqual(read, ["0", "1"]);
  await assert.rejects(
    loadInkProject("main.ink", "INCLUDE secret.ink", [], async () => {
      throw new Error("Must not read");
    }),
    /Cannot preview INCLUDE/,
  );
  for (const path of [
    "../../secret.ink",
    "https://example.com/a.ink",
    "/tmp/a.ink",
    ".locdoc/a.ink",
    "a.txt",
  ])
    assert.throws(() => inkPath("Stories/main.ink", path), /INCLUDE/);
  const annotated = "A line[[comment(sam): hidden]]\nINCLUDE end.ink\n-> END";
  assert.equal(prepareInk(annotated, "Stories/main.ink").split("\n").length, 3);
  assert.ok(!inkSource(annotated).includes("hidden"));
  const ignored = await loadInkProject(
    "main.ink",
    "/*\nINCLUDE secret.ink\n*/\nHello.\n-> END",
    [],
    async () => {
      throw new Error("Must not read");
    },
  );
  assert.equal(Object.keys(ignored).length, 1);
});

test("divert completion offers knots and stitches and follows source edits", () => {
  const source = "=== start ===\n= door\n// === hidden ===\n-> st";
  const state = EditorState.create({ doc: source });
  assert.deepEqual(
    completeInk(new CompletionContext(state, source.length, true))?.options.map(
      (option) => option.label,
    ),
    ["END", "DONE", "start", "start.door"],
  );
  const next = state.update({
    changes: { from: 4, to: 9, insert: "home" },
  }).state;
  assert.ok(
    completeInk(
      new CompletionContext(next, next.doc.length, true),
    )?.options.some((option) => option.label === "home.door"),
  );
  assert.equal(
    countDocumentWords(
      "VAR key = 1\n=== gate ===\nHello there. # tag\n* [Go inside] -> END\n// no words",
      "story.ink",
    ),
    4,
  );
});
