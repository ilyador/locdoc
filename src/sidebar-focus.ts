import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

// At this width and below, style.css lays the sidebar over the document as a
// drawer with a scrim.
const DRAWER = "(max-width: 760px)";

// Focus that nothing holds, or that a closed or covered part of the
// workspace holds.
const lost = (element: Element | null) =>
  !element || element === document.body || !!element.closest("[inert]");

function keyboardFocus(element: Element) {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}

// Focus enters at the open document's row, or the row that takes Tab in the
// tree, or Close sidebar when there is no tree.
function enter(sidebar: HTMLElement) {
  const row =
    sidebar.querySelector<HTMLElement>(
      '[role="treeitem"][aria-current="page"]',
    ) ?? sidebar.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]');
  const target =
    row ?? sidebar.querySelector<HTMLElement>("[data-sidebar-close]");
  target?.focus({ preventScroll: true });
  // A keyboard user sees the row; a press or a tap leaves the list where it
  // was.
  if (row && keyboardFocus(row)) row.scrollIntoView?.({ block: "nearest" });
}

function useDrawerLayout() {
  const [drawer, setDrawer] = useState(
    () => !!window.matchMedia?.(DRAWER).matches,
  );
  useEffect(() => {
    const query = window.matchMedia?.(DRAWER);
    if (!query) return;
    const change = () => setDrawer(query.matches);
    change();
    query.addEventListener?.("change", change);
    return () => query.removeEventListener?.("change", change);
  }, []);
  return drawer;
}

// The sidebar takes keyboard focus as it opens and gives it back as it
// closes, as the workspace's dialogs do. As a drawer it is modal: it returns
// whether the workspace behind it is inert, and Escape closes it. The sidebar
// stays mounted while documents open, so this follows it from one document
// to the next; each document lends the parts that are its own.
export function useSidebarFocus({
  open,
  setOpen,
  sidebar,
  trigger,
  editorTakesFocus,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  sidebar: RefObject<HTMLElement | null>;
  // The open document's Open sidebar, which shows while the sidebar is
  // closed.
  trigger: () => HTMLElement | null;
  // A document created from the sidebar focuses its editor instead.
  editorTakesFocus: () => boolean;
}) {
  const drawer = useDrawerLayout();
  const modal = drawer && open;
  const shown = useRef(open);
  // What had focus before the sidebar opened.
  const before = useRef<Element | null>(null);
  // Focus goes back where it was, or to Open sidebar. A document opened from
  // the drawer closes it, and its own Open sidebar takes focus then.
  const giveBack = () => {
    const back = before.current;
    before.current = null;
    if (editorTakesFocus()) return;
    const target = back?.isConnected && !lost(back) ? back : trigger();
    (target as HTMLElement | null)?.focus({ preventScroll: true });
  };
  useLayoutEffect(() => {
    if (shown.current === open) return;
    shown.current = open;
    const element = sidebar.current;
    if (!element) return;
    const active = document.activeElement;
    const inside = element.contains(active);
    if (!open) {
      if (inside || lost(active)) giveBack();
      else before.current = null;
      return;
    }
    before.current = inside || active === document.body ? null : active;
    if (!inside && lost(active)) enter(element);
  }, [open]);
  useEffect(() => {
    if (!modal) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing)
        return;
      // A dialog or a menu opened from the drawer takes its own Escape.
      const target = event.target;
      if (
        target !== document.body &&
        !(target instanceof Node && sidebar.current?.contains(target))
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [modal]);
  return modal;
}
