import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Spawn from Node's loaded environment. `node --run` does not propagate
// --env-file values to its subprocess on every supported Node release.
const server = spawn(
  fileURLToPath(new URL("../target/release/locdoc", import.meta.url)),
  {
    stdio: "inherit",
    env: process.env,
  },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => server.kill("SIGINT"));
server.on("error", () => {
  console.error("Could not start Locdoc. Run npm run build first.");
  process.exitCode = 1;
});
server.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
