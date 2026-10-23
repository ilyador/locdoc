import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { documentFontFamily, useFontCategory } from "../src/appearance";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
for (const key of [
  "window",
  "document",
  "navigator",
  "localStorage",
  "location",
])
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: dom.window[key],
  });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
  dom.window.close();
});

test("each document font is followed by a Hebrew face that pairs with it", () => {
  const pairs: [string, string, string][] = [
    [
      "JetBrains Mono",
      "",
      '"Locdoc Shapes", "JetBrains Mono", "Locdoc Hebrew Mono", ui-monospace, monospace',
    ],
    [
      "Courier Prime",
      "",
      '"Locdoc Shapes", "Courier Prime", "Locdoc Hebrew Typewriter", ui-monospace, monospace',
    ],
    [
      "IBM Plex Sans",
      "",
      '"Locdoc Shapes", "IBM Plex Sans", "Locdoc Hebrew Sans", sans-serif',
    ],
    [
      "DM Sans",
      "",
      '"Locdoc Shapes", "DM Sans Variable", "Locdoc Hebrew Geometric", sans-serif',
    ],
    [
      "Lora",
      "",
      '"Locdoc Shapes", "Lora", "Locdoc Hebrew Serif", Georgia, serif',
    ],
    [
      "Georgia",
      "",
      '"Locdoc Shapes", "Georgia", "Locdoc Hebrew Serif", Georgia, serif',
    ],
    [
      "monospace",
      "",
      '"Locdoc Shapes", ui-monospace, "Locdoc Hebrew Mono", monospace',
    ],
    // Families installed from Google Fonts keep their fallbacks and get a
    // partner for their catalog category.
    [
      "Merriweather",
      "Serif",
      '"Locdoc Shapes", "Merriweather", "Locdoc Hebrew Serif", sans-serif',
    ],
    [
      "Space Mono",
      "Monospace",
      '"Locdoc Shapes", "Space Mono", "Locdoc Hebrew Mono", sans-serif',
    ],
    [
      "Inter",
      "Sans Serif",
      '"Locdoc Shapes", "Inter", "Locdoc Hebrew Sans", sans-serif',
    ],
    [
      "Caveat",
      "Handwriting",
      '"Locdoc Shapes", "Caveat", "Locdoc Hebrew Sans", sans-serif',
    ],
  ];
  for (const [font, category, family] of pairs)
    assert.equal(documentFontFamily(font, category), family, font);

  // The interface and code faces have Hebrew partners too, after the shapes
  // face that leads every stack.
  const stylesheet = readFileSync(
    new URL("../src/style.css", import.meta.url),
    "utf8",
  );
  for (const token of ["--ui-font", "--reading-font", "--code-font"])
    assert.match(
      stylesheet,
      new RegExp(
        `${token}:\\s*"Locdoc Shapes", "[^"]+", "Locdoc Hebrew (Sans|Mono)"`,
      ),
      token,
    );
});

test("a family installed from Google Fonts finds its catalog category for its partner", async () => {
  const { renderHook, waitFor } = await import("@testing-library/react");
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(new URL(String(input), location.href).pathname);
    return new Response(
      JSON.stringify({
        fonts: [
          { family: "Merriweather", category: "Serif" },
          { family: "Space Mono", category: "Monospace" },
        ],
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const bundled = renderHook(() => useFontCategory("JetBrains Mono"));
  assert.equal(bundled.result.current, "");
  assert.deepEqual(requests, [], "Bundled families need no catalog");
  bundled.unmount();
  const installed = renderHook(({ font }) => useFontCategory(font), {
    initialProps: { font: "Merriweather" },
  });
  await waitFor(() => assert.equal(installed.result.current, "Serif"));
  installed.rerender({ font: "Space Mono" });
  assert.equal(installed.result.current, "Monospace");
  installed.rerender({ font: "Not In Catalog" });
  assert.equal(
    installed.result.current,
    "",
    "An unknown family pairs as sans-serif",
  );
  installed.unmount();
  assert.deepEqual(requests, ["/font-catalog.json"], "The catalog loads once");
});

test("the built Hebrew faces cover only Hebrew and every one of their files is served", () => {
  const web = process.env.LOCDOC_WEB;
  assert.ok(
    web && existsSync(join(web, "index.html")),
    "the verified web build exists",
  );
  const assets = join(web!, "assets");
  const css = readdirSync(assets)
    .filter((file) => file.endsWith(".css"))
    .map((file) => readFileSync(join(assets, file), "utf8"))
    .join("\n");
  const faces = css.match(/@font-face\{[^}]*\}/g) || [];
  const hebrew = faces.filter((face) => face.includes("Locdoc Hebrew"));
  const summary = hebrew
    .map((face) => {
      const family = /font-family:\s*"?([^;"]+)"?;/.exec(face)![1];
      const weight = /font-weight:\s*(\d+)/.exec(face)![1];
      return `${family} ${weight}`;
    })
    .sort();
  assert.deepEqual(summary, [
    "Locdoc Hebrew Geometric 400",
    "Locdoc Hebrew Geometric 600",
    "Locdoc Hebrew Geometric 700",
    "Locdoc Hebrew Mono 400",
    "Locdoc Hebrew Mono 600",
    "Locdoc Hebrew Mono 700",
    "Locdoc Hebrew Sans 400",
    "Locdoc Hebrew Sans 500",
    "Locdoc Hebrew Sans 600",
    "Locdoc Hebrew Sans 700",
    "Locdoc Hebrew Serif 400",
    "Locdoc Hebrew Serif 600",
    "Locdoc Hebrew Serif 700",
    "Locdoc Hebrew Typewriter 400",
    "Locdoc Hebrew Typewriter 700",
  ]);
  for (const face of hebrew) {
    const range = /unicode-range:\s*([^;}]+)/
      .exec(face)?.[1]
      .replace(/\s/g, "");
    assert.equal(
      range?.toUpperCase(),
      "U+590-5FF,U+20AA,U+FB1D-FB4F",
      "Latin and Cyrillic text never reaches a Hebrew face",
    );
    const url = /url\(([^)]+)\)/.exec(face)![1].replace(/["']/g, "");
    assert.match(url, /^\/assets\/.+\.woff2$/);
    assert.ok(existsSync(join(web!, url)), `${url} is part of the build`);
  }
  // The Latin faces are loaded exactly as before: no Hebrew partner face
  // claims their family names.
  for (const family of ["JetBrains Mono", "IBM Plex Sans", "Courier Prime"])
    assert.ok(
      faces.some(
        (face) => face.includes(family) && !face.includes("Locdoc Hebrew"),
      ),
      family,
    );
});
