import { BlockWrapper } from "@codemirror/view";

// Cue extensions and dual-dialogue markers do not identify another speaker.
export function fountainSpeakerName(text: string) {
  return text
    .replace(/^\s*@/, "")
    .replace(/\s*\^\s*$/, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim()
    .replace(/\s+/g, " ")
    .normalize("NFC");
}

const distance = (a: number, b: number) =>
  180 - Math.abs(Math.abs(a - b) - 180);

// Muted text inks: enough color to identify a speaker without competing with
// dialogue. Each row is hue, light-mode L/C, dark-mode L/C.
const palette = [
  [255, 0.48, 0.133, 0.78, 0.084], // cobalt
  [65, 0.53, 0.098, 0.82, 0.098], // amber
  [180, 0.47, 0.07, 0.75, 0.091], // teal
  [15, 0.53, 0.126, 0.79, 0.112], // crimson
  [305, 0.48, 0.133, 0.78, 0.105], // violet
  [120, 0.52, 0.091, 0.83, 0.112], // olive
  [40, 0.51, 0.112, 0.79, 0.098], // copper
  [220, 0.53, 0.07, 0.81, 0.084], // cyan
  [340, 0.5, 0.126, 0.77, 0.105], // magenta
  [150, 0.51, 0.098, 0.8, 0.112], // green
  [280, 0.54, 0.119, 0.75, 0.098], // indigo
  [90, 0.48, 0.07, 0.77, 0.084], // ochre
] as const;

function tone(hue: number) {
  return palette.reduce((nearest, ink) =>
    distance(ink[0], hue) < distance(nearest[0], hue) ? ink : nearest,
  );
}

// Compare perceived separation in both themes, rather than just hue angles.
function separation(a: number, b: number) {
  const first = tone(a),
    second = tone(b);
  const radians = ((a - b) * Math.PI) / 180;
  return Math.min(
    ...[1, 3].map((i) =>
      Math.sqrt(
        (first[i] - second[i]) ** 2 +
          first[i + 1] ** 2 +
          second[i + 1] ** 2 -
          2 * first[i + 1] * second[i + 1] * Math.cos(radians),
      ),
    ),
  );
}

function chooseHue(name: string, used: number[]) {
  // A name-seeded random starting point also keeps a new, unfinished cue steady
  // when its line is laid out again. No document text is rewritten for color.
  let hash = 2166136261;
  for (const letter of name)
    hash = Math.imul(hash ^ letter.codePointAt(0)!, 16777619);
  const preferred = ((hash >>> 0) / 2 ** 32) * 360;
  const available = palette.filter((ink) => !used.includes(ink[0]));
  if (!used.length) return tone(preferred)[0];
  if (available.length) {
    const score = (hue: number) =>
      Math.min(...used.map((other) => separation(hue, other)));
    return available.reduce((best, ink) =>
      score(ink[0]) > score(best[0]) ? ink : best,
    )[0];
  }
  // A larger cast shares the remaining gaps; existing speakers never move.
  const sorted = [...used].sort((a, b) => a - b);
  let gap = -1,
    hue = preferred;
  for (let i = 0; i < sorted.length; i++) {
    const end =
      sorted[(i + 1) % sorted.length] + (i === sorted.length - 1 ? 360 : 0);
    if (end - sorted[i] > gap) {
      gap = end - sorted[i];
      hue = (sorted[i] + gap / 2) % 360;
    }
  }
  return hue;
}

// Display preferences belong to this browser and document, never the source or
// CRDT. A blocked/full store must not prevent reading or editing the screenplay.
export class FountainSpeakerColors {
  private hues = new Map<string, number>();
  private wrappers = new Map<number, BlockWrapper>();
  private storage: Pick<Storage, "getItem" | "setItem"> | undefined;
  private key: string;
  private dirty = false;

  constructor(id = "", storage?: Pick<Storage, "getItem" | "setItem">) {
    this.key = id ? `locdoc.speakerColors.${id}` : "";
    if (!this.key) return;
    try {
      this.storage = storage ?? globalThis.localStorage;
      const saved = JSON.parse(this.storage?.getItem(this.key) || "null") as {
        version?: unknown;
        hues?: unknown;
      } | null;
      // Replace the old low-chroma palette once, including saved browser hues.
      if (saved?.version !== 2 || !Array.isArray(saved.hues)) return;
      for (const pair of saved.hues) {
        if (
          Array.isArray(pair) &&
          pair.length === 2 &&
          typeof pair[0] === "string" &&
          typeof pair[1] === "number" &&
          Number.isFinite(pair[1]) &&
          pair[1] >= 0 &&
          pair[1] < 360 &&
          !this.hues.has(pair[0]) &&
          ![...this.hues.values()].includes(pair[1])
        )
          this.hues.set(pair[0], pair[1]);
      }
    } catch {
      /* Browser storage is optional. */
    }
  }

  prime(cues: Iterable<string>) {
    const counts = new Map<string, number>();
    for (const cue of cues) {
      const name = fountainSpeakerName(cue).toUpperCase();
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    // Main roles get the widest separation first. Saved assignments never move
    // when dialogue counts change or somebody adds another speaker later.
    for (const [name] of [...counts].sort((a, b) => b[1] - a[1]))
      this.wrapper(name);
  }

  wrapper(text: string, remember = true) {
    const name = fountainSpeakerName(text).toUpperCase();
    let hue = this.hues.get(name);
    if (hue === undefined) {
      hue = chooseHue(name, [...this.hues.values()]);
      if (remember) {
        this.hues.set(name, hue);
        this.dirty = true;
      }
    }
    let wrapper = this.wrappers.get(hue);
    if (!wrapper) {
      const [, lightness, chroma, darkLightness, darkChroma] = tone(hue);
      wrapper = BlockWrapper.create({
        tagName: "div",
        attributes: {
          class: "fountain-line fountain-character",
          style: `--speaker-hue:${hue};--speaker-light:oklch(${lightness} ${chroma} ${hue});--speaker-dark:oklch(${darkLightness} ${darkChroma} ${hue})`,
        },
      });
      this.wrappers.set(hue, wrapper);
    }
    return wrapper;
  }

  flush() {
    if (!this.dirty || !this.key) return;
    this.dirty = false;
    try {
      this.storage?.setItem(
        this.key,
        JSON.stringify({ version: 2, hues: [...this.hues] }),
      );
    } catch {
      /* Keep the colors in memory if storage is unavailable. */
    }
  }
}
