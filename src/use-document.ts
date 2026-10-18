import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { readVarString, hasContent } from "lib0/decoding";
import {
  createEncoder,
  writeVarUint,
  writeVarString,
  toUint8Array,
} from "lib0/encoding";
import { api, ApiError, ownerSession } from "./api";
import { DraftJournal, textHash, type DraftRecovery } from "./drafts";
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
  const [status, setStatus] = useState("Connecting");
  const [people, setPeople] = useState<{ name: string; color: string }[]>([]);
  const [error, setError] = useState("");
  const [recovery, setRecovery] = useState<DraftRecovery[]>([]);
  const [storageWarning, setStorageWarning] = useState("");
  const [reload, setReload] = useState(0);
  const recoveryJournal = useRef<DraftJournal | null>(null);
  const accessQuery = sharedToken
    ? `?token=${encodeURIComponent(sharedToken)}`
    : "";
  useEffect(() => {
    if (!id || !authorized) return;
    let active = true;
    let connection: Session | null = null;
    let cancelRetry: (() => void) | undefined;
    setDoc(null);
    setSession(null);
    setError("");
    setStatus("Connecting");
    if (!sharedToken) {
      try {
        localStorage.setItem("locdoc.document", id);
      } catch {
        /* Navigation still works without browser storage. */
      }
    }
    const loaded =
      !reload && initialDocument?.id === id ? initialDocument : null;
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
            protocols: ownerSession()
              ? [`locdoc-session.${ownerSession()}`]
              : [],
            params: {
              client: "plain-text-v2",
              epoch: d.collaborationEpoch || "",
              ...(sharedToken ? { token: sharedToken } : {}),
            },
            disableBc: true,
            connect: false,
          },
        );
        let serverWaiting = !!d.diskPending;
        let receiptId = "";
        let resetting = false;
        let transientWarning = "";
        let retryTimer: ReturnType<typeof setTimeout> | undefined;
        let retryDelay = 500;
        cancelRetry = () => clearTimeout(retryTimer);
        let notifiedRecovery: DraftRecovery[] | undefined;
        let notifiedWarning: string | undefined;
        let notifiedStatus: string | undefined;
        const updateStatus = () => {
          if (active) {
            const recovered = drafts.recoveries;
            if (
              !notifiedRecovery ||
              notifiedRecovery.length !== recovered.length ||
              notifiedRecovery.some(
                (record, index) => record.id !== recovered[index].id,
              )
            ) {
              notifiedRecovery = recovered;
              setRecovery(recovered);
            }
            const warning = drafts.storageWarning || transientWarning;
            if (warning !== notifiedWarning) {
              notifiedWarning = warning;
              setStorageWarning(warning);
            }
            const status = drafts.pending
              ? provider.wsconnected
                ? serverWaiting
                  ? "Waiting for desktop file"
                  : "Saving…"
                : drafts.stored
                  ? "Offline · draft saved here"
                  : "Saving draft…"
              : serverWaiting
                ? "Waiting for desktop file"
                : provider.synced
                  ? "Saved to disk"
                  : "Connecting";
            if (status !== notifiedStatus) {
              notifiedStatus = status;
              setStatus(status);
            }
          }
        };
        const drafts = new DraftJournal(
          ydoc,
          `${d.owner ? "owner" : await textHash(sharedToken || "guest")}/${d.id}`,
          updateStatus,
          () => {
            if (active) setStorageWarning(drafts.storageWarning);
          },
        );
        recoveryJournal.current = drafts;
        await drafts.restore(d.edit, {
          lineEndingMigrated: d.lineEndingMigrated,
          collaborationEpoch: d.collaborationEpoch,
        });
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
        document.title = `${d.path.split("/").pop()?.replace(/\.md$/, "")} · locdoc`;
        const rejectDraft = (message: string) => {
          if (!active || resetting) return;
          resetting = true;
          clearTimeout(retryTimer);
          provider.disconnect();
          setDoc((value) => (value ? { ...value, edit: false } : value));
          void drafts
            .reject(message)
            .then(() => {
              if (active) setReload((value) => value + 1);
            })
            .catch(() => {
              if (active)
                setError(
                  "The rejected draft is still in this tab. Keep it open and download a recovery copy before reloading.",
                );
            });
        };
        provider.messageHandlers[125] = (_encoder, decoder) => {
          rejectDraft(readVarString(decoder));
        };
        provider.messageHandlers[120] = (_encoder, decoder) => {
          if (!active || resetting) return;
          transientWarning = readVarString(decoder);
          provider.disconnect();
          drafts.disconnected();
          clearTimeout(retryTimer);
          retryTimer = setTimeout(() => {
            if (active && !resetting) provider.connect();
          }, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 5000);
          updateStatus();
        };
        provider.messageHandlers[127] = (_encoder, decoder) => {
          if (hasContent(decoder)) {
            const id = readVarString(decoder);
            if (id === receiptId) {
              transientWarning = "";
              retryDelay = 500;
            }
            void drafts.acknowledge(id).catch(() => {});
            updateStatus();
          }
        };
        provider.messageHandlers[122] = (_encoder, decoder) => {
          if (readVarString(decoder) === receiptId) {
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
            if (!drafts.pending) {
              transientWarning = "";
              retryDelay = 500;
            }
            drafts.requestSave();
            updateStatus();
          }
        });
        provider.on("connection-close", () => {
          if (resetting) return;
          serverWaiting = false;
          drafts.disconnected();
          if (active && !transientWarning)
            api<Doc>(`/api/docs/${id}${accessQuery}`)
              .then((d) => {
                if (active && !resetting) setDoc(d);
              })
              .catch((e) => {
                if (
                  active &&
                  e instanceof ApiError &&
                  [403, 404].includes(e.status)
                ) {
                  rejectDraft(e.message);
                }
              });
        });
        let notifiedPeople: { name: string; color: string }[] = [];
        const presence = () => {
          if (!active) return;
          const next = Array.from(provider.awareness.getStates().values())
            .map((state) => normalizePresence(state.user))
            .filter(
              (person): person is NonNullable<typeof person> => person !== null,
            );
          if (
            notifiedPeople.length === next.length &&
            notifiedPeople.every(
              (person, index) =>
                person.name === next[index].name &&
                person.color === next[index].color,
            )
          )
            return;
          notifiedPeople = next;
          setPeople(next);
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
      cancelRetry?.();
      connection?.leave();
      setPeople([]);
    };
  }, [id, authorized, accessQuery, initialDocument, reload]);
  const clearRecovery = async (id: string) => {
    const journal = recoveryJournal.current;
    if (!journal) return;
    await journal.clearRecovery(id);
    setRecovery(journal.recoveries);
  };
  return {
    doc,
    setDoc,
    session,
    status,
    people,
    error,
    setError,
    recovery,
    clearRecovery,
    storageWarning,
  };
}
