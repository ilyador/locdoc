import { useEffect, useState } from "react";
import { CloudCheck, CloudSlash } from "@phosphor-icons/react";
import { onlineApi } from "./api";
import {
  offlineBatch,
  offlineDelete,
  offlineGet,
  offlinePut,
  type CachedResource,
} from "./offline-db";
import {
  queuedFiles,
  changedOfflineFiles,
  type QueuedFile,
} from "./offline-files";
import { queuedActions, type FormAction } from "./offline-actions";
import { currentOfflineScope } from "./offline-cache";
import type { Workspace } from "./workspace";

type Problem = {
  key: string;
  label: string;
  message: string;
  file?: QueuedFile;
  form?: FormAction;
};

// A quiet readiness disclosure, with recovery controls only when needed.
// No optimistic form is discarded merely because its server reply failed.
export function OfflineNotice({ workspace }: { workspace: Workspace }) {
  const [open, setOpen] = useState(false);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!open) return;
    let active = true;
    const refresh = async () => {
      const [files, forms] = await Promise.all([
        queuedFiles(),
        queuedActions(),
      ]);
      if (!active) return;
      setProblems([
        ...files
          .filter((item) => item.error)
          .map((file) => ({
            key: file.key,
            label: file.command.path || file.command.from,
            message: file.error!,
            file,
          })),
        ...forms
          .filter((item) => item.error)
          .map((form) => ({
            key: form.key,
            label: form.type === "upload" ? form.name : "Comment",
            message: form.error!,
            form,
          })),
      ]);
    };
    void refresh().catch((e) => {
      if (active) setError(e.message);
    });
    const changed = () => void refresh().catch(() => {});
    window.addEventListener("locdoc-offline-files", changed);
    return () => {
      active = false;
      window.removeEventListener("locdoc-offline-files", changed);
    };
  }, [open, version, workspace.config?.offlineScope]);
  const act = async (problem: Problem, action: "retry" | "keep" | "cancel") => {
    if (busy) return;
    setBusy(problem.key);
    setError("");
    const perform = async () => {
      const current = await offlineGet<QueuedFile | FormAction>(
        "commands",
        problem.key,
      );
      if (!current || current.result) return;
      if (action === "cancel") {
        // Creation has no other on-disk copy, so it offers Keep both instead.
        if (!problem.file || problem.file.command.kind.startsWith("create"))
          return;
        await offlineDelete("commands", problem.key);
      } else if (action === "keep" && problem.file) {
        const file = problem.file;
        const tree = await onlineApi<{ entries: { path: string }[] }>(
          "/api/tree",
        );
        const previous = file.command.path;
        const dot = previous.lastIndexOf(".");
        const split =
          dot > previous.lastIndexOf("/") && file.command.kind.endsWith("file")
            ? dot
            : previous.length;
        let next = `${previous.slice(0, split)} (offline copy)${previous.slice(split)}`;
        for (
          let n = 2;
          tree.entries.some(
            (entry) =>
              entry.path.toLocaleLowerCase() === next.toLocaleLowerCase(),
          );
          n++
        )
          next = `${previous.slice(0, split)} (offline copy ${n})${previous.slice(split)}`;
        const id = crypto.randomUUID();
        const from = file.command.path;
        const updates = (await queuedFiles()).map((entry) => {
          const mapPath = (path: string) =>
            path === from || path.startsWith(`${from}/`)
              ? `${next}${path.slice(from.length)}`
              : path;
          const command =
            entry.key === problem.key
              ? { ...entry.command, id, path: next }
              : {
                  ...entry.command,
                  path: mapPath(entry.command.path),
                  from: mapPath(entry.command.from),
                  identity:
                    entry.command.identity === `new.${file.command.id}`
                      ? `new.${id}`
                      : entry.command.identity,
                };
          return {
            key: entry.key,
            value: {
              ...entry,
              command,
              entries: entry.entries.map((item) => ({
                ...item,
                path: mapPath(item.path),
              })),
              error: undefined,
            },
          };
        });
        await offlineBatch(updates);
      } else
        await offlinePut("commands", problem.key, {
          ...current,
          error: undefined,
        });
      changedOfflineFiles();
      workspace.offline.retry();
      await workspace.loadTree();
    };
    try {
      const scope = await currentOfflineScope();
      if (scope && navigator.locks)
        await navigator.locks.request(`locdoc-offline-${scope.scope}`, perform);
      else await perform();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
      setVersion((value) => value + 1);
    }
  };
  const download = async (form: FormAction) => {
    try {
      const resource =
        form.type === "upload"
          ? await offlineGet<CachedResource>("resources", form.resource)
          : undefined;
      const blob =
        resource?.blob ||
        (form.type === "comment"
          ? new Blob([form.body.body || JSON.stringify(form.body)], {
              type: "text/plain",
            })
          : undefined);
      if (!blob)
        throw new Error("This attachment is unavailable on this device.");
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = form.type === "upload" ? form.name : "locdoc-comment.txt";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const attention =
    workspace.offline.warning ||
    problems.length ||
    workspace.offline.problems.length ||
    /attention|review/.test(workspace.offline.message);
  return (
    <details
      className="offline-notice"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="offline-note">
        {attention ? <CloudSlash size={15} /> : <CloudCheck size={15} />}
        <span>
          {workspace.offline.problems.length
            ? "Offline changes need review"
            : workspace.offline.message}
        </span>
      </summary>
      <div className="offline-notice-content">
        <p>{workspace.offline.warning || workspace.offline.detail}</p>
        {problems.map((problem) => (
          <div className="offline-problem" key={problem.key}>
            <strong dir="auto">{problem.label}</strong>
            <p>{problem.message}</p>
            <div className="offline-problem-actions">
              <button
                className="text-button"
                aria-disabled={!!busy}
                onClick={() => void act(problem, "retry")}
              >
                Try again
              </button>
              {problem.form && (
                <button
                  className="text-button"
                  onClick={() => void download(problem.form!)}
                >
                  Download copy
                </button>
              )}
              {problem.file &&
                /(?:already|path).*exists/i.test(problem.message) &&
                (problem.file.command.kind.startsWith("create") ||
                  problem.file.command.kind.startsWith("move")) && (
                  <button
                    className="text-button"
                    aria-disabled={!!busy}
                    onClick={() => void act(problem, "keep")}
                  >
                    Keep both
                  </button>
                )}
              {problem.file &&
                !problem.file.command.kind.startsWith("create") && (
                  <button
                    className="text-button"
                    aria-disabled={!!busy}
                    onClick={() => void act(problem, "cancel")}
                  >
                    Cancel action
                  </button>
                )}
            </div>
          </div>
        ))}
        {error && <p role="alert">{error}</p>}
        {!problems.length && (
          <button className="text-button" onClick={workspace.offline.retry}>
            Check again
          </button>
        )}
      </div>
    </details>
  );
}
