import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { commentParser } from "../src/comment-syntax.ts";
import {
  decodeMarkdownText,
  isLocalMediaPath,
  previewedImage,
  wholeLineImage,
} from "../src/markdown-media.ts";
import {
  documentExtension,
  documentFormat,
  documentName,
  documentPath,
  isDocumentPath,
} from "../src/document-format.ts";
import { resolveDocumentLink } from "../src/document-links.ts";

const fixtures = JSON.parse(
  readFileSync(
    new URL("./fixtures/media-references.json", import.meta.url),
    "utf8",
  ),
);

// The images the editor previews, in document order, by its own rule.
function previewedImages(source) {
  const images = [];
  commentParser.parse(source).iterate({
    enter(node) {
      if (node.name === "LocdocComment") return false;
      if (node.name !== "Image") return;
      const image = previewedImage(
        (from, to) => source.slice(from, to),
        node.node,
      );
      if (image) images.push(image);
    },
  });
  return images;
}

test("the editor previews exactly the fixture images, with the server's destination", () => {
  for (const fixture of fixtures) {
    // Bounded scalar rows in both directions: nothing previewed is missing
    // from the fixture and nothing in it goes unpreviewed.
    const previewed = previewedImages(fixture.source).map((image) => {
      const start = fixture.source.lastIndexOf("\n", image.from) + 1;
      const end = fixture.source.indexOf("\n", image.to);
      const line = fixture.source.slice(start, end < 0 ? undefined : end);
      return {
        path: image.path,
        alt: image.alt,
        title: image.title,
        block: wholeLineImage(line)?.path === image.path,
      };
    });
    assert.deepEqual(previewed, fixture.rendered, `${fixture.name}: previewed`);
    for (const { path } of previewed)
      assert.ok(
        fixture.references.includes(path),
        `${fixture.name}: the server serves ${path}`,
      );
  }
});

test("the server and the editor agree on which references are local files", () => {
  for (const fixture of fixtures)
    assert.deepEqual(
      fixture.references.filter(isLocalMediaPath),
      fixture.local,
      `${fixture.name}: local references`,
    );
});

test("media destinations decode like CommonMark and stay local", () => {
  assert.equal(decodeMarkdownText("a\\_b\\]c"), "a_b]c");
  assert.equal(
    decodeMarkdownText("x &amp; y &lt;z&gt; &#65;&#x42;"),
    "x & y <z> AB",
  );
  assert.equal(
    decodeMarkdownText("keep \\q and &unknown;"),
    "keep \\q and &unknown;",
  );
  assert.equal(decodeMarkdownText("&#0; &#xD800;"), "� �");
  for (const path of ["pic.png", "../shared/pic.png", "my%20pic.png"])
    assert.equal(isLocalMediaPath(path), true, path);
  for (const path of [
    "",
    "/pic.png",
    "//cdn/pic.png",
    "https://x/pic.png",
    "data:,x",
    "vbscript:x",
    "#top",
  ])
    assert.equal(isLocalMediaPath(path), false, path);
});

test("plain-text documents are a format with their own extension and links", () => {
  assert.equal(documentFormat("Notes/plan.txt"), "text");
  assert.equal(documentFormat("Notes/plan.md"), "markdown");
  assert.equal(documentFormat("Notes/plan.fountain"), "fountain");
  assert.equal(documentName("Notes/plan.TXT"), "plan");
  assert.equal(documentExtension("Notes/plan.TXT"), ".txt");
  assert.equal(documentPath("Notes/plan", "text"), "Notes/plan.txt");
  assert.equal(isDocumentPath("plan.txt"), true);
  assert.equal(isDocumentPath("plan.text"), false);
  const entries = [
    {
      id: "p",
      path: "Notes/plan.txt",
      kind: "file",
      shared: false,
      url: "/d/p",
    },
  ];
  assert.equal(
    resolveDocumentLink("plan.txt", "Notes/Index.md", entries),
    "/d/p",
  );
  assert.equal(
    resolveDocumentLink("plan.text", "Notes/Index.md", entries),
    null,
  );
});
