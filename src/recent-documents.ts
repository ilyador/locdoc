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
      // As toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      // with and without the year.
      day: Intl.DateTimeFormat;
      year: Intl.DateTimeFormat;
      // As toLocaleString().
      full: Intl.DateTimeFormat;
    }
  | undefined;
const formats = () =>
  (shared ??= {
    order: new Intl.Collator(),
    names: new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }),
    day: new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }),
    year: new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
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

// The written forms of each time the sidebar shows, which never change. A
// listing shows the same times each time it renders.
type Written = {
  date: Date;
  dateTime: string;
  title: string;
  day?: string;
  year?: string;
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

export function sidebarTimestamp(modified?: number, now = new Date()) {
  if (!modified || !Number.isFinite(modified) || modified <= 0) return null;
  const time = writtenTime(modified);
  if (!time) return null;
  const { date } = time;
  const seconds = Math.max(0, (+now - +date) / 1000);
  const label =
    seconds < 60
      ? "now"
      : seconds < 3600
        ? `${Math.floor(seconds / 60)}m ago`
        : seconds < 86400
          ? `${Math.floor(seconds / 3600)}h ago`
          : seconds < 30 * 86400
            ? `${Math.floor(seconds / 86400)}d ago`
            : date.getFullYear() !== now.getFullYear()
              ? (time.year ??= formats().year.format(date))
              : (time.day ??= formats().day.format(date));
  return { label, dateTime: time.dateTime, title: time.title };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// When the label sidebarTimestamp gives a time changes next, in milliseconds
// since the epoch, or null when it stays as it is.
export function sidebarTimestampChange(modified?: number, now = Date.now()) {
  if (!modified || !Number.isFinite(modified) || modified <= 0) return null;
  const at = modified * 1000;
  if (!Number.isFinite(+new Date(at))) return null;
  const age = Math.max(0, now - at);
  const unit =
    age < HOUR ? MINUTE : age < DAY ? HOUR : age < 30 * DAY ? DAY : 0;
  if (unit) return at + (Math.floor(age / unit) + 1) * unit;
  // A date from this year gains its year once the year is over.
  const year = new Date(now).getFullYear();
  return new Date(at).getFullYear() === year ? +new Date(year + 1, 0, 1) : null;
}
