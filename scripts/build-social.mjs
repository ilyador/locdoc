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
    "630x1200",
    "gradient:#f4f4f2-#e7f0f7",
    "-rotate",
    "-90",
    "(",
    icon,
    "-resize",
    "300x300",
    "(",
    "-size",
    "300x300",
    "xc:none",
    "-fill",
    "white",
    "-draw",
    "roundrectangle 0,0 299,299 40,40",
    ")",
    "-alpha",
    "off",
    "-compose",
    "CopyOpacity",
    "-composite",
    ")",
    "-geometry",
    "+836+266",
    "-compose",
    "Over",
    "-composite",
    "-fill",
    "#173349",
    "-font",
    "node_modules/@fontsource/bebas-neue/files/bebas-neue-latin-400-normal.woff",
    "-pointsize",
    "76",
    "-annotate",
    "+64+590",
    "LOCDOC.",
    "-font",
    font + "600-normal.woff",
    "-pointsize",
    "88",
    "-annotate",
    "+64+144",
    "Local Markdown.",
    "-annotate",
    "+64+240",
    "Shared ideas.",
    "-font",
    font + "400-normal.woff",
    "-pointsize",
    "44",
    "-fill",
    "#173349",
    "-annotate",
    "+64+320",
    "Write together.",
    "-annotate",
    "+64+376",
    "Keep your files.",
    "-set",
    "comment",
    `Locdoc social preview v2: large readable type, warm paper fading to pale blue, full oversized Origami Hash inset evenly from the edges. Original layout rendered by scripts/build-social.mjs with ImageMagick; existing Origami Hash icon ${icon}, SHA-256 ${digest}. Self-hosted Bebas Neue and IBM Plex Sans. 1200x630px.`,
    "-depth",
    "8",
    "-define",
    "png:compression-level=9",
    "-define",
    "png:exclude-chunks=date,time",
    "public/social/locdoc-v2.png",
  ],
  { cwd: root, encoding: "utf8" },
);
if (result.error)
  throw new Error("Install ImageMagick to regenerate the social preview.", {
    cause: result.error,
  });
if (result.status !== 0) throw new Error(result.stderr);
console.log("public/social/locdoc-v2.png");
