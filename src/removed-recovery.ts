import * as Y from "yjs";
import { plainText, type DraftArchive } from "./drafts.ts";

export type RemovedRecovery = {
  document: string;
  path: string;
  state: string | null;
  liveState: string | null;
  collaborationEpoch: string;
  updates: { state: string }[];
};

const decode = (state: string) =>
  Uint8Array.from(atob(state), (character) => character.charCodeAt(0));

// Reconstruct a download only. This document has no provider or persistence
// observer, and cannot publish recovered drafts or revive an old share link.
export function recoveredSource(
  bundle: RemovedRecovery,
  drafts: DraftArchive[],
): string | null {
  const doc = new Y.Doc();
  doc.getText("content");
  try {
    if (!bundle.state && !bundle.liveState) return null;
    if (bundle.state) Y.applyUpdate(doc, decode(bundle.state));
    for (const update of bundle.updates)
      Y.applyUpdate(doc, decode(update.state));
    if (bundle.liveState) Y.applyUpdate(doc, decode(bundle.liveState));
    for (const draft of drafts) {
      if (
        draft.recovery ||
        (draft.collaborationEpoch ?? "") !== bundle.collaborationEpoch ||
        (draft.formatVersion ?? 1) < 2 ||
        !Array.isArray(draft.state) ||
        !draft.state.every(
          (byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255,
        )
      )
        return null;
      Y.applyUpdate(doc, Uint8Array.from(draft.state));
    }
    if (!plainText(doc) || doc.store.pendingStructs || doc.store.pendingDs)
      return null;
    return doc.getText("content").toString();
  } catch {
    return null;
  } finally {
    doc.destroy();
  }
}
