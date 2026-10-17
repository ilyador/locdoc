export type DocumentFormat = "markdown" | "fountain";

export function documentFormat(path = ""): DocumentFormat {
  return /\.fountain$/i.test(path) ? "fountain" : "markdown";
}

export function documentName(path: string) {
  return path
    .split("/")
    .pop()!
    .replace(/\.(md|fountain)$/i, "");
}

export function documentPath(path: string, format: DocumentFormat) {
  return /\.(md|fountain)$/i.test(path)
    ? path
    : path + (format === "fountain" ? ".fountain" : ".md");
}
