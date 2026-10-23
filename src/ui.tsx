import React, { Fragment, type CSSProperties } from "react";
import { hasRightToLeft } from "./bidi";
import { nameParts } from "./document-format";
import { normalizePresence } from "./presence";
const colors = ["#487495", "#b46538", "#526db0", "#a04c73", "#80752c"];
export function IconButton({
  label,
  children,
  className = "",
  ...props
}: React.ComponentProps<"button"> & { label: string }) {
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
// A path reads left to right like the interface, each folder in its own
// direction, so Hebrew folder names cannot swap places or carry the slashes
// with them. A name keeps its extension after it, as the sidebar shows it. A
// path without right-to-left letters stays one plain string.
export function PathText({
  path,
  separator = " / ",
}: {
  path: string;
  separator?: string;
}) {
  const parts = path.split("/");
  if (!hasRightToLeft(path)) return <>{parts.join(separator)}</>;
  return (
    <>
      {parts.map((part, index) => {
        const [title, extension] = nameParts(part);
        return (
          <Fragment key={index}>
            {index > 0 && separator}
            <bdi>{title}</bdi>
            {extension}
          </Fragment>
        );
      })}
    </>
  );
}
// A short label that screen readers read in full: "5m" shows, and "5 minutes
// ago" is read. A label that needs no reading aloud stays plain text.
export function Abbreviated({
  label,
  phrase,
}: {
  label: string;
  phrase?: string;
}) {
  if (!phrase || phrase === label) return <>{label}</>;
  return (
    <>
      <span aria-hidden="true">{label}</span>
      <span className="visually-hidden">{phrase}</span>
    </>
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
