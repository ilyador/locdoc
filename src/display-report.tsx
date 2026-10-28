import { useState } from "react";
import { Copy } from "@phosphor-icons/react";

// An explicit, local report of geometry only. Capture before opening Settings:
// the dialog can focus a field and bring up the iPad's software keyboard.
export function displayReport(target: Document) {
  const win = target.defaultView!;
  const root = target.documentElement;
  const round = (value: number) => Math.round(value * 100) / 100;
  const box = (selector: string) => {
    const element = target.querySelector(selector);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const style = win.getComputedStyle(element);
    return {
      x: round(rect.x),
      y: round(rect.y),
      bottom: round(rect.bottom),
      width: round(rect.width),
      height: round(rect.height),
      display: style.display,
      position: style.position,
      padding: style.padding,
      margin: style.margin,
      rows: style.gridTemplateRows,
    };
  };
  const probe = target.createElement("div");
  probe.style.cssText =
    "position:fixed;top:0;left:0;width:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px);box-sizing:border-box;";
  target.body.append(probe);
  const units: Record<string, number> = {};
  let safeTop = "",
    safeBottom = "";
  try {
    for (const unit of ["vh", "svh", "dvh", "lvh"]) {
      probe.style.height = `100${unit}`;
      units[unit] = round(probe.getBoundingClientRect().height);
    }
    const style = win.getComputedStyle(probe);
    safeTop = style.paddingTop;
    safeBottom = style.paddingBottom;
  } finally {
    probe.remove();
  }
  const vv = win.visualViewport;
  return JSON.stringify(
    {
      version: 1,
      captured: new Date().toISOString(),
      bundle:
        target
          .querySelector('script[type="module"][src]')
          ?.getAttribute("src")
          ?.match(/\/assets\/[\w-]+\.js(?=$|[?#])/g)?.[0] ?? null,
      browser: win.navigator.userAgent.slice(0, 300),
      standalone: root.hasAttribute("data-standalone"),
      keyboard: root.hasAttribute("data-keyboard-open"),
      focusedTag: target.activeElement?.tagName,
      screen: {
        width: win.screen.width,
        height: win.screen.height,
        availHeight: win.screen.availHeight,
      },
      window: {
        width: win.innerWidth,
        height: win.innerHeight,
        outerHeight: win.outerHeight,
        scrollX: win.scrollX,
        scrollY: win.scrollY,
        pixelRatio: win.devicePixelRatio,
      },
      visual: vv
        ? {
            width: vv.width,
            height: vv.height,
            top: vv.offsetTop,
            left: vv.offsetLeft,
            pageTop: vv.pageTop,
            scale: vv.scale,
          }
        : null,
      layout: {
        width: root.clientWidth,
        height: root.clientHeight,
        scrollHeight: root.scrollHeight,
        scrollTop: root.scrollTop,
      },
      shell: {
        height: root.style.getPropertyValue("--app-viewport-height"),
        top: root.style.getPropertyValue("--app-viewport-top"),
      },
      safeTop,
      safeBottom,
      units,
      elements: Object.fromEntries(
        [
          "html",
          "body",
          "#root",
          ".app",
          ".workspace",
          ".topbar",
          ".writing-pane",
          ".statusbar",
          "[data-viewport-gauge]",
        ].map((selector) => [selector, box(selector)]),
      ),
    },
    null,
    2,
  );
}

export function CopyDisplayReport({ report }: { report: string }) {
  const [result, setResult] = useState<"" | "copied" | "manual">("");
  return (
    <>
      <button
        className="menu-action"
        type="button"
        onClick={async () => {
          try {
            if (!navigator.clipboard) throw new Error("Clipboard unavailable");
            await navigator.clipboard.writeText(report);
            setResult("copied");
          } catch {
            setResult("manual");
          }
        }}
      >
        <Copy />
        Copy display report
      </button>
      {result === "copied" && (
        <p className="field-help" role="status">
          Display measurements copied. Paste them into the support conversation.
        </p>
      )}
      {result === "manual" && (
        <>
          <p className="field-help">Select and copy the report below.</p>
          <textarea
            className="text-input"
            aria-label="Display report"
            dir="ltr"
            readOnly
            rows={6}
            value={report}
            onFocus={(event) => event.currentTarget.select()}
          />
        </>
      )}
    </>
  );
}
