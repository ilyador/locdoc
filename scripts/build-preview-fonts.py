"""Rebuild the bundled preview faces from the pinned Fontsource packages.

Development only: python -m pip install fonttools==4.67.0
Run after npm ci. The app embeds the resulting TTFs and needs no Python at runtime.

Each face merges its family's Latin, Cyrillic and Greek subsets with the Hebrew
face the app pairs with that family in src/hebrew-fonts.css. Only the characters
the app draws in a Hebrew face are taken from it, and only those the family
lacks, so every other character keeps its own glyph and the preview faces grow
by the Hebrew glyphs alone.
"""
from pathlib import Path
from fontTools.merge import Merger
from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont
from fontTools.ttLib.scaleUpem import scale_upem
import tempfile

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "node_modules/@fontsource"
OUTPUT = ROOT / "assets/social"
# The Hebrew block, its presentation forms and the sheqel sign: the
# unicode-range of every Hebrew face in src/hebrew-fonts.css.
HEBREW = [*range(0x0590, 0x0600), 0x20AA, *range(0xFB1D, 0xFB50)]
MONO = ["latin", "latin-ext", "cyrillic", "cyrillic-ext", "greek", "vietnamese"]
SANS = ["latin", "latin-ext", "cyrillic", "cyrillic-ext", "greek"]
# File, family, style, the family's subsets and its Hebrew partner: Cascadia
# Mono for JetBrains Mono, IBM Plex Sans Hebrew for IBM Plex Sans.
FACES = [
    ("Mono-Regular.ttf", "Locdoc Social Mono", "Regular",
     [f"jetbrains-mono/files/jetbrains-mono-{subset}-400-normal.woff" for subset in MONO],
     "cascadia-mono/files/cascadia-mono-hebrew-400-normal.woff"),
    ("Mono-SemiBold.ttf", "Locdoc Social Mono", "SemiBold",
     [f"jetbrains-mono/files/jetbrains-mono-{subset}-600-normal.woff" for subset in MONO],
     "cascadia-mono/files/cascadia-mono-hebrew-600-normal.woff"),
    ("Body-Regular.ttf", "Locdoc Social Sans", "Regular",
     [f"ibm-plex-sans/files/ibm-plex-sans-{subset}-400-normal.woff" for subset in SANS],
     "ibm-plex-sans-hebrew/files/ibm-plex-sans-hebrew-hebrew-400-normal.woff"),
]


def hebrew(path, covered, units):
    """The partner's Hebrew glyphs for the characters the family lacks, with
    their Hebrew shaping and mark positioning, scaled to the family's em."""
    font = TTFont(path)
    font.flavor = None
    options = Options()
    options.layout_scripts = ["hebr"]
    options.hinting = False  # resvg draws outlines without hinting
    options.glyph_names = True
    subsetter = Subsetter(options)
    subsetter.populate(unicodes=[c for c in HEBREW if c not in covered])
    subsetter.subset(font)
    if font["head"].unitsPerEm != units:
        scale_upem(font, units)
    return font


for file, family, style, subsets, partner in FACES:
    with tempfile.TemporaryDirectory(prefix="locdoc-font-") as temporary:
        paths, covered = [], set()
        for index, subset in enumerate(subsets):
            font = TTFont(SOURCE / subset)
            font.flavor = None
            covered |= set(font.getBestCmap())
            units = font["head"].unitsPerEm
            path = Path(temporary) / f"{index}.ttf"
            font.save(path)
            paths.append(str(path))
        font = hebrew(SOURCE / partner, covered, units)
        notices = [TTFont(paths[0])["name"].getDebugName(0), font["name"].getDebugName(0)]
        path = Path(temporary) / "hebrew.ttf"
        font.save(path)
        paths.append(str(path))
        merged = Merger().merge(paths)
        names = {0: " ".join(dict.fromkeys(notices)), 1: family, 2: style,
                 3: f"{family} {style}", 4: f"{family} {style}",
                 6: f"{family.replace(' ', '')}-{style}", 16: family, 17: style}
        for record in merged["name"].names:
            if record.nameID in names:
                record.string = names[record.nameID].encode(record.getEncoding())
        merged.save(OUTPUT / file)
        print(f"assets/social/{file}")
