import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { CaretLeft, CaretRight, type Icon } from "@phosphor-icons/react";

export type MenuEntry =
  | {
      kind?: "item";
      label: string;
      icon?: Icon;
      // Shown text, and the aria-keyshortcuts value.
      shortcut?: string;
      keys?: string;
      disabled?: boolean;
      detail?: string;
      depth?: number;
      run?: () => void;
      // Opens a nested list in place, such as the folders for Move to.
      items?: () => MenuEntry[];
      title?: string;
    }
  | { kind: "separator" };
type Item = Exclude<MenuEntry, { kind: "separator" }>;
export type MenuPosition = {
  x: number;
  y: number;
  // A menu opened from a button aligns its right edge with the button.
  align?: "start" | "end";
};
type CloseReason = "escape" | "select" | "outside" | "tab";

const isItem = (entry: MenuEntry): entry is Item => entry.kind !== "separator";

// A native-feeling menu: arrow keys, Home and End move through items, a
// letter jumps to the next item starting with it, Enter or Space runs one,
// Escape or Left leaves a nested list and Escape or Tab closes. It renders
// outside the sidebar, whose transform and overflow would clip it.
export function ContextMenu({
  label,
  items,
  at,
  focusFirst,
  onClose,
}: {
  label: string;
  items: MenuEntry[];
  at: MenuPosition;
  focusFirst: boolean;
  onClose: (reason: CloseReason) => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  // Each nested list remembers the label of the item that opened it.
  const [stack, setStack] = useState<
    { title: string; label: string; items: MenuEntry[] }[]
  >([]);
  // Leaving a nested list returns focus to the item that opened it.
  const opener = useRef<string | null>(null);
  const leave = () => {
    opener.current = stack.at(-1)?.label ?? null;
    setStack((value) => value.slice(0, -1));
  };
  const level = stack.at(-1);
  const visible = level ? level.items : items;
  const [position, setPosition] = useState({ left: at.x, top: at.y });
  const typed = useRef({ text: "", at: 0 });
  const closing = useRef(onClose);
  closing.current = onClose;
  const buttons = () =>
    Array.from(
      menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ||
        [],
    );
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const box = element.getBoundingClientRect();
    const margin = 8;
    let left = at.align === "end" ? at.x - box.width : at.x;
    let top = at.y;
    if (left + box.width > window.innerWidth - margin)
      left = window.innerWidth - margin - box.width;
    if (top + box.height > window.innerHeight - margin)
      top = Math.max(margin, at.y - box.height);
    setPosition({ left: Math.max(margin, left), top: Math.max(margin, top) });
  }, [at.x, at.y, at.align, stack.length]);
  useLayoutEffect(() => {
    const label = opener.current;
    opener.current = null;
    const back = label
      ? buttons().find(
          (button) =>
            button.querySelector(".context-menu-label")?.textContent === label,
        )
      : undefined;
    if (back) back.focus({ preventScroll: true });
    // Lists start on their first enabled entry; a nested one skips Back.
    else if (focusFirst || stack.length)
      buttons()
        .slice(stack.length ? 1 : 0)
        .find((item) => !item.hasAttribute("aria-disabled"))
        ?.focus({ preventScroll: true });
    else menu.current?.focus({ preventScroll: true });
  }, [stack.length, focusFirst]);
  useEffect(() => {
    const outside = (event: Event) => {
      if (!menu.current?.contains(event.target as Node))
        closing.current("outside");
    };
    const scroll = (event: Event) => {
      if (!menu.current?.contains(event.target as Node))
        closing.current("outside");
    };
    const resize = () => closing.current("outside");
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", resize);
    window.addEventListener("blur", resize);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", resize);
      window.removeEventListener("blur", resize);
    };
  }, []);
  const activate = (item: Item) => {
    if (item.disabled) return;
    if (item.items) {
      setStack((value) => [
        ...value,
        {
          title: item.title || item.label,
          label: item.label,
          items: item.items!(),
        },
      ]);
      return;
    }
    closing.current("select");
    item.run?.();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = buttons();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    const move = (next: number) => {
      event.preventDefault();
      list[(next + list.length) % list.length]?.focus({ preventScroll: true });
    };
    // Every handled key stays inside the menu: the tree and the workspace
    // have their own arrow, Escape and shortcut handling.
    event.stopPropagation();
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index < 0 ? -1 : index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(-1);
    else if (event.key === "Escape" || (event.key === "ArrowLeft" && level)) {
      event.preventDefault();
      if (level) leave();
      else if (event.key === "Escape") closing.current("escape");
    } else if (event.key === "Tab") {
      event.preventDefault();
      closing.current("tab");
    } else if (
      event.key === "ArrowRight" &&
      index >= 0 &&
      list[index].hasAttribute("data-nested")
    ) {
      event.preventDefault();
      list[index].click();
    } else if (
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      event.key !== " "
    ) {
      const now = Date.now();
      typed.current =
        now - typed.current.at > 700
          ? { text: event.key.toLowerCase(), at: now }
          : { text: typed.current.text + event.key.toLowerCase(), at: now };
      const labels = list.map((button) =>
        (
          button.querySelector(".context-menu-label")?.textContent || ""
        ).toLowerCase(),
      );
      // A repeated letter moves on; a longer prefix may match the current item.
      const first = typed.current.text.length > 1 ? 0 : 1;
      for (let offset = first; offset <= labels.length; offset++) {
        const candidate = (Math.max(0, index) + offset) % labels.length;
        if (labels[candidate].startsWith(typed.current.text)) {
          move(candidate);
          break;
        }
      }
    }
  };
  return createPortal(
    <div
      ref={menu}
      className="context-menu"
      role="menu"
      aria-label={level ? level.title : label}
      tabIndex={-1}
      style={position}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {level && (
        <>
          <button
            type="button"
            role="menuitem"
            className="context-menu-back"
            tabIndex={-1}
            onClick={leave}
            onPointerMove={(event) =>
              event.currentTarget.focus({ preventScroll: true })
            }
          >
            <CaretLeft size={14} aria-hidden="true" />
            <span className="context-menu-label">Back</span>
            <span className="context-menu-detail">{level.title}</span>
          </button>
          <div role="separator" />
        </>
      )}
      <div className="context-menu-items">
        {visible.map((entry, index) =>
          isItem(entry) ? (
            <button
              key={`${entry.label}-${index}`}
              type="button"
              role="menuitem"
              tabIndex={-1}
              aria-disabled={entry.disabled || undefined}
              aria-haspopup={entry.items ? "menu" : undefined}
              aria-keyshortcuts={entry.keys}
              data-nested={entry.items ? "" : undefined}
              style={
                entry.depth
                  ? { paddingInlineStart: 10 + entry.depth * 14 }
                  : undefined
              }
              onClick={() => activate(entry)}
              onPointerMove={(event) =>
                event.currentTarget.focus({ preventScroll: true })
              }
            >
              {entry.icon && <entry.icon size={16} aria-hidden="true" />}
              <span className="context-menu-label">{entry.label}</span>
              {entry.detail && (
                <span className="context-menu-detail">{entry.detail}</span>
              )}
              {entry.shortcut && <kbd>{entry.shortcut}</kbd>}
              {entry.items && <CaretRight size={13} aria-hidden="true" />}
            </button>
          ) : (
            <div key={`separator-${index}`} role="separator" />
          ),
        )}
      </div>
    </div>,
    document.body,
  );
}
