import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
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
  ],
  build: { outDir: "dist" },
});
