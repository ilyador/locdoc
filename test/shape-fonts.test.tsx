import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { documentFontFamily } from "../src/appearance";

const source = (file: string) =>
  readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
// A progress meter's circles: ◉ done, ○ not done, and the ● older documents
// use for done.
const meter = [0x25c9, 0x25cb, 0x25cf];

function inRange(range: string, codePoint: number) {
  return range.split(",").some((part) => {
    const [first, last = first] = part.trim().replace(/^U\+/i, "").split("-");
    return parseInt(first, 16) <= codePoint && codePoint <= parseInt(last, 16);
  });
}

// Looks up the glyph a WOFF2 font draws for a character, in its Unicode
// cmap; 0 means the font has none.
function woff2Glyphs(file: Buffer) {
  assert.equal(file.toString("latin1", 0, 4), "wOF2");
  let offset = 48;
  const base128 = () => {
    let value = 0;
    for (;;) {
      const byte = file[offset++];
      value = value * 128 + (byte & 0x7f);
      if (byte < 0x80) return value;
    }
  };
  // Tables follow each other in the decompressed stream, each as long as its
  // transformed length when it has one (glyf and loca by default).
  const tables: { tag: number; length: number }[] = [];
  for (let count = file.readUInt16BE(12); count > 0; count--) {
    const flags = file[offset++];
    const tag = flags & 0x3f;
    if (tag === 63) offset += 4;
    const version = flags >> 6;
    const length = base128();
    const transformed =
      tag === 10 || tag === 11 ? version !== 3 : version !== 0;
    tables.push({ tag, length: transformed ? base128() : length });
  }
  const data = brotliDecompressSync(
    file.subarray(offset, offset + file.readUInt32BE(20)),
  );
  let start = 0;
  let cmap = Buffer.alloc(0);
  for (const table of tables) {
    if (table.tag === 0) cmap = data.subarray(start, start + table.length);
    start += table.length;
  }
  let subtable = -1;
  for (let index = 0; index < cmap.readUInt16BE(2); index++) {
    const record = 4 + index * 8;
    if (cmap.readUInt16BE(record) === 3 && cmap.readUInt16BE(record + 2) === 1)
      subtable = cmap.readUInt32BE(record + 4);
  }
  assert.ok(subtable >= 0, "the font has a Unicode cmap");
  assert.equal(cmap.readUInt16BE(subtable), 4, "a segment-mapped cmap");
  const segments = cmap.readUInt16BE(subtable + 6) / 2;
  const ends = subtable + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const offsets = deltas + segments * 2;
  return (codePoint: number) => {
    for (let index = 0; index < segments; index++) {
      if (cmap.readUInt16BE(ends + index * 2) < codePoint) continue;
      const first = cmap.readUInt16BE(starts + index * 2);
      if (first > codePoint) return 0;
      const delta = cmap.readUInt16BE(deltas + index * 2);
      const rangeOffset = cmap.readUInt16BE(offsets + index * 2);
      if (!rangeOffset) return (codePoint + delta) & 0xffff;
      const glyph = cmap.readUInt16BE(
        offsets + index * 2 + rangeOffset + (codePoint - first) * 2,
      );
      return glyph && (glyph + delta) & 0xffff;
    }
    return 0;
  };
}

test("one face draws only geometric shapes, and its file has every meter circle", () => {
  const css = source("shape-fonts.css");
  const faces = css.match(/@font-face\s*\{[^}]*\}/g) || [];
  assert.equal(faces.length, 1, "a single shapes face");
  const face = faces[0];
  assert.match(face, /font-family:\s*"Locdoc Shapes";/);
  assert.match(face, /font-display:\s*swap;/);
  // Every weight uses this face as it is, so circles stay thin in bold text.
  assert.match(face, /font-weight:\s*100 900;/);
  assert.match(face, /size-adjust:\s*\d+(\.\d+)?%;/);
  const range = /unicode-range:\s*([^;]+);/.exec(face)![1];
  assert.equal(range.replace(/\s/g, "").toUpperCase(), "U+25A0-25FF");
  for (const codePoint of meter)
    assert.ok(
      inRange(range, codePoint),
      `U+${codePoint.toString(16)} is drawn`,
    );
  // Spaces, Latin, Cyrillic, Hebrew, bullets and dashes keep their own faces.
  for (const codePoint of [0x20, 0x41, 0x6f, 0x430, 0x5d0, 0x2022, 0x2014])
    assert.ok(
      !inRange(range, codePoint),
      `U+${codePoint.toString(16)} keeps its family's face`,
    );

  const url = /url\("([^"]+)"\)/.exec(face)![1];
  assert.match(url, /^@fontsource\/noto-sans-math\/files\/.+\.woff2$/);
  const glyph = woff2Glyphs(
    readFileSync(createRequire(import.meta.url).resolve(url)),
  );
  for (const codePoint of meter)
    assert.ok(
      glyph(codePoint) > 0,
      `the face draws U+${codePoint.toString(16)}`,
    );
  for (let codePoint = 0x25a0; codePoint <= 0x25ff; codePoint++)
    assert.ok(
      glyph(codePoint) > 0,
      `U+${codePoint.toString(16)} is in the face`,
    );

  assert.match(source("main.tsx"), /^import "\.\/shape-fonts\.css";$/m);
});

test("every document, interface and code stack starts with the shapes face", () => {
  const families = [
    ["JetBrains Mono", ""],
    ["Courier Prime", ""],
    ["IBM Plex Sans", ""],
    ["DM Sans", ""],
    ["Lora", ""],
    ["Georgia", ""],
    ["monospace", ""],
    // Families installed from Google Fonts, including ones that draw some
    // shapes themselves: the meter still comes from one face.
    ["Roboto", "Sans Serif"],
    ["Space Mono", "Monospace"],
    ["Merriweather", "Serif"],
    ["Caveat", "Handwriting"],
    ["Bungee", "Display"],
    ["Not In Catalog", ""],
  ];
  for (const [font, category] of families) {
    const stack = documentFontFamily(font, category);
    assert.ok(stack.startsWith('"Locdoc Shapes", '), font);
    assert.equal(stack.split('"Locdoc Shapes"').length, 2, `${font} once`);
  }
  // Every stylesheet stack with a Hebrew partner leads with the shapes face.
  const declarations = source("style.css")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/[;{}]/)
    .filter((declaration) => declaration.includes('"Locdoc Hebrew'));
  assert.ok(
    declarations.length >= 3,
    "interface, reading and code; versions inherit the selected document font",
  );
  for (const declaration of declarations)
    assert.match(
      declaration,
      /^\s*(--[\w-]+:|font:\s*[\d.]+rem\/[\d.]+)\s*"Locdoc Shapes",/,
      declaration.trim().split("\n")[0],
    );
});

test("the built shapes face keeps its range and its file is served", () => {
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
  const faces = (css.match(/@font-face\{[^}]*\}/g) || []).filter((face) =>
    face.includes("Locdoc Shapes"),
  );
  assert.equal(faces.length, 1, "the build keeps one shapes face");
  const range = /unicode-range:\s*([^;}]+)/.exec(faces[0])![1];
  assert.equal(range.replace(/\s/g, "").toUpperCase(), "U+25A0-25FF");
  assert.match(faces[0], /size-adjust:\s*\d+(\.\d+)?%/);
  const url = /url\(([^)]+)\)/.exec(faces[0])![1].replace(/["']/g, "");
  assert.match(url, /^\/assets\/.+\.woff2$/);
  assert.ok(existsSync(join(web!, url)), `${url} is part of the build`);
});
