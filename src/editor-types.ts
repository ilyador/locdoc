import type * as Y from "yjs";
import type { FountainForce } from "./fountain";

export type Anchor = {
  start: ReturnType<typeof Y.relativePositionToJSON>;
  end: ReturnType<typeof Y.relativePositionToJSON>;
};
export type Selection = { quote: string; anchor: Anchor | null };
export type LinkTarget = {
  url: string;
  label: string;
  rect: { left: number; bottom: number };
};
export type EditorHandle = {
  formatFountain: (kind: FountainForce) => void;
  insertLink: (url: string, label: string, anchor: Anchor | null) => void;
  toggleTasks: () => void;
  insert: (text: string) => void;
  insertTable: (rows: number, columns: number) => void;
  wrap: (before: string, after?: string) => void;
  selection: (wholeLine?: boolean) => Selection;
  locate: (anchor: Anchor) => void;
  revealComment: (id?: string) => void;
  focus: () => void;
  measure: () => void;
};
