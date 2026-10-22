import { useCallback, useEffect, useRef, useState } from "react";
import { SIDEBAR_MIN, SIDEBAR_MAX } from "./sidebar-resize";
import { hasUnstoredDrafts } from "./drafts";
import { useAppearance } from "./appearance";
import { protectTouchViewport } from "./touch-viewport";
import { api, ownerSession, send } from "./api";
import { normalizePresence } from "./presence";
import { useFileActions } from "./file-actions";
import {
  sharedToken,
  directDocumentId,
  type Config,
  type Document,
  type Entry,
} from "./model";

export type SidebarView = "date" | "folders";
// How far each sidebar view's list is scrolled, in pixels.
export type SidebarScroll = Record<SidebarView, number>;

declare global {
  interface Window {
    // public/theme.js starts a share link's open request before the bundle.
    __locdocOpen?: Promise<Response | null>;
  }
}

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
  // A guest's name stays in this browser. The owner's is stored with the
  // workspace, so every device shows the same one.
  const rememberGuestName = (value: string) => {
    try {
      localStorage.setItem("locdoc.guestName", value);
    } catch {
      // The name still applies in this tab when storage is blocked.
    }
  };
  const chooseName = (value: string) => {
    const person = normalizePresence({ name: value });
    if (!person) return;
    rememberGuestName(person.name);
    setName(person.name);
    setNeedsName(false);
  };
  // A name read from the server applies only while no newer read or save
  // has started.
  const nameRequest = useRef(0);
  const saveName = async (value: string) => {
    const person = normalizePresence({ name: value });
    if (!person) throw new Error("Enter a name (1–60 characters).");
    if (!config) throw new Error("Your workspace is still opening.");
    if (!config.owner) {
      rememberGuestName(person.name);
      setName(person.name);
      return person.name;
    }
    nameRequest.current++;
    const saved = await api<{ name: string }>(
      "/api/profile",
      send("PATCH", { name: person.name }),
    );
    nameRequest.current++;
    setName(saved.name);
    return saved.name;
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
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(() => {
    try {
      const value = localStorage.getItem("locdoc.sidebarWidth");
      if (value && Number.isFinite(Number(value)))
        return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Number(value)));
    } catch {
      // An unavailable preference store must not block the workspace.
    }
    return null;
  });
  useEffect(() => {
    try {
      if (sidebarWidth === null) localStorage.removeItem("locdoc.sidebarWidth");
      else localStorage.setItem("locdoc.sidebarWidth", String(sidebarWidth));
    } catch {
      // Resizing still works without preference storage.
    }
  }, [sidebarWidth]);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sidebarView, setSidebarView] = useState<SidebarView>(() => {
    try {
      const saved = localStorage.getItem("locdoc.sidebarView");
      if (saved === "date" || saved === "folders") return saved;
    } catch {
      // Viewing documents must not depend on preference storage.
    }
    return sharedToken ? "folders" : "date";
  });
  useEffect(() => {
    try {
      localStorage.setItem("locdoc.sidebarView", sidebarView);
    } catch {
      // Both views remain available without storage.
    }
  }, [sidebarView]);
  // The sidebar mounts again with each document's workspace, and its list
  // takes its scroll position back from here.
  const sidebarScroll = useRef<SidebarScroll>({ date: 0, folders: 0 }).current;
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
  // A listing that started before a file action finished, or before a newer
  // listing was applied, may hold the old tree. It must not undo that change.
  const treeRequest = useRef(0);
  const treeApplied = useRef(0);
  const treeChanged = useRef(0);
  const loadTree = useCallback(async () => {
    const request = ++treeRequest.current;
    const changed = treeChanged.current;
    try {
      const { entries } = await api<{ entries: Entry[] }>(
        sharedToken && folderView.current
          ? `/api/tree?token=${encodeURIComponent(sharedToken)}`
          : "/api/tree",
      );
      if (request < treeApplied.current || changed !== treeChanged.current)
        return;
      treeApplied.current = request;
      setEntries(entries);
      setError("");
      if (!current.current)
        setId(entries.find((e) => e.kind === "file")?.id || null);
    } catch (error) {
      if (request < treeApplied.current || changed !== treeChanged.current)
        return;
      setError((error as Error).message);
    }
  }, []);
  const patchEntries = useCallback(
    (update: (entries: Entry[]) => Entry[]) => {
      treeChanged.current++;
      setEntries(update);
    },
    [],
  );
  const files = useFileActions({
    owner: !!config?.owner && !sharedToken,
    root: config?.root || "",
    entries,
    patchEntries,
    loadTree,
    currentId: () => current.current,
    navigate,
    setExpanded,
    view: sidebarView,
    setView: setSidebarView,
    setQuery,
    setSidebar,
  });
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
  }, [name]);
  // The owner may have chosen another name in another tab or on another
  // device; a tab coming back into view shows it.
  useEffect(() => {
    if (!config?.owner) return;
    const refresh = () => {
      if (document.hidden) return;
      const request = ++nameRequest.current;
      void api<Config>("/api/config").then(
        (current) => {
          if (current.owner && request === nameRequest.current)
            setName(current.ownerName || "Owner");
        },
        () => {},
      );
    };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [config?.owner]);
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
    saveName,
    needsName,
    chooseName,
    sidebar,
    setSidebar,
    sidebarWidth,
    setSidebarWidth,
    query,
    setQuery,
    expanded,
    setExpanded,
    sidebarView,
    setSidebarView,
    sidebarScroll,
    loadTree,
    patchEntries,
    files,
  };
}
export type Workspace = ReturnType<typeof useWorkspace>;
