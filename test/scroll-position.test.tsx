import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import * as Y from "yjs";
import { rememberEditorScroll } from "../src/editor-scroll";

const LINE = 20;
const PADDING = 40;

let dom: JSDOM;
let stops: (() => void)[];
let animationFrames: Map<number, FrameRequestCallback>;
let nextAnimationFrame: number;
let resizes: Set<() => void>;
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
  animationFrames = new Map();
  nextAnimationFrame = 0;
  window.requestAnimationFrame = (callback) => {
    const id = ++nextAnimationFrame;
    animationFrames.set(id, callback);
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    animationFrames.delete(id);
  };
  resizes = new Set();
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class {
      constructor(readonly callback: () => void) {}
      observe() {
        resizes.add(this.callback);
      }
      disconnect() {
        resizes.delete(this.callback);
      }
    },
  });
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
function open(
  key: string,
  text = lines(),
  height = 5000,
  wrap = 0,
  glyphInset = 0,
) {
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
  const wrapped = (pos: number) => {
    const line = lineOf(text, pos);
    const column = pos - starts()[line];
    return drawn(line) + (wrap ? Math.floor(column / wrap) * LINE : 0);
  };
  const starts = () => {
    const result = [0];
    const source = text.toString();
    for (let index = 0; index < source.length; index++)
      if (source[index] === "\n") result.push(index + 1);
    return result;
  };
  if (wrap)
    text
      .toString()
      .split("\n")
      .forEach((line, index) => {
        heights[index] = Math.max(1, Math.ceil(line.length / wrap)) * LINE;
      });
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
      const row = wrap ? Math.max(0, Math.floor((y - drawn(line)) / LINE)) : 0;
      const end = all[line + 1] === undefined ? text.length : all[line + 1] - 1;
      return Math.min(all[line] + row * wrap, end);
    },
    coordsAtPos(pos: number) {
      const top = wrapped(pos) + glyphInset;
      return { top, bottom: top + LINE, left: 0, right: 0 };
    },
    lineBlockAt(pos: number) {
      return { top: lineOf(text, pos) * LINE };
    },
    // Model CodeMirror's public scroll effect: draw its target, then align it
    // in the containing pane during the next measurement.
    dispatch({ effects }: { effects: any }) {
      const target = effects.value;
      queue.push({
        read: () => wrapped(target.range.head) + glyphInset - target.yMargin,
        write: (delta: number) => {
          pane.scrollTop += delta;
        },
      });
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
  let maxMeasures = 0;
  return {
    pane,
    stop,
    text,
    heights,
    drawn,
    wrapped,
    get maxMeasures() {
      return maxMeasures;
    },
    // CodeMirror can drain requests added by a write in the SAME frame. An
    // alignment callback must yield to a real animation frame between passes.
    frame() {
      const callbacks = [...animationFrames.values()];
      animationFrames.clear();
      callbacks.forEach((callback) => callback(0));
      let measured = 0;
      for (let pass = 0; queue.length && pass < 6; pass++) {
        const requests = queue;
        queue = [];
        measured += requests.length;
        const values = requests.map((request) => request.read());
        requests.forEach((request, index) => request.write?.(values[index]));
      }
      maxMeasures = Math.max(maxMeasures, measured);
    },
    settle() {
      for (
        let frames = 0;
        (queue.length || animationFrames.size) && frames < 500;
        frames++
      )
        this.frame();
      assert.equal(queue.length, 0, "restoration must finish");
      assert.equal(animationFrames.size, 0, "restoration must stop polling");
    },
    scroll(position: number) {
      pane.dispatchEvent(new window.Event("wheel"));
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
  for (const resize of resizes) resize();
  reopened.settle();
  assert.equal(reopened.drawn(58), -7);
  reopened.scroll(reopened.pane.scrollTop + 3 * LINE);
  reopened.stop();
  assert.deepEqual(reading(document), { line: 61, offset: 7 });
});

test("restoration delegates one scroll to CodeMirror and then waits for layout changes", () => {
  localStorage.setItem("position", JSON.stringify({ pos: 120, offset: 7 }));
  const page = open("position");
  page.settle();
  assert.equal(
    page.maxMeasures,
    1,
    "alignment must not recurse in a measure pass",
  );
  assert.equal(animationFrames.size, 0);
  assert.equal(
    resizes.size,
    1,
    "idle layout changes retain the reading anchor",
  );
  page.stop();
  assert.equal(resizes.size, 0);
});

test("late layout changes preserve the saved text after initial restoration has settled", () => {
  const note = lines();
  const page = open("position", note);
  page.scroll(PADDING + 58 * LINE + 7);
  page.stop();
  page.pane.remove();
  const saved = localStorage.getItem("position");
  const reopened = open("position", note);
  reopened.settle();
  // Lazy media or a font can change layout long after the first stable frames.
  for (let line = 40; line < 58; line++) reopened.heights[line] = 55;
  for (const resize of resizes) resize();
  reopened.settle();
  assert.equal(reopened.drawn(58), -7);
  window.dispatchEvent(new window.Event("pagehide"));
  assert.equal(localStorage.getItem("position"), saved);
  reopened.pane.dispatchEvent(new window.Event("wheel"));
  const landed = reopened.pane.scrollTop;
  for (let line = 40; line < 58; line++) reopened.heights[line] = 70;
  for (const resize of resizes) resize();
  reopened.settle();
  assert.equal(reopened.pane.scrollTop, landed, "reader input ends alignment");
});

test("font readiness realigns after settling, while cancelled and detached views stay put", async () => {
  let ready!: () => void;
  const fonts = new window.EventTarget();
  Object.defineProperty(fonts, "ready", {
    value: new Promise<void>((resolve) => {
      ready = resolve;
    }),
  });
  Object.defineProperty(document, "fonts", { value: fonts });
  localStorage.setItem("position", JSON.stringify({ pos: 120, offset: 7 }));
  const page = open("position");
  page.settle();
  const line = lineOf(page.text, 120);
  page.heights[0] = 80;
  ready();
  await Promise.resolve();
  page.settle();
  assert.equal(page.drawn(line), -7);
  page.heights[0] = 100;
  fonts.dispatchEvent(new window.Event("loadingdone"));
  page.settle();
  assert.equal(page.drawn(line), -7);
  page.stop();
  const landed = page.pane.scrollTop;
  page.heights[0] = 200;
  fonts.dispatchEvent(new window.Event("loadingdone"));
  page.settle();
  assert.equal(page.pane.scrollTop, landed);
  const pending = open("position");
  pending.frame();
  assert.equal(
    animationFrames.size,
    0,
    "Restoring does not start a polling loop",
  );
  for (const resize of resizes) resize();
  assert.ok(
    animationFrames.size > 0,
    "Layout changes are coalesced into a frame",
  );
  pending.stop();
  assert.equal(animationFrames.size, 0, "cleanup cancels the queued frame");
});

test("wrapped visual lines retain their text anchor when reopening at a different width", () => {
  const note = new Y.Doc().getText("content");
  note.insert(
    0,
    Array.from(
      { length: 80 },
      (_, index) => `line ${index} ${"word ".repeat(18)}\n`,
    ).join(""),
  );
  const page = open("position", note, 15000, 24);
  page.scroll(page.drawn(28) + 2 * LINE + 7);
  page.stop();
  page.pane.remove();
  const { pos, offset } = JSON.parse(localStorage.getItem("position")!);
  assert.equal(lineOf(note, pos), 28);
  assert.equal(offset, 7);
  const reopened = open("position", note, 18000, 20);
  reopened.settle();
  assert.equal(reopened.wrapped(pos), -7);
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

test("late alignment resolves the current CRDT anchor after edits above a restored page", () => {
  const note = lines();
  const page = open("position", note);
  page.scroll(PADDING + 58 * LINE + 7);
  page.stop();
  page.pane.remove();
  const reopened = open("position", note);
  reopened.settle();
  note.insert(0, "inserted\n".repeat(10));
  for (const resize of resizes) resize();
  reopened.settle();
  assert.equal(reopened.drawn(68), -7);
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

test("touch scrolling immediately before switching documents saves the final position", () => {
  const page = open("position");
  page.pane.dispatchEvent(new window.Event("touchstart", { bubbles: true }));
  page.pane.scrollTop = PADDING + 38 * LINE + 9;
  page.pane.dispatchEvent(new window.Event("scroll"));
  // iOS can defer CodeMirror's measurement until after navigation unmounts it.
  page.stop();
  assert.ok(
    localStorage.getItem("position"),
    "Closing must capture a pending scroll",
  );
  assert.deepEqual(reading(page.text), { line: 38, offset: 9 });
});

test("scrollend flushes a touch reading position before a delayed measurement", () => {
  const page = open("position");
  page.pane.scrollTop = PADDING + 20 * LINE + 3;
  page.pane.dispatchEvent(new window.Event("scroll"));
  page.pane.dispatchEvent(new window.Event("scrollend"));
  assert.deepEqual(reading(page.text), { line: 20, offset: 3 });
});

test("restoration does not poll or correct the page on every animation frame", () => {
  localStorage.setItem("position", JSON.stringify({ pos: 120, offset: 7 }));
  const page = open("position");
  page.frame();
  assert.equal(
    animationFrames.size,
    0,
    "CodeMirror should own the restore, without a second alignment loop",
  );
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

test("canvas offsets use the line box and never accumulate glyph inset on reload", () => {
  const note = lines();
  const page = open("position", note, 5000, 0, -2);
  page.scroll(12);
  page.stop();
  page.pane.remove();
  for (let reload = 0; reload < 4; reload++) {
    const reopened = open("position", note, 5000, 0, -2);
    reopened.settle();
    assert.equal(reopened.pane.scrollTop, 12);
    reopened.stop();
    reopened.pane.remove();
  }
  // Existing text-position records used documentTop for this case too.
  const { at, pos, offset } = JSON.parse(localStorage.getItem("position")!);
  localStorage.setItem("position", JSON.stringify({ at, pos, offset }));
  const legacy = open("position", note, 5000, 0, -2);
  legacy.settle();
  assert.equal(legacy.pane.scrollTop, 12);
});

test("a negative first-line glyph offset remains distinct from canvas space", () => {
  const note = lines();
  const page = open("position", note, 5000, 0, 4);
  page.scroll(PADDING + 1);
  page.stop();
  page.pane.remove();
  const saved = JSON.parse(localStorage.getItem("position")!);
  assert.equal(saved.offset, -3);
  assert.equal(saved.canvas, false);
  const reopened = open("position", note, 5000, 0, 4);
  reopened.settle();
  assert.equal(reopened.pane.scrollTop, PADDING + 1);
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
