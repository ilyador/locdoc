import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
const offlineBuild = String(Date.now());
export default defineConfig({
  define: { __LOCDOC_OFFLINE_BUILD__: JSON.stringify(offlineBuild) },
  plugins: [
    react(),
    {
      name: "shell-before-bootstrap",
      transformIndexHtml: {
        order: "post",
        handler(html) {
          // Vite moves CSS entries to the end of head. Keep the initial page
          // background ready before the blocking appearance/PWA bootstrap.
          const sheets = /<link\b[^>]*rel="stylesheet"[^>]*>/g;
          const css = html.match(sheets) || [];
          return html
            .replace(sheets, "")
            .replace(
              '<script src="/theme.js"></script>',
              `${css.join("\n")}\n<script src="/theme.js"></script>`,
            );
        },
      },
    },
    {
      name: "offline-shell",
      enforce: "post",
      generateBundle(_, bundle) {
        const index = bundle["index.html"];
        if (index?.type !== "asset") return;
        this.emitFile({
          type: "asset",
          fileName: "offline.html",
          source: String(index.source)
            .replaceAll("__LOCDOC_TITLE__", "Locdoc")
            .replace(/__LOCDOC_[A-Z_]+__/g, ""),
        });
        const files = [
          "/offline.html",
          "/theme.js",
          "/manifest.webmanifest",
          "/font-catalog.json",
          ...readdirSync("public/icons")
            .filter((name) => /v5\.(png|svg)$/.test(name))
            .map((name) => `/icons/${name}`),
          ...Object.keys(bundle)
            .filter((name) => name.startsWith("assets/"))
            .map((name) => `/${name}`),
        ];
        this.emitFile({
          type: "asset",
          fileName: "offline-manifest.json",
          source: JSON.stringify({ version: offlineBuild, files }),
        });
      },
    },
  ],
  build: {
    outDir: "dist",
    rolldownOptions: {
      input: {
        index: fileURLToPath(new URL("index.html", import.meta.url)),
        "offline-worker": fileURLToPath(
          new URL("src/offline-worker.ts", import.meta.url),
        ),
      },
      output: {
        entryFileNames: (entry) =>
          entry.name === "offline-worker" ? "sw.js" : "assets/[name]-[hash].js",
      },
    },
  },
});
