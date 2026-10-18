import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import * as Y from "yjs";
import { rememberEditorScroll } from "../src/editor-scroll";

const LINE = 20;
const PADDING = 40;

let dom: JSDOM;
let stops: (() => void)[];
beforeEach(() => {
  dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://locdoc.test/",
  });
  for (const name of ["window", "document", "localStorage"])
    Object.defineProperty(globalThis, name, {
      value: dom.window[name],
      configurable: true,
      writable: true,
    });
  stops = [];
});
afterEach(() => {
  for (const stop of stops) stop();
  dom.window.close();
});

function lines(count = 100) {
  const text = new Y.Doc().getText("content");
  text.insert(
    0,
    Array.from({ length: count }, (_, n) => `line ${n}\n`).join(""),
  );
  return text;
}
function lineOf(text: Y.Text, pos: number) {
  return text.toString().slice(0, pos).split("\n").length - 1;
}
function reading(text: Y.Text, key = "position") {
  const { pos, offset } = JSON.parse(localStorage.getItem(key)!);
  return { line: lineOf(text, pos), offset };
}

// The pane's top is at screen y=0, below the canvas padding. CodeMirror's
// height estimate is LINE for every line; `heights` is the drawn layout.
function open(key: string, text = lines(), height = 5000) {
  const pane = document.createElement("div");
  pane.className = "writing-pane";
  Object.defineProperties(pane, {
    scrollHeight: { value: height },
    clientHeight: { value: 500 },
  });
  const editor = pane.appendChild(document.createElement("div"));
  document.body.appendChild(pane);
  const heights: number[] = [];
  const drawn = (line: number) => {
    let top = PADDING - pane.scrollTop;
    for (let index = 0; index < line; index++) top += heights[index] ?? LINE;
    return top;
  };
  const starts = () => {
    const result = [0];
    const source = text.toString();
    for (let index = 0; index < source.length; index++)
      if (source[index] === "\n") result.push(index + 1);
    return result;
  };
  let queue: any[] = [];
  const view = {
    dom: editor,
    contentDOM: editor,
    get documentTop() {
      return PADDING - pane.scrollTop;
    },
    get state() {
      return { doc: { length: text.length } };
    },
    posAtCoords({ y }: { y: number }) {
      const all = starts();
      let line = 0;
      while (line + 1 < all.length && drawn(line + 1) <= y) line++;
      return all[line];
    },
    coordsAtPos(pos: number) {
      const top = drawn(lineOf(text, pos));
      return { top, bottom: top + LINE, left: 0, right: 0 };
    },
    lineBlockAt(pos: number) {
      return { top: lineOf(text, pos) * LINE };
    },
    requestMeasure(request: any) {
      queue = queue.filter(
        (queued) => !request.key || queued.key !== request.key,
      );
      queue.push(request);
    },
  };
  const stop = rememberEditorScroll(view as any, key, text)!;
  stops.push(stop);
  return {
    pane,
    stop,
    text,
    heights,
    drawn,
    // One animation frame: CodeMirror reads every request, then writes.
    frame() {
      const requests = queue;
      queue = [];
      const values = requests.map((request) => request.read());
      requests.forEach((request, index) => request.write?.(values[index]));
    },
    settle() {
      for (let frames = 0; queue.length && frames < 500; frames++) this.frame();
      assert.equal(queue.length, 0, "restoration must finish");
    },
    scroll(position: number) {
      pane.scrollTop = position;
      pane.dispatchEvent(new window.Event("scroll"));
      this.frame();
    },
  };
}

test("reading positions restore the same text and remain separate by document and reader", () => {
  const document = lines();
  const a = open("locdoc.scroll.owner.a", document);
  a.scroll(PADDING + 58 * LINE + 7);
  a.stop();
  a.pane.remove();
  const b = open("locdoc.scroll.owner.b", document);
  b.scroll(PADDING + 15 * LINE);
  b.stop();
  b.pane.remove();
  assert.deepEqual(reading(document, "locdoc.scroll.owner.a"), {
    line: 58,
    offset: 7,
  });
  const reopened = open("locdoc.scroll.owner.a", document);
  assert.equal(reopened.pane.scrollTop, 0);
  reopened.settle();
  assert.equal(reopened.pane.scrollTop, PADDING + 58 * LINE + 7);
  const other = open("locdoc.scroll.owner.b", document);
  other.settle();
  assert.equal(other.pane.scrollTop, PADDING + 15 * LINE);
  const visitor = open("locdoc.scroll.visitor.a", document);
  visitor.settle();
  assert.equal(visitor.pane.scrollTop, 0);
});

test("the saved line stays at the top while CodeMirror measures taller text above it", () => {
  const document = lines();
  const page = open("position", document);
  page.scroll(PADDING + 58 * LINE + 7);
  page.stop();
  page.pane.remove();
  const reopened = open("position", document);
  reopened.frame();
  // Headings, wrapped paragraphs and media above the target get their real
  // heights only once drawn, after the first jump.
  for (let line = 40; line < 58; line++) reopened.heights[line] = 55;
  reopened.settle();
  assert.equal(reopened.drawn(58), -7);
  reopened.scroll(reopened.pane.scrollTop + 3 * LINE);
  reopened.stop();
  assert.deepEqual(reading(document), { line: 61, offset: 7 });
});

test("reader input stops aligning the restored line", () => {
  const document = lines();
  const page = open("position", document);
  page.scroll(PADDING + 58 * LINE);
  page.stop();
  page.pane.remove();
  const reopened = open("position", document);
  reopened.frame();
  const landed = reopened.pane.scrollTop;
  reopened.pane.dispatchEvent(new window.Event("wheel"));
  for (let line = 40; line < 58; line++) reopened.heights[line] = 55;
  reopened.settle();
  assert.equal(reopened.pane.scrollTop, landed);
});

test("a click outside the pane, such as jumping to a comment, also stops alignment", () => {
  const note = lines();
  const page = open("position", note);
  page.scroll(PADDING + 58 * LINE);
  page.stop();
  page.pane.remove();
  const reopened = open("position", note);
  reopened.frame();
  const landed = reopened.pane.scrollTop;
  document.body.dispatchEvent(new window.Event("pointerdown"));
  for (let line = 40; line < 58; line++) reopened.heights[line] = 55;
  reopened.settle();
  assert.equal(reopened.pane.scrollTop, landed);
});

test("collaborator edits above the reading position keep the same text at the top", () => {
  const document = lines();
  const page = open("position", document);
  page.scroll(PADDING + 58 * LINE + 7);
  page.stop();
  page.pane.remove();
  document.insert(0, "inserted\n".repeat(10));
  document.delete(document.toString().indexOf("line 70\n"), "line 70\n".length);
  const reopened = open("position", document);
  reopened.settle();
  assert.equal(reopened.pane.scrollTop, PADDING + 68 * LINE + 7);
  assert.equal(document.toString().split("\n")[68], "line 58");
});

test("a position from another collaboration generation falls back to its index within the document", () => {
  localStorage.setItem(
    "position",
    JSON.stringify({
      at: { item: { client: 1, clock: 999 } },
      pos: 99999,
      offset: 0,
    }),
  );
  const page = open("position");
  page.settle();
  assert.equal(page.pane.scrollTop, PADDING + 100 * LINE);
});

test("legacy pixel positions restore once and then become text positions", () => {
  localStorage.setItem("position", "1200");
  const page = open("position");
  page.frame();
  assert.equal(page.pane.scrollTop, 1200);
  page.scroll(PADDING + 58 * LINE + 7);
  page.stop();
  assert.deepEqual(reading(page.text), { line: 58, offset: 7 });
  localStorage.setItem("position", "9000");
  const short = open("position", lines(), 1000);
  short.frame();
  assert.equal(short.pane.scrollTop, 500);
});

test("reader input cancels pending restoration and closing early cannot erase the saved position", () => {
  localStorage.setItem("position", "800");
  const early = open("position");
  early.stop();
  early.frame();
  assert.equal(early.pane.scrollTop, 0);
  assert.equal(localStorage.getItem("position"), "800");
  const page = open("position");
  page.pane.dispatchEvent(new window.Event("wheel"));
  page.scroll(PADDING + 3 * LINE);
  assert.equal(page.pane.scrollTop, PADDING + 3 * LINE);
  page.stop();
  assert.deepEqual(reading(page.text), { line: 3, offset: 0 });
});

test("page exit and hiding flush the latest position without waiting for a scroll event", () => {
  const page = open("position");
  page.pane.scrollTop = PADDING + 33 * LINE;
  window.dispatchEvent(new window.Event("pagehide"));
  assert.deepEqual(reading(page.text), { line: 33, offset: 0 });
  page.pane.scrollTop = PADDING + 45 * LINE + 10;
  Object.defineProperty(document, "visibilityState", { value: "hidden" });
  document.dispatchEvent(new window.Event("visibilitychange"));
  assert.deepEqual(reading(page.text), { line: 45, offset: 10 });
  page.stop();
  page.pane.scrollTop = 0;
  window.dispatchEvent(new window.Event("pagehide"));
  assert.deepEqual(reading(page.text), { line: 45, offset: 10 });
});

test("the canvas above the first line is remembered as a negative offset", () => {
  const document = lines();
  const page = open("position", document);
  page.scroll(15);
  page.stop();
  page.pane.remove();
  assert.deepEqual(reading(document), { line: 0, offset: 15 - PADDING });
  const reopened = open("position", document);
  reopened.settle();
  assert.equal(reopened.pane.scrollTop, 15);
});

test("invalid positions and unavailable storage cannot break reading", () => {
  for (const value of [
    "-1",
    "1e999",
    "{}",
    "null",
    "broken",
    '{"pos":-3,"offset":0}',
    '{"pos":1.5,"offset":0}',
    '{"pos":4,"offset":"far"}',
  ]) {
    localStorage.setItem("position", value);
    const page = open("position");
    page.settle();
    assert.equal(page.pane.scrollTop, 0);
    page.scroll(PADDING + 15 * LINE);
    page.stop();
    assert.deepEqual(reading(page.text), { line: 15, offset: 0 });
  }
  globalThis.localStorage = {
    getItem() {
      throw new Error("Storage blocked");
    },
    setItem() {
      throw new Error("Storage full");
    },
  } as any;
  const page = open("position");
  page.scroll(500);
  page.stop();
  assert.equal(page.pane.scrollTop, 500);
});

test("continuous scrolling coalesces local writes and another tab cannot move the open page", async () => {
  const page = open("position");
  const prototype = Object.getPrototypeOf(localStorage);
  const original = prototype.setItem;
  let writes = 0;
  prototype.setItem = function (...args) {
    writes++;
    return original.apply(this, args);
  };
  try {
    for (const top of [50, 100, 150, 200]) page.scroll(top);
    assert.equal(writes, 0);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(writes, 1);
    assert.deepEqual(reading(page.text), { line: 8, offset: 0 });
    localStorage.setItem("position", "900");
    window.dispatchEvent(
      new window.StorageEvent("storage", { key: "position" }),
    );
    assert.equal(page.pane.scrollTop, 200);
  } finally {
    prototype.setItem = original;
  }
});
