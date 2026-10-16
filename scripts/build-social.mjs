import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const icon = "public/icons/icon-512-v5.png";
const font =
  "node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-";
const digest = createHash("sha256")
  .update(readFileSync(root + icon))
  .digest("hex");
mkdirSync(root + "public/social", { recursive: true });
const result = spawnSync(
  "magick",
  [
    "-size",
    "1200x630",
    "xc:#f4f4f2",
    "(",
    icon,
    "-resize",
    "360x360",
    "(",
    "-size",
    "360x360",
    "xc:none",
    "-fill",
    "white",
    "-draw",
    "roundrectangle 0,0 359,359 42,42",
    ")",
    "-alpha",
    "off",
    "-compose",
    "CopyOpacity",
    "-composite",
    ")",
    "-geometry",
    "+76+135",
    "-compose",
    "Over",
    "-composite",
    "-fill",
    "#173349",
    "-font",
    "node_modules/@fontsource/bebas-neue/files/bebas-neue-latin-400-normal.woff",
    "-pointsize",
    "90",
    "-annotate",
    "+500+212",
    "LOCDOC.",
    "-font",
    font + "600-normal.woff",
    "-pointsize",
    "60",
    "-annotate",
    "+500+310",
    "Local Markdown.",
    "-annotate",
    "+500+379",
    "Shared ideas.",
    "-font",
    font + "400-normal.woff",
    "-pointsize",
    "27",
    "-fill",
    "#51606c",
    "-annotate",
    "+500+453",
    "Write together. Keep your files.",
    "-set",
    "comment",
    `Locdoc social preview. Original layout rendered by scripts/build-social.mjs with ImageMagick; existing Origami Hash icon ${icon}, SHA-256 ${digest}. Self-hosted Bebas Neue and IBM Plex Sans. 1200x630px.`,
    "-define",
    "png:exclude-chunks=date,time",
    "public/social/locdoc-v1.png",
  ],
  { cwd: root, encoding: "utf8" },
);
if (result.error)
  throw new Error("Install ImageMagick to regenerate the social preview.", {
    cause: result.error,
  });
if (result.status !== 0) throw new Error(result.stderr);
console.log("public/social/locdoc-v1.png");
