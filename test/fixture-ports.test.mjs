import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

// A fixture server on a fixed port fails its whole file whenever another
// local server holds that port. Every test that sets LOCDOC_BIND takes its
// port from the shared helper in fixtures/free-port.mjs.
test("fixture servers bind free ports, never fixed ones", () => {
  const folder = new URL(".", import.meta.url);
  const fixed = [];
  for (const name of readdirSync(folder)) {
    if (!/\.test\.(mjs|tsx)$/.test(name) || name === "fixture-ports.test.mjs")
      continue;
    const source = readFileSync(new URL(name, folder), "utf8");
    const binds = source.match(/LOCDOC_BIND[^,;\n]*/g) ?? [];
    for (const bind of binds)
      if (/(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0):\d/.test(bind))
        fixed.push(`${name}: ${bind.trim()}`);
    if (
      binds.length &&
      !/from ["']\.\/fixtures\/free-port\.mjs["']/.test(source)
    )
      fixed.push(`${name}: no port from fixtures/free-port.mjs`);
  }
  assert.deepEqual(fixed, []);
});
