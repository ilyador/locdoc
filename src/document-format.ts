export type DocumentFormat = "markdown" | "fountain";

export function documentFormat(path = ""): DocumentFormat {
  return /\.fountain$/i.test(path) ? "fountain" : "markdown";
}

export function documentName(path: string) {
  return path
    .split("/")
    .pop()!
    .replace(/\.(md|fountain|txt)$/i, "");
}

export function documentPath(path: string, format: DocumentFormat) {
  return /\.(md|fountain)$/i.test(path)
    ? path
    : path + (format === "fountain" ? ".fountain" : ".md");
}

export function documentExtension(path: string) {
  return /\.(md|fountain|txt)$/i.exec(path)?.[0].toLowerCase() || "";
}
