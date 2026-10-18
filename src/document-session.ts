import * as Y from "yjs";
import { DraftJournal } from "./drafts.ts";
import type { WebsocketProvider } from "y-websocket";

export type Insertion = { start: Y.RelativePosition; end: Y.RelativePosition };
export function captureInsertion(
  ydoc: Y.Doc,
  from?: number,
  to?: number,
): Insertion {
  const text = ydoc.getText("content");
  return {
    start: Y.createRelativePositionFromTypeIndex(text, from ?? text.length),
    end: Y.createRelativePositionFromTypeIndex(text, to ?? from ?? text.length),
  };
}
export function insertAttachment(
  ydoc: Y.Doc,
  position: Insertion,
  markdown: string,
) {
  const text = ydoc.getText("content");
  const start = Y.createAbsolutePositionFromRelativePosition(
    position.start,
    ydoc,
  );
  const end = Y.createAbsolutePositionFromRelativePosition(position.end, ydoc);
  const from = start?.type === text ? start.index : text.length;
  const to = end?.type === text ? Math.max(from, end.index) : from;
  ydoc.transact(() => {
    text.delete(from, to - from);
    text.insert(from, markdown);
  });
}
export function documentSession(
  id: string,
  ydoc: Y.Doc,
  provider: WebsocketProvider,
  drafts: DraftJournal,
) {
  let references = 1;
  let disposed = false;
  const release = () => {
    references--;
    if (references) return;
    // Give an in-flight upload time to persist online; offline drafts have
    // already been journaled and can safely outlive this provider.
    const retire = async () => {
      if (disposed || references) return;
      try {
        await drafts.flush();
      } catch {
        setTimeout(() => void retire(), 1000);
        return;
      }
      // A retained upload or a newer local edit may arrive while IndexedDB is
      // committing. Recheck ownership and durability after that asynchronous
      // boundary before destroying the only live copy of the document.
      if (disposed || references) return;
      if (drafts.pending && !drafts.stored) {
        setTimeout(() => void retire(), 0);
        return;
      }
      disposed = true;
      drafts.dispose();
      provider.destroy();
      ydoc.destroy();
    };
    setTimeout(
      () => void retire(),
      provider.wsconnected && drafts.pending ? 3000 : 0,
    );
  };
  return {
    id,
    ydoc,
    provider,
    drafts,
    retain() {
      if (disposed) throw new Error("The document has closed.");
      references++;
      return release;
    },
    leave() {
      provider.awareness.setLocalState(null);
      release();
    },
  };
}
