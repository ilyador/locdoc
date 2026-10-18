import { useCallback, useEffect, useRef, useState } from "react";
import { hasUnstoredDrafts } from "./drafts";
import { useAppearance } from "./appearance";
import { protectTouchViewport } from "./touch-viewport";
import { api, ownerSession, send } from "./api";
import { normalizePresence } from "./presence";
import {
  sharedToken,
  directDocumentId,
  type Config,
  type Document,
  type Entry,
} from "./model";

// Workspace state survives document navigation. No document content, sharing
// state, comments or asynchronous document mutations live at this level.
export function useWorkspace() {
  const appearance = useAppearance();
  useEffect(() => protectTouchViewport(document), []);
  useEffect(() => {
    const protectDraft = (event: BeforeUnloadEvent) => {
      if (hasUnstoredDrafts()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", protectDraft);
    return () => window.removeEventListener("beforeunload", protectDraft);
  }, []);
  const [config, setConfig] = useState<Config | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [id, setId] = useState<string | null>(
    sharedToken
      ? null
      : directDocumentId || localStorage.getItem("locdoc.document"),
  );
  const [initialDocument, setInitialDocument] = useState<Document | null>(null);
  const [error, setError] = useState("");
  const [name, setName] = useState(
    normalizePresence({ name: localStorage.getItem("locdoc.guestName") })
      ?.name || "",
  );
  const [needsName, setNeedsName] = useState(false);
  const chooseName = (value: string) => {
    const person = normalizePresence({ name: value });
    if (!person) return;
    localStorage.setItem("locdoc.guestName", person.name);
    setName(person.name);
    setNeedsName(false);
  };
  const [sidebar, setSidebar] = useState(() => {
    try {
      const saved = localStorage.getItem("locdoc.sidebar");
      if (saved === "open" || saved === "closed") return saved === "open";
    } catch {
      // A blocked preference store must not prevent opening the workspace.
    }
    return window.innerWidth > 760;
  });
  useEffect(() => {
    try {
      localStorage.setItem("locdoc.sidebar", sidebar ? "open" : "closed");
    } catch {
      // The sidebar still works when preferences cannot be saved.
    }
  }, [sidebar]);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [scope, setScope] = useState("all");
  const [foldersOpen, setFoldersOpen] = useState(false);
  const current = useRef(id);
  const folderView = useRef(false);
  current.current = id;
  const navigation = useRef(0);
  const navigate = useCallback(
    async (
      from: string | null,
      next: string | null,
      prepare: () => Promise<void>,
    ) => {
      if (current.current !== from) return false;
      const request = ++navigation.current;
      await prepare();
      if (navigation.current !== request || current.current !== from)
        return false;
      current.current = next;
      setInitialDocument(null);
      setId(next);
      return true;
    },
    [],
  );
  const loadTree = useCallback(async () => {
    try {
      const { entries } = await api<{ entries: Entry[] }>(
        sharedToken && folderView.current
          ? `/api/tree?token=${encodeURIComponent(sharedToken)}`
          : "/api/tree",
      );
      setEntries(entries);
      setError("");
      if (!current.current)
        setId(entries.find((e) => e.kind === "file")?.id || null);
    } catch (error) {
      setError((error as Error).message);
    }
  }, []);
  useEffect(() => {
    const unavailable = (error: Error) => {
      setError(error.message);
      setConfig({
        owner: false,
        root: "",
        guest: "",
        publicUrl: location.origin,
      });
    };
    const ticket = new URLSearchParams(location.hash.slice(1)).get("ticket");
    if (ticket) {
      history.replaceState(null, "", location.pathname);
      void api("/api/redeem", send("POST", { ticket }))
        .then(() => location.reload())
        .catch(unavailable);
      return;
    }
    const open = async () => {
      if (sharedToken) {
        const response = ownerSession()
          ? null
          : await (window.__locdocOpen ||
              fetch(
                `/api/open/${encodeURIComponent(sharedToken)}${location.search}`,
              ));
        const data = response
          ? await response.json()
          : await api<Config & { document: Document | null; entries: Entry[] }>(
              `/api/open/${encodeURIComponent(sharedToken)}${location.search}`,
            );
        if (response && !response.ok)
          throw new Error(data.error || "This sharing link is unavailable.");
        setInitialDocument(data.document);
        folderView.current = !!data.folder;
        setConfig(data);
        if (data.folder) {
          setEntries(data.entries);
          setFoldersOpen(true);
        }
        if (data.owner) setName(data.ownerName || "Owner");
        else
          setNeedsName(
            !normalizePresence({
              name: localStorage.getItem("locdoc.guestName"),
            }),
          );
        setId(data.document?.id || null);
      } else {
        const config = await api<Config>("/api/config");
        setConfig(config);
        if (config.owner) {
          await loadTree();
          setName(config.ownerName || "Owner");
        }
      }
    };
    void open().catch(unavailable);
    const fonts = document.createElement("link");
    fonts.rel = "stylesheet";
    fonts.href = "/api/fonts.css";
    fonts.id = "installed-fonts";
    document.head.appendChild(fonts);
    return () => fonts.remove();
  }, [loadTree]);
  useEffect(() => {
    if (!id || (sharedToken && !config?.folder)) return;
    const url = sharedToken
      ? `/s/${encodeURIComponent(sharedToken)}?doc=${encodeURIComponent(id)}`
      : `/d/${encodeURIComponent(id)}`;
    if (location.pathname + location.search !== url)
      history.replaceState(null, "", url + location.hash);
  }, [id, config?.folder]);
  useEffect(() => {
    if (name) localStorage.setItem("locdoc.name", name);
    if (config && !config.owner && !needsName && normalizePresence({ name }))
      localStorage.setItem(
        "locdoc.guestName",
        normalizePresence({ name })!.name,
      );
  }, [name, config?.owner, needsName]);
  useEffect(() => {
    if (!config?.owner && !config?.folder) return;
    if (sharedToken && !config.folder) return;
    const timer = setInterval(loadTree, 4000);
    return () => clearInterval(timer);
  }, [config?.owner, config?.folder, loadTree]);
  return {
    appearance,
    config,
    entries,
    id,
    navigate,
    initialDocument,
    error,
    name,
    setName,
    needsName,
    chooseName,
    sidebar,
    setSidebar,
    query,
    setQuery,
    collapsed,
    setCollapsed,
    scope,
    setScope,
    foldersOpen,
    setFoldersOpen,
    loadTree,
  };
}
export type Workspace = ReturnType<typeof useWorkspace>;
