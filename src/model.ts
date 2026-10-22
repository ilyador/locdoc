import type { DocumentFormat } from "./document-format";
import type { Anchor } from "./editor-types";

export type Entry = {
  path: string;
  kind: "folder" | "file";
  id: string | null;
  shared: boolean;
  modified?: number;
  title?: string;
  url?: string;
  format?: DocumentFormat;
};
// A document or folder in Locdoc's trash. `deleted` is in seconds.
export type TrashItem = {
  id: string;
  kind: "document" | "folder";
  path: string;
  deleted: number;
  documents: number;
};
// A media reference the owner sees but link visitors cannot.
export type HiddenMedia = { path: string; reason: "unapproved" | "missing" };
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
};
export type Config = {
  owner: boolean;
  root: string;
  guest: string;
  publicUrl: string;
  ownerName?: string;
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
