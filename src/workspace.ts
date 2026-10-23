import { useCallback, useEffect, useRef, useState } from "react";
import { SIDEBAR_MIN, SIDEBAR_MAX } from "./sidebar-resize";
import { hasUnstoredDrafts } from "./drafts";
import { useAppearance } from "./appearance";
import { protectTouchViewport } from "./touch-viewport";
import { api, ownerSession, revalidate, send, type Kept } from "./api";
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
// How far the sidebar list is scrolled, in pixels, in each view and in the
// current search's results.
export type SidebarScroll = Record<SidebarView | "search", number>;

declare global {
  interface Window {
    // public/theme.js starts a share link's open request before the bundle.
    __locdocOpen?: Promise<Response | null>;
  }
}

// The tree is listed again every few seconds and usually has not changed.
// A listing equal to the one shown keeps it, and each entry that is the same
// keeps its object, so the sidebar and editor render again only for what
// changed, such as the time of a document just saved.
export function keepUnchanged(shown: Entry[], listed: Entry[]) {
  const known = new Map(shown.map((entry) => [entry.path, entry]));
  let changed = shown.length !== listed.length;
  const kept = listed.map((entry, index) => {
    const before = known.get(entry.path);
    const same = before && sameEntry(before, entry) ? before : entry;
    if (same !== shown[index]) changed = true;
    return same;
  });
  return changed ? kept : shown;
}
function sameEntry(a: Entry, b: Entry) {
  const keys = Object.keys(a) as (keyof Entry)[];
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => a[key] === b[key])
  );
}

// The folders open in Folders, as this browser left them. The owner's
// workspace and each folder link keep their own, since a link's paths start
// at its folder. A link's key holds a hash of its token, as its drafts do,
// never the token.
export const openFoldersKey = (token?: string) =>
  token
    ? `locdoc.openFolders.link.${linkHash(token)}`
    : "locdoc.openFolders.owner";
const OPEN_FOLDERS = openFoldersKey(sharedToken);
// cyrb53: 53 bits keep apart the links one browser opens.
function linkHash(token: string) {
  let a = 0xdeadbeef;
  let b = 0x41c6ce57;
  for (let index = 0; index < token.length; index++) {
    const code = token.charCodeAt(index);
    a = Math.imul(a ^ code, 2654435761);
    b = Math.imul(b ^ code, 1597334677);
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507);
  a ^= Math.imul(b ^ (b >>> 13), 3266489909);
  b = Math.imul(b ^ (b >>> 16), 2246822507);
  b ^= Math.imul(a ^ (a >>> 13), 3266489909);
  return (4294967296 * (2097151 & b) + (a >>> 0)).toString(36);
}
// What is stored, or null while storage refuses to be read.
function storedFolders(): Set<string> | null {
  let saved: string | null;
  try {
    saved = localStorage.getItem(OPEN_FOLDERS);
  } catch {
    return null;
  }
  try {
    const paths: unknown = JSON.parse(saved || "[]");
    if (Array.isArray(paths))
      return new Set(
        paths.filter(
          (path): path is string => typeof path === "string" && path !== "",
        ),
      );
  } catch {
    // A damaged value opens nothing, and the next change replaces it.
  }
  return new Set();
}
// Another tab may have opened or closed folders since this one loaded. A
// change stores only the folders it opened and closed, over what is stored
// at that moment, so tabs keep each other's folders and, for one folder, the
// last change wins. A tab shows the others' changes when it loads again.
function storeFolders(before: Set<string>, after: Set<string>) {
  const opened = [...after].filter((path) => !before.has(path));
  const closed = [...before].filter((path) => !after.has(path));
  if (!opened.length && !closed.length) return;
  const stored = storedFolders();
  if (!stored) return;
  for (const path of closed) stored.delete(path);
  for (const path of opened) stored.add(path);
  try {
    if (stored.size)
      localStorage.setItem(OPEN_FOLDERS, JSON.stringify([...stored].sort()));
    else localStorage.removeItem(OPEN_FOLDERS);
  } catch {
    // Folders still open and close; this browser cannot remember them.
  }
}
// The open folders are read before the first render, so the tree never
// opens visibly after it loads.
function useOpenFolders() {
  const [open, setOpen] = useState(() => storedFolders() ?? new Set<string>());
  // The folders as last stored. A listing judges only those open when it
  // was asked for.
  const stored = useRef(open);
  useEffect(() => {
    storeFolders(stored.current, open);
    stored.current = open;
  }, [open]);
  return [open, setOpen, stored] as const;
}
// A listing closes the open folders it no longer lists, among those open
// when it was asked for: a folder opened since may be newer than the
// listing. This forgets folders another app removed or renamed, so what is
// stored never outgrows the tree.
function closeGone(open: Set<string>, asked: Set<string>, entries: Entry[]) {
  let listed: Set<string> | undefined;
  let next: Set<string> | undefined;
  for (const path of asked) {
    if (!open.has(path)) continue;
    listed ??= new Set(
      entries.flatMap((entry) => (entry.kind === "folder" ? [entry.path] : [])),
    );
    if (!listed.has(path)) (next ??= new Set(open)).delete(path);
  }
  return next ?? open;
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
  const [expanded, setExpanded, openFolders] = useOpenFolders();
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
  // How far the sidebar's list is scrolled in each view; a list that mounts
  // again takes its position back from here.
  const sidebarScroll = useRef<SidebarScroll>({
    date: 0,
    folders: 0,
    search: 0,
  }).current;
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
  // The last listing the server sent in full, with its tag. A tree that has
  // not changed since is answered without a body and this one stands, as if
  // it had been sent again.
  const listed = useRef<Kept<{ entries: Entry[] }> | null>(null);
  const loadTree = useCallback(async () => {
    const request = ++treeRequest.current;
    const changed = treeChanged.current;
    const asked = openFolders.current;
    try {
      const kept = await revalidate<{ entries: Entry[] }>(
        sharedToken && folderView.current
          ? `/api/tree?token=${encodeURIComponent(sharedToken)}`
          : "/api/tree",
        listed.current,
      );
      listed.current = kept;
      const { entries } = kept.body;
      if (request < treeApplied.current || changed !== treeChanged.current)
        return;
      treeApplied.current = request;
      setEntries((shown) => keepUnchanged(shown, entries));
      setExpanded((open) => closeGone(open, asked, entries));
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
        const asked = openFolders.current;
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
          setExpanded((shown) => closeGone(shown, asked, data.entries));
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
