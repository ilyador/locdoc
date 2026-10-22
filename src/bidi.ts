export type TextDirection = "ltr" | "rtl";

// Letters of the right-to-left scripts: Hebrew, Arabic, Syriac, Thaana, N'Ko,
// Samaritan and Mandaic, their presentation forms and historic blocks.
const rightToLeft =
  /[\u{0590}-\u{08FF}\u{FB1D}-\u{FDFF}\u{FE70}-\u{FEFC}\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;
const letter = /\p{L}/u;

// The direction of the first strong character, as dir="auto" chooses it:
// right-to-left letters and marks, or any other letter. Digits, punctuation,
// symbols, spaces and combining marks are not strong, so text made only of
// them has no direction of its own.
export function textDirection(text: string): TextDirection | null {
  for (const char of text) {
    if (char === "\u{200F}" || char === "\u{061C}") return "rtl";
    if (char === "\u{200E}") return "ltr";
    if (letter.test(char)) return rightToLeft.test(char) ? "rtl" : "ltr";
  }
  return null;
}

export function hasRightToLeft(text: string) {
  return rightToLeft.test(text);
}

// Text a person wrote, inside a sentence of interface text, keeps its own
// direction: a Hebrew name cannot reorder the English sentence around it, and
// neutral characters at its edges stay with it. Text without right-to-left
// letters needs no isolation and is returned unchanged.
export function isolate(text: string) {
  return hasRightToLeft(text) ? `\u{2068}${text}\u{2069}` : text;
}
