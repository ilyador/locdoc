import type { Dispatch, RefObject, SetStateAction } from "react";
import * as Y from "yjs";
import { api } from "./api";
import {
  captureInsertion,
  insertAttachment,
  type DocumentSession,
} from "./document-session";
import type { EditorHandle } from "./editor-types";
import type { Document } from "./model";

// The upload belongs to the session that started it. Its result is inserted
// there and never into a document opened while the request was running.
export async function uploadAttachment(
  file: File,
  {
    doc,
    session: origin,
    editor,
    accessQuery,
    setDoc,
    tell,
  }: {
    doc: Document | null;
    session: DocumentSession | null;
    editor: RefObject<EditorHandle | null>;
    accessQuery: string;
    setDoc: Dispatch<SetStateAction<Document | null>>;
    tell: (message: string) => void;
  },
) {
  if (!doc?.edit || !origin || origin.id !== doc.id) return;
  const video = file.type.startsWith("video/");
  if (file.size > (video ? 20 : 5) * 1e6)
    throw new Error(
      video
        ? "Videos must be 20 MB or smaller."
        : "Images must be 5 MB or smaller.",
    );
  const data = new FormData();
  data.append("file", file);
  const anchor = editor.current?.selection().anchor;
  const position = anchor
    ? {
        start: Y.createRelativePositionFromJSON(anchor.start),
        end: Y.createRelativePositionFromJSON(anchor.end),
      }
    : captureInsertion(origin.ydoc);
  const release = origin.retain();
  try {
    const result = await api<{ path: string; usage: number }>(
      `/api/docs/${origin.id}/upload${accessQuery}`,
      {
        method: "POST",
        body: data,
      },
    );
    const alt = file.name.replace(/[\\\[\]<>\r\n]/g, "");
    insertAttachment(origin.ydoc, position, `\n![${alt}](${result.path})\n`);
    await origin.drafts.flush();
    setDoc((d) => (d?.id === origin.id ? { ...d, usage: result.usage } : d));
    tell(`${video ? "Video" : "Image"} saved to ${doc.path.split("/").pop()}.`);
  } finally {
    release();
  }
}
