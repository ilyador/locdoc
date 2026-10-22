import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { api, send } from "./api";
import {
  ancestors,
  baseName,
  checkName,
  copyName,
  entryFormat,
  extensionOf,
  joinPath,
  parentPath,
  relocateEntries,
  relocatePaths,
  siblingNames,
  within,
  type DocumentExtension,
} from "./file-names";
import type { Entry, TrashItem } from "./model";
import type { SidebarView } from "./workspace";

// Sidebar file actions belong to the workspace, not to the open document:
// they change the tree, survive navigation and never write to a document's
// state. Each action takes a sequence number when it starts, so a response
// that arrives after a later action cannot replace that action's feedback.

export type FileEdit = {
  id: number;
  mode: "create" | "rename";
  kind: "file" | "folder";
  view: SidebarView;
  // The folder that holds the new or renamed entry ("" is the root).
  parent: string;
  // Rename only: the entry's path, document id and current name.
  path?: string;
  entryId?: string | null;
  original?: string;
  value: string;
  saving: boolean;
  error: string;
  touched: boolean;
  returnFocus: string | null;
};
export type FileToast = {
  seq: number;
  message: string;
  tone: "done" | "error";
  undo?: TrashItem;
  restoring?: boolean;
};
type Prepare = () => Promise<void>;
// Where focus goes once an action finishes: `focus` moves keyboard focus
// there only when the action started from the tree.
type Origin = { focus?: boolean; neighbor?: string | null };

const EXTENSION_KEY = "locdoc.newDocumentExtension";
const TOAST_TIME = { done: 4000, error: 6000, undo: 10000 };
const ROOT_NAME = "Documents";

export function trashItem(value: unknown): TrashItem | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || typeof item.path !== "string") return null;
  const deleted = Number(item.deleted) || 0;
  return {
    id: item.id,
    kind: item.kind === "folder" ? "folder" : "document",
    path: item.path,
    // Every other Locdoc time is in seconds; accept milliseconds as well.
    deleted: deleted > 1e12 ? Math.floor(deleted / 1000) : deleted,
    documents: Array.isArray(item.documents)
      ? item.documents.length
      : Number(item.documents) || 0,
  };
}

async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Plain HTTP origins other than localhost have no asynchronous clipboard.
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.append(field);
    field.select();
    const copied = document.execCommand?.("copy");
    field.remove();
    if (!copied) throw new Error("Copying is blocked.");
  }
}

const fileEntry = (path: string, id: string | null): Entry => {
  const name = baseName(path);
  return {
    path,
    kind: "file",
    id,
    shared: false,
    modified: Math.floor(Date.now() / 1000),
    title: name.slice(0, name.length - extensionOf(name).length),
    format: entryFormat(path),
  };
};

export function useFileActions({
  owner,
  root,
  entries,
  patchEntries,
  loadTree,
  currentId,
  navigate,
  setExpanded,
  view,
  setView,
  setQuery,
  setSidebar,
}: {
  owner: boolean;
  root: string;
  entries: Entry[];
  patchEntries: (update: (entries: Entry[]) => Entry[]) => void;
  loadTree: () => Promise<void>;
  currentId: () => string | null;
  navigate: (
    from: string | null,
    next: string | null,
    prepare: Prepare,
  ) => Promise<boolean>;
  setExpanded: Dispatch<SetStateAction<Set<string>>>;
  view: SidebarView;
  setView: (view: SidebarView) => void;
  setQuery: (query: string) => void;
  setSidebar: (open: boolean) => void;
}) {
  const latest = useRef(entries);
  latest.current = entries;
  const [edit, setEditState] = useState<FileEdit | null>(null);
  const editRef = useRef(edit);
  const setEdit = (next: FileEdit | null) => {
    editRef.current = next;
    setEditState(next);
  };
  const editSeq = useRef(0);
  const actionSeq = useRef(0);
  const [fieldFocus, setFieldFocus] = useState(0);
  const [busy, setBusy] = useState<string[]>([]);
  const busyRef = useRef<string[]>([]);
  const [toast, setToastState] = useState<FileToast | null>(null);
  const toastRef = useRef(toast);
  const queue = useRef<FileToast[]>([]);
  const [held, setHeld] = useState(false);
  const [announcement, setAnnouncement] = useState({ seq: 0, text: "" });
  // The tree owns its focused row; it reports the row here without a render,
  // and actions request focus through `request`.
  const cursor = useRef<string | null>(null);
  const [request, setRequest] = useState({
    path: null as string | null,
    seq: 0,
    dom: false,
  });
  const [trashed, setTrashed] = useState<{
    seq: number;
    item: TrashItem;
  } | null>(null);
  const editorFocus = useRef<string | null>(null);
  const treeFocus = useRef(false);
  // Ctrl+Z in the tree restores the latest deletion until another change.
  const lastDeletion = useRef<TrashItem | null>(null);
  const restoring = useRef(new Set<string>());
  const [extension, setExtension] = useState<DocumentExtension>(() => {
    try {
      const saved = localStorage.getItem(EXTENSION_KEY);
      if (saved === ".fountain" || saved === ".txt") return saved;
    } catch {
      // New documents stay Markdown without preference storage.
    }
    return ".md";
  });

  const announce = (text: string) =>
    setAnnouncement((current) => ({ seq: current.seq + 1, text }));
  const focusPath = useCallback((path: string | null, dom = false) => {
    cursor.current = path;
    setRequest((current) => ({ path, seq: current.seq + 1, dom }));
  }, []);
  const setToast = (next: FileToast | null) => {
    toastRef.current = next;
    setToastState(next);
  };
  // An older action's response never replaces a later action's toast. Its
  // error waits until that toast closes; its success is only announced.
  const showToast = (next: FileToast) => {
    const current = toastRef.current;
    if (!current || current.seq <= next.seq) {
      setToast(next);
      setHeld(false);
    } else if (next.tone === "error") queue.current.push(next);
    else announce(next.message);
  };
  const dismissToast = useCallback(() => {
    const next = queue.current.shift() || null;
    toastRef.current = next;
    setToastState(next);
    setHeld(false);
  }, []);
  useEffect(() => {
    if (!toast || held || toast.restoring) return;
    const timer = setTimeout(
      dismissToast,
      toast.undo
        ? TOAST_TIME.undo
        : toast.tone === "error"
          ? TOAST_TIME.error
          : TOAST_TIME.done,
    );
    return () => clearTimeout(timer);
  }, [toast, held, dismissToast]);

  // A change to a folder also changes everything inside it.
  const overlaps = (paths: string[], path: string) =>
    paths.some((other) => within(path, other) || within(other, path));
  const track = async <T,>(path: string, run: () => Promise<T>) => {
    busyRef.current = [...busyRef.current, path];
    setBusy(busyRef.current);
    try {
      return await run();
    } finally {
      const index = busyRef.current.indexOf(path);
      busyRef.current = busyRef.current.filter((_, i) => i !== index);
      setBusy(busyRef.current);
    }
  };
  const expand = (paths: string[]) =>
    setExpanded((previous) => {
      if (paths.every((path) => previous.has(path))) return previous;
      const next = new Set(previous);
      for (const path of paths) next.add(path);
      return next;
    });
  const refresh = () => void loadTree();
  const failure = (error: unknown) => (error as Error).message;
  const folderName = (folder: string) =>
    folder ? baseName(folder) : ROOT_NAME;

  const checkEdit = (current: FileEdit) =>
    checkName(current.value, {
      kind: current.kind,
      siblings: siblingNames(latest.current, current.parent, current.path),
      original: current.original,
      extension:
        current.mode === "rename"
          ? extensionOf(current.original || "") || ".md"
          : extension,
    });
  // An edit holding text the user may still want is never replaced.
  const editInUse = () => {
    const current = editRef.current;
    if (!current) return false;
    if (current.saving || current.error) return true;
    const check = checkEdit(current);
    return current.touched && !check.empty && !check.unchanged;
  };
  const begin = (
    next: Omit<FileEdit, "id" | "saving" | "error" | "touched">,
  ) => {
    if (!owner) return false;
    setSidebar(true);
    if (editInUse()) {
      setFieldFocus((value) => value + 1);
      return false;
    }
    setEdit({
      ...next,
      id: ++editSeq.current,
      saving: false,
      error: "",
      touched: false,
    });
    return true;
  };

  // VS Code's rule: create inside the focused folder, or beside the focused
  // document. By date has no folders, so new documents start at its top.
  const targetFolder = () => {
    const path = cursor.current;
    const entry = path
      ? latest.current.find((item) => item.path === path)
      : undefined;
    return !entry ? "" : entry.kind === "folder" ? entry.path : parentPath(entry.path);
  };
  const startCreate = (kind: "file" | "folder", folder?: string) => {
    const target: SidebarView = kind === "folder" ? "folders" : view;
    const parent = target === "date" ? "" : (folder ?? targetFolder());
    if (
      !begin({
        mode: "create",
        kind,
        view: target,
        parent,
        value: "",
        returnFocus: cursor.current,
      })
    )
      return;
    setQuery("");
    if (target !== view) setView(target);
    if (parent) expand([...ancestors(parent), parent]);
  };
  const startRename = (entry: Entry, inView: SidebarView = view) => {
    if (overlaps(busyRef.current, entry.path)) return;
    begin({
      mode: "rename",
      kind: entry.kind,
      view: inView,
      parent: parentPath(entry.path),
      path: entry.path,
      entryId: entry.id,
      original: baseName(entry.path),
      value: baseName(entry.path),
      returnFocus: entry.path,
    });
  };
  const changeEdit = (value: string) => {
    const current = editRef.current;
    if (!current || current.saving) return;
    setEdit({ ...current, value, touched: true, error: "" });
  };
  const cancelEdit = (restoreFocus = true) => {
    const current = editRef.current;
    if (!current || current.saving) return;
    setEdit(null);
    if (restoreFocus) focusPath(current.returnFocus, true);
  };

  // A path change: rename, drag and drop, or Move to.
  const relocate = async (entry: Entry, to: string) => {
    const from = entry.path;
    await track(from, () =>
      entry.kind === "file"
        ? api(
            `/api/docs/${encodeURIComponent(entry.id || "")}`,
            send("PATCH", { path: to }),
          )
        : api("/api/folders", send("PATCH", { from, to })),
    );
    patchEntries((items) => relocateEntries(items, from, to));
    setExpanded((paths) => relocatePaths(paths, from, to));
    lastDeletion.current = null;
    refresh();
  };

  const commitEdit = async (
    trigger: "enter" | "blur",
    prepare: Prepare = async () => {},
  ) => {
    const current = editRef.current;
    if (!current || current.saving) return;
    const check = checkEdit(current);
    if (check.unchanged || (check.empty && trigger === "blur")) {
      cancelEdit(trigger === "enter");
      return;
    }
    if (check.error) {
      // The text stays, and the field explains what to change.
      if (!current.touched) setEdit({ ...current, touched: true });
      return;
    }
    const seq = ++actionSeq.current;
    const path = joinPath(current.parent, check.name);
    const from = currentId();
    const saving = { ...current, saving: true, error: "" };
    setEdit(saving);
    // This edit cannot be replaced while it saves; never touch a newer one.
    const settle = (next: FileEdit | null) => {
      if (editRef.current?.id === current.id) setEdit(next);
    };
    try {
      if (current.mode === "rename") {
        const entry = latest.current.find((item) => item.path === current.path);
        if (!entry)
          throw new Error("It moved or was deleted. Close this field and try again.");
        await relocate(entry, path);
        settle(null);
        focusPath(path, trigger === "enter");
        announce(`Renamed to ${check.name}.`);
        return;
      }
      const created = await api<{ id?: string }>(
        "/api/files",
        send("POST", { path, kind: current.kind }),
      );
      settle(null);
      lastDeletion.current = null;
      const id = current.kind === "file" ? created.id || null : null;
      patchEntries((items) =>
        items.some((item) => item.path === path)
          ? items
          : [
              ...items,
              current.kind === "file"
                ? fileEntry(path, id)
                : {
                    path,
                    kind: "folder",
                    id: null,
                    shared: false,
                    title: check.name,
                  },
            ],
      );
      refresh();
      if (current.kind === "folder") {
        focusPath(path, trigger === "enter");
        announce(`Created folder ${check.name}.`);
        return;
      }
      focusPath(path);
      const typed = extensionOf(current.value.trim());
      if (typed && typed !== extension) {
        setExtension(typed);
        try {
          localStorage.setItem(EXTENSION_KEY, typed);
        } catch {
          // The preferred extension is a convenience only.
        }
      }
      announce(`Created ${check.name}.`);
      if (!id) return;
      editorFocus.current = id;
      let moved = false;
      try {
        moved = await navigate(from, id, prepare);
      } catch {
        showToast({
          seq,
          tone: "error",
          message: `${check.name} is ready in the sidebar. Unsaved changes here could not be stored, so this document stays open.`,
        });
      }
      if (!moved) {
        if (editorFocus.current === id) editorFocus.current = null;
      } else if (window.innerWidth <= 760) setSidebar(false);
    } catch (error) {
      settle({ ...saving, saving: false, error: failure(error), touched: true });
    }
  };

  const move = async (entry: Entry, folder: string, origin: Origin = {}) => {
    if (!owner || parentPath(entry.path) === folder) return;
    if (overlaps(busyRef.current, entry.path)) return;
    const seq = ++actionSeq.current;
    const name = baseName(entry.path);
    if (entry.kind === "folder" && within(folder, entry.path)) {
      showToast({
        seq,
        tone: "error",
        message: "A folder can’t move into itself or a folder inside it.",
      });
      return;
    }
    if (folder && overlaps(busyRef.current, folder)) return;
    if (siblingNames(latest.current, folder).includes(name)) {
      showToast({
        seq,
        tone: "error",
        message: `${folderName(folder)} already has an item named ${name}.`,
      });
      return;
    }
    const to = joinPath(folder, name);
    try {
      await relocate(entry, to);
      if (folder) expand([...ancestors(folder), folder]);
      focusPath(to, !!origin.focus);
      announce(`Moved ${name} to ${folderName(folder)}.`);
    } catch (error) {
      showToast({
        seq,
        tone: "error",
        message: `Could not move ${name}. ${failure(error)}`,
      });
    }
  };

  const remove = async (entry: Entry, origin: Origin = {}) => {
    if (!owner || overlaps(busyRef.current, entry.path)) return;
    const seq = ++actionSeq.current;
    const name = baseName(entry.path);
    try {
      const result = await track(entry.path, () =>
        entry.kind === "file"
          ? api<{ trash?: unknown }>(
              `/api/docs/${encodeURIComponent(entry.id || "")}`,
              send("DELETE"),
            )
          : api<{ trash?: unknown }>(
              "/api/folders",
              send("DELETE", { path: entry.path }),
            ),
      );
      const item = trashItem(result.trash) || {
        id: "",
        kind: entry.kind === "file" ? "document" : "folder",
        path: entry.path,
        deleted: Math.floor(Date.now() / 1000),
        documents: 0,
      };
      patchEntries((items) =>
        items.filter((other) => !within(other.path, entry.path)),
      );
      refresh();
      setTrashed({ seq, item });
      lastDeletion.current = item.id ? item : null;
      if (origin.neighbor !== undefined)
        focusPath(origin.neighbor, !!origin.focus);
      const count = item.documents;
      showToast({
        seq,
        tone: "done",
        undo: item.id ? item : undefined,
        message:
          entry.kind === "folder" && count
            ? `${name} and ${count} ${count === 1 ? "document" : "documents"} moved to Recently deleted.`
            : `${name} moved to Recently deleted.`,
      });
    } catch (error) {
      showToast({
        seq,
        tone: "error",
        message: `Could not delete ${name}. ${failure(error)}`,
      });
    }
  };

  // Settings restores quietly and reports in place; the dialog hides toasts.
  const restore = async (
    item: TrashItem,
    origin: Origin & { quiet?: boolean } = {},
  ): Promise<{ ok: true; path: string } | { ok: false; error: string }> => {
    if (!owner) return { ok: false, error: "Only the owner can restore." };
    const seq = ++actionSeq.current;
    const undoing = () => toastRef.current?.undo?.id === item.id;
    if (undoing()) setToast({ ...toastRef.current!, restoring: true });
    restoring.current.add(item.id);
    try {
      const result = await api<{ path?: string }>(
        `/api/trash/${encodeURIComponent(item.id)}/restore`,
        send("POST"),
      );
      const path = typeof result.path === "string" ? result.path : item.path;
      if (lastDeletion.current?.id === item.id) lastDeletion.current = null;
      refresh();
      expand(ancestors(path));
      focusPath(path, !!origin.focus);
      const done: FileToast = {
        seq,
        tone: "done",
        message: `Restored ${baseName(path)}.`,
      };
      // Undo replaces its own toast; anything newer keeps its place.
      if (undoing()) setToast(done);
      else if (origin.quiet) announce(done.message);
      else showToast(done);
      return { ok: true, path };
    } catch (error) {
      if (undoing()) setToast({ ...toastRef.current!, restoring: false });
      if (!origin.quiet)
        showToast({
          seq,
          tone: "error",
          message: `Could not restore ${baseName(item.path)}. ${failure(error)}`,
        });
      return { ok: false, error: failure(error) };
    } finally {
      restoring.current.delete(item.id);
    }
  };
  // The toast's deletion, or else the latest one with nothing changed since.
  const undo = (origin: Origin = {}) => {
    const item = toastRef.current?.undo ?? lastDeletion.current;
    if (!item || restoring.current.has(item.id)) return false;
    void restore(item, origin);
    return true;
  };

  const duplicate = async (entry: Entry, origin: Origin = {}) => {
    if (!owner || entry.kind !== "file" || overlaps(busyRef.current, entry.path))
      return;
    const seq = ++actionSeq.current;
    const folder = parentPath(entry.path);
    const tried: string[] = [];
    try {
      const created = await track(entry.path, async () => {
        for (;;) {
          const name = copyName(baseName(entry.path), [
            ...siblingNames(latest.current, folder),
            ...tried,
          ]);
          const path = joinPath(folder, name);
          try {
            const result = await api<{ id?: string; path?: string }>(
              `/api/docs/${encodeURIComponent(entry.id || "")}/duplicate`,
              send("POST", { path }),
            );
            return { id: result.id || null, path: result.path || path };
          } catch (error) {
            // Another tab or a desktop app took the name first.
            if ((error as { status?: number }).status !== 409 || tried.length > 3)
              throw error;
            tried.push(name);
          }
        }
      });
      patchEntries((items) =>
        items.some((item) => item.path === created.path)
          ? items
          : [...items, fileEntry(created.path, created.id)],
      );
      lastDeletion.current = null;
      refresh();
      focusPath(created.path, !!origin.focus);
      announce(`Duplicated as ${baseName(created.path)}.`);
    } catch (error) {
      showToast({
        seq,
        tone: "error",
        message: `Could not duplicate ${baseName(entry.path)}. ${failure(error)}`,
      });
    }
  };

  const copyPath = async (entry: Entry, relative: boolean) => {
    const seq = ++actionSeq.current;
    const text = relative
      ? entry.path
      : `${root.replace(/\/+$/, "")}/${entry.path}`;
    try {
      await writeClipboard(text);
      showToast({
        seq,
        tone: "done",
        message: relative ? "Relative path copied." : "Path copied.",
      });
    } catch {
      showToast({
        seq,
        tone: "error",
        message: `Could not copy. The path is ${text}`,
      });
    }
  };

  // Document options renamed the open document through its own form.
  const renamed = (id: string, path: string) => {
    const entry = latest.current.find(
      (item) => item.kind === "file" && item.id === id,
    );
    if (entry && entry.path !== path) {
      patchEntries((items) => relocateEntries(items, entry.path, path));
      expand(ancestors(path));
      focusPath(path);
    }
    refresh();
  };

  return {
    owner,
    edit,
    check: edit ? checkEdit(edit) : null,
    fieldFocus,
    busy,
    toast,
    announcement,
    request,
    trashed,
    startCreate,
    startRename,
    changeEdit,
    commitEdit,
    cancelEdit,
    move,
    remove,
    restore,
    undo,
    duplicate,
    copyPath,
    renamed,
    focusPath,
    cursor: () => cursor.current,
    setCursor: (path: string | null) => {
      cursor.current = path;
    },
    dismissToast,
    holdToast: setHeld,
    isBusy: (path: string) => overlaps(busy, path),
    // A remounted tree takes keyboard focus back once if it had it.
    keepTreeFocus: (value: boolean) => {
      treeFocus.current = value;
    },
    takeTreeFocus: () => {
      const value = treeFocus.current && !editorFocus.current;
      treeFocus.current = false;
      return value;
    },
    // The created document's workspace focuses its editor once.
    takeEditorFocus: (id: string) => {
      if (editorFocus.current !== id) return false;
      editorFocus.current = null;
      return true;
    },
  };
}
export type FileActions = ReturnType<typeof useFileActions>;
