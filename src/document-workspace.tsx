import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { flushSync } from "react-dom";
import { IconContext, WarningCircle, X } from "@phosphor-icons/react";
import { api, send } from "./api";
import { MarkdownEditor } from "./editor";
import type { EditorHandle, LinkTarget, Selection } from "./editor-types";
import { FolderShare, type ShareAccess } from "./sharing";
import { LinkPicker } from "./link-picker";
import { LinkPreview } from "./link-preview";
import { FormattingTools } from "./formatting-tools";
import { publishPresence } from "./presence";
import { DraftRecoveryNotice } from "./draft-recovery";
import { useDocument } from "./use-document";
import {
  AppearancePanel,
  documentFontFamily,
  useFontCategory,
} from "./appearance";
import { VersionHistory } from "./version-history";
import { IconButton } from "./ui";
import { documentFormat, documentName } from "./document-format";
import { NamePrompt } from "./name-prompt";
import { CommentConversation, useConversation } from "./document-conversation";
import { DocumentFooter } from "./document-footer";
import { DocumentFormatbar } from "./document-formatbar";
import { DocumentTopbar } from "./document-topbar";
import { uploadAttachment } from "./document-upload";
import {
  FileActionToast,
  Toast,
  useAction,
  useToast,
} from "./workspace-feedback";
import {
  DocumentOptions,
  DocumentSharePanel,
  OwnerLoginForm,
  WorkspaceSettings,
  downloadDocument,
  panelTitle,
} from "./workspace-panels";
import { baseName, within } from "./file-names";
import { TrashedDocument, TrashedNotice } from "./trash";
import { WorkspaceSidebar } from "./workspace-sidebar";
import { useSidebarFocus } from "./sidebar-focus";
import {
  EmptyWorkspace,
  OpeningDocument,
  OwnerWelcome,
} from "./workspace-welcome";
import { type Entry, sharedToken } from "./model";
import type { Workspace } from "./workspace";

export function DocumentWorkspace({ workspace }: { workspace: Workspace }) {
  const {
    config,
    entries,
    id,
    navigate,
    name,
    saveName,
    sidebar,
    setSidebar,
    sidebarWidth,
    loadTree,
    files,
  } = workspace;
  const {
    doc,
    setDoc,
    session,
    status,
    people,
    error: documentError,
    recovery,
    clearRecovery,
    storageWarning,
    setError,
    trashed,
    mediaRetry,
    reload,
    checkTrashed,
  } = useDocument(
    id,
    !!config && (config.owner || !!sharedToken),
    workspace.initialDocument,
  );
  // The tree follows renames made here, in other tabs and on the desktop, so
  // the open document takes its current path from there.
  const entry = id
    ? entries.find((item) => item.kind === "file" && item.id === id)
    : undefined;
  // Visitors see names only; folder links list paths below the shared folder.
  const listed = entry
    ? (doc ? doc.owner : config?.owner)
      ? entry.path
      : baseName(entry.path)
    : null;
  const path = listed ?? doc?.path ?? trashed?.path ?? null;
  useEffect(() => {
    if (path) document.title = `${documentName(path)} · locdoc`;
  }, [path]);
  const reopenedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!doc?.owner || !entry || entry.path === doc.path) return;
    if (documentFormat(entry.path) === documentFormat(doc.path)) {
      setDoc((value) =>
        value && value.id === entry.id ? { ...value, path: entry.path } : value,
      );
      return;
    }
    // A different format needs a different editor, so the document reopens,
    // once for each new name.
    if (reopenedFor.current === entry.path) return;
    reopenedFor.current = entry.path;
    void (session?.drafts.flush() ?? Promise.resolve()).then(reload, () =>
      setError(
        "Could not store unsaved changes. Keep this document open until connected.",
      ),
    );
  }, [entry?.path, doc?.path]);
  // Restoring brings the document back into the tree; open it again then.
  const trashedTree = useRef<typeof entries | null>(null);
  useEffect(() => {
    if (!trashed) {
      trashedTree.current = null;
      return;
    }
    if (!trashedTree.current) trashedTree.current = entries;
    else if (entries !== trashedTree.current && entry) reload();
  }, [trashed, entries, entry]);
  // Deleting the open document, or a folder holding it, from this sidebar.
  const trashEvent = files.trashed;
  const handledTrash = useRef(trashEvent?.seq ?? 0);
  useEffect(() => {
    if (!trashEvent || trashEvent.seq === handledTrash.current) return;
    handledTrash.current = trashEvent.seq;
    if (doc && within(doc.path, trashEvent.item.path)) checkTrashed();
  }, [trashEvent?.seq]);
  const format = documentFormat(doc?.path);
  const appearance = workspace.appearance.forFormat(format);
  const {
    font,
    fontSize,
    setFontSize,
    lineHeight,
    pageWidth,
    scrollPastEnd,
    paragraphSpacing,
  } = appearance;
  const fontCategory = useFontCategory(font);
  const [shareFolderPath, setShareFolderPath] = useState<string | null>(null);
  const [panel, setPanel] = useState<string | null>(null);
  const { toast, tell, dismiss } = useToast();
  const { busy, action } = useAction(tell);
  const error = documentError || workspace.error;
  const [apiKey, setApiKey] = useState("");
  const editor = useRef<EditorHandle>(null);
  const [linkSelection, setLinkSelection] = useState<Selection | null>(null);
  const [linkTarget, setLinkTarget] = useState<LinkTarget | null>(null);
  const closeLink = useCallback(() => setLinkTarget(null), []);
  const startLink = () => {
    if (!doc?.edit || documentFormat(doc.path) !== "markdown") return;
    setLinkSelection(editor.current?.selection() || null);
    setLinkTarget(null);
    setPanel("link");
  };
  const fileInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const appearanceTrigger = useRef<HTMLButtonElement>(null);
  const sidebarPanel = useRef<HTMLElement>(null);
  const sidebarTrigger = useRef<HTMLButtonElement>(null);
  // While the drawer covers the document, the document is out of reach.
  const drawerOpen = useSidebarFocus({
    open: sidebar,
    setOpen: setSidebar,
    sidebar: sidebarPanel,
    trigger: sidebarTrigger,
    memory: workspace.sidebarFocus,
    editorTakesFocus: () => !!id && files.focusesEditor(id),
  });
  const accessQuery = sharedToken
    ? `?token=${encodeURIComponent(sharedToken)}`
    : "";
  const endpoint = useCallback(
    (suffix = "") => `/api/docs/${id}${suffix}${accessQuery}`,
    [id, accessQuery],
  );
  const thread = useConversation({
    editor,
    endpoint,
    ready: !!doc,
    source: session?.ydoc.getText("content"),
    plain: format === "text",
    name,
    action,
  });
  const { comments, conversation, selection, currentComment } = thread;
  useEffect(() => {
    if (session) publishPresence(session.provider.awareness, name);
  }, [name, session]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.defaultPrevented && (e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        // A closed sidebar is inert: it opens before its search takes focus.
        flushSync(() => setSidebar(true));
        searchInput.current?.focus();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        tell("Changes save automatically.");
      }
      if (e.key === "Escape") {
        setLinkTarget(null);
        if (!dialog.current?.open) thread.close();
        setPanel(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tell]);
  // Hook order: this runs after useConversation's reveal effect. Closing a
  // modal dialog refocuses what had focus when it opened, so an update that
  // closed a dialog and opened a conversation would take focus from the
  // composer. No dialog control opens a conversation.
  useEffect(() => {
    if (panel && panel !== "appearance") dialog.current?.showModal();
    else dialog.current?.close();
  }, [panel]);
  const openDocument = async (next: string | null) => {
    try {
      const moved = await navigate(
        id,
        next,
        () => session?.drafts.flush() || Promise.resolve(),
      );
      if (moved && window.innerWidth <= 760) setSidebar(false);
    } catch {
      setError(
        "Could not store unsaved changes. Keep this document open until connected.",
      );
    }
  };
  const choose = (entry: Entry) => {
    void openDocument(entry.id);
  };
  const upload = (file: File) =>
    action(() =>
      uploadAttachment(file, {
        doc,
        session,
        editor,
        accessQuery,
        setDoc,
        tell,
      }),
    );
  const openCreate = (kind: "file" | "folder") => files.startCreate(kind);
  const prepareNavigation = () =>
    session?.drafts.flush() || Promise.resolve();
  // A document created from the sidebar opens ready for writing.
  useEffect(() => {
    if (!session || !doc || !files.takeEditorFocus(doc.id)) return;
    const active = document.activeElement;
    if (active && active !== document.body && !active.closest(".sidebar"))
      return;
    requestAnimationFrame(() => editor.current?.focus());
  }, [session]);
  const shareFolder = (path: string) => {
    setShareFolderPath(path);
    setPanel("folder-share");
  };
  const updateShare = async (permission: string, rotate = false) => {
    const result = await api<ShareAccess>(
      endpoint("/share"),
      send("POST", { permission, rotate }),
    );
    setDoc((d) => (d ? { ...d, ...result } : d));
    await loadTree();
  };
  const login = () =>
    action(async () => {
      await api("/api/login", send("POST", { key: apiKey }));
      setApiKey("");
      location.reload();
    });
  const toggleAppearance = () =>
    setPanel((current) => (current === "appearance" ? null : "appearance"));
  const filename = path ? documentName(path) : "Your workspace";
  // Only Markdown can hold links, images and videos.
  const markdown = format === "markdown";
  const formattingTools = (expanded = false) =>
    doc && (
      <FormattingTools
        expanded={expanded}
        format={format}
        editable={doc.edit}
        busy={busy}
        onEdit={(command) => {
          setPanel(null);
          if (editor.current) command(editor.current);
          requestAnimationFrame(() => editor.current?.focus());
        }}
        onLink={startLink}
        onUpload={() => {
          setPanel(null);
          fileInput.current?.click();
        }}
        onComment={() => {
          setPanel(null);
          thread.start();
        }}
      />
    );
  const style = {
    "--sidebar-custom-width":
      sidebarWidth === null ? undefined : `${sidebarWidth}px`,
    "--doc-font": documentFontFamily(font, fontCategory),
    "--doc-size": `${fontSize}px`,
    "--doc-line-height": lineHeight,
    "--doc-width": pageWidth === null ? undefined : `${pageWidth}px`,
    "--doc-end-space": scrollPastEnd ? "50cqh" : "0px",
    "--doc-paragraph-spacing": paragraphSpacing,
  } as CSSProperties;

  return (
    <IconContext.Provider value={{ size: 18, weight: "regular" }}>
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
          doc={doc}
          filename={filename}
          panel={sidebarPanel}
          searchInput={searchInput}
          choose={choose}
          prepare={prepareNavigation}
          onCreate={openCreate}
          onShareFolder={shareFolder}
          onSettings={() => setPanel("settings")}
        />
        <main className="workspace" inert={drawerOpen}>
          <DocumentTopbar
            doc={doc}
            path={path}
            filename={filename}
            people={people}
            sidebar={sidebar}
            openSidebar={() => setSidebar(true)}
            sidebarTrigger={sidebarTrigger}
            commentsOpen={thread.commentsOpen}
            toggleComments={thread.toggle}
            share={trashed ? undefined : () => setPanel("share")}
          />
          {storageWarning && (
            <div className="storage-notice" role="status">
              {storageWarning}
            </div>
          )}
          {trashed && doc && (
            <TrashedNotice files={files} item={trashed.item} />
          )}
          <DraftRecoveryNotice
            records={recovery}
            dismiss={clearRecovery}
            onError={setError}
          />
          {error && (
            <div className="error-banner" role="alert">
              <WarningCircle />
              <span>{error}</span>
              <button onClick={() => location.reload()}>Reload</button>
            </div>
          )}
          {doc && (
            <DocumentFormatbar
              editable={doc.edit}
              format={format}
              font={font}
              fontSize={fontSize}
              setFontSize={setFontSize}
              appearanceOpen={panel === "appearance"}
              toggleAppearance={toggleAppearance}
              appearanceTrigger={appearanceTrigger}
              optionsOpen={panel === "document"}
              openOptions={() => setPanel("document")}
              formatFountain={(kind) => editor.current?.formatFountain(kind)}
              tools={formattingTools()}
            />
          )}
          <div
            className={`document-layout ${panel === "appearance" ? "with-appearance" : ""}`}
          >
            {panel === "appearance" && (
              <AppearancePanel
                owner={!!config?.owner}
                value={appearance}
                onClose={() => {
                  setPanel(null);
                  appearanceTrigger.current?.focus({ preventScroll: true });
                }}
              />
            )}
            {trashed && !doc ? (
              <TrashedDocument
                files={files}
                item={trashed.item}
                path={trashed.path}
              />
            ) : !config ||
              (!doc &&
                !error &&
                Boolean((sharedToken && !config.folder) || id)) ? (
              <OpeningDocument />
            ) : !config.owner && !sharedToken ? (
              <OwnerWelcome onOpen={() => setPanel("login")} />
            ) : !doc ? (
              <EmptyWorkspace
                config={config}
                error={error}
                onCreate={() => openCreate("file")}
              />
            ) : (
              <div className="writing-pane">
                <div
                  className="document-canvas"
                  onClick={(event) => {
                    // Native editor selections and media controls own their clicks.
                    if (event.target === event.currentTarget)
                      editor.current?.focus();
                  }}
                >
                  {session ? (
                    <div>
                      <MarkdownEditor
                        key={session.ydoc.clientID}
                        ref={editor}
                        {...session}
                        editable={doc.edit}
                        id={doc.id}
                        scrollKey={`locdoc.scroll.${config.owner ? "owner" : config.guest}.${doc.id}`}
                        token={doc.mediaToken || sharedToken}
                        owner={doc.owner}
                        mediaRetry={mediaRetry}
                        path={doc.path}
                        entries={entries}
                        onLink={setLinkTarget}
                        onInsertLink={markdown ? startLink : undefined}
                        onIntegrityError={setError}
                        onComment={thread.start}
                        onUpload={
                          markdown
                            ? upload
                            : () =>
                                tell(
                                  "Use a Markdown document for images and videos.",
                                )
                        }
                        comments={comments}
                        activeComment={currentComment?.id}
                        commentDraft={selection}
                        onOpenComment={thread.open}
                        conversation={
                          conversation && (
                            <CommentConversation
                              thread={thread}
                              busy={busy}
                              editable={!!doc?.edit}
                            />
                          )
                        }
                      />
                    </div>
                  ) : (
                    <div className="loading-surface">
                      <div className="loading-line" />
                      <div className="loading-line" />
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
          <DocumentFooter
            status={status}
            doc={doc}
            id={id}
            text={session?.ydoc.getText("content")}
          />
          <input
            ref={fileInput}
            className="visually-hidden"
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/avif,video/mp4,video/webm,video/quicktime"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload(f);
              e.target.value = "";
            }}
          />
          <dialog
            ref={dialog}
            aria-labelledby="panel-title"
            className="dialog"
            onCancel={() => setPanel(null)}
            onClick={(e) => {
              if (e.target === dialog.current) setPanel(null);
            }}
          >
            <div className="dialog-content">
              <div className="dialog-heading">
                <h2 id="panel-title">{panelTitle(panel)}</h2>
                <IconButton label="Close dialog" onClick={() => setPanel(null)}>
                  <X size={18} />
                </IconButton>
              </div>
              {panel === "link" && doc?.edit && (
                <LinkPicker
                  entries={entries}
                  selection={linkSelection?.quote || ""}
                  onInsert={(url, label) => {
                    editor.current?.insertLink(
                      url,
                      label,
                      linkSelection?.anchor || null,
                    );
                    setPanel(null);
                    requestAnimationFrame(() => editor.current?.focus());
                  }}
                />
              )}
              {panel === "share" && doc && !trashed && (
                <DocumentSharePanel
                  doc={doc}
                  filename={filename}
                  name={name}
                  onChange={updateShare}
                  onShareFolder={shareFolder}
                />
              )}
              {panel === "folder-share" && config?.owner && shareFolderPath && (
                <FolderShare
                  key={shareFolderPath}
                  path={shareFolderPath}
                  name={name}
                  onChanged={loadTree}
                />
              )}
              {panel === "login" && (
                <OwnerLoginForm
                  apiKey={apiKey}
                  setApiKey={setApiKey}
                  busy={busy}
                  onSubmit={login}
                />
              )}
              {panel === "settings" && (
                <WorkspaceSettings
                  config={config}
                  id={id}
                  doc={doc}
                  session={session}
                  endpoint={endpoint}
                  name={name}
                  saveName={saveName}
                  files={files}
                  toggleAppearance={toggleAppearance}
                  lock={() =>
                    action(async () => {
                      await api("/api/logout", send("POST"));
                      location.href = "/";
                    })
                  }
                />
              )}
              {panel === "history" && doc && (
                <VersionHistory
                  endpoint={endpoint}
                  onRestore={() => {
                    setPanel(null);
                    tell(
                      "Version restored. Your previous text was kept in history.",
                    );
                  }}
                />
              )}
              {panel === "document" && doc && (
                <DocumentOptions
                  doc={doc}
                  format={format}
                  endpoint={endpoint()}
                  formatting={formattingTools(true)}
                  onDownload={() => {
                    downloadDocument(doc, session);
                    setPanel(null);
                  }}
                  onHistory={() => setPanel("history")}
                  onRename={(path) => {
                    setDoc((doc) => (doc ? { ...doc, path } : doc));
                    files.renamed(doc.id, path);
                    setPanel(null);
                  }}
                />
              )}
            </div>
          </dialog>
        </main>
        {linkTarget && doc && (
          <LinkPreview
            key={linkTarget.url}
            target={linkTarget}
            source={doc.id}
            token={sharedToken}
            onClose={closeLink}
            onDocument={(next) => {
              if (sharedToken && !config?.folder) {
                void session?.drafts
                  .flush()
                  .then(() => location.assign(`/d/${next}`))
                  .catch(() =>
                    setError(
                      "Could not store unsaved changes. Keep this document open until connected.",
                    ),
                  );
              } else void openDocument(next);
            }}
          />
        )}
        <div className="toast-region">
          <Toast message={toast} onDismiss={dismiss} />
          <FileActionToast files={files} />
        </div>
        <div className="visually-hidden" aria-live="polite" aria-atomic="true">
          <span key={files.announcement.seq}>{files.announcement.text}</span>
        </div>
      </div>
    </IconContext.Provider>
  );
}
