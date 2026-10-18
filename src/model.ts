import type { Anchor } from "./editor";

export type Entry = {
  path: string;
  kind: "folder" | "file";
  id: string | null;
  shared: boolean;
  modified?: number;
  title?: string;
  url?: string;
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
  lineEndingMigrated?: boolean;
  collaborationEpoch?: string;
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
  guest: string;
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
