import { mkdir, writeFile, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Keep installation independent of the account or checkout location. This
// installs only a user service; it never changes DNS, sudo, or the firewall.
const project = fileURLToPath(new URL("../", import.meta.url)).replace(
  /\/$/,
  "",
);
const serviceDir = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "systemd/user",
);
const destination = join(serviceDir, "locdoc.service");
const noStart = process.argv.includes("--no-start");
const quote = (value) =>
  '"' +
  value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"') +
  '"';
try {
  if (process.platform !== "linux")
    throw Error("Locdoc currently requires Linux file leases.");
  if (/[\r\n]/.test(project)) throw Error("The checkout path cannot contain line breaks.");
  await access(join(project, "target/release/locdoc"));
  await access(join(project, "dist/index.html"));
  if (!process.argv.includes("--replace")) {
    try {
      await access(destination);
      throw Error(
        "A Locdoc service already exists. Use --replace to update its paths.",
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  await mkdir(serviceDir, { recursive: true });
  const service = `[Unit]
Description=Locdoc local Markdown workspace
After=network.target

[Service]
Type=simple
WorkingDirectory=${project.replaceAll("%", "%%")}
ExecStart=${quote(resolve(project, "target/release/locdoc"))}
EnvironmentFile=-${quote(join(project, ".env"))}
Restart=on-failure
RestartSec=3
KillSignal=SIGINT
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;
  await writeFile(destination, service, { mode: 0o600 });
  if (!noStart) {
    for (const args of [
      ["--user", "daemon-reload"],
      ["--user", "enable", "--now", "locdoc.service"],
    ]) {
      const result = spawnSync("systemctl", args, { stdio: "inherit" });
      if (result.error || result.status !== 0)
        throw Error(
          "Could not start the user service. Check systemctl --user status locdoc.",
        );
    }
  }
  console.log(
    `Installed ${destination}${noStart ? " (not started)" : ""}. Open your workspace with npm run owner.`,
  );
} catch (error) {
  console.error(`Could not install Locdoc: ${error.message}`);
  process.exitCode = 1;
}
