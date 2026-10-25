import type { Awareness } from "y-protocols/awareness";

export type Person = { name: string; color: string };
export function normalizePresence(value: unknown): Person | null {
  if (!value || typeof value !== "object") return null;
  const user = value as Record<string, unknown>;
  if (typeof user.name !== "string") return null;
  const name = [
    ...user.name.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim(),
  ]
    .slice(0, 60)
    .join("");
  if (!name) return null;
  return {
    name,
    color:
      typeof user.color === "string" && /^#[\da-f]{6}$/i.test(user.color)
        ? user.color
        : "#487495",
  };
}

export function publishPresence(awareness: Awareness, name: string) {
  const person = normalizePresence({ name });
  if (!person) {
    const state = awareness.getLocalState();
    if (state && "user" in state) {
      const next = { ...state };
      delete next.user;
      awareness.setLocalState(next);
    }
    return;
  }
  const colors = ["#487495", "#b46538", "#526db0", "#a04c73", "#80752c"];
  const color = colors[person.name.charCodeAt(0) % colors.length];
  awareness.setLocalStateField("user", {
    name: person.name,
    color,
    colorLight: color + "24",
  });
}

// Closing or caching a page does not unmount React. Withdraw its cursor while
// keeping its connection and draft journal free to finish saving. A cached
// page restores its presence when the browser shows it again.
export function pagePresence(awareness: Awareness, page: Window) {
  let paused: ReturnType<Awareness["getLocalState"]> = null;
  const hide = () => {
    const state = awareness.getLocalState();
    if (state) {
      paused = state;
      awareness.setLocalState(null);
    }
  };
  const show = () => {
    if (paused && awareness.getLocalState() === null)
      awareness.setLocalState(paused);
    paused = null;
  };
  page.addEventListener("pagehide", hide);
  page.addEventListener("pageshow", show);
  return () => {
    page.removeEventListener("pagehide", hide);
    page.removeEventListener("pageshow", show);
    paused = null;
  };
}
