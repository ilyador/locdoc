import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { ArrowLeft, CalendarBlank, Check } from "@phosphor-icons/react";
import { api, send } from "./api";
import { useRemote } from "./use-remote";
import { IconButton } from "./ui";
import { HistoryPreview } from "./history-preview";

type Version = { id: string; created: number; bytes: number };
type Preview = {
  content: string;
  previous?: { id: string; created: number; content: string } | null;
};
const day = new Intl.DateTimeFormat(undefined, { dateStyle: "long" });
const time = new Intl.DateTimeFormat(undefined, { timeStyle: "medium" });
const timestamp = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});

export function VersionHistory({
  endpoint,
  onRestore,
  onClose,
  path,
  documentId,
  token,
  covered = false,
  style,
}: {
  endpoint: (suffix: string) => string;
  onRestore: () => void;
  onClose: () => void;
  path: string;
  documentId: string;
  token?: string;
  covered?: boolean;
  style?: CSSProperties;
}) {
  const versions = useRemote<{ versions: Version[] }>(endpoint("/versions"));
  const [id, setId] = useState("");
  const selected =
    versions.data?.versions.find((v) => v.id === id) ||
    versions.data?.versions[0];
  const preview = useRemote<Preview>(
    selected ? endpoint(`/versions/${selected.id}`) : null,
  );
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState("");
  const [changes, setChanges] = useState(true);
  const [datesOpen, setDatesOpen] = useState(false);
  const back = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    // Let the document-options dialog finish closing before taking focus.
    const frame = requestAnimationFrame(() =>
      back.current?.focus({ preventScroll: true }),
    );
    return () => {
      alive.current = false;
      cancelAnimationFrame(frame);
    };
  }, []);
  const groups = useMemo(() => {
    const groups: { label: string; versions: Version[] }[] = [];
    for (const version of versions.data?.versions || []) {
      const label = day.format(version.created * 1000);
      const group = groups.at(-1);
      if (group?.label === label) group.versions.push(version);
      else groups.push({ label, versions: [version] });
    }
    return groups;
  }, [versions.data]);
  const choose = (version: Version) => {
    if (restoring) return;
    setId(version.id);
    setError("");
  };
  const restore = async () => {
    if (restoring || !selected || !preview.data || preview.loading) return;
    setRestoring(true);
    setError("");
    try {
      await api(endpoint(`/versions/${selected.id}/restore`), send("POST"));
      if (alive.current) onRestore();
    } catch (error) {
      if (alive.current) setError((error as Error).message);
    } finally {
      if (alive.current) setRestoring(false);
    }
  };
  const previous = preview.data?.previous;
  return (
    <section
      className="version-history"
      style={style}
      aria-label="Version history"
      inert={covered}
      data-dates-open={datesOpen || undefined}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          if (!restoring) onClose();
        }
      }}
    >
      <header className="history-topbar">
        <IconButton
          ref={back}
          label="Back to document"
          aria-disabled={restoring}
          onClick={() => {
            if (!restoring) onClose();
          }}
        >
          <ArrowLeft size={20} />
        </IconButton>
        <h1>Version history</h1>
        <IconButton
          className="history-dates-toggle"
          label="Choose version date"
          aria-expanded={datesOpen}
          aria-controls="history-dates"
          onClick={() => setDatesOpen((value) => !value)}
        >
          <CalendarBlank size={20} />
        </IconButton>
        <button
          className="button primary"
          aria-label="Restore this version"
          aria-disabled={restoring || preview.loading || !preview.data}
          onClick={() => void restore()}
        >
          {restoring ? "Restoring…" : "Restore"}
        </button>
      </header>
      <div className="history-body">
        <section
          className="history-document"
          aria-label="Version preview"
          aria-busy={preview.loading}
        >
          <div className="history-preview-heading">
            <div>
              <h2>
                {selected
                  ? timestamp.format(selected.created * 1000)
                  : "Saved versions"}
              </h2>
              <p>
                {preview.data
                  ? previous
                    ? `Compared with ${timestamp.format(previous.created * 1000)}`
                    : "Earliest saved version"
                  : "Select a saved date to preview it."}
              </p>
            </div>
            {previous && (
              <label className="history-changes-toggle">
                <input
                  type="checkbox"
                  checked={changes}
                  onChange={(e) => setChanges(e.target.checked)}
                />
                Show changes
              </label>
            )}
          </div>
          {(versions.error || preview.error || error) && (
            <p className="history-error" role="alert">
              {versions.error || preview.error || error}
            </p>
          )}
          {previous && changes && (
            <p className="history-legend">
              <ins>Added</ins>
              <del>Removed</del>
            </p>
          )}
          <div className="history-preview-scroll writing-pane">
            {preview.loading ? (
              <p className="history-message" role="status">
                Loading version…
              </p>
            ) : preview.data ? (
              <HistoryPreview
                content={preview.data.content}
                original={changes && previous ? previous.content : null}
                path={path}
                documentId={documentId}
                token={token}
              />
            ) : (
              <p className="history-message" role="status">
                {versions.loading
                  ? "Loading versions…"
                  : versions.data?.versions.length === 0
                    ? "Saved versions will appear here as you edit."
                    : "Choose a version to read it."}
              </p>
            )}
          </div>
        </section>
        <aside
          className="history-sidebar"
          id="history-dates"
          aria-label="Saved dates"
        >
          <nav
            aria-label="Saved versions"
            onKeyDown={(e) => {
              const list = versions.data?.versions || [];
              const index = list.findIndex((v) => v.id === selected?.id);
              const next =
                e.key === "ArrowDown"
                  ? Math.min(index + 1, list.length - 1)
                  : e.key === "ArrowUp"
                    ? Math.max(index - 1, 0)
                    : e.key === "Home"
                      ? 0
                      : e.key === "End"
                        ? list.length - 1
                        : -1;
              if (next < 0 || restoring) return;
              e.preventDefault();
              choose(list[next]);
              e.currentTarget
                .querySelectorAll<HTMLButtonElement>(".history-version")
                [next]?.focus();
            }}
          >
            {groups.map((group) => (
              <section key={group.versions[0].id} className="history-day">
                <h2>{group.label}</h2>
                {group.versions.map((v) => (
                  <button
                    key={v.id}
                    className="history-version"
                    data-version-id={v.id}
                    tabIndex={selected?.id === v.id ? 0 : -1}
                    aria-label={`Saved version ${timestamp.format(v.created * 1000)}`}
                    aria-current={selected?.id === v.id ? "true" : undefined}
                    aria-disabled={restoring}
                    onClick={() => choose(v)}
                  >
                    <time dateTime={new Date(v.created * 1000).toISOString()}>
                      {time.format(v.created * 1000)}
                    </time>
                    {selected?.id === v.id && (
                      <Check size={16} aria-hidden="true" />
                    )}
                  </button>
                ))}
              </section>
            ))}
          </nav>
          <p className="history-retention">
            Up to 50 automatic snapshots and 20 recovery versions.
          </p>
        </aside>
      </div>
    </section>
  );
}
