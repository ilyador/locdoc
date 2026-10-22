import { useLayoutEffect, useRef } from "react";
import { ArrowUpRight, FileText, GlobeSimple } from "@phosphor-icons/react";
import type { LinkTarget } from "./editor-types";
import { useRemote } from "./use-remote";

type Preview = {
  kind: "document" | "web";
  title: string;
  description: string;
  site: string;
  url: string;
  id?: string;
  owner?: boolean;
};
export function LinkPreview({
  target,
  source,
  token,
  onClose,
  onDocument,
}: {
  target: LinkTarget;
  source: string;
  token?: string;
  onClose: () => void;
  onDocument: (id: string) => void;
}) {
  const card = useRef<HTMLDivElement>(null);
  const query = new URLSearchParams({
    url: target.url,
    ...(token ? { token } : {}),
  });
  const result = useRemote<Preview>(
    `/api/docs/${source}/link-preview?${query}`,
  );
  useLayoutEffect(() => {
    const element = card.current;
    if (!element) return;
    element.showPopover?.();
    const close = (e: Event) => {
      if (
        e.target instanceof Node &&
        !element.contains(e.target) &&
        !(e.target instanceof Element && e.target.closest("a[data-link-url]"))
      )
        onClose();
    };
    const scroll = (e: Event) => {
      if (
        e.target instanceof Element &&
        e.target.classList.contains("writing-pane")
      )
        onClose();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("scroll", scroll, true);
    };
  }, [onClose]);
  const data = result.data;
  const width = Math.min(340, window.innerWidth - 32);
  const left = Math.max(
    16,
    Math.min(target.rect.left, window.innerWidth - width - 16),
  );
  const top = Math.max(
    12,
    Math.min(target.rect.bottom + 8, window.innerHeight - 210),
  );
  return (
    <div
      ref={card}
      popover="manual"
      className="link-preview"
      role="dialog"
      aria-label="Link preview"
      style={{ left, top, width }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="link-preview-site">
        {data?.kind === "document" ? (
          <FileText size={15} />
        ) : (
          <GlobeSimple size={15} />
        )}
        <span>{data?.site || new URL(target.url).hostname}</span>
      </div>
      <a
        className="link-preview-title"
        href={data?.url || target.url}
        target={data?.kind === "document" ? undefined : "_blank"}
        rel="noopener noreferrer"
        onClick={(e) => {
          if (data?.kind === "document" && data.owner && data.id) {
            e.preventDefault();
            onDocument(data.id);
            onClose();
          }
        }}
      >
        <span dir="auto">{data?.title || target.label || target.url}</span>
        <ArrowUpRight size={17} />
      </a>
      {result.loading ? (
        <p className="link-preview-description" role="status">
          Loading preview…
        </p>
      ) : data?.description ? (
        <p className="link-preview-description" dir="auto">
          {data.description}
        </p>
      ) : result.error ? (
        <p className="link-preview-description">
          Preview unavailable. Open the link above.
        </p>
      ) : null}
    </div>
  );
}
