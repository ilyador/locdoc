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
import { api, ApiError, decodeState, ownerSession } from "./api";
import { DraftJournal, textHash, type DraftRecovery } from "./drafts";
import { documentSession, type DocumentSession } from "./document-session";
import { normalizePresence, pagePresence } from "./presence";
import {
  cachedRead,
  cacheRead,
  currentOfflineScope,
  documentReadPath,
  offlineCacheEnabled,
  waitForOfflineCache,
  storageFailed,
} from "./offline-cache";
import { holdDocumentCache, offlineGet, scopedKey } from "./offline-db";
import { OfflineReplica } from "./offline-replica";
import { offlineDocumentBusy, offlineDocumentPending } from "./offline-actions";
import { trashItem } from "./file-actions";
import { sharedToken, type Document as Doc, type TrashItem } from "./model";
type Projection = "synced" | "pending" | "blocked" | "conflict";

// The trash item holding the open document, and the path the document had.
// A document deleted with its folder is held by the folder's item.
export type Trashed = { item: TrashItem; path: string };

// A trashed document answers 410 with its trash item and its former path.
const trashedDocument = (error: ApiError, id: string, known = ""): Trashed => {
  const body = error.body as { trash?: unknown; path?: unknown } | undefined;
  const item = trashItem(body?.trash);
  const path =
    typeof body?.path === "string"
      ? body.path
      : known || (item?.kind === "document" ? item.path : id);
  return {
    item: item || { id: "", kind: "document", path, deleted: 0, documents: 1 },
    path,
  };
};

export function useDocument(
  id: string | null,
  authorized: boolean,
  initialDocument: Doc | null,
) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [session, setSession] = useState<DocumentSession | null>(null);
  const [status, setStatus] = useState("Connecting");
  const [people, setPeople] = useState<{ name: string; color: string }[]>([]);
  const [error, setError] = useState("");
  const [recovery, setRecovery] = useState<DraftRecovery[]>([]);
  const [storageWarning, setStorageWarning] = useState("");
  const [trashed, setTrashed] = useState<Trashed | null>(null);
  const [reload, setReload] = useState(0);
  const [mediaRetry, setMediaRetry] = useState(0);
  const recoveryJournal = useRef<DraftJournal | null>(null);
  const verify = useRef<(() => void) | null>(null);
  const accessQuery = sharedToken
    ? `?token=${encodeURIComponent(sharedToken)}`
    : "";
  useEffect(() => {
    if (!id || !authorized) return;
    let active = true;
    const opening = new AbortController();
    let connection: DocumentSession | null = null;
    let cancelRetry: (() => void) | undefined;
    let stopPresence: (() => void) | undefined;
    let stopOffline: (() => void) | undefined;
    let releaseCache: (() => void) | undefined;
    setDoc(null);
    setSession(null);
    setError("");
    setTrashed(null);
    setStatus("Connecting");
    verify.current = null;
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
      : api<Doc>(`/api/docs/${id}${accessQuery}`, { signal: opening.signal })
    )
      .then(async (d) => {
        if (!active) return;
        if (!d.state)
          throw new Error(
            "The editor is updating. Reload to open the latest version.",
          );
        const ydoc = new Y.Doc();
        ydoc.getText("content");
        Y.applyUpdate(ydoc, decodeState(d.state));
        if (offlineCacheEnabled()) await waitForOfflineCache();
        const offlineScope = offlineCacheEnabled()
          ? await currentOfflineScope().catch(() => undefined)
          : undefined;
        if (offlineScope) {
          const lease = holdDocumentCache(offlineScope.scope, d.id);
          releaseCache = lease.release;
          await lease.ready;
          ydoc.on("destroy", lease.release);
          if (!active) {
            ydoc.destroy();
            return;
          }
          // Cleanup may have expired a downloaded file while opening it.
          // Restore its accepted bootstrap before an editable view is exposed.
          if (
            !(await offlineGet(
              "reads",
              scopedKey(offlineScope.scope, documentReadPath(d.id)),
            ))
          )
            await cacheRead(documentReadPath(d.id), d).catch(storageFailed);
        }
        const stored = await cachedRead<Doc>(documentReadPath(d.id)).catch(
          () => undefined,
        );
        const replica =
          offlineScope &&
          stored &&
          stored.body.collaborationEpoch === d.collaborationEpoch
            ? new OfflineReplica(
                offlineScope,
                documentReadPath(d.id),
                d.collaborationEpoch || "",
                decodeState(stored.body.state),
              )
            : null;
        if (replica)
          await replica.remote(decodeState(d.state)).catch(storageFailed);
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
        let projection: Projection = d.diskConflict
          ? "conflict"
          : d.diskPending
            ? "blocked"
            : d.diskSaving
              ? "pending"
              : "synced";
        let receiptId = "";
        let resetting = false;
        let inTrash = false;
        let transientWarning = "";
        let pendingForms = false;
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
            const status = inTrash
              ? "In Recently deleted"
              : projection === "conflict"
                ? "Recovery needed"
                : pendingForms
                  ? navigator.onLine === false
                    ? "Offline · changes saved here"
                    : "Syncing offline changes…"
                  : drafts.pending
                    ? provider.wsconnected
                      ? projection === "blocked"
                        ? "Waiting for desktop file"
                        : "Saving…"
                      : drafts.stored
                        ? "Offline · draft saved here"
                        : "Saving draft…"
                    : projection === "blocked"
                      ? "Waiting for desktop file"
                      : provider.synced
                        ? projection === "pending"
                          ? "Saving…"
                          : "Saved to disk"
                        : typeof navigator !== "undefined" &&
                            navigator.onLine === false
                          ? "Offline · saved on this device"
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
          replica ? () => replica.accepted(ydoc) : undefined,
        );
        recoveryJournal.current = drafts;
        await drafts.restore(d.edit && projection !== "conflict", {
          lineEndingMigrated: d.lineEndingMigrated,
          collaborationEpoch: d.collaborationEpoch,
        });
        if (!active) {
          replica?.destroy();
          drafts.dispose();
          provider.destroy();
          ydoc.destroy();
          return;
        }
        drafts.bind(provider, (id) => {
          if (
            projection === "conflict" ||
            !provider.wsconnected ||
            !provider.ws
          )
            return false;
          receiptId = id;
          const encoder = createEncoder();
          writeVarUint(encoder, 124);
          writeVarString(encoder, id);
          provider.ws.send(toUint8Array(encoder));
          return true;
        });
        if (replica) {
          const remember = (update: Uint8Array, origin: unknown) => {
            if (origin === provider)
              void replica.remote(update).catch(storageFailed);
          };
          ydoc.on("update", remember);
          ydoc.on("destroy", () => {
            ydoc.off("update", remember);
            replica.destroy();
          });
        }
        setDoc(projection === "conflict" ? { ...d, edit: false } : d);
        // The text stays readable; local drafts stay journaled for a restore.
        const moveToTrash = (error: ApiError) => {
          if (!active || resetting || inTrash) return;
          inTrash = true;
          clearTimeout(retryTimer);
          provider.disconnect();
          drafts.disconnected();
          setDoc((value) => (value ? { ...value, edit: false } : value));
          setTrashed(trashedDocument(error, d.id, d.path));
          updateStatus();
        };
        verify.current = () => {
          if (!active || inTrash) return;
          api<Doc>(`/api/docs/${id}${accessQuery}`).catch((e) => {
            if (e instanceof ApiError && e.status === 410) moveToTrash(e);
          });
        };
        const rejectDraft = (message: string) => {
          if (!active || resetting || projection === "conflict") return;
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
          if (projection === "conflict") {
            updateStatus();
            return;
          }
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
          if (projection === "conflict") return;
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
          const state = readVarString(decoder);
          if (state === "3") {
            projection = "conflict";
            clearTimeout(retryTimer);
            drafts.disconnected();
            if (active)
              setDoc((doc) =>
                doc ? { ...doc, edit: false, diskConflict: true } : doc,
              );
          } else if (projection !== "conflict") {
            projection =
              state === "1" ? "blocked" : state === "0" ? "synced" : "pending";
          }
          updateStatus();
        };
        // An approval may let the server serve media this view could not
        // load, so the editor requests it once more. The signal names nothing.
        provider.messageHandlers[119] = () => {
          if (active) setMediaRetry((count) => count + 1);
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
          if (resetting || inTrash) return;
          if (projection === "blocked") projection = "pending";
          drafts.disconnected();
          if (active && !transientWarning)
            api<Doc>(`/api/docs/${id}${accessQuery}`)
              .then((d) => {
                if (active && !resetting) {
                  if (d.diskConflict) projection = "conflict";
                  setDoc(
                    projection === "conflict"
                      ? { ...d, edit: false, diskConflict: true }
                      : d,
                  );
                  updateStatus();
                }
              })
              .catch((e) => {
                if (!active || !(e instanceof ApiError)) return;
                if (e.status === 410) moveToTrash(e);
                else if ([403, 404].includes(e.status)) rejectDraft(e.message);
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
        stopPresence = pagePresence(provider.awareness, window);
        connection = documentSession(d.id, ydoc, provider, drafts);
        setSession(connection);
        const pause = (event: Event) => {
          if ((event as CustomEvent<string>).detail === d.id) {
            provider.disconnect();
            drafts.disconnected();
            updateStatus();
          }
        };
        const resume = () => {
          void Promise.all([
            offlineDocumentBusy(d.id),
            offlineDocumentPending(d.id),
          ])
            .then(([busy, pending]) => {
              if (!active || resetting || inTrash || projection === "conflict")
                return;
              pendingForms = pending;
              if (busy) provider.disconnect();
              else if (!provider.shouldConnect) provider.connect();
              updateStatus();
            })
            .catch(() => {});
        };
        window.addEventListener("locdoc-offline-pause", pause);
        window.addEventListener("locdoc-offline-files", resume);
        stopOffline = () => {
          window.removeEventListener("locdoc-offline-pause", pause);
          window.removeEventListener("locdoc-offline-files", resume);
        };
        if (offlineScope) resume();
        else provider.connect();
        if (!d.edit && !d.diskConflict && offlineScope)
          void drafts
            .preserveReadOnly(
              "Editing access changed while you were offline. Your draft is kept for download.",
              {
                collaborationEpoch: d.collaborationEpoch,
                lineEndingMigrated: d.lineEndingMigrated,
              },
            )
            .catch(storageFailed);
      })
      .catch((e) => {
        if (active && e instanceof ApiError && e.status === 410) {
          setTrashed(trashedDocument(e, id));
          setStatus("In Recently deleted");
        } else if (active) {
          setError(e.message);
          setStatus("Unable to open document");
          // Keep the selected document and error stable. Automatically choosing
          // the first file again would repeatedly clear and recreate this error.
        }
      });
    return () => {
      active = false;
      opening.abort();
      cancelRetry?.();
      stopPresence?.();
      stopOffline?.();
      connection?.leave();
      if (!connection) releaseCache?.();
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
    trashed,
    mediaRetry,
    // Open the document again, as after a restore or a change of format.
    reload: () => setReload((value) => value + 1),
    // Ask whether the open document went to the trash.
    checkTrashed: () => verify.current?.(),
  };
}
