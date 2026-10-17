# Preview fonts

These fonts are embedded in the Rust renderer, so previews need no system fonts,
image tools, browser process, or external service at runtime.

- `Body-Regular.ttf`: IBM Plex Sans from the pinned
  `@fontsource/ibm-plex-sans` package. Latin, Latin Extended, Cyrillic, Cyrillic
  Extended and Greek subsets were merged with fontTools 4.67.0 and named
  **Locdoc Social Sans** to respect the upstream reserved font name.
- `Mono-Regular.ttf` and `Mono-SemiBold.ttf`: JetBrains Mono 400/600 from the
  pinned `@fontsource/jetbrains-mono` package, named **Locdoc Social Mono**.
  Rebuild these optional development assets with fontTools 4.67.0 using
  `python scripts/build-preview-fonts.py` after `npm ci`.
- `Wordmark.ttf`: the pinned `@fontsource/bebas-neue` Latin face, converted from
  WOFF to TrueType with fontTools and named **Locdoc Social Display**.

The outlines are unchanged. Original copyright notices and SIL Open Font
Licenses are included beside the fonts. The source WOFF files remain available
in the corresponding installed Fontsource packages.
