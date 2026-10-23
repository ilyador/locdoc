import { test } from "node:test";
import assert from "node:assert/strict";
import {
  headerTimestamp,
  sidebarTimestamp,
  sidebarTimestampChange,
} from "../src/recent-documents.ts";

const MINUTE = 60_000,
  HOUR = 60 * MINUTE,
  DAY = 24 * HOUR;

test("a sidebar timestamp's next change is the moment its label moves to the next count or unit", () => {
  const now = new Date(2026, 9, 23, 12);
  // The label now, just before its next change, and at it.
  const labels = (modified) => {
    const next = sidebarTimestampChange(modified, +now);
    assert.ok(next > +now, "the change is ahead");
    return [now, new Date(next - 1), new Date(next)].map(
      (time) => sidebarTimestamp(modified, time).label,
    );
  };
  const age = (before) => (+now - before) / 1000;
  const at = (...date) => +new Date(...date) / 1000;
  assert.deepEqual(labels(age(30_000)), ["now", "now", "1m"]);
  assert.deepEqual(labels(age(59 * MINUTE)), ["59m", "59m", "1h"]);
  assert.deepEqual(labels(age(23 * HOUR)), ["23h", "23h", "1d"]);
  assert.deepEqual(labels(age(13 * DAY)), ["13d", "13d", "2w"]);
  assert.deepEqual(labels(age(15 * DAY)), ["2w", "2w", "3w"]);
  assert.deepEqual(labels(age(62 * DAY)), ["8w", "8w", "2mo"]);
  assert.deepEqual(labels(at(2026, 7, 1, 12)), ["2mo", "2mo", "3mo"]);
  assert.deepEqual(labels(at(2024, 9, 24, 12)), ["23mo", "23mo", "2y"]);
  assert.deepEqual(labels(at(2024, 9, 23, 12)), ["2y", "2y", "3y"]);
  // A month that lacks the day runs on into the next, as Date counts it.
  assert.equal(
    sidebarTimestampChange(at(2026, 0, 31, 9), +new Date(2026, 3, 30)),
    +new Date(2026, 4, 1, 9),
  );
  assert.equal(sidebarTimestampChange(undefined, +now), null);
  assert.equal(sidebarTimestampChange(NaN, +now), null);
});

test("the document header's time is the full local date and time to the minute", () => {
  const saved = new Date(2026, 9, 23, 15, 42, 37);
  const stamp = headerTimestamp(+saved / 1000);
  assert.equal(
    stamp.label,
    saved.toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }),
  );
  assert.match(stamp.label, /2026/, "with the year");
  assert.equal(stamp.dateTime, saved.toISOString());
  // The same written time the sidebar gives that modification.
  assert.equal(stamp.dateTime, sidebarTimestamp(+saved / 1000).dateTime);
  assert.equal(headerTimestamp(undefined), null);
  assert.equal(headerTimestamp(0), null);
  assert.equal(headerTimestamp(NaN), null);
});
