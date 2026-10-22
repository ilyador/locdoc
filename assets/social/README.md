# Preview fonts

These fonts are embedded in the Rust renderer, so previews need no system fonts,
image tools, browser process, or external service at runtime.

- `Body-Regular.ttf`: IBM Plex Sans from the pinned
  `@fontsource/ibm-plex-sans` package with the Hebrew of IBM Plex Sans Hebrew
  from `@fontsource/ibm-plex-sans-hebrew`, named **Locdoc Social Sans** to
  respect the upstream reserved font name.
- `Mono-Regular.ttf` and `Mono-SemiBold.ttf`: JetBrains Mono 400/600 from the
  pinned `@fontsource/jetbrains-mono` package with the Hebrew of Cascadia Mono
  400/600 from `@fontsource/cascadia-mono`, named **Locdoc Social Mono**.
- `Wordmark.ttf`: the pinned `@fontsource/bebas-neue` Latin face, converted from
  WOFF to TrueType with fontTools and named **Locdoc Social Display**.

Rebuild the body and mono faces with fontTools 4.67.0 using
`python scripts/build-preview-fonts.py` after `npm ci`. The script merges each
family's Latin, Latin Extended, Cyrillic, Cyrillic Extended and Greek subsets,
and Vietnamese for JetBrains Mono, with a subset of the Hebrew face the app
pairs with that family in `src/hebrew-fonts.css`. The subset keeps only the
Hebrew block, its presentation forms and the sheqel sign that the family lacks,
with their Hebrew shaping and mark positioning and without hinting. Cascadia
Mono lacks some points, such as sheva and hiriq, so the renderer draws a title
or line that uses them in IBM Plex Sans Hebrew.

The outlines are unchanged, except that Cascadia Mono's are scaled to the 1000
units per em of JetBrains Mono. Original copyright notices and SIL Open Font
Licenses are included beside the fonts; the Cascadia Mono license carries the
notice from the font itself, since its package's LICENSE names Google Inc. The
source WOFF files remain available in the corresponding installed Fontsource
packages.
