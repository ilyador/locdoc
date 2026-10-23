import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import { IconContext } from "@phosphor-icons/react";
import { NamePrompt } from "./name-prompt";
import { useSidebarFocus } from "./sidebar-focus";
import { WorkspaceSidebar } from "./workspace-sidebar";
import type { Entry } from "./model";
import type { Workspace } from "./workspace";

// What the open document's workspace does for the sidebar. The sidebar stays
// mounted while documents open, and reaches whichever document is open
// through this; each document's workspace sets it while it is mounted.
export type DocumentPort = {
  choose: (entry: Entry) => void;
  prepare: () => Promise<void>;
  shareFolder: (path: string) => void;
  settings: () => void;
  // The document's Open sidebar, which takes focus back as the sidebar
  // closes.
  trigger: RefObject<HTMLButtonElement | null>;
  // Whether the document is about to focus its editor, as one created from
  // the sidebar does.
  focusesEditor: () => boolean;
};
// What the frame gives the open document's workspace.
export type Frame = {
  port: RefObject<DocumentPort | null>;
  // Where the open document's workspace shows a shared document's note.
  note: HTMLElement | null;
  // Whether the sidebar covers the document as a drawer. The document is out
  // of reach meanwhile.
  covered: boolean;
};

const icons = { size: 18, weight: "regular" } as const;

// The workspace around the open document: the sidebar and the frame it
// shares with the document. A workspace lists a thousand documents, and
// building that list again for every document would block opening it, so
// this stays mounted while the document inside it changes.
export function WorkspaceFrame({
  workspace,
  children,
}: {
  workspace: Workspace;
  // The open document's workspace, given what the frame shares with it.
  children: (frame: Frame) => ReactNode;
}) {
  const { sidebar, setSidebar, sidebarWidth, files } = workspace;
  const port = useRef<DocumentPort | null>(null);
  const [note, setNote] = useState<HTMLElement | null>(null);
  const panel = useRef<HTMLElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  // Keyboard focus moves into the sidebar as it opens and back out to the
  // open document as it closes.
  const covered = useSidebarFocus({
    open: sidebar,
    setOpen: setSidebar,
    sidebar: panel,
    trigger: () => port.current?.trigger.current ?? null,
    editorTakesFocus: () => !!port.current?.focusesEditor(),
  });
  const choose = useCallback(
    (entry: Entry) => port.current?.choose(entry),
    [port],
  );
  const prepare = useCallback(
    () => port.current?.prepare() ?? Promise.resolve(),
    [port],
  );
  const shareFolder = useCallback(
    (path: string) => port.current?.shareFolder(path),
    [port],
  );
  const settings = useCallback(() => port.current?.settings(), [port]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.defaultPrevented && (e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        // A closed sidebar is inert: it opens before its search takes focus.
        flushSync(() => setSidebar(true));
        searchInput.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSidebar]);
  const style = {
    "--sidebar-custom-width":
      sidebarWidth === null ? undefined : `${sidebarWidth}px`,
  } as CSSProperties;
  return (
    <IconContext.Provider value={icons}>
      {workspace.needsName && <NamePrompt onChoose={workspace.chooseName} />}
      <div className={`app ${sidebar ? "with-sidebar" : ""}`} style={style}>
        <button
          className="sidebar-scrim"
          aria-label="Close sidebar"
          aria-hidden={!sidebar}
          inert={!sidebar}
          tabIndex={-1}
          onClick={() => setSidebar(false)}
        />
        <WorkspaceSidebar
          workspace={workspace}
          panel={panel}
          note={setNote}
          searchInput={searchInput}
          choose={choose}
          prepare={prepare}
          onCreate={(kind) => files.startCreate(kind)}
          onShareFolder={shareFolder}
          onSettings={settings}
        />
        {children({ port, note, covered })}
      </div>
    </IconContext.Provider>
  );
}
