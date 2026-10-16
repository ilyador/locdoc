import { useEffect, useState } from "react";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { readVarString, hasContent } from "lib0/decoding";
import {
  createEncoder,
  writeVarUint,
  writeVarString,
  toUint8Array,
} from "lib0/encoding";
import { api, ApiError } from "./api";
import { DraftJournal, textHash } from "./drafts";
import { documentSession } from "./document-session";
import { normalizePresence } from "./presence";
import { sharedToken, type Document as Doc } from "./model";
type Session = ReturnType<typeof documentSession>;

export function useDocument(
  id: string | null,
  authorized: boolean,
  initialDocument: Doc | null,
) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [content, setContent] = useState("");
  const [status, setStatus] = useState("Connecting");
  const [people, setPeople] = useState<{ name: string; color: string }[]>([]);
  const [error, setError] = useState("");
  const accessQuery = sharedToken
    ? `?token=${encodeURIComponent(sharedToken)}`
    : "";
  useEffect(() => {
    if (!id || !authorized) return;
    let active = true;
    let connection: Session | null = null;
    setDoc(null);
    setSession(null);
    setError("");
    setContent("");
    setStatus("Connecting");
    if (!sharedToken) localStorage.setItem("locdoc.document", id);
    const loaded = initialDocument?.id === id ? initialDocument : null;
    (loaded
      ? Promise.resolve(loaded)
      : api<Doc>(`/api/docs/${id}${accessQuery}`)
    )
      .then(async (d) => {
        if (!active) return;
        if (!d.state)
          throw new Error(
            "The editor is updating. Reload to open the latest version.",
          );
        const ydoc = new Y.Doc();
        ydoc.getText("content");
        Y.applyUpdate(
          ydoc,
          Uint8Array.from(atob(d.state), (c) => c.charCodeAt(0)),
        );
        const provider = new WebsocketProvider(
          `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
          id,
          ydoc,
          {
            params: {
              client: "file-comments-v1",
              ...(sharedToken ? { token: sharedToken } : {}),
            },
            disableBc: true,
            connect: false,
          },
        );
        let waitingForFile = false;
        let serverWaiting = !!d.diskPending;
        let receiptId = "";
        const updateStatus = () => {
          if (active)
            setStatus(
              drafts.pending
                ? provider.wsconnected
                  ? waitingForFile
                    ? "Waiting for desktop file"
                    : "Saving…"
                  : drafts.stored
                    ? "Offline · draft saved here"
                    : "Saving draft…"
                : serverWaiting
                  ? "Waiting for desktop file"
                  : provider.synced
                    ? "Saved to disk"
                    : "Connecting",
            );
        };
        const drafts = new DraftJournal(
          ydoc,
          `${d.owner ? "owner" : await textHash(sharedToken || "guest")}/${d.id}`,
          updateStatus,
          () => {
            if (active)
              setError(
                "Could not store unsaved changes. Keep this tab open until connected.",
              );
          },
        );
        try {
          await drafts.restore(d.edit);
        } catch (error) {
          drafts.dispose();
          provider.destroy();
          ydoc.destroy();
          throw error;
        }
        if (!active) {
          drafts.dispose();
          provider.destroy();
          ydoc.destroy();
          return;
        }
        drafts.bind(provider, (id) => {
          if (!provider.wsconnected || !provider.ws) return false;
          receiptId = id;
          const encoder = createEncoder();
          writeVarUint(encoder, 124);
          writeVarString(encoder, id);
          provider.ws.send(toUint8Array(encoder));
          return true;
        });
        setDoc(d);
        setContent(ydoc.getText("content").toString());
        document.title = `${d.path.split("/").pop()?.replace(/\.md$/, "")} · locdoc`;
        provider.messageHandlers[125] = (_encoder, decoder) => {
          if (active) {
            setError(readVarString(decoder));
            provider.disconnect();
          }
        };
        provider.messageHandlers[127] = (_encoder, decoder) => {
          if (hasContent(decoder)) {
            const id = readVarString(decoder);
            if (id === receiptId) waitingForFile = false;
            void drafts.acknowledge(id).catch(() => {});
            updateStatus();
          }
        };
        provider.messageHandlers[122] = (_encoder, decoder) => {
          if (readVarString(decoder) === receiptId) {
            waitingForFile = true;
            updateStatus();
          }
        };
        provider.messageHandlers[121] = (_encoder, decoder) => {
          serverWaiting = readVarString(decoder) === "1";
          updateStatus();
        };
        provider.messageHandlers[123] = (_encoder, decoder) => {
          const usage = Number(readVarString(decoder));
          if (active && Number.isSafeInteger(usage) && usage >= 0)
            setDoc((doc) => (doc ? { ...doc, usage } : doc));
        };
        provider.on("status", () => {
          updateStatus();
        });
        provider.on("sync", (synced: boolean) => {
          if (synced) {
            drafts.requestSave();
            updateStatus();
          }
        });
        provider.on("connection-close", () => {
          waitingForFile = false;
          drafts.disconnected();
          if (active)
            api<Doc>(`/api/docs/${id}${accessQuery}`)
              .then((d) => {
                if (active) setDoc(d);
              })
              .catch((e) => {
                if (
                  active &&
                  e instanceof ApiError &&
                  [403, 404].includes(e.status)
                ) {
                  setError(e.message);
                  provider.disconnect();
                }
              });
        });
        const presence = () => {
          if (active)
            setPeople(
              Array.from(provider.awareness.getStates().values())
                .map((s) => normalizePresence(s.user))
                .filter(
                  (person): person is NonNullable<typeof person> =>
                    person !== null,
                ),
            );
        };
        provider.awareness.on("change", presence);
        connection = documentSession(d.id, ydoc, provider, drafts);
        setSession(connection);
        provider.connect();
      })
      .catch((e) => {
        if (active) {
          setError(e.message);
          setStatus("Unable to open document");
          // Keep the selected document and error stable. Automatically choosing
          // the first file again would repeatedly clear and recreate this error.
        }
      });
    return () => {
      active = false;
      connection?.leave();
      setPeople([]);
    };
  }, [id, authorized, accessQuery, initialDocument]);
  return {
    doc,
    setDoc,
    session,
    content,
    setContent,
    status,
    people,
    error,
    setError,
  };
}
