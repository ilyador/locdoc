import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parsers } from "prettier/plugins/typescript";

const html = new Set([
  "innerHTML",
  "outerHTML",
  "insertAdjacentHTML",
  "createContextualFragment",
  "setHTMLUnsafe",
  "parseHTMLUnsafe",
  "dangerouslySetInnerHTML",
  "srcDoc",
  "srcdoc",
]);
type Node = {
  type?: string;
  name?: string | Node;
  value?: unknown;
  property?: Node;
  object?: Node;
  key?: Node;
  callee?: Node;
  loc?: { start: { line: number } };
};
const name = (node: Node | undefined) =>
  (typeof node?.name === "string" ? node.name : "") ||
  (typeof node?.value === "string" ? node.value : "");

async function sinks(source: string, path: string) {
  const violations: string[] = [];
  const tree = await parsers.typescript.parse(source, { filepath: path });
  function inspect(value: unknown) {
    if (Array.isArray(value)) {
      value.forEach(inspect);
      return;
    }
    if (!value || typeof value !== "object") return;
    const node = value as Node;
    let sink = "";
    if (
      node.type === "MemberExpression" &&
      (html.has(name(node.property)) ||
        ["eval", "Function"].includes(name(node.property)))
    )
      sink = name(node.property);
    else if (
      node.type === "MemberExpression" &&
      name(node.object) === "document" &&
      ["write", "writeln"].includes(name(node.property))
    )
      sink = `document.${name(node.property)}`;
    else if (
      ["JSXAttribute", "Property"].includes(node.type || "") &&
      html.has(name(node.type === "Property" ? node.key : (node.name as Node)))
    )
      sink = name(node.type === "Property" ? node.key : (node.name as Node));
    else if (
      ["CallExpression", "NewExpression"].includes(node.type || "") &&
      ["eval", "Function"].includes(name(node.callee))
    )
      sink = name(node.callee);
    if (sink) violations.push(`${path}:${node.loc?.start.line || 1}: ${sink}`);
    for (const [key, child] of Object.entries(value))
      if (!["loc", "range", "comments", "tokens"].includes(key)) inspect(child);
  }
  inspect(tree);
  return violations;
}

test("rendering guard checks syntax without rejecting inert comments and strings", async () => {
  assert.deepEqual(
    await sinks('// avoid innerHTML\nconst text = "eval(1)";', "safe.ts"),
    [],
  );
  const blocked = await sinks(
    'node.innerHTML = value; node["outerHTML"] = value; eval(value); Function(value); document.write(value); const view = <div dangerouslySetInnerHTML={{ __html: value }} />;',
    "unsafe.tsx",
  );
  assert.equal(blocked.length, 6);
});

test("frontend document rendering has no HTML or dynamic script sinks", async () => {
  const root = fileURLToPath(new URL("../src/", import.meta.url));
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const violations: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
    const path = join(entry.parentPath, entry.name);
    violations.push(
      ...(await sinks(await readFile(path, "utf8"), relative(root, path))),
    );
  }
  assert.deepEqual(
    violations,
    [],
    "Render untrusted source as text; keep HTML and dynamic scripts out of the frontend",
  );
});
