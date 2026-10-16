import type { Entry } from "./model";

export function recentDocuments(entries: Entry[]) {
  return entries
    .filter((entry) => entry.kind === "file")
    .sort(
      (a, b) =>
        (b.modified || 0) - (a.modified || 0) || a.path.localeCompare(b.path),
    );
}

export function sidebarTimestamp(modified?: number, now = new Date()) {
  if (!modified || !Number.isFinite(modified) || modified <= 0) return null;
  const date = new Date(modified * 1000);
  if (!Number.isFinite(+date)) return null;
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
            : date.toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                ...(date.getFullYear() !== now.getFullYear()
                  ? { year: "numeric" }
                  : {}),
              });
  return { label, dateTime: date.toISOString(), title: date.toLocaleString() };
}
