import { sourceComments } from "./comment-syntax";

// Keep original line numbers in compiler messages. Locdoc annotations belong
// to the authoring surface, never the story's output.
export function inkSource(source: string) {
  const chars = source.split("");
  for (const record of sourceComments(source, true))
    for (let at = record.from; at < record.to; at++)
      if (chars[at] !== "\n") chars[at] = " ";
  return chars.join("");
}

export function withoutInkComments(source: string) {
  return source.replace(/\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*/g, (text) =>
    text.replace(/[^\n]/g, " "),
  );
}

export function inkPath(from: string, relative: string) {
  if (/^[\\/]|[:\\\u0000-\u001f]/.test(relative))
    throw new Error("INCLUDE must name an Ink file inside this workspace.");
  const parts = from.split("/").slice(0, -1);
  for (const part of relative.split("/")) {
    if (part === "." || !part) continue;
    if (part === "..") {
      if (!parts.length) throw new Error("INCLUDE leaves this workspace.");
      parts.pop();
    } else {
      if (part.startsWith("."))
        throw new Error("INCLUDE cannot open hidden files.");
      parts.push(part);
    }
  }
  const path = parts.join("/");
  if (!/\.ink$/i.test(path)) throw new Error("INCLUDE must name a .ink file.");
  return path;
}

export function inkIncludes(source: string) {
  return Array.from(
    withoutInkComments(source).matchAll(
      /^[\t ]*INCLUDE[\t ]+([^\n]+?)[\t ]*$/gm,
    ),
    (match) => ({
      from: match.index,
      to: match.index + match[0].length,
      name: match[1].trim(),
    }),
  );
}

// Compiler includes use canonical, workspace-relative keys. The worker has
// only these in-memory strings, no filesystem or network file handler.
export function prepareInk(source: string, path: string) {
  let text = inkSource(source);
  for (const include of inkIncludes(text).reverse())
    text =
      text.slice(0, include.from) +
      `INCLUDE ${inkPath(path, include.name)}` +
      text.slice(include.to);
  return text;
}
