import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { protectTouchViewport } from "../src/touch-viewport";

for (const profile of [
  {
    name: "installed iPhone portrait",
    agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)",
    platform: "iPhone",
    width: 390,
    fixed: 751,
    large: 844,
    safeTop: 59,
    safeBottom: 34,
    expanded: false,
  },
  {
    name: "installed iPhone landscape, wider than a portrait iPad",
    agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)",
    platform: "iPhone",
    width: 844,
    fixed: 350,
    large: 390,
    safeTop: 0,
    safeBottom: 21,
    expanded: false,
  },
  {
    name: "installed iPad in desktop browsing mode",
    agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    platform: "MacIntel",
    width: 744,
    fixed: 1101,
    large: 1133,
    safeTop: 32,
    safeBottom: 20,
    expanded: true,
  },
]) {
  test(`${profile.name} keeps its footer within the idle shell after keyboard dismissal`, () => {
    const dom = new JSDOM("<!doctype html><body><textarea></textarea>", {
      pretendToBeVisual: true,
    });
    const win = dom.window;
    const target = win.document;
    const root = target.documentElement;
    const input = target.querySelector("textarea")!;
    const viewport = Object.assign(new win.EventTarget(), {
      height: profile.fixed,
      offsetTop: 0,
    });
    Object.defineProperties(win, {
      innerWidth: { value: profile.width, configurable: true },
      innerHeight: { value: profile.fixed, configurable: true },
      visualViewport: { value: viewport, configurable: true },
    });
    Object.defineProperties(win.navigator, {
      standalone: { value: true, configurable: true },
      userAgent: { value: profile.agent, configurable: true },
      platform: { value: profile.platform, configurable: true },
      maxTouchPoints: { value: 5, configurable: true },
    });
    const getRect = win.HTMLElement.prototype.getBoundingClientRect;
    win.HTMLElement.prototype.getBoundingClientRect = function () {
      if (!this.hasAttribute("data-viewport-gauge")) return getRect.call(this);
      return new win.DOMRect(
        0,
        0,
        profile.width,
        this.style.height ? profile.large : profile.fixed,
      );
    };
    const computed = win.getComputedStyle;
    win.getComputedStyle = (element, pseudo) =>
      element.hasAttribute("data-viewport-gauge")
        ? ({
            paddingTop: `${profile.safeTop}px`,
            paddingBottom: `${profile.safeBottom}px`,
          } as CSSStyleDeclaration)
        : computed.call(win, element, pseudo);
    const stop = protectTouchViewport(target);
    const expected = `${profile.expanded ? profile.large : profile.fixed}px`;
    try {
      assert.equal(
        root.style.getPropertyValue("--app-viewport-height"),
        expected,
      );
      assert.ok(!root.hasAttribute("data-keyboard-open"));
      input.focus();
      assert.ok(!root.hasAttribute("data-keyboard-open"));
      assert.equal(
        root.style.getPropertyValue("--app-viewport-height"),
        expected,
      );

      viewport.height = Math.round(profile.fixed / 2);
      viewport.offsetTop = 12;
      viewport.dispatchEvent(new win.Event("resize"));
      assert.ok(root.hasAttribute("data-keyboard-open"));
      assert.equal(
        root.style.getPropertyValue("--app-viewport-height"),
        `${viewport.height}px`,
      );

      // iOS Done can close the keyboard while leaving the editor focused.
      viewport.height = profile.fixed;
      viewport.offsetTop = 0;
      viewport.dispatchEvent(new win.Event("resize"));
      assert.ok(target.activeElement === input, "the editor keeps focus");
      assert.ok(!root.hasAttribute("data-keyboard-open"));
      assert.equal(
        root.style.getPropertyValue("--app-viewport-height"),
        expected,
      );
      assert.equal(root.style.getPropertyValue("--app-viewport-top"), "");
    } finally {
      stop();
      assert.ok(!target.querySelector("[data-viewport-gauge]"));
      dom.window.close();
    }
  });
}
