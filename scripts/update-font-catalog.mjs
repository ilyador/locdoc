import { writeFile } from "node:fs/promises";
const source = "https://fonts.google.com/metadata/fonts";
const response = await fetch(source, {
  signal: AbortSignal.timeout(15000),
  redirect: "error",
});
if (!response.ok)
  throw new Error(`Google Fonts catalog: HTTP ${response.status}`);
const data = JSON.parse((await response.text()).replace(/^\)\]\}'\s*/, ""));
if (!Array.isArray(data.familyMetadataList))
  throw new Error("Unexpected Google Fonts catalog format");
const fonts = data.familyMetadataList
  .filter(
    (f) => f.isOpenSource && !f.isBrandFont && typeof f.family === "string",
  )
  .map((f) => ({ family: f.family, category: f.category }))
  .sort((a, b) => a.family.localeCompare(b.family));
if (fonts.length < 1000)
  throw new Error("Google Fonts catalog is unexpectedly incomplete");
await writeFile(
  new URL("../public/font-catalog.json", import.meta.url),
  JSON.stringify({ source, updatedAt: new Date().toISOString(), fonts }) + "\n",
);
console.log(`Updated ${fonts.length} Google Fonts families`);
