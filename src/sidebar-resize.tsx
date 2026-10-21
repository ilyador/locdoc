import { useLayoutEffect, useRef, useState } from "react";

export const SIDEBAR_MIN = 220;
export const SIDEBAR_MAX = 600;
const maximumWidth = () => Math.min(SIDEBAR_MAX, window.innerWidth - 360);
const constrain = (width: number) =>
  Math.max(SIDEBAR_MIN, Math.min(maximumWidth(), Math.round(width)));

export function SidebarResize({
  onResize,
}: {
  onResize: (width: number | null) => void;
}) {
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    x: number;
    width: number;
    previous: string;
    latest: number;
    pointer: number;
  } | null>(null);
  const [width, setWidth] = useState(SIDEBAR_MIN);
  const [maximum, setMaximum] = useState(SIDEBAR_MAX);
  useLayoutEffect(() => {
    const sidebar = handle.current!.parentElement!;
    const measure = () => {
      setWidth(Math.round(sidebar.getBoundingClientRect().width));
      setMaximum(Math.max(SIDEBAR_MIN, maximumWidth()));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(sidebar);
    return () => {
      observer.disconnect();
      sidebar.parentElement?.classList.remove("sidebar-resizing");
    };
  }, []);
  const finish = (commit: boolean) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    const app = handle.current!.parentElement!.parentElement!;
    app.classList.remove("sidebar-resizing");
    if (commit) onResize(current.latest);
    else if (current.previous)
      app.style.setProperty("--sidebar-custom-width", current.previous);
    else app.style.removeProperty("--sidebar-custom-width");
  };
  return (
    <div
      ref={handle}
      className="sidebar-resize"
      role="separator"
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      aria-controls="workspace-sidebar"
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={maximum}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize sidebar. Double-click to reset."
      onPointerDown={(event) => {
        if (event.button !== 0 || event.isPrimary === false) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        const app = event.currentTarget.parentElement!.parentElement!;
        const width =
          event.currentTarget.parentElement!.getBoundingClientRect().width;
        drag.current = {
          x: event.clientX,
          width,
          latest: width,
          pointer: event.pointerId,
          previous: app.style.getPropertyValue("--sidebar-custom-width"),
        };
        app.classList.add("sidebar-resizing");
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!drag.current || drag.current.pointer !== event.pointerId) return;
        drag.current.latest = constrain(
          drag.current.width + event.clientX - drag.current.x,
        );
        event.currentTarget.parentElement!.parentElement!.style.setProperty(
          "--sidebar-custom-width",
          `${drag.current.latest}px`,
        );
      }}
      onPointerUp={(event) => {
        if (!drag.current || drag.current.pointer !== event.pointerId) return;
        finish(true);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => finish(false)}
      onLostPointerCapture={() => finish(false)}
      onDoubleClick={() => {
        handle.current!.parentElement!.parentElement!.style.removeProperty(
          "--sidebar-custom-width",
        );
        onResize(null);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          if (drag.current) {
            event.preventDefault();
            finish(false);
          }
          return;
        }
        const next =
          event.key === "ArrowLeft"
            ? width - (event.shiftKey ? 50 : 10)
            : event.key === "ArrowRight"
              ? width + (event.shiftKey ? 50 : 10)
              : event.key === "Home"
                ? SIDEBAR_MIN
                : event.key === "End"
                  ? maximum
                  : null;
        if (next === null) return;
        event.preventDefault();
        onResize(constrain(next));
      }}
    />
  );
}
