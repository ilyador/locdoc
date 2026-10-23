import type { Entry } from "./model";

// Making a collator or a date format costs far more than using one, and the
// sidebar uses them for every row it lists. These are made once, with the
// same locale and options as the String and Date methods they stand for.
let shared:
  | {
      // As a.localeCompare(b).
      order: Intl.Collator;
      // As a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }).
      names: Intl.Collator;
      // As toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }).
      minute: Intl.DateTimeFormat;
      // As toLocaleString().
      full: Intl.DateTimeFormat;
    }
  | undefined;
const formats = () =>
  (shared ??= {
    order: new Intl.Collator(),
    names: new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }),
    minute: new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }),
    full: new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    }),
  });

// The order a.path.localeCompare(b.path) gives.
export const comparePaths = (a: string, b: string) =>
  formats().order.compare(a, b);
// Names as people read them: numbers by value, case and accents aside.
export const compareNames = (a: string, b: string) =>
  formats().names.compare(a, b);

export function recentDocuments(entries: Entry[]) {
  return entries
    .filter((entry) => entry.kind === "file")
    .sort(
      (a, b) =>
        (b.modified || 0) - (a.modified || 0) || comparePaths(a.path, b.path),
    );
}

// The written forms of each time the sidebar and the document header show,
// which never change. A listing shows the same times each time it renders.
type Written = {
  date: Date;
  dateTime: string;
  title: string;
  minute?: string;
};
const written = new Map<number, Written | null>();
function writtenTime(modified: number) {
  let value = written.get(modified);
  if (value === undefined) {
    if (written.size >= 10_000) written.clear();
    const date = new Date(modified * 1000);
    value = Number.isFinite(+date)
      ? {
          date,
          dateTime: date.toISOString(),
          title: formats().full.format(date),
        }
      : null;
    written.set(modified, value);
  }
  return value;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
type Unit = "minute" | "hour" | "day" | "week" | "month" | "year";
const SHORT: Record<Unit, string> = {
  minute: "m",
  hour: "h",
  day: "d",
  week: "w",
  month: "mo",
  year: "y",
};
// The time a number of calendar months after `date`, counted as Date counts
// them: a day the month lacks runs on into the next.
const addMonths = (date: Date, months: number) =>
  new Date(
    date.getFullYear(),
    date.getMonth() + months,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  );
// The age of the time `at` at `now`, both in milliseconds since the epoch, in
// whole units rounded down, and when that count next changes. Under a minute
// it is now. Each longer unit takes over once it can count two: days run to
// 13, weeks to 8 and months to 23, so no age reads 1w, 1mo or 1y.
function ageAt(
  at: number,
  now: number,
): { unit: Unit | null; count: number; next: number } {
  const elapsed = Math.max(0, now - at);
  const counted = (unit: Unit, length: number) => {
    const count = Math.floor(elapsed / length);
    return { unit, count, next: at + (count + 1) * length };
  };
  if (elapsed < MINUTE) return { unit: null, count: 0, next: at + MINUTE };
  if (elapsed < HOUR) return counted("minute", MINUTE);
  if (elapsed < DAY) return counted("hour", HOUR);
  if (elapsed < 14 * DAY) return counted("day", DAY);
  if (elapsed < 9 * WEEK) return counted("week", WEEK);
  // Months are calendar months. Two of them never span more than 62 days, so
  // nine weeks always hold at least two.
  const from = new Date(at);
  const today = new Date(now);
  let months =
    (today.getFullYear() - from.getFullYear()) * 12 +
    today.getMonth() -
    from.getMonth();
  while (months > 2 && +addMonths(from, months) > now) months--;
  if (months < 24)
    return { unit: "month", count: months, next: +addMonths(from, months + 1) };
  const years = Math.floor(months / 12);
  return {
    unit: "year",
    count: years,
    next: +addMonths(from, (years + 1) * 12),
  };
}

// A document's age as each sidebar row shows it: now, 5m, 3h, 4d, 3w, 2mo or
// 5y, the same age in words for screen readers, and the exact time on hover.
export function sidebarTimestamp(modified?: number, now = new Date()) {
  if (!modified || !Number.isFinite(modified) || modified <= 0) return null;
  const time = writtenTime(modified);
  if (!time) return null;
  const { unit, count } = ageAt(+time.date, +now);
  return {
    label: unit ? `${count}${SHORT[unit]}` : "now",
    phrase: unit ? `${count} ${unit}${count === 1 ? "" : "s"} ago` : "just now",
    dateTime: time.dateTime,
    title: time.title,
  };
}

// When the label sidebarTimestamp gives a time changes next, in milliseconds
// since the epoch, or null for a time it gives no label.
export function sidebarTimestampChange(modified?: number, now = Date.now()) {
  if (!modified || !Number.isFinite(modified) || modified <= 0) return null;
  const at = modified * 1000;
  if (!Number.isFinite(+new Date(at))) return null;
  return ageAt(at, now).next;
}

// When a document was last modified, in full to the minute, as its header
// shows it: "23 Oct 2026, 15:42" in British English.
export function headerTimestamp(modified?: number) {
  if (!modified || !Number.isFinite(modified) || modified <= 0) return null;
  const time = writtenTime(modified);
  if (!time) return null;
  return {
    label: (time.minute ??= formats().minute.format(time.date)),
    dateTime: time.dateTime,
  };
}
