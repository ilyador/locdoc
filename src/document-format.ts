export type DocumentFormat = "markdown" | "fountain" | "text";
export type DocumentExtension = ".md" | ".fountain" | ".txt";

const extensions: Record<DocumentFormat, DocumentExtension> = {
  markdown: ".md",
  fountain: ".fountain",
  text: ".txt",
};
const documentExtensionPattern = /\.(md|fountain|txt)$/i;
// The extensions a name shows after its title: a document's, and those of the
// images and videos a document embeds.
const nameExtensionPattern =
  /\.(?:md|fountain|txt|png|jpe?g|gif|webp|avif|mp4|webm|mov)$/i;

export function documentFormat(path = ""): DocumentFormat {
  return /\.fountain$/i.test(path)
    ? "fountain"
    : /\.txt$/i.test(path)
      ? "text"
      : "markdown";
}

// Whether a file name is one Locdoc opens as a document.
export function isDocumentPath(path: string) {
  return documentExtensionPattern.test(path);
}

export function documentName(path: string) {
  return path.split("/").pop()!.replace(documentExtensionPattern, "");
}

export function documentPath(path: string, format: DocumentFormat) {
  return isDocumentPath(path) ? path : path + extensions[format];
}

export function documentExtension(path: string): DocumentExtension | "" {
  const match = documentExtensionPattern.exec(path)?.[0].toLowerCase();
  return (match as DocumentExtension | undefined) || "";
}

// A file or folder name as its title and the extension shown after it, as
// written.
export function nameParts(name: string): [title: string, extension: string] {
  const extension = nameExtensionPattern.exec(name)?.[0] || "";
  return [name.slice(0, name.length - extension.length), extension];
}

export function formatLabel(format: DocumentFormat) {
  return format === "fountain"
    ? "Fountain"
    : format === "text"
      ? "Plain text"
      : "Markdown";
}
