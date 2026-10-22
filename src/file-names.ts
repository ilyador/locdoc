import {
  documentExtension,
  documentFormat,
  documentName,
  type DocumentExtension,
  type DocumentFormat,
} from "./document-format";
import type { Entry } from "./model";

// Names and paths for the sidebar's file actions. Everything here is pure, so
// the inline name field validates on every keystroke without a request.

// How a rename that changes format says the document will open.
const opensAs: Record<DocumentFormat, string> = {
  markdown: "Markdown",
  fountain: "a Fountain screenplay",
  text: "plain text",
};

export const parentPath = (path: string) =>
  path.split("/").slice(0, -1).join("/");
export const baseName = (path: string) => path.split("/").pop() || "";
export const joinPath = (folder: string, name: string) =>
  folder ? `${folder}/${name}` : name;
// True for the path itself and everything inside it.
export const within = (path: string, folder: string) =>
  path === folder || path.startsWith(`${folder}/`);

export type NameCheck = {
  // The final file or folder name, with any added extension.
  name: string;
  error: string;
  hint: string;
  empty: boolean;
  unchanged: boolean;
};

// `extension` is added to a document name that has none: the original one when
// renaming, or the preferred one when creating.
export function checkName(
  input: string,
  options: {
    kind: "file" | "folder";
    siblings: string[];
    original?: string;
    extension?: DocumentExtension;
  },
): NameCheck {
  const value = input.trim();
  const result = {
    name: value,
    error: "",
    hint: "",
    empty: !value,
    unchanged: false,
  };
  if (!value) return { ...result, error: "Enter a name." };
  if (/[/\\]/.test(value))
    return {
      ...result,
      error: "A name can’t include / or \\. To change folders, use Move to.",
    };
  if (value.startsWith("."))
    return {
      ...result,
      error: "A name can’t start with a dot. Locdoc hides those files.",
    };
  if (/[\u0000-\u001f\u007f]/.test(value))
    return { ...result, error: "Remove the control characters." };
  let name = value;
  if (options.kind === "file" && !documentExtension(value))
    name += options.extension || ".md";
  if (new TextEncoder().encode(name).length > 255)
    return { ...result, name, error: "That name is too long." };
  if (options.original !== undefined && name === options.original)
    return { ...result, name, unchanged: true };
  if (options.siblings.includes(name))
    return { ...result, name, error: `${name} already exists here.` };
  let hint = name === value ? "" : `Saved as ${name}`;
  if (options.kind === "file" && options.original !== undefined) {
    const before = documentExtension(options.original);
    const after = documentExtension(name);
    if (before && after && before !== after)
      hint = `${hint ? `${hint}. ` : ""}Opens as ${opensAs[documentFormat(name)]}.`;
  }
  return { ...result, name, hint };
}

// Names directly inside `folder`, optionally leaving one entry out.
export function siblingNames(entries: Entry[], folder: string, except = "") {
  return entries
    .filter((entry) => parentPath(entry.path) === folder && entry.path !== except)
    .map((entry) => baseName(entry.path));
}

// "Plan copy.md", then "Plan copy 2.md", like a desktop file manager.
export function copyName(name: string, taken: string[]) {
  const extension = documentExtension(name);
  const stem = (extension ? name.slice(0, -extension.length) : name).replace(
    / copy(?: \d+)?$/,
    "",
  );
  for (let index = 1; ; index++) {
    const candidate = `${stem} copy${index > 1 ? ` ${index}` : ""}${extension}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

// Entries after moving `from` (and everything inside it) to `to`.
export function relocateEntries(entries: Entry[], from: string, to: string) {
  return entries.map((entry) => {
    if (!within(entry.path, from)) return entry;
    const path = to + entry.path.slice(from.length);
    if (entry.path !== from) return { ...entry, path };
    return entry.kind === "file"
      ? {
          ...entry,
          path,
          title: documentName(to),
          format: documentFormat(path),
        }
      : { ...entry, path, title: baseName(to) };
  });
}

export function relocatePaths(paths: Set<string>, from: string, to: string) {
  return new Set(
    Array.from(paths, (path) =>
      within(path, from) ? to + path.slice(from.length) : path,
    ),
  );
}

export function ancestors(path: string) {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}
