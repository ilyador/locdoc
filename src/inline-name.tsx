import { useEffect, useId, useLayoutEffect, useRef } from "react";
import { FileText, Folder } from "@phosphor-icons/react";
import type { FileActions } from "./file-actions";
import { documentExtension } from "./document-format";
import { baseName } from "./file-names";

// The name field VS Code places in the tree for New and Rename. It checks the
// name on every keystroke, keeps its text on any failure, commits with Enter
// or by leaving it, and cancels with Escape.
export function InlineName({
  files,
  indent,
  prepare,
}: {
  files: FileActions;
  indent: number;
  prepare?: () => Promise<void>;
}) {
  const edit = files.edit!;
  const check = files.check!;
  const input = useRef<HTMLInputElement>(null);
  const messageId = useId();
  useLayoutEffect(() => {
    const field = input.current;
    if (!field) return;
    field.focus({ preventScroll: true });
    field.scrollIntoView?.({ block: "nearest" });
    // Renaming selects the name without its extension, as desktop apps do.
    const stem =
      edit.mode === "rename" && edit.kind === "file"
        ? field.value.length - documentExtension(field.value).length
        : field.value.length;
    field.setSelectionRange(0, stem);
    // Only a new edit takes focus and selects its text.
  }, [edit.id]);
  useEffect(() => {
    if (files.fieldFocus) input.current?.focus({ preventScroll: true });
  }, [files.fieldFocus]);
  const error = edit.error || (edit.touched ? check.error : "");
  const message = error
    ? error
    : edit.saving
      ? edit.mode === "rename"
        ? "Renaming…"
        : "Creating…"
      : edit.value.trim()
        ? check.hint
        : "";
  const place = edit.parent ? ` in ${baseName(edit.parent)}` : "";
  const label =
    edit.mode === "rename"
      ? `Rename ${edit.original}`
      : `New ${edit.kind === "folder" ? "folder" : "document"} name${place}`;
  const Glyph = edit.kind === "folder" ? Folder : FileText;
  return (
    <div
      className="tree-edit"
      data-invalid={error ? "" : undefined}
      style={{ paddingLeft: indent }}
    >
      <div className="tree-edit-row">
        <Glyph size={edit.kind === "folder" ? 17 : 16} aria-hidden="true" />
        <input
          ref={input}
          value={edit.value}
          aria-label={label}
          aria-invalid={error ? true : undefined}
          aria-describedby={message ? messageId : undefined}
          aria-busy={edit.saving || undefined}
          readOnly={edit.saving}
          dir="auto"
          placeholder={edit.kind === "folder" ? "Folder name" : "Document name"}
          spellCheck={false}
          autoComplete="off"
          enterKeyHint="done"
          onChange={(event) => files.changeEdit(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              void files.commitEdit("enter", prepare);
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              files.cancelEdit(true);
            }
          }}
          onBlur={(event) => {
            // Switching windows keeps the field; the browser refocuses it.
            if (!event.relatedTarget && !document.hasFocus()) return;
            void files.commitEdit("blur", prepare);
          }}
        />
      </div>
      {message && (
        <p
          id={messageId}
          className={`tree-edit-message ${error ? "is-error" : ""} ${edit.saving ? "is-saving" : ""}`}
          role={edit.error ? "alert" : undefined}
        >
          {message}
        </p>
      )}
    </div>
  );
}
