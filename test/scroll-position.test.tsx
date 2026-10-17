import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { rememberEditorScroll } from "../src/editor-scroll";

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

function open(key: string, height = 5000) {
  const pane = document.createElement("div");
  pane.className = "writing-pane";
  Object.defineProperties(pane, {
    scrollHeight: { value: height },
    clientHeight: { value: 500 },
  });
  const editor = pane.appendChild(document.createElement("div"));
  document.body.appendChild(pane);
  const measures: any[] = [];
  const stop = rememberEditorScroll(
    { dom: editor, requestMeasure: (measure) => measures.push(measure) } as any,
    key,
  )!;
  stops.push(stop);
  return {
    pane,
    stop,
    measure() {
      for (const measure of measures.splice(0)) measure.write(measure.read());
    },
    scroll(top: number) {
      pane.scrollTop = top;
      pane.dispatchEvent(new window.Event("scroll"));
    },
  };
}

test("reading positions restore after editor layout and remain separate by document and reader", () => {
  localStorage.setItem("locdoc.scroll.owner.a", "1200");
  localStorage.setItem("locdoc.scroll.owner.b", "300");
  localStorage.setItem("locdoc.scroll.visitor.a", "600");
  const a = open("locdoc.scroll.owner.a");
  const b = open("locdoc.scroll.owner.b");
  const visitor = open("locdoc.scroll.visitor.a");
  assert.equal(a.pane.scrollTop, 0);
  a.measure();
  b.measure();
  visitor.measure();
  assert.equal(a.pane.scrollTop, 1200);
  assert.equal(b.pane.scrollTop, 300);
  assert.equal(visitor.pane.scrollTop, 600);
  a.scroll(1700);
  a.stop();
  a.pane.remove();
  assert.equal(localStorage.getItem("locdoc.scroll.owner.a"), "1700");
  assert.equal(localStorage.getItem("locdoc.scroll.owner.b"), "300");
  assert.equal(localStorage.getItem("locdoc.scroll.visitor.a"), "600");
  const reopened = open("locdoc.scroll.owner.a");
  reopened.measure();
  assert.equal(reopened.pane.scrollTop, 1700);
});

test("a shortened document clamps its remembered position to the available page", () => {
  localStorage.setItem("position", "9000");
  const page = open("position", 1000);
  page.measure();
  assert.equal(page.pane.scrollTop, 500);
});

test("reader input cancels pending restoration and closing early cannot erase the saved position", () => {
  localStorage.setItem("position", "800");
  const early = open("position");
  early.stop();
  early.measure();
  assert.equal(early.pane.scrollTop, 0);
  assert.equal(localStorage.getItem("position"), "800");
  const page = open("position");
  page.pane.dispatchEvent(new window.Event("wheel"));
  page.scroll(100);
  page.measure();
  assert.equal(page.pane.scrollTop, 100);
  page.stop();
  assert.equal(localStorage.getItem("position"), "100");
});

test("page exit and hiding flush the latest position without waiting for a scroll event", () => {
  const page = open("position");
  page.pane.scrollTop = 700;
  window.dispatchEvent(new window.Event("pagehide"));
  assert.equal(localStorage.getItem("position"), "700");
  page.pane.scrollTop = 950;
  Object.defineProperty(document, "visibilityState", { value: "hidden" });
  document.dispatchEvent(new window.Event("visibilitychange"));
  assert.equal(localStorage.getItem("position"), "950");
  page.stop();
  page.pane.scrollTop = 0;
  window.dispatchEvent(new window.Event("pagehide"));
  assert.equal(localStorage.getItem("position"), "950");
});

test("invalid positions and unavailable storage cannot break reading", () => {
  for (const value of ["-1", "1e999", "{}", "null", "broken"]) {
    localStorage.setItem("position", value);
    const page = open("position");
    page.measure();
    assert.equal(page.pane.scrollTop, 0);
    page.scroll(250);
    page.stop();
    assert.equal(localStorage.getItem("position"), "250");
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
    assert.equal(localStorage.getItem("position"), "200");
    localStorage.setItem("position", "900");
    window.dispatchEvent(
      new window.StorageEvent("storage", { key: "position" }),
    );
    assert.equal(page.pane.scrollTop, 200);
  } finally {
    prototype.setItem = original;
  }
});
