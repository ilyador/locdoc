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

function chooseHue(name: string, used: number[]) {
  // A name-seeded random starting point also keeps a new, unfinished cue steady
  // when its line is laid out again. No document text is rewritten for color.
  let hash = 2166136261;
  for (const letter of name)
    hash = Math.imul(hash ^ letter.codePointAt(0)!, 16777619);
  const preferred = ((hash >>> 0) / 2 ** 32) * 360;
  if (used.every((hue) => distance(hue, preferred) >= 35)) return preferred;
  // When the preferred hue is crowded, bisect the largest available gap.
  // Existing speakers never move; a large cast gradually shares the wheel.
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
      const saved: unknown = JSON.parse(
        this.storage?.getItem(this.key) || "null",
      );
      if (!Array.isArray(saved)) return;
      for (const pair of saved) {
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
      wrapper = BlockWrapper.create({
        tagName: "div",
        attributes: {
          class: "fountain-line fountain-character",
          style: `--speaker-hue:${hue}`,
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
      this.storage?.setItem(this.key, JSON.stringify([...this.hues]));
    } catch {
      /* Keep the colors in memory if storage is unavailable. */
    }
  }
}
