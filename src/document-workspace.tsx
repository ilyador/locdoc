import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  IconContext,
  Files,
  FileText,
  Folder,
  MagnifyingGlass,
  Plus,
  Minus,
  CaretDown,
  CaretRight,
  SidebarSimple,
  ArrowUpRight,
  ShareNetwork,
  X,
  Image,
  ChatCircle,
  TextAa,
  LockSimple,
  GlobeSimple,
  DotsThree,
  ArrowCounterClockwise,
  DownloadSimple,
  WarningCircle,
  PencilSimple,
  CheckCircle,
  Clock,
} from "@phosphor-icons/react";
import * as Y from "yjs";
import { api, send } from "./api";
import { MarkdownEditor, type EditorHandle, type Selection } from "./editor";
import { FolderShare, ShareControls, type ShareAccess } from "./sharing";
import { DocumentSidebar } from "./document-sidebar";
import { LinkPicker } from "./link-picker";
import { LinkPreview } from "./link-preview";
import type { LinkTarget } from "./editor";
import { FormattingTools } from "./formatting-tools";
import { captureInsertion, insertAttachment } from "./document-session";
import { normalizePresence, publishPresence } from "./presence";
import { CollaborationRecovery } from "./collaboration-recovery";
import { RemovedDocumentRecovery } from "./removed-document-recovery";
import { DraftRecoveryNotice } from "./draft-recovery";
import { useDocument } from "./use-document";
import { AppearancePanel, documentFontFamily } from "./appearance";
import { VersionHistory } from "./version-history";
import { RenameDocument } from "./rename-document";
import { CommentThread, CommentComposer } from "./comments";
import { IconButton, Avatar } from "./ui";
import { countDocumentWords } from "./word-count";
import {
  documentFormat,
  documentExtension,
  documentName,
  documentPath,
  type DocumentFormat,
} from "./document-format";
import type { FountainForce } from "./fountain";
import { useComments } from "./use-comments";
import { NamePrompt } from "./name-prompt";
declare global {
  interface Window {
    __locdocOpen?: Promise<Response | null>;
  }
}
import { type Entry, sharedToken } from "./model";
import type { Workspace } from "./workspace";
type DraftConversation = { kind: "draft"; selection: Selection };

export function DocumentWordMetrics({
  text,
  initial,
  path,
}: {
  text?: Y.Text;
  initial: string;
  path: string;
}) {
  const [count, setCount] = useState(() =>
    countDocumentWords(text?.toString() ?? initial, path),
  );
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const snapshot = () => {
      timer = undefined;
      setCount(countDocumentWords(text?.toString() ?? initial, path));
    };
    const changed = () => {
      timer ??= setTimeout(snapshot, 100);
    };
    snapshot();
    text?.observe(changed);
    return () => {
      clearTimeout(timer);
      text?.unobserve(changed);
    };
  }, [text, initial, path]);
  return (
    <>
      <span>
        {count.toLocaleString()} {count === 1 ? "word" : "words"}
      </span>
      <span className="reading-time">
        {Math.max(1, Math.ceil(count / 220))} min read
      </span>
    </>
  );
}

export function DocumentWorkspace({ workspace }: { workspace: Workspace }) {
  const {
    config,
    entries,
    id,
    navigate,
    name,
    setName,
    sidebar,
    setSidebar,
    query,
    setQuery,
    collapsed,
    setCollapsed,
    scope,
    setScope,
    loadTree,
    foldersOpen,
    setFoldersOpen,
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
  } = useDocument(
    id,
    !!config && (config.owner || !!sharedToken),
    workspace.initialDocument,
  );
  const appearance = workspace.appearance.forFormat(documentFormat(doc?.path));
  const {
    font,
    fontSize,
    setFontSize,
    lineHeight,
    pageWidth,
    scrollPastEnd,
    paragraphSpacing,
  } = appearance;
  const [shareFolderPath, setShareFolderPath] = useState<string | null>(null);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [newCommentDraft, setNewCommentDraft] = useState<{
    conversation: DraftConversation;
    body: string;
  } | null>(null);
  const [conversation, setConversation] = useState<
    DraftConversation | { kind: "thread"; id: string } | null
  >(null);
  const selection =
    conversation?.kind === "draft" ? conversation.selection : null;
  const commentsOpen = conversation !== null;
  const [panel, setPanel] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const busy = pending > 0;
  const [toast, setToast] = useState("");
  const error = documentError || workspace.error;
  const currentFooterStatus = doc || id ? status : "Local workspace";
  const [footerStatus, setFooterStatus] = useState(currentFooterStatus);
  useEffect(() => {
    if (currentFooterStatus === footerStatus) return;
    // Brief local or remote projection cycles should not animate the footer.
    // Completion and warnings are authoritative and must never wait on this
    // presentation-only delay.
    if (
      currentFooterStatus !== "Saving…" &&
      currentFooterStatus !== "Saving draft…" &&
      currentFooterStatus !== "Waiting for desktop file"
    ) {
      setFooterStatus(currentFooterStatus);
      return;
    }
    const timer = setTimeout(() => setFooterStatus(currentFooterStatus), 2000);
    return () => clearTimeout(timer);
  }, [currentFooterStatus, footerStatus]);
  const statusWarning =
    footerStatus.startsWith("Offline") ||
    footerStatus === "Recovery needed" ||
    footerStatus === "Unable to open document";
  const [newPath, setNewPath] = useState("");
  const [createFormat, setCreateFormat] = useState<DocumentFormat>("markdown");
  const [createKind, setCreateKind] = useState("file");
  const [apiKey, setApiKey] = useState("");
  const editor = useRef<EditorHandle>(null);
  const cancelComment = () => {
    if (conversation?.kind === "draft") {
      forgetRequest();
      setNewCommentDraft(null);
    } else if (conversation?.kind === "thread") {
      forgetRequest(conversation.id);
    }
    setConversation(null);
    editor.current?.focus();
  };
  const [linkSelection, setLinkSelection] = useState<Selection | null>(null);
  const [linkTarget, setLinkTarget] = useState<LinkTarget | null>(null);
  const closeLink = useCallback(() => setLinkTarget(null), []);
  const startLink = () => {
    if (!doc?.edit) return;
    setLinkSelection(editor.current?.selection() || null);
    setLinkTarget(null);
    setPanel("link");
  };
  const fileInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const appearanceTrigger = useRef<HTMLButtonElement>(null);
  const accessQuery = sharedToken
    ? `?token=${encodeURIComponent(sharedToken)}`
    : "";
  const endpoint = useCallback(
    (suffix = "") => `/api/docs/${id}${suffix}${accessQuery}`,
    [id, accessQuery],
  );
  const {
    comments,
    mutate: mutateComment,
    forgetRequest,
  } = useComments(endpoint, !!doc, session?.ydoc.getText("content"));
  const tell = useCallback((message: string) => setToast(message), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    if (session) publishPresence(session.provider.awareness, name);
  }, [name, session]);
  useEffect(() => {
    if (!commentsOpen) return;
    const dismiss = (event: MouseEvent) => {
      // Keep the original event path: Cancel may remove its own form before
      // this listener runs. Waiting for click also preserves editor caret hit
      // testing and avoids dismissing while a touch gesture is just scrolling.
      const inside = event
        .composedPath()
        .some(
          (node) =>
            node instanceof Element &&
            node.matches(
              ".inline-comment-host, .comment-marker, [data-comment-control]",
            ),
        );
      if (!inside) setConversation(null);
    };
    document.addEventListener("click", dismiss);
    return () => document.removeEventListener("click", dismiss);
  }, [commentsOpen]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.defaultPrevented && (e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSidebar(true);
        searchInput.current?.focus();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        tell("Changes save automatically.");
      }
      if (e.key === "Escape") {
        setLinkTarget(null);
        if (!dialog.current?.open) setConversation(null);
        setPanel(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tell]);
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
  const startComment = () => {
    if (selection) {
      document.getElementById("new-comment")?.focus();
      return;
    }
    if (newCommentDraft) {
      setConversation(newCommentDraft.conversation);
      return;
    }
    forgetRequest();
    const draft: DraftConversation = {
      kind: "draft",
      selection: editor.current?.selection(true) || { quote: "", anchor: null },
    };
    setNewCommentDraft({ conversation: draft, body: "" });
    setConversation(draft);
  };
  useEffect(() => {
    if (conversation?.kind === "thread")
      editor.current?.revealComment(conversation.id);
    if (conversation?.kind === "draft") {
      editor.current?.revealComment();
      document.getElementById("new-comment")?.focus({ preventScroll: true });
    }
  }, [conversation]);
  const action = async (fn: () => Promise<void>) => {
    setPending((count) => count + 1);
    try {
      await fn();
      return true;
    } catch (e) {
      tell((e as Error).message);
      return false;
    } finally {
      setPending((count) => count - 1);
    }
  };
  const upload = (file: File) =>
    action(async () => {
      const origin = session;
      if (!doc?.edit || !origin || origin.id !== doc.id) return;
      const video = file.type.startsWith("video/");
      if (file.size > (video ? 20 : 5) * 1e6)
        throw new Error(
          video
            ? "Videos must be 20 MB or smaller."
            : "Images must be 5 MB or smaller.",
        );
      const data = new FormData();
      data.append("file", file);
      const anchor = editor.current?.selection().anchor;
      const position = anchor
        ? {
            start: Y.createRelativePositionFromJSON(anchor.start),
            end: Y.createRelativePositionFromJSON(anchor.end),
          }
        : captureInsertion(origin.ydoc);
      const release = origin.retain();
      try {
        const result = await api<{ path: string; usage: number }>(
          `/api/docs/${origin.id}/upload${accessQuery}`,
          {
            method: "POST",
            body: data,
          },
        );
        const alt = file.name.replace(/[\\\[\]<>\r\n]/g, "");
        insertAttachment(
          origin.ydoc,
          position,
          `\n![${alt}](${result.path})\n`,
        );
        await origin.drafts.flush();
        setDoc((d) =>
          d?.id === origin.id ? { ...d, usage: result.usage } : d,
        );
        tell(
          `${video ? "Video" : "Image"} saved to ${doc.path.split("/").pop()}.`,
        );
      } finally {
        release();
      }
    });
  const createFile = () =>
    action(async () => {
      let path = newPath.trim();
      if (createKind === "file") path = documentPath(path, createFormat);
      const result = await api<{ id?: string }>(
        "/api/files",
        send("POST", { path, kind: createKind }),
      );
      setPanel(null);
      setNewPath("");
      await loadTree();
      if (result.id) await openDocument(result.id);
    });
  const updateShare = async (permission: string, rotate = false) => {
    const result = await api<ShareAccess>(
      endpoint("/share"),
      send("POST", { permission, rotate }),
    );
    setDoc((d) => (d ? { ...d, ...result } : d));
    await loadTree();
  };
  const addComment = (body: string) =>
    action(async () => {
      const c = await mutateComment("", {
        body,
        name: normalizePresence({ name })?.name || "Guest",
        quote: selection?.quote,
        anchor: selection?.anchor,
      });
      setNewCommentDraft((current) =>
        current?.conversation === conversation && current.body === body
          ? null
          : current,
      );
      setConversation((current) =>
        current === conversation ? { kind: "thread", id: c.id } : current,
      );
    });
  const updateComment = (
    cid: string,
    data: { body?: string; name?: string; resolved?: boolean },
  ) =>
    action(async () => {
      await mutateComment(cid, data);
    });
  const download = () => {
    const blob = new Blob(
      [session?.ydoc.getText("content").toString() ?? doc?.content ?? ""],
      {
        type:
          documentFormat(doc?.path) === "fountain"
            ? "text/plain;charset=utf-8"
            : "text/markdown;charset=utf-8",
      },
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = doc?.path.split("/").pop() || "document.md";
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const login = () =>
    action(async () => {
      await api("/api/login", send("POST", { key: apiKey }));
      setApiKey("");
      location.reload();
    });
  const toggleFolder = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const filename = doc ? documentName(doc.path) : "Your workspace";
  const fountain = documentFormat(doc?.path) === "fountain";
  const currentComment =
    conversation?.kind === "thread"
      ? comments.find((c) => c.id === conversation.id)
      : null;
  const currentCommentIndex = comments.findIndex(
    (c) => c.id === currentComment?.id,
  );
  const commentContent = conversation && (
    <section className="inline-conversation" aria-label="Comment conversation">
      {selection ? (
        <CommentComposer
          draft={newCommentDraft?.body || ""}
          onDraftChange={(body) =>
            setNewCommentDraft((current) =>
              current?.conversation === conversation
                ? { ...current, body }
                : current,
            )
          }
          busy={busy}
          onSubmit={addComment}
          onCancel={cancelComment}
        />
      ) : currentComment ? (
        <CommentThread
          key={currentComment.id}
          comment={currentComment}
          onResolve={() =>
            updateComment(currentComment.id, {
              resolved: !currentComment.resolved,
            })
          }
          navigation={
            comments.length > 1 && (
              <>
                <button
                  type="button"
                  disabled={currentCommentIndex <= 0}
                  onClick={() =>
                    setConversation({
                      kind: "thread",
                      id: comments[currentCommentIndex - 1].id,
                    })
                  }
                >
                  Previous comment
                </button>
                <button
                  type="button"
                  disabled={currentCommentIndex >= comments.length - 1}
                  onClick={() =>
                    setConversation({
                      kind: "thread",
                      id: comments[currentCommentIndex + 1].id,
                    })
                  }
                >
                  Next comment
                </button>
              </>
            )
          }
          canResolve={!!doc?.edit || !!currentComment.canResolve}
          onReply={(body) =>
            updateComment(currentComment.id, {
              body,
              name: normalizePresence({ name })?.name || "Guest",
            })
          }
          busy={busy}
          onCancel={cancelComment}
          draft={replyDrafts[currentComment.id] || ""}
          onDraftChange={(body) =>
            setReplyDrafts((current) => ({
              ...current,
              [currentComment.id]: body,
            }))
          }
        />
      ) : (
        <p className="field-help">This conversation is no longer available.</p>
      )}
    </section>
  );
  const formattingTools = (expanded = false) =>
    doc && (
      <FormattingTools
        expanded={expanded}
        fountain={fountain}
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
          startComment();
        }}
      />
    );
  const style = {
    "--doc-font": documentFontFamily(font),
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
        <aside
          className={`sidebar ${sidebar ? "is-open" : ""}`}
          inert={!sidebar}
        >
          <div className="brand-row">
            <a
              className="brand"
              href={sharedToken ? `/s/${encodeURIComponent(sharedToken)}` : "/"}
              aria-label="Locdoc home"
            >
              <span className="brand-mark">
                <img src="/icons/locdoc-v5.png" width="28" height="28" alt="" />
              </span>
              locdoc<span className="brand-dot">.</span>
            </a>
            <IconButton label="Close sidebar" onClick={() => setSidebar(false)}>
              <SidebarSimple />
            </IconButton>
          </div>
          {(config?.folder || (config?.owner && !sharedToken)) && (
            <>
              <label className="search-box">
                <MagnifyingGlass size={16} />
                <input
                  ref={searchInput}
                  placeholder="Find a document…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label="Find a document"
                />
                <kbd>Ctrl K</kbd>
              </label>
              {!config.folder && (
                <nav className="scope-nav" aria-label="Workspace views">
                  <button
                    className={scope === "all" ? "selected" : ""}
                    onClick={() => setScope("all")}
                  >
                    <Files />
                    All documents
                    <span>
                      {entries.filter((e) => e.kind === "file").length}
                    </span>
                  </button>
                  <button
                    className={scope === "shared" ? "selected" : ""}
                    onClick={() => setScope("shared")}
                  >
                    <ShareNetwork />
                    Shared with others
                    <span>
                      {entries.filter((e) => e.kind === "file" && e.shared)
                        .length || ""}
                    </span>
                  </button>
                </nav>
              )}
              <div className="section-label">
                <span>
                  {config.folder?.name ||
                    (scope === "shared" ? "SHARED DOCUMENTS" : "FILES")}
                </span>
                {config.owner && !sharedToken && (
                  <div>
                    <IconButton
                      label="New folder"
                      onClick={() => {
                        setCreateKind("folder");
                        setNewPath("");
                        setPanel("create");
                      }}
                    >
                      <Folder size={16} />
                    </IconButton>
                    <IconButton
                      label="New document"
                      onClick={() => {
                        setCreateKind("file");
                        setNewPath("");
                        setPanel("create");
                      }}
                    >
                      <Plus size={16} />
                    </IconButton>
                  </div>
                )}
              </div>
              <DocumentSidebar
                entries={entries}
                id={id}
                query={query}
                scope={scope}
                collapsed={collapsed}
                toggleFolder={toggleFolder}
                choose={choose}
                foldersOpen={foldersOpen}
                setFoldersOpen={setFoldersOpen}
                shareFolder={
                  config.owner && !sharedToken
                    ? (path) => {
                        setShareFolderPath(path);
                        setPanel("folder-share");
                      }
                    : undefined
                }
              />
              {config.owner && !sharedToken && (
                <button
                  className="new-doc"
                  onClick={() => {
                    setCreateKind("file");
                    setNewPath("");
                    setPanel("create");
                  }}
                >
                  <Plus size={16} />
                  New document
                </button>
              )}
            </>
          )}
          {sharedToken && doc && !config?.folder && (
            <div className="shared-sidebar">
              <FileText />
              <strong className="doc-label">
                <span className="doc-title">{filename}</span>{" "}
                <span className="doc-extension">
                  {documentExtension(doc.path)}
                </span>
              </strong>
              <p>
                {doc.edit
                  ? "You can edit this document and leave comments."
                  : "You can read this document and leave comments."}
              </p>
              <span className="subtle-label">
                <GlobeSimple size={14} />
                Anyone with this link
              </span>
            </div>
          )}
          <div className="sidebar-bottom">
            <div className="local-note">
              <span className="status-dot" />
              <span>
                {sharedToken
                  ? "Shared from a local workspace"
                  : "Stored on your computer"}
              </span>
            </div>
            {config?.owner && (
              <span className="root-path" title={config.root}>
                {config.root}
              </span>
            )}
            <button className="profile" onClick={() => setPanel("settings")}>
              <Avatar name={name} color="#39795e" />
              <span>
                <strong>{name}</strong>
                <small>
                  {config?.owner ? "Workspace owner" : "Guest collaborator"}
                </small>
              </span>
              <DotsThree size={22} />
            </button>
          </div>
        </aside>
        <main className="workspace">
          <header className="topbar">
            <div className="breadcrumbs">
              {!sidebar && (
                <IconButton
                  label="Open sidebar"
                  onClick={() => setSidebar(true)}
                >
                  <SidebarSimple />
                </IconButton>
              )}
              <span className="crumb-home">
                {sharedToken ? "Shared" : "Documents"}
              </span>
              <CaretRight size={12} />
              {doc?.path.includes("/") && (
                <>
                  <span className="crumb-folder">
                    {doc.path.split("/").slice(0, -1).join(" / ")}
                  </span>
                  <CaretRight size={12} />
                </>
              )}
              <span className="crumb-current doc-label">
                <span className="doc-title">{filename}</span>{" "}
                {doc && (
                  <span className="doc-extension">
                    {documentExtension(doc.path)}
                  </span>
                )}
              </span>
            </div>
            <div className="top-actions">
              {doc && (
                <>
                  <div className="presence">
                    {people.slice(0, 4).map((p, i) => (
                      <Avatar key={`${p.name}-${i}`} {...p} small />
                    ))}
                    {people.length > 4 && (
                      <span className="presence-more">
                        +{people.length - 4}
                      </span>
                    )}
                  </div>
                  <button
                    className={`button quiet comments-toggle ${commentsOpen ? "pressed" : ""}`}
                    aria-label="Toggle comments"
                    aria-expanded={commentsOpen}
                    data-comment-control=""
                    onClick={() => {
                      if (commentsOpen) setConversation(null);
                      else if (newCommentDraft) startComment();
                      else {
                        const first =
                          comments.find((c) => !c.resolved) || comments[0];
                        if (first)
                          setConversation({ kind: "thread", id: first.id });
                        else startComment();
                      }
                    }}
                  >
                    <ChatCircle size={17} />
                    <span>Comments</span>
                  </button>
                  {doc.owner ? (
                    <button
                      className="button primary share-button"
                      onClick={() => setPanel("share")}
                    >
                      <ShareNetwork size={17} />
                      <span>Share</span>
                    </button>
                  ) : (
                    <span className="access-badge">
                      {doc.edit ? (
                        <PencilSimple size={14} />
                      ) : (
                        <LockSimple size={14} />
                      )}
                      {doc.edit ? "Can edit" : "View & comment"}
                    </span>
                  )}
                </>
              )}
            </div>
          </header>
          {storageWarning && (
            <div className="storage-notice" role="status">
              {storageWarning}
            </div>
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
            <div
              className="formatbar"
              data-format={fountain ? "fountain" : "markdown"}
            >
              <div className="format-left">
                <button
                  className="font-button"
                  ref={appearanceTrigger}
                  aria-label="Fonts and appearance"
                  aria-expanded={panel === "appearance"}
                  aria-controls="appearance-panel"
                  title={`Fonts and appearance (${font})`}
                  onClick={() =>
                    setPanel((current) =>
                      current === "appearance" ? null : "appearance",
                    )
                  }
                >
                  <span>aA</span>
                </button>
                <div
                  className="text-size-control"
                  role="group"
                  aria-label="Document text size"
                >
                  <IconButton
                    label="Decrease text size"
                    disabled={fontSize <= 10}
                    onClick={() =>
                      setFontSize((value) => Math.max(10, value - 1))
                    }
                  >
                    <Minus size={14} />
                  </IconButton>
                  <output aria-live="polite" aria-label="Text size">
                    {fontSize}
                  </output>
                  <IconButton
                    label="Increase text size"
                    disabled={fontSize >= 28}
                    onClick={() =>
                      setFontSize((value) => Math.min(28, value + 1))
                    }
                  >
                    <Plus size={14} />
                  </IconButton>
                </div>
              </div>
              <div className="format-tools">
                {doc.edit && (
                  <>
                    {fountain && (
                      <div className="select-field fountain-element-field">
                        <select
                          className="fountain-element-select"
                          aria-label="Screenplay element"
                          value=""
                          onChange={(event) =>
                            editor.current?.formatFountain(
                              event.target.value as FountainForce,
                            )
                          }
                        >
                          <option value="" disabled>
                            Element
                          </option>
                          <option value="scene">Scene heading</option>
                          <option value="action">Action</option>
                          <option value="character">Character</option>
                          <option value="parenthetical">Parenthetical</option>
                          <option value="transition">Transition</option>
                          <option value="centered">Centered</option>
                          <option value="lyric">Lyrics</option>
                        </select>
                        <CaretDown
                          size={14}
                          className="select-arrow"
                          aria-hidden="true"
                        />
                      </div>
                    )}
                  </>
                )}
                <div
                  className="format-command-slot"
                  aria-hidden={panel === "document" || undefined}
                >
                  {formattingTools()}
                </div>
                <span className="toolbar-divider" />
                <IconButton
                  label="Document options"
                  onClick={() => setPanel("document")}
                >
                  <DotsThree size={22} />
                </IconButton>
              </div>
            </div>
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
            {!config ||
            (!doc &&
              !error &&
              Boolean((sharedToken && !config.folder) || id)) ? (
              <div
                className="loading-surface"
                role="status"
                aria-label="Opening document"
              >
                <div />
                <div />
                <div />
              </div>
            ) : !config.owner && !sharedToken ? (
              <div className="welcome">
                <span className="welcome-symbol">
                  <Files size={32} weight="duotone" />
                </span>
                <h1>
                  Your words.
                  <br />
                  Your own space.
                </h1>
                <p>
                  Open your local workspace with the owner API key stored on
                  this computer.
                </p>
                <button
                  className="button primary"
                  onClick={() => setPanel("login")}
                >
                  Open workspace
                  <ArrowUpRight size={17} />
                </button>
                <code>npm run owner</code>
              </div>
            ) : !doc ? (
              <div className="welcome">
                <span className="welcome-symbol">
                  <FileText size={32} />
                </span>
                <h1>
                  {error
                    ? "This document is unavailable."
                    : config.folder
                      ? "This folder is empty."
                      : "A little room for your ideas."}
                </h1>
                <p>
                  {config.folder && !error
                    ? "Documents added here will appear automatically."
                    : sharedToken
                      ? "Ask the owner for a current sharing link."
                      : "Create a document or open a Markdown or Fountain file from the sidebar. Your words stay on your computer."}
                </p>
                {config.owner && (
                  <button
                    className="button primary"
                    onClick={() => {
                      setCreateKind("file");
                      setNewPath("");
                      setPanel("create");
                    }}
                  >
                    <Plus />
                    Create a document
                  </button>
                )}
              </div>
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
                        path={doc.path}
                        entries={entries}
                        onLink={setLinkTarget}
                        onInsertLink={fountain ? undefined : startLink}
                        onIntegrityError={setError}
                        onComment={startComment}
                        onUpload={
                          fountain
                            ? () =>
                                tell(
                                  "Use a Markdown document for images and videos.",
                                )
                            : upload
                        }
                        comments={comments}
                        activeComment={currentComment?.id}
                        commentDraft={selection}
                        onOpenComment={(id) =>
                          setConversation((current) =>
                            current?.kind === "thread" && current.id === id
                              ? null
                              : { kind: "thread", id },
                          )
                        }
                        conversation={commentContent}
                      />
                    </div>
                  ) : (
                    <div className="loading-surface">
                      <div />
                      <div />
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
          <footer className="statusbar">
            <div
              className={`document-status ${statusWarning ? "has-warning" : ""}`}
              role="status"
              aria-live="polite"
              aria-atomic="true"
              aria-label={footerStatus}
              title={footerStatus}
            >
              {statusWarning ? (
                <WarningCircle size={15} aria-hidden="true" />
              ) : footerStatus === "Saved to disk" ? (
                <CheckCircle size={15} aria-hidden="true" />
              ) : !doc && !id ? (
                <FileText size={15} aria-hidden="true" />
              ) : (
                <Clock size={15} aria-hidden="true" />
              )}
              <span>{footerStatus}</span>
            </div>
            {doc && (
              <div className="footer-metrics">
                <DocumentWordMetrics
                  text={session?.ydoc.getText("content")}
                  initial={doc.content}
                  path={doc.path}
                />
                <span
                  className="attachment-usage"
                  title="Attachment storage, including uploaded files awaiting insertion"
                >
                  {(doc.usage / 1e6).toFixed(1)} / 50 MB
                </span>
                <span className="markdown-tag">
                  {fountain ? "Fountain" : "Markdown"}
                </span>
              </div>
            )}
          </footer>
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
                <h2 id="panel-title">
                  {
                    {
                      share: "Share document",
                      "folder-share": "Share folder",
                      create:
                        createKind === "folder" ? "New folder" : "New document",
                      login: "Open your workspace",
                      settings: "Your workspace",
                      document: "Document options",
                      history: "Version history",
                      link: "Insert link",
                    }[panel || ""]
                  }
                </h2>
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
              {panel === "share" && doc && (
                <>
                  <p className="dialog-description">
                    Share “{filename}” with a link.
                  </p>
                  <ShareControls
                    value={doc}
                    name={name}
                    onChange={updateShare}
                  />
                  {doc.owner && doc.path.includes("/") && (
                    <button
                      className="text-button"
                      onClick={() => {
                        setShareFolderPath(
                          doc.path.split("/").slice(0, -1).join("/"),
                        );
                        setPanel("folder-share");
                      }}
                    >
                      <Folder size={16} />
                      Share containing folder
                    </button>
                  )}
                  {doc.path.includes("/") && (
                    <p className="field-help">
                      Folder links grant access separately.
                    </p>
                  )}
                </>
              )}
              {panel === "folder-share" && config?.owner && shareFolderPath && (
                <FolderShare
                  key={shareFolderPath}
                  path={shareFolderPath}
                  name={name}
                  onChanged={loadTree}
                />
              )}
              {panel === "create" && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    createFile();
                  }}
                >
                  <p className="dialog-description">
                    {createKind === "folder"
                      ? "Create a real folder in your document directory."
                      : "A plain text file, ready to write in any editor."}
                  </p>
                  {createKind === "file" && (
                    <>
                      <label className="field-label" htmlFor="new-format">
                        File type
                      </label>
                      <select
                        id="new-format"
                        className="text-input"
                        value={
                          /\.(md|fountain)$/i.test(newPath)
                            ? documentFormat(newPath)
                            : createFormat
                        }
                        onChange={(event) => {
                          const format = event.target.value as DocumentFormat;
                          setCreateFormat(format);
                          setNewPath((value) =>
                            value
                              ? value.replace(/\.(md|fountain)$/i, "") +
                                (format === "fountain" ? ".fountain" : ".md")
                              : value,
                          );
                        }}
                      >
                        <option value="markdown">Markdown (.md)</option>
                        <option value="fountain">
                          Fountain screenplay (.fountain)
                        </option>
                      </select>
                    </>
                  )}
                  <label className="field-label" htmlFor="new-path">
                    {createKind === "folder" ? "Folder path" : "Document path"}
                  </label>
                  <input
                    id="new-path"
                    className="text-input"
                    autoFocus
                    placeholder={
                      createKind === "folder"
                        ? "Projects / Research"
                        : createFormat === "fountain"
                          ? "Projects/My screenplay.fountain"
                          : "Projects/My next idea.md"
                    }
                    value={newPath}
                    onChange={(e) => setNewPath(e.target.value)}
                    required
                  />
                  <p className="field-help">
                    Use / to place it inside a folder.
                  </p>
                  <div className="dialog-actions">
                    <button
                      type="button"
                      className="button quiet"
                      onClick={() => setPanel(null)}
                    >
                      Cancel
                    </button>
                    <button
                      className="button primary"
                      disabled={busy || !newPath.trim()}
                    >
                      {busy
                        ? "Creating…"
                        : createKind === "folder"
                          ? "Create folder"
                          : "Create document"}
                    </button>
                  </div>
                </form>
              )}
              {panel === "login" && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    login();
                  }}
                >
                  <p className="dialog-description">
                    Use the API key from this computer’s{" "}
                    <code>.locdoc/owner.key</code>. Run{" "}
                    <code>npm run owner</code> in the Locdoc folder to open it
                    automatically.
                  </p>
                  <label className="field-label" htmlFor="owner-key">
                    Owner API key
                  </label>
                  <input
                    id="owner-key"
                    type="password"
                    autoComplete="off"
                    className="text-input"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    autoFocus
                    required
                  />
                  <p className="field-help">
                    This browser will remember your owner session.
                  </p>
                  <div className="dialog-actions">
                    <button
                      className="button primary"
                      disabled={busy || !apiKey.trim()}
                    >
                      {busy ? "Opening…" : "Open workspace"}
                    </button>
                  </div>
                </form>
              )}
              {panel === "settings" && (
                <>
                  <label className="field-label" htmlFor="your-name">
                    Your display name
                  </label>
                  <input
                    id="your-name"
                    className="text-input"
                    maxLength={60}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                  <p className="field-help">
                    Shown beside your cursor and comments.
                  </p>
                  {config?.owner && (
                    <div className="settings-folder">
                      <Folder />
                      <span>
                        <strong>Documents folder</strong>
                        <code>{config.root}</code>
                      </span>
                    </div>
                  )}
                  <button
                    className="menu-action"
                    onClick={() =>
                      setPanel((current) =>
                        current === "appearance" ? null : "appearance",
                      )
                    }
                  >
                    <TextAa />
                    Fonts and appearance
                    <CaretRight size={14} />
                  </button>
                  {config?.owner && id && (
                    <CollaborationRecovery
                      key={id}
                      endpoint={endpoint}
                      available={!!doc}
                      disconnect={async () => {
                        await session?.drafts.flush();
                        const provider = session?.provider;
                        if (!provider?.wsconnected) return;
                        await new Promise<void>((resolve) => {
                          const closed = () => {
                            clearTimeout(timer);
                            provider.off("connection-close", closed);
                            resolve();
                          };
                          const timer = setTimeout(closed, 500);
                          provider.on("connection-close", closed);
                          provider.disconnect();
                        });
                      }}
                      reconnect={() => session?.provider.connect()}
                    />
                  )}
                  {config?.owner && <RemovedDocumentRecovery />}
                  {config?.owner && (
                    <button
                      className="menu-action"
                      onClick={() =>
                        action(async () => {
                          await api("/api/logout", send("POST"));
                          location.href = "/";
                        })
                      }
                    >
                      <LockSimple />
                      Lock this browser
                    </button>
                  )}
                </>
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
                <>
                  <p className="dialog-description">{doc.path}</p>
                  {doc.edit && !fountain && (
                    <div
                      className="formatting-menu"
                      role="group"
                      aria-label="Formatting"
                    >
                      {formattingTools(true)}
                    </div>
                  )}
                  <button
                    className="menu-action"
                    onClick={() => {
                      download();
                      setPanel(null);
                    }}
                  >
                    <DownloadSimple />
                    Download {fountain ? "Fountain" : "Markdown"}
                  </button>
                  {doc.owner && (
                    <button
                      className="menu-action"
                      onClick={() => setPanel("history")}
                    >
                      <ArrowCounterClockwise />
                      Version history
                    </button>
                  )}
                  {doc.owner && (
                    <RenameDocument
                      path={doc.path}
                      endpoint={endpoint()}
                      onRename={(path) => {
                        setDoc((doc) => (doc ? { ...doc, path } : doc));
                        void loadTree();
                        setPanel(null);
                      }}
                    />
                  )}
                  <div className="attachment-info">
                    <Image />
                    <span>
                      <strong>
                        {(doc.usage / 1e6).toFixed(1)} MB of 50 MB used
                      </strong>
                      <small>Images up to 5 MB · Videos up to 20 MB</small>
                    </span>
                  </div>
                </>
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
        {toast && (
          <div className="toast" role="status">
            <CheckCircle size={18} />
            {toast}
            <IconButton
              label="Dismiss notification"
              onClick={() => setToast("")}
            >
              <X size={14} />
            </IconButton>
          </div>
        )}
      </div>
    </IconContext.Provider>
  );
}
