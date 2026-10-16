import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = "design/icon-options/03-root-hash.png";
const prompt = readFileSync(root + "design/icon-options/03-root-hash.prompt.txt", "utf8").trim();
const digest = createHash("sha256").update(readFileSync(root + source)).digest("hex");
function magick(args) {
  const result = spawnSync("magick", args, { cwd: root, encoding: "utf8" });
  if (result.error) throw new Error("Install ImageMagick to regenerate Locdoc icons.", { cause: result.error });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
const [width, height] = magick([source, "-format", "%w %h", "info:"]).split(" ").map(Number);
if (width !== height) throw new Error("The Origami Hash master must remain square.");
// Cream/coral paper is bright red; the navy background and shadows are not.
const [paperWidth, paperHeight, paperLeft, paperTop] = magick([source, "-fx", "r>0.45 ? 1 : 0", "-trim", "-format", "%w %h %X %Y", "info:"]).split(" ").map(Number);
const paperExtent = Math.max(paperWidth, paperHeight);
const exports = [
  [192, "public/icons/icon-192-v5.png", false],
  [512, "public/icons/icon-512-v5.png", false],
  [64, "public/icons/locdoc-v5.png", false],
  [32, "public/icons/favicon-32-v5.png", false],
  [512, "public/icons/maskable-512-v5.png", true],
  [180, "public/icons/apple-touch-180-v5.png", true],
];

for (const [size, output, platformPadded] of exports) {
  // Restore breathing room halfway between v3 and v4. Center the visible
  // paper bounds, which sit slightly above the original canvas center.
  const previousFill = (paperExtent / width) * (platformPadded ? 0.84 : 1);
  const targetFill = (1 + 3 * previousFill) / 4;
  const crop = Math.round(paperExtent / targetFill);
  const left = Math.round(paperLeft + paperWidth / 2 - crop / 2);
  const top = Math.round(paperTop + paperHeight / 2 - crop / 2);
  const offset = n => `${n >= 0 ? "+" : ""}${n}`;
  const frame = `${crop}x${crop}${offset(left)}${offset(top)}`;
  const origin = `Locdoc Origami Hash. Built-in image generation. Source: ${source}; SHA-256: ${digest}. Prompt: ${prompt}. Export: ${size}px; ${crop}px square frame centered on visible paper bounds; padding midway between v3 and v4, original artwork proportions retained.`;
  magick([
    source, "-virtual-pixel", "edge", "-filter", "point",
    "-define", `distort:viewport=${frame}`, "-distort", "SRT", "0", "+repage",
    "-filter", "Lanczos", "-resize", `${size}x${size}`,
    "-set", "comment", origin,
    "-define", "png:exclude-chunks=date,time", output,
  ]);
  console.log(output);
}
