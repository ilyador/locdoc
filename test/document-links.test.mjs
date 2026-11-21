import { test } from "node:test";
import assert from "node:assert/strict";
import {
  webLink,
  markdownLink,
  resolveDocumentLink,
  sameLinkTargets,
  pastedDocumentPath,
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
test("a pasted workspace path is written from the folder of the document it is pasted into", () => {
  const entries = [
    { kind: "folder", path: "Projects" },
    { kind: "file", path: "Projects/Plan.md", url: "/d/plan" },
    { kind: "file", path: "Projects/Life goals (2027).md", url: "/d/goals" },
    { kind: "file", path: "Inbox.md", url: "/d/inbox" },
    { kind: "file", path: "Notes/Deep/Today.md", url: "/d/today" },
    { kind: "file", path: "Notes/Deep/Projects/Plan.md", url: "/d/other" },
  ];
  const paste = (text, path, destination = false) =>
    pastedDocumentPath(text, path, entries, destination);
  // Each written path opens the document the pasted path names.
  const opens = (text, path) => {
    const written = paste(text, path, true) ?? text;
    return resolveDocumentLink(written, path, entries);
  };
  assert.equal(paste("Projects/Plan.md", "Notes/Deep/Today.md"), null,
    "a path that already names a document from there is kept");
  assert.equal(paste("Projects/Plan.md", "Notes/Today.md"), "../Projects/Plan.md");
  assert.equal(paste("Projects/Plan.md", "Projects/Other.md"), "Plan.md");
  assert.equal(paste("Inbox.md", "Notes/Deep/Today.md"), "../../Inbox.md");
  assert.equal(paste("Projects/Plan.md", "Top.md"), null,
    "a document at the top of the workspace keeps the workspace path");
  assert.equal(paste(" Inbox.md\n", "Notes/Today.md"), "../Inbox.md",
    "the copied path may come with surrounding white space");
  assert.equal(opens("Inbox.md", "Notes/Deep/Today.md"), "/d/inbox");
  assert.equal(opens("Projects/Plan.md", "Notes/Today.md"), "/d/plan");
  // In a link's destination, spaces and parentheses need angle brackets.
  assert.equal(
    paste("Projects/Life goals (2027).md", "Notes/Today.md", true),
    "<../Projects/Life goals (2027).md>",
  );
  assert.equal(
    paste("Projects/Life goals (2027).md", "Notes/Today.md"),
    "../Projects/Life goals (2027).md",
    "outside a link the path reads as it is",
  );
  assert.equal(
    opens("Projects/Life goals (2027).md", "Notes/Today.md"),
    "/d/goals",
  );
  assert.equal(
    paste("Projects/Life goals (2027).md", "Top.md", true),
    "<Projects/Life goals (2027).md>",
  );
  // Text that names no document pastes as it is.
  for (const text of ["Projects/Missing.md", "Projects", "plan", "https://example.com"])
    assert.equal(paste(text, "Notes/Today.md", true), null, text);
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
test("sidebar timestamps are compact ages in whole units at every age, with the exact time on hover", () => {
  const now = new Date(2026, 9, 23, 12);
  const MINUTE = 60_000,
    HOUR = 60 * MINUTE,
    DAY = 24 * HOUR;
  // A time this long before now, or at this local date and time.
  const age = (before) => sidebarTimestamp((+now - before) / 1000, now);
  const at = (...date) => sidebarTimestamp(+new Date(...date) / 1000, now);
  const shown = (stamp) => [stamp.label, stamp.phrase];
  // Each unit, from the first moment it counts to the last.
  assert.deepEqual(shown(age(0)), ["now", "just now"]);
  assert.deepEqual(shown(age(MINUTE - 1)), ["now", "just now"]);
  assert.deepEqual(shown(age(MINUTE)), ["1m", "1 minute ago"]);
  assert.deepEqual(shown(age(HOUR - 1)), ["59m", "59 minutes ago"]);
  assert.deepEqual(shown(age(HOUR)), ["1h", "1 hour ago"]);
  assert.deepEqual(shown(age(DAY - 1)), ["23h", "23 hours ago"]);
  assert.deepEqual(shown(age(DAY)), ["1d", "1 day ago"]);
  assert.deepEqual(shown(age(14 * DAY - 1)), ["13d", "13 days ago"]);
  assert.deepEqual(shown(age(14 * DAY)), ["2w", "2 weeks ago"]);
  assert.deepEqual(shown(age(63 * DAY - 1)), ["8w", "8 weeks ago"]);
  // Nine weeks always hold two calendar months.
  assert.deepEqual(shown(age(63 * DAY)), ["2mo", "2 months ago"]);
  assert.deepEqual(shown(at(2026, 7, 1, 12)), ["2mo", "2 months ago"]);
  assert.deepEqual(shown(at(2026, 6, 23, 12)), ["3mo", "3 months ago"]);
  assert.deepEqual(shown(at(2026, 6, 23, 12, 0, 1)), ["2mo", "2 months ago"]);
  assert.deepEqual(shown(at(2025, 9, 23, 12)), ["12mo", "12 months ago"]);
  assert.deepEqual(shown(at(2024, 9, 23, 12, 0, 1)), ["23mo", "23 months ago"]);
  assert.deepEqual(shown(at(2024, 9, 23, 12)), ["2y", "2 years ago"]);
  assert.deepEqual(shown(at(2023, 9, 24)), ["2y", "2 years ago"]);
  assert.deepEqual(shown(at(2016, 9, 23, 12)), ["10y", "10 years ago"]);
  // A file stamped ahead of this clock is new, not in the future.
  assert.deepEqual(shown(age(-5 * MINUTE)), ["now", "just now"]);
  // Hovering shows the exact local date and time.
  const exact = new Date(2026, 6, 23, 9, 5, 7);
  const stamp = sidebarTimestamp(+exact / 1000, now);
  assert.equal(stamp.title, exact.toLocaleString());
  assert.equal(stamp.dateTime, exact.toISOString());
  assert.equal(sidebarTimestamp(undefined, now), null);
  assert.equal(sidebarTimestamp(NaN, now), null);
  assert.equal(sidebarTimestamp(-1, now), null);
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
