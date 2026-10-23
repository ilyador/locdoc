import { test } from "node:test";
import assert from "node:assert/strict";
import {
  webLink,
  markdownLink,
  resolveDocumentLink,
  sameLinkTargets,
} from "../src/document-links.ts";
import { recentDocuments, sidebarTimestamp } from "../src/recent-documents.ts";
import { markdownLanguage } from "@codemirror/lang-markdown";

test("link insertion preserves balanced URL parentheses and escapes labels", () => {
  const md = markdownLink(
    "A [draft] \\ note",
    "https://example.com/a_(b)?x=1&y=2",
  );
  const tree = markdownLanguage.parser.parse(md);
  assert.equal(tree.topNode.firstChild.firstChild.name, "Link");
  assert.equal(
    md.slice(
      tree.topNode.firstChild.firstChild.getChild("URL").from,
      tree.topNode.firstChild.firstChild.getChild("URL").to,
    ),
    "<https://example.com/a_(b)?x=1&y=2>",
  );
  assert.equal(webLink("javascript:alert(1)"), null);
  assert.equal(webLink("file:///etc/passwd"), null);
  assert.equal(webLink("https://user:secret@example.com"), null);
  assert.equal(webLink("www.example.com"), "https://www.example.com/");
});
test("relative document links resolve within actual workspace folders only", () => {
  const entries = [
    {
      kind: "file",
      path: "Ideas/Draft one.md",
      url: "https://locdoc.test/d/id",
    },
  ];
  assert.equal(
    resolveDocumentLink("../Ideas/Draft%20one.md", "Notes/current.md", entries),
    entries[0].url,
  );
  assert.equal(
    resolveDocumentLink(
      "../../Ideas/Draft%20one.md",
      "Notes/current.md",
      entries,
    ),
    null,
  );
  assert.equal(
    resolveDocumentLink("Missing.md", "Notes/current.md", entries),
    null,
  );
});
test("recent documents sort by modification without date groups", () => {
  const entries = [
    { kind: "file", id: "old", path: "Old.md", modified: 1 },
    { kind: "folder", id: null, path: "Folder", modified: 0 },
    { kind: "file", id: "new", path: "New.md", modified: 2 },
  ];
  assert.deepEqual(
    recentDocuments(entries).map((entry) => entry.id),
    ["new", "old"],
  );
});
test("sidebar timestamps use relative time, then a compact calendar date", () => {
  const now = new Date(2026, 9, 16, 12);
  const stamp = (seconds) =>
    sidebarTimestamp((+now - seconds * 1000) / 1000, now)?.label;
  assert.equal(stamp(5), "now");
  assert.equal(stamp(120), "2m ago");
  assert.equal(stamp(7200), "2h ago");
  assert.equal(stamp(86400 * 6), "6d ago");
  const old = new Date(2026, 7, 1, 12),
    previous = new Date(2025, 7, 1, 12);
  assert.equal(
    sidebarTimestamp(+old / 1000, now).label,
    old.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
  );
  assert.equal(
    sidebarTimestamp(+previous / 1000, now).label,
    previous.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    }),
  );
  assert.equal(sidebarTimestamp(undefined, now), null);
  assert.equal(sidebarTimestamp(NaN, now), null);
});
test("listings resolve document links alike while their files keep their paths and addresses", () => {
  const listing = [
    { kind: "folder", path: "Ideas", url: null, modified: 0 },
    {
      kind: "file",
      path: "Ideas/Draft.md",
      url: "https://l.test/d/a",
      modified: 1,
    },
    { kind: "file", path: "Plan.md", url: "https://l.test/d/b", modified: 2 },
  ];
  const saved = listing.map((entry) =>
    entry.path === "Plan.md" ? { ...entry, modified: 3 } : entry,
  );
  assert.equal(sameLinkTargets(listing, saved), true, "a newer time");
  assert.equal(
    sameLinkTargets(listing, [listing[1], listing[2]]),
    true,
    "folders hold no link targets",
  );
  const renamed = saved.map((entry) =>
    entry.path === "Plan.md" ? { ...entry, path: "Plans.md" } : entry,
  );
  assert.equal(sameLinkTargets(listing, renamed), false, "a renamed file");
  const shared = saved.map((entry) =>
    entry.path === "Plan.md"
      ? { ...entry, url: "https://l.test/s/token" }
      : entry,
  );
  assert.equal(sameLinkTargets(listing, shared), false, "a new address");
  assert.equal(
    sameLinkTargets(listing, listing.slice(0, 2)),
    false,
    "a removed file",
  );
  const added = [
    ...listing,
    { kind: "file", path: "New.md", url: "https://l.test/d/c" },
  ];
  assert.equal(sameLinkTargets(listing, added), false, "an added file");
  for (const [a, b] of [
    [listing, saved],
    [listing, renamed],
  ])
    assert.equal(
      sameLinkTargets(a, b),
      ["../Plan.md", "Draft.md"].every(
        (link) =>
          resolveDocumentLink(link, "Ideas/Note.md", a) ===
          resolveDocumentLink(link, "Ideas/Note.md", b),
      ),
      "the same targets resolve the same links",
    );
});
