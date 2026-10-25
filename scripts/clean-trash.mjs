import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// Ask the running namespace owner to expire trash under its restore/move lock.
// Never walk files or change SQLite from a second process.
try {
  const local = new URL(
    process.env.LOCDOC_LOCAL_URL ||
      `http://${process.env.LOCDOC_BIND || "127.0.0.1:3477"}`,
  );
  if (!process.env.LOCDOC_LOCAL_URL && local.hostname === "0.0.0.0")
    local.hostname = "127.0.0.1";
  if (!process.env.LOCDOC_LOCAL_URL && local.hostname === "[::]")
    local.hostname = "[::1]";
  if (
    local.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(local.hostname)
  )
    throw Error("LOCDOC_LOCAL_URL must be a loopback HTTP address.");
  const key = (
    await readFile(
      resolve(process.env.LOCDOC_STATE || ".locdoc", "owner.key"),
      "utf8",
    )
  ).trim();
  const response = await fetch(new URL("/api/trash/cleanup", local), {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(90_000),
    headers: { Authorization: `Bearer ${key}` },
  });
  const body = await response.json();
  if (!response.ok) throw Error(body.error || `HTTP ${response.status}`);
  console.log(
    `Trash cleanup: ${body.items} expired item(s), ${body.folders} empty folder(s) removed.`,
  );
} catch (error) {
  console.error(`Trash cleanup failed: ${error.message}`);
  process.exitCode = 1;
}
