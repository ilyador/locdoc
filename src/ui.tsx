import React, { type CSSProperties } from "react";
import { normalizePresence } from "./presence";
const colors = ["#487495", "#b46538", "#526db0", "#a04c73", "#80752c"];
export function IconButton({
  label,
  children,
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      className={`icon-button ${className}`}
      title={label}
      aria-label={label}
      {...props}
    >
      {children}
    </button>
  );
}
export function Avatar({
  name,
  color,
  small = false,
}: {
  name: string;
  color?: string;
  small?: boolean;
}) {
  const safe = normalizePresence({ name, color }) || {
    name: "Guest",
    color: colors[0],
  };
  return (
    <span
      className={`avatar ${small ? "small" : ""}`}
      style={
        {
          "--avatar-color": safe.color,
        } as CSSProperties
      }
      title={safe.name}
    >
      {safe.name.slice(0, 1).toUpperCase()}
    </span>
  );
}
export function timeAgo(t: number) {
  const m = Math.floor((Date.now() / 1000 - t) / 60);
  return m < 1
    ? "Just now"
    : m < 60
      ? `${m}m ago`
      : m < 1440
        ? `${Math.floor(m / 60)}h ago`
        : new Date(t * 1000).toLocaleDateString();
}
