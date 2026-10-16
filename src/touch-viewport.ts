// Keep editing at the page's original scale, including WebKit gesture events.
export function protectTouchViewport(target: Document) {
  const win = target.defaultView;
  const viewport = win?.visualViewport;
  const root = target.documentElement;
  const previousHeight = root.style.getPropertyValue("--app-viewport-height");
  const previousTop = root.style.getPropertyValue("--app-viewport-top");
  const standalone =
    !!(win?.navigator as Navigator & { standalone?: boolean })?.standalone ||
    !!win?.matchMedia?.(
      "(display-mode: standalone), (display-mode: fullscreen)",
    ).matches;
  const previousStandalone = root.hasAttribute("data-standalone");
  const previousKeyboard = root.hasAttribute("data-keyboard-open");
  root.toggleAttribute("data-standalone", standalone);
  // Measure the full viewport without a painted fixed app ancestor, which can
  // influence iOS's native status-bar treatment. Explicit pixels also avoid
  // WebKit subtracting safe areas from an absolutely positioned shell's insets.
  const gauge = target.createElement("div");
  gauge.setAttribute("data-viewport-gauge", "");
  gauge.setAttribute("aria-hidden", "true");
  gauge.style.cssText =
    "position:fixed;inset:0;pointer-events:none;visibility:hidden;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);box-sizing:border-box;";
  (target.body || root).appendChild(gauge);
  let idle: { width: number; usable: number } | null = null;
  let keyboardOpen = false;
  let rotatedKeyboardHeight: number | null = null;
  const isEditing = () => {
    const active = target.activeElement as HTMLElement | null;
    if (!active) return false;
    if (active.closest('[contenteditable="true"]')) return true;
    if (active.tagName === "TEXTAREA")
      return !(active as HTMLTextAreaElement).readOnly;
    return (
      active.tagName === "INPUT" &&
      /^(text|search|url|tel|email|password|number)$/.test(
        (active as HTMLInputElement).type,
      ) &&
      !(active as HTMLInputElement).readOnly
    );
  };
  const fitViewport = () => {
    if (!win) return;
    const editing = isEditing();
    const full = gauge.getBoundingClientRect().height || win.innerHeight;
    const safe = win.getComputedStyle(gauge);
    const safeHeight =
      (parseFloat(safe.paddingTop) || 0) +
      (parseFloat(safe.paddingBottom) || 0);
    const visible = viewport?.height ?? win.innerHeight;
    const widthChanged = !!idle && idle.width !== win.innerWidth;
    // Cache the idle baseline before an IME can resize viewport CSS units.
    if (!idle || !editing || widthChanged || visible > idle.usable + 1) {
      idle = {
        width: win.innerWidth,
        usable: standalone ? full - safeHeight : full,
      };
    }
    if (
      !editing ||
      (rotatedKeyboardHeight !== null && visible > rotatedKeyboardHeight + 1)
    )
      rotatedKeyboardHeight = null;
    if (widthChanged && editing && keyboardOpen && idle.usable - visible <= 1)
      rotatedKeyboardHeight = visible;
    keyboardOpen =
      !!viewport &&
      editing &&
      (idle.usable - visible > 1 || rotatedKeyboardHeight !== null);
    root.toggleAttribute("data-keyboard-open", keyboardOpen);
    if (standalone && !keyboardOpen) {
      root.style.setProperty("--app-viewport-height", `${full}px`);
      root.style.removeProperty("--app-viewport-top");
      return;
    }
    root.style.setProperty(
      "--app-viewport-height",
      `${viewport?.height ?? win.innerHeight}px`,
    );
    root.style.setProperty(
      "--app-viewport-top",
      `${viewport?.offsetTop ?? 0}px`,
    );
  };
  fitViewport();
  win?.addEventListener("resize", fitViewport);
  target.addEventListener("focusin", fitViewport);
  target.addEventListener("focusout", fitViewport);
  viewport?.addEventListener("resize", fitViewport);
  viewport?.addEventListener("scroll", fitViewport);
  const stopGesture = (event: Event) => event.preventDefault();
  const stopMultiTouch = (event: TouchEvent) => {
    if (event.touches.length > 1) event.preventDefault();
  };
  const stopWheelZoom = (event: WheelEvent) => {
    if (event.ctrlKey) event.preventDefault();
  };
  const options = { passive: false };
  target.addEventListener("gesturestart", stopGesture, options);
  target.addEventListener("gesturechange", stopGesture, options);
  target.addEventListener("touchstart", stopMultiTouch, options);
  target.addEventListener("touchmove", stopMultiTouch, options);
  target.addEventListener("wheel", stopWheelZoom, options);
  return () => {
    win?.removeEventListener("resize", fitViewport);
    target.removeEventListener("focusin", fitViewport);
    target.removeEventListener("focusout", fitViewport);
    gauge.remove();
    root.toggleAttribute("data-standalone", previousStandalone);
    root.toggleAttribute("data-keyboard-open", previousKeyboard);
    viewport?.removeEventListener("resize", fitViewport);
    viewport?.removeEventListener("scroll", fitViewport);
    if (previousHeight)
      root.style.setProperty("--app-viewport-height", previousHeight);
    else root.style.removeProperty("--app-viewport-height");
    if (previousTop) root.style.setProperty("--app-viewport-top", previousTop);
    else root.style.removeProperty("--app-viewport-top");
    target.removeEventListener("gesturestart", stopGesture);
    target.removeEventListener("gesturechange", stopGesture);
    target.removeEventListener("touchstart", stopMultiTouch);
    target.removeEventListener("touchmove", stopMultiTouch);
    target.removeEventListener("wheel", stopWheelZoom);
  };
}
