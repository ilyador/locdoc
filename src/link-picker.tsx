import { useLayoutEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  FileText,
  LinkSimple,
  LockSimple,
} from "@phosphor-icons/react";
import type { Entry } from "./model";
import { documentTitle, webLink } from "./document-links";
import { PathText } from "./ui";

export function LinkPicker({
  entries,
  onInsert,
  selection,
}: {
  entries: Entry[];
  onInsert: (url: string, title: string) => void;
  selection: string;
}) {
  const [query, setQuery] = useState("");
  const url = webLink(query);
  const matches = entries
    .filter(
      (e) =>
        e.kind === "file" &&
        e.url &&
        `${documentTitle(e)} ${e.path}`
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase()),
    )
    .slice(0, 20);
  const [active, setActive] = useState(0);
  const count = url ? 1 : matches.length;
  const results = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const list = results.current;
    const item = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !item) return;
    const bounds = list.getBoundingClientRect(),
      selected = item.getBoundingClientRect();
    if (selected.top < bounds.top) list.scrollTop += selected.top - bounds.top;
    else if (selected.bottom > bounds.bottom)
      list.scrollTop += selected.bottom - bounds.bottom;
  }, [active, query, count]);
  const insert = (index: number) => {
    if (url) onInsert(url, selection || new URL(url).hostname);
    else if (matches[index])
      onInsert(matches[index].url!, selection || documentTitle(matches[index]));
  };
  return (
    <form
      className="link-picker"
      onSubmit={(e) => {
        e.preventDefault();
        insert(Math.min(active, count - 1));
      }}
    >
      <label className="visually-hidden" htmlFor="link-search">
        Document title or URL
      </label>
      <input
        id="link-search"
        className="text-input"
        placeholder="Search documents or paste a URL…"
        dir="auto"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        autoFocus
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={count > 0}
        aria-controls="link-results"
        aria-activedescendant={
          count ? `link-result-${Math.min(active, count - 1)}` : undefined
        }
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setActive((value) =>
              count
                ? (value + (e.key === "ArrowDown" ? 1 : -1) + count) % count
                : 0,
            );
          }
        }}
      />
      <div
        ref={results}
        id="link-results"
        role="listbox"
        aria-label="Link destinations"
        className="link-results"
      >
        {url ? (
          <button
            type="button"
            id="link-result-0"
            role="option"
            aria-selected={true}
            onClick={() => insert(0)}
          >
            <LinkSimple size={18} />
            <span>
              <strong>{new URL(url).hostname}</strong>
              <small>{url}</small>
            </span>
            <ArrowUpRight size={15} />
          </button>
        ) : (
          matches.map((entry, index) => (
            <button
              type="button"
              key={entry.id}
              id={`link-result-${index}`}
              role="option"
              aria-selected={index === active}
              onClick={() => insert(index)}
            >
              <FileText size={18} />
              <span>
                <strong dir="auto">{documentTitle(entry)}</strong>
                <small>
                  <PathText path={entry.path} separator="/" />
                </small>
              </span>
              {!entry.shared && (
                <LockSimple size={13} aria-label="Private document" />
              )}
            </button>
          ))
        )}
      </div>
      {!count && (
        <p className="field-help">
          {query
            ? "No matching documents. You can also paste an HTTP or HTTPS URL."
            : "Paste a URL to link to a page or shared document."}
        </p>
      )}
    </form>
  );
}
