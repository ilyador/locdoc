import type { DocumentFormat } from "./document-format";
import type { Anchor } from "./editor-types";

export type Entry = {
  path: string;
  kind: "folder" | "file";
  id: string | null;
  shared: boolean;
  modified?: number;
  offlineVersion?: string;
  title?: string;
  url?: string;
  workspacePathHash?: string;
  format?: DocumentFormat;
  identity?: string;
};
// A document or folder in Locdoc's trash. `deleted` is in seconds.
export type TrashItem = {
  id: string;
  kind: "document" | "folder";
  path: string;
  deleted: number;
  documents: number;
};
// A media reference the owner's editor shows that link visitors cannot see,
// and why. Only "unapproved" is the owner's to change from Locdoc. "hidden"
// is a dot-named file or folder the owner still sees; "trash" is a `.trash`
// or `.locdoc-trash` folder, which serves nobody.
export type HiddenMedia = {
  path: string;
  reason:
    | "unapproved"
    | "missing"
    | "outside"
    | "hidden"
    | "trash"
    | "state"
    | "too-large"
    | "unsupported"
    | "invalid";
};
export type Document = {
  id: string;
  path: string;
  owner: boolean;
  edit: boolean;
  permission: string;
  shareUrl: string | null;
  usage: number;
  content: string;
  modified: number;
  state: string;
  diskPending?: boolean;
  diskSaving?: boolean;
  diskConflict?: boolean;
  lineEndingMigrated?: boolean;
  collaborationEpoch?: string;
  mediaToken?: string | null;
  hiddenMedia?: HiddenMedia[];
  offlineMedia?: { path: string; version: string; bytes: number }[];
  /** Made in this browser and not accepted by the server when it was read. */
  unsent?: boolean;
};
export type Config = {
  owner: boolean;
  root: string;
  guest: string;
  publicUrl: string;
  ownerName?: string;
  offlineScope?: string;
  folder?: { name: string; permission: string };
};
export type Comment = {
  id: string;
  body: string;
  name: string;
  canResolve: boolean;
  quote: string | null;
  anchor: Anchor | null;
  created: number;
  resolved: boolean;
  replies: { body: string; name: string; created: number }[];
};
export const sharedToken = location.pathname.match(/^\/s\/([^/]+)/)?.[1];
export const directDocumentId = location.pathname.match(
  /^\/d\/([\da-f-]{36})\/?$/i,
)?.[1];
// The address that shows a document: its own for the owner, its folder
// link's with the document chosen for a folder link's visitors.
export const documentAddress = (id: string) =>
  sharedToken
    ? `/s/${encodeURIComponent(sharedToken)}?doc=${encodeURIComponent(id)}`
    : `/d/${encodeURIComponent(id)}`;
// The document the current address names, as documentAddress wrote it.
export function addressedDocument(): string | null {
  try {
    if (sharedToken) return new URLSearchParams(location.search).get("doc");
    const id = location.pathname.match(/^\/d\/([^/]+)\/?$/)?.[1];
    return id ? decodeURIComponent(id) : null;
  } catch {
    return null;
  }
}
