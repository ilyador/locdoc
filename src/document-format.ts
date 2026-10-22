export type DocumentFormat = "markdown" | "fountain" | "text";

const extensions: Record<DocumentFormat, string> = {
  markdown: ".md",
  fountain: ".fountain",
  text: ".txt",
};
const documentExtensionPattern = /\.(md|fountain|txt)$/i;

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

export function documentExtension(path: string) {
  return documentExtensionPattern.exec(path)?.[0].toLowerCase() || "";
}

export function formatLabel(format: DocumentFormat) {
  return format === "fountain"
    ? "Fountain"
    : format === "text"
      ? "Plain text"
      : "Markdown";
}
