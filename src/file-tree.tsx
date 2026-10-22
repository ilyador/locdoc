import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  ArrowElbowDownRight,
  CaretDown,
  CaretRight,
  Copy,
  CopySimple,
  DotsThree,
  FilePlus,
  FileText,
  Files,
  Folder,
  FolderOpen,
  FolderPlus,
  LinkSimple,
  Path,
  PencilSimple,
  ShareNetwork,
  Trash,
} from "@phosphor-icons/react";
import { ContextMenu, type MenuEntry, type MenuPosition } from "./context-menu";
import { documentExtension } from "./document-format";
import { documentTitle } from "./document-links";
import type { FileActions } from "./file-actions";
import { baseName, parentPath, within } from "./file-names";
import { InlineName } from "./inline-name";
import type { Entry } from "./model";
import { sidebarTimestamp } from "./recent-documents";
import { mac, shortcuts } from "./shortcuts";
import type { SidebarView } from "./workspace";

export type TreeRow =
  | {
      type: "entry";
      entry: Entry;
      depth: number;
      setsize: number;
      posinset: number;
    }
  | { type: "create"; depth: number; parent: string };

const MOVE_TYPE = "application/x-locdoc-entry";
const EXPAND_DELAY = 600;
const indentOf = (depth: number, folder: boolean) =>
  12 + depth * 16 + (folder ? 0 : 18);

type Menu = {
  path: string | null;
  at: MenuPosition;
  focusFirst: boolean;
  fromButton: boolean;
};

// A VS Code-style ARIA tree: one row takes Tab focus, arrows move between
// visible rows, Right and Left open, close and climb folders, Enter opens,
// and owners get F2, Delete, a context menu and drag and drop.
export function FileTree({
  view,
  rows,
  entries,
  id,
  label,
  files,
  isOpen,
  toggle,
  choose,
  shareFolder,
  prepare,
  empty,
}: {
  view: SidebarView;
  rows: TreeRow[];
  entries: Entry[];
  id: string | null;
  label: string;
  files?: FileActions;
  isOpen: (path: string) => boolean;
  toggle: (path: string) => void;
  choose: (entry: Entry) => void;
  shareFolder?: (path: string) => void;
  prepare?: () => Promise<void>;
  empty: ReactNode;
}) {
  const owner = !!files?.owner;
  const treeId = useId();
  const container = useRef<HTMLDivElement>(null);
  const elements = useRef(new Map<string, HTMLLIElement>());
  const entryRows = rows.filter(
    (row): row is Extract<TreeRow, { type: "entry" }> => row.type === "entry",
  );
  const paths = entryRows.map((row) => row.entry.path);
  const [cursor, setCursorState] = useState<string | null>(
    () => files?.cursor() ?? null,
  );
  const setCursor = (path: string | null) => {
    setCursorState(path);
    files?.setCursor(path);
  };
  const activePath =
    entryRows.find((row) => row.entry.kind === "file" && row.entry.id === id)
      ?.entry.path ?? null;
  const roving =
    cursor && paths.includes(cursor) ? cursor : (activePath ?? paths[0] ?? null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const keyMenu = useRef(0);
  const typed = useRef({ text: "", at: 0 });
  const dragged = useRef<Entry | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const expandTimer = useRef<{ path: string; timer: number } | null>(null);
  const handled = useRef(files?.request.seq ?? 0);

  const focusRow = (path: string | null, scroll = true) => {
    const element = path ? elements.current.get(path) : undefined;
    setCursor(path);
    element?.focus({ preventScroll: !scroll });
  };
  // Focus may follow an action only while the user has not moved elsewhere.
  const mayTakeFocus = () => {
    const active = document.activeElement;
    return (
      !active ||
      active === document.body ||
      !!container.current?.contains(active) ||
      !!active.closest?.(".context-menu, .toast-region, .sidebar")
    );
  };
  useLayoutEffect(() => {
    if (files?.takeTreeFocus()) focusRow(roving, false);
    const tree = container.current;
    return () => {
      if (tree?.contains(document.activeElement)) files?.keepTreeFocus(true);
    };
  }, []);
  const request = files?.request;
  useLayoutEffect(() => {
    if (!request || request.seq === handled.current) return;
    handled.current = request.seq;
    setCursorState(request.path);
    if (!request.dom || !mayTakeFocus()) return;
    const element = request.path
      ? elements.current.get(request.path)
      : undefined;
    (element || (roving ? elements.current.get(roving) : undefined))?.focus();
  }, [request?.seq]);

  const entryAt = (path: string | null) =>
    path === null
      ? undefined
      : entryRows.find((row) => row.entry.path === path)?.entry;
  // The row that takes focus once `path` and its contents leave the tree.
  const neighbor = (path: string) => {
    const index = paths.indexOf(path);
    const after = paths.slice(index + 1).find((other) => !within(other, path));
    const before = paths
      .slice(0, Math.max(0, index))
      .reverse()
      .find((other) => !within(other, path));
    return after ?? before ?? null;
  };

  const folderChoices = (entry: Entry): MenuEntry[] => {
    const current = parentPath(entry.path);
    // Segment by segment, so every folder lists right after its parent.
    const folders = entries
      .filter(
        (item) =>
          item.kind === "folder" &&
          !(entry.kind === "folder" && within(item.path, entry.path)),
      )
      .map((item) => item.path.split("/"))
      .sort((a, b) => {
        for (let index = 0; index < Math.min(a.length, b.length); index++) {
          const order = a[index].localeCompare(b[index], undefined, {
            numeric: true,
            sensitivity: "base",
          });
          if (order) return order;
        }
        return a.length - b.length;
      });
    return [
      { path: "", depth: 0 },
      ...folders.map((parts) => ({ path: parts.join("/"), depth: parts.length })),
    ].map(({ path, depth }) => ({
      label: path ? baseName(path) : "Documents",
      icon: path ? Folder : Files,
      depth,
      disabled: path === current || files!.isBusy(path),
      detail: path === current ? "Current" : undefined,
      run: () => void files!.move(entry, path, { focus: true }),
    }));
  };
  const menuItems = (path: string | null): MenuEntry[] => {
    if (!files) return [];
    const entry = entryAt(path);
    const create = (folder: string): MenuEntry[] =>
      view === "date"
        ? [
            {
              label: "New document…",
              icon: FilePlus,
              run: () => files.startCreate("file"),
            },
          ]
        : [
            {
              label: "New document…",
              icon: FilePlus,
              run: () => files.startCreate("file", folder),
            },
            {
              label: "New folder…",
              icon: FolderPlus,
              run: () => files.startCreate("folder", folder),
            },
          ];
    if (!entry) return create("");
    const busy = files.isBusy(entry.path);
    const name = baseName(entry.path);
    const folder = entry.kind === "folder";
    const remove = () =>
      void files.remove(entry, { focus: true, neighbor: neighbor(entry.path) });
    const rename: MenuEntry = {
      label: "Rename…",
      icon: PencilSimple,
      shortcut: "F2",
      keys: "F2",
      disabled: busy,
      run: () => files.startRename(entry, view),
    };
    const copy: MenuEntry[] = [
      {
        label: "Copy path",
        icon: Copy,
        shortcut: shortcuts.copyPath[0],
        keys: shortcuts.copyPath[1],
        run: () => void files.copyPath(entry, false),
      },
      {
        label: "Copy relative path",
        icon: Path,
        shortcut: shortcuts.copyRelative[0],
        keys: shortcuts.copyRelative[1],
        run: () => void files.copyPath(entry, true),
      },
    ];
    const deletion: MenuEntry = {
      label: "Delete",
      icon: Trash,
      shortcut: shortcuts.remove[0],
      keys: shortcuts.remove[1],
      disabled: busy,
      run: remove,
    };
    const duplicate: MenuEntry = {
      label: "Duplicate",
      icon: CopySimple,
      disabled: busy,
      run: () => void files.duplicate(entry, { focus: true }),
    };
    if (view === "date")
      return [
        rename,
        duplicate,
        { kind: "separator" },
        ...copy,
        { kind: "separator" },
        deletion,
      ];
    return [
      ...create(folder ? entry.path : parentPath(entry.path)),
      { kind: "separator" },
      ...(folder && shareFolder
        ? [
            {
              label: "Share folder…",
              icon: ShareNetwork,
              run: () => shareFolder(entry.path),
            },
          ]
        : []),
      ...(folder ? [] : [duplicate]),
      {
        label: "Move to…",
        icon: ArrowElbowDownRight,
        disabled: busy,
        title: `Move ${name} to`,
        items: () => folderChoices(entry),
      },
      { kind: "separator" },
      ...copy,
      { kind: "separator" },
      rename,
      deletion,
    ];
  };
  const openMenu = (path: string | null, at: MenuPosition, focusFirst: boolean, fromButton = false) => {
    if (!owner) return;
    if (path) focusRow(path, false);
    setMenu({ path, at, focusFirst, fromButton });
  };
  const closeMenu = (reason: string) => {
    const path = menu?.path ?? null;
    setMenu(null);
    if (reason !== "outside") {
      const target = path ?? roving;
      const element = target ? elements.current.get(target) : undefined;
      if (element) focusRow(target, false);
    }
  };
  const menuAtRow = (path: string) => {
    const box = elements.current.get(path)?.getBoundingClientRect();
    return box
      ? { x: box.left + Math.min(48, box.width / 3), y: box.bottom + 2 }
      : { x: 0, y: 0 };
  };

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const target = event.target as HTMLElement;
    if (target.getAttribute("role") !== "treeitem" || !target.dataset.path)
      return;
    const path = target.dataset.path;
    const index = paths.indexOf(path);
    const entry = entryAt(path);
    if (!entry) return;
    const folder = entry.kind === "folder";
    const go = (next: string | undefined | null) => {
      event.preventDefault();
      if (next) focusRow(next);
    };
    const command = mac ? event.metaKey : event.ctrlKey;
    const key = event.key;
    if (key === "ArrowDown") return go(paths[index + 1]);
    if (key === "ArrowUp") return go(paths[index - 1]);
    if (key === "Home") return go(paths[0]);
    if (key === "End") return go(paths.at(-1));
    if (key === "ArrowRight") {
      event.preventDefault();
      if (!folder) return;
      if (!isOpen(path)) toggle(path);
      else if (parentPath(paths[index + 1] || "") === path)
        focusRow(paths[index + 1]);
      return;
    }
    if (key === "ArrowLeft") {
      event.preventDefault();
      if (folder && isOpen(path)) toggle(path);
      else if (paths.includes(parentPath(path))) focusRow(parentPath(path));
      return;
    }
    if (key === "Enter" || key === " ") {
      event.preventDefault();
      if (folder) toggle(path);
      else choose(entry);
      return;
    }
    if (!owner || !files) {
      typeahead(event, index);
      return;
    }
    if ((event.shiftKey && key === "F10") || key === "ContextMenu") {
      event.preventDefault();
      keyMenu.current = Date.now();
      openMenu(path, menuAtRow(path), true);
      return;
    }
    if (key === "F2") {
      event.preventDefault();
      files.startRename(entry, view);
      return;
    }
    if (key === "Delete" || (mac && event.metaKey && key === "Backspace")) {
      event.preventDefault();
      void files.remove(entry, { focus: true, neighbor: neighbor(path) });
      return;
    }
    if (command && !event.shiftKey && !event.altKey && key.toLowerCase() === "z") {
      if (files.undo({ focus: true })) event.preventDefault();
      return;
    }
    if (event.code === "KeyC" && event.altKey) {
      const relative = mac
        ? event.metaKey && event.shiftKey
        : event.ctrlKey && event.shiftKey;
      const absolute = mac
        ? event.metaKey && !event.shiftKey
        : event.shiftKey && !event.ctrlKey && !event.metaKey;
      if (relative || absolute) {
        event.preventDefault();
        void files.copyPath(entry, relative);
      }
      return;
    }
    typeahead(event, index);
  };
  // Typing a name's first letters moves to the next matching row.
  const typeahead = (event: KeyboardEvent, index: number) => {
    if (
      event.key.length !== 1 ||
      event.key === " " ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    )
      return;
    const now = Date.now();
    typed.current =
      now - typed.current.at > 700
        ? { text: event.key.toLocaleLowerCase(), at: now }
        : { text: typed.current.text + event.key.toLocaleLowerCase(), at: now };
    const titles = entryRows.map((row) =>
      documentTitle(row.entry).toLocaleLowerCase(),
    );
    const first = typed.current.text.length > 1 ? 0 : 1;
    for (let offset = first; offset <= titles.length; offset++) {
      const candidate = (index + offset) % titles.length;
      if (titles[candidate].startsWith(typed.current.text)) {
        event.preventDefault();
        focusRow(paths[candidate]);
        return;
      }
    }
  };

  // Drag and drop moves documents and folders into folders or the root.
  const canDrag = owner && view === "folders";
  const accepts = (folder: string) => {
    const entry = dragged.current;
    if (!entry || !files) return false;
    if (parentPath(entry.path) === folder) return false;
    if (entry.kind === "folder" && within(folder, entry.path)) return false;
    return !folder || !files.isBusy(folder);
  };
  const clearExpand = () => {
    if (expandTimer.current) clearTimeout(expandTimer.current.timer);
    expandTimer.current = null;
  };
  const over = (event: DragEvent, folder: string, expandable?: string) => {
    if (!dragged.current) return;
    event.stopPropagation();
    if (!accepts(folder)) {
      event.dataTransfer.dropEffect = "none";
      setDropTarget(null);
      clearExpand();
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTarget(folder);
    if (!expandable) clearExpand();
    else if (expandTimer.current?.path !== expandable) {
      clearExpand();
      expandTimer.current = {
        path: expandable,
        timer: window.setTimeout(() => {
          expandTimer.current = null;
          if (dragged.current && !isOpen(expandable)) toggle(expandable);
        }, EXPAND_DELAY),
      };
    }
  };
  const drop = (event: DragEvent, folder: string) => {
    const entry = dragged.current;
    if (!entry) return;
    event.preventDefault();
    event.stopPropagation();
    const accepted = accepts(folder);
    finishDrag();
    if (accepted) void files?.move(entry, folder);
  };
  const finishDrag = () => {
    dragged.current = null;
    setDragging(null);
    setDropTarget(null);
    clearExpand();
  };

  const rowFor = (row: Extract<TreeRow, { type: "entry" }>) => {
    const e = row.entry;
    const folder = e.kind === "folder";
    const open = folder && isOpen(e.path);
    const active = !folder && e.id === id;
    // A rename shows wherever its row is listed.
    const editing =
      files?.edit?.mode === "rename" && files.edit.path === e.path;
    const busy = !!files?.isBusy(e.path);
    const nested = view === "folders";
    const stamp = !folder ? sidebarTimestamp(e.modified) : null;
    const labelId = `${treeId}-${paths.indexOf(e.path)}`;
    const detailId = `${labelId}-detail`;
    const parent = parentPath(e.path);
    const indent = nested ? indentOf(row.depth, folder) : 12;
    const name = baseName(e.path);
    const highlighted =
      dropTarget !== null &&
      dropTarget !== "" &&
      (dropTarget === e.path || within(e.path, dropTarget));
    return (
      <li
        key={e.path}
        ref={(element) => {
          if (element) elements.current.set(e.path, element);
          else elements.current.delete(e.path);
        }}
        role="treeitem"
        className={[
          "tree-item",
          e.kind,
          active ? "active" : "",
          editing ? "editing" : "",
          dropTarget === e.path ? "drop-target" : highlighted ? "in-drop-target" : "",
          dragging === e.path ? "dragging" : "",
          menu?.path === e.path ? "menu-open" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        title={editing ? undefined : e.path}
        data-path={e.path}
        aria-level={row.depth + 1}
        aria-setsize={row.setsize}
        aria-posinset={row.posinset}
        aria-expanded={folder ? open : undefined}
        aria-selected={active || undefined}
        aria-current={active ? "page" : undefined}
        aria-busy={busy || undefined}
        aria-labelledby={labelId}
        aria-describedby={!nested && (parent || stamp) ? detailId : undefined}
        tabIndex={!editing && e.path === roving ? 0 : -1}
        draggable={canDrag && !editing && !busy}
        style={editing || !nested ? undefined : { paddingLeft: indent }}
        onFocus={(event) => {
          if (event.target === event.currentTarget) setCursor(e.path);
        }}
        onClick={(event: MouseEvent) => {
          if (editing || event.defaultPrevented) return;
          focusRow(e.path, false);
          if (folder) toggle(e.path);
          else choose(e);
        }}
        onContextMenu={(event) => {
          if (!owner || editing) return;
          event.preventDefault();
          event.stopPropagation();
          // A keyboard menu key may also send this event.
          if (Date.now() - keyMenu.current < 400) return;
          const keyboard = event.clientX === 0 && event.clientY === 0;
          openMenu(
            e.path,
            keyboard ? menuAtRow(e.path) : { x: event.clientX, y: event.clientY },
            keyboard,
          );
        }}
        onDragStart={(event) => {
          if (!canDrag || editing || busy) {
            event.preventDefault();
            return;
          }
          dragged.current = e;
          setDragging(e.path);
          event.dataTransfer.effectAllowed = "move";
          try {
            event.dataTransfer.setData(MOVE_TYPE, e.path);
          } catch {
            // Some engines refuse custom types; the drag still works here.
          }
        }}
        onDragOver={(event) =>
          over(
            event,
            folder ? e.path : parent,
            folder && !open ? e.path : undefined,
          )
        }
        onDrop={(event) => drop(event, folder ? e.path : parent)}
        onDragEnd={finishDrag}
      >
        {editing && files ? (
          <InlineName
            files={files}
            indent={nested ? indentOf(row.depth, folder) : 12}
            prepare={prepare}
          />
        ) : (
          <>
            {folder ? (
              <>
                {open ? <CaretDown size={12} /> : <CaretRight size={12} />}
                {open ? <FolderOpen size={17} /> : <Folder size={17} />}
              </>
            ) : (
              <FileText size={16} />
            )}
            <span className="doc-name">
              <span className="doc-label" id={labelId}>
                <span className="doc-title">{documentTitle(e)}</span>{" "}
                {!folder && (
                  <span className="doc-extension">
                    {documentExtension(e.path)}
                  </span>
                )}
              </span>
              {!nested && parent && (
                <small>{parent.replaceAll("/", " / ")}</small>
              )}
            </span>
            {!folder && (
              <span className="doc-meta" id={nested ? undefined : detailId}>
                {!nested && parent && (
                  <span className="visually-hidden">in {parent}, </span>
                )}
                {e.shared && (
                  <LinkSimple size={12} className="shared-indicator" />
                )}
                {stamp && (
                  <time
                    className="doc-time"
                    dateTime={stamp.dateTime}
                    title={stamp.title}
                  >
                    {stamp.label}
                  </time>
                )}
              </span>
            )}
            {(owner || (folder && shareFolder)) && (
              <span className="tree-actions">
                {folder && shareFolder && (
                  <button
                    type="button"
                    className="icon-button tree-action"
                    tabIndex={-1}
                    aria-label={`Share folder ${e.path}`}
                    title={`Share folder ${e.path}`}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      shareFolder(e.path);
                    }}
                  >
                    <ShareNetwork size={16} />
                  </button>
                )}
                {owner && (
                  <button
                    type="button"
                    className="icon-button tree-action tree-more"
                    tabIndex={-1}
                    aria-label={`More actions for ${name}`}
                    title="More actions"
                    aria-haspopup="menu"
                    aria-expanded={menu?.path === e.path && menu.fromButton}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      const box = event.currentTarget.getBoundingClientRect();
                      openMenu(
                        e.path,
                        { x: box.right, y: box.bottom + 4, align: "end" },
                        event.detail === 0,
                        true,
                      );
                    }}
                  >
                    <DotsThree size={18} weight="bold" />
                  </button>
                )}
              </span>
            )}
          </>
        )}
      </li>
    );
  };
  const createRow = (row: Extract<TreeRow, { type: "create" }>) =>
    files?.edit && (
      <li
        key="new-entry"
        role="treeitem"
        className="tree-create"
        aria-level={row.depth + 1}
        aria-label={`New ${files.edit.kind === "folder" ? "folder" : "document"}`}
      >
        <InlineName
          files={files}
          indent={
            view === "folders"
              ? indentOf(row.depth, files.edit.kind === "folder")
              : 12
          }
          prepare={prepare}
        />
      </li>
    );

  return (
    <div
      ref={container}
      className={`file-tree-body ${dropTarget === "" ? "drop-root" : ""}`}
      onContextMenu={(event) => {
        // Rows open their own menu; a row's name field keeps the native one.
        if (
          !owner ||
          event.defaultPrevented ||
          (event.target as Element).closest?.('[role="treeitem"]')
        )
          return;
        event.preventDefault();
        openMenu(null, { x: event.clientX, y: event.clientY }, false);
      }}
      onDragOver={(event) => over(event, "")}
      onDrop={(event) => drop(event, "")}
      onDragLeave={(event) => {
        if (!container.current?.contains(event.relatedTarget as Node)) {
          setDropTarget(null);
          clearExpand();
        }
      }}
    >
      {rows.length > 0 && (
        <ul
          role="tree"
          aria-label={label}
          className="tree"
          onKeyDown={onKeyDown}
        >
          {rows.map((row) =>
            row.type === "entry" ? rowFor(row) : createRow(row),
          )}
        </ul>
      )}
      {!entryRows.length && empty}
      {menu && files && (
        <ContextMenu
          label={
            menu.path ? `Actions for ${baseName(menu.path)}` : "Workspace actions"
          }
          items={menuItems(menu.path)}
          at={menu.at}
          focusFirst={menu.focusFirst}
          onClose={closeMenu}
        />
      )}
    </div>
  );
}
