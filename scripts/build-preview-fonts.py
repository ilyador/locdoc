"""Rebuild bundled preview monospace faces from the pinned Fontsource package.

Development only: python -m pip install fonttools==4.67.0
Run after npm ci. The app embeds the resulting TTFs and needs no Python at runtime.
"""
from pathlib import Path
from fontTools.merge import Merger
from fontTools.ttLib import TTFont
import tempfile

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "node_modules/@fontsource/jetbrains-mono/files"
OUTPUT = ROOT / "assets/social"
SUBSETS = ["latin", "latin-ext", "cyrillic", "cyrillic-ext", "greek", "vietnamese"]

for weight, label in [(400, "Regular"), (600, "SemiBold")]:
    with tempfile.TemporaryDirectory(prefix="locdoc-font-") as temporary:
        paths = []
        for subset in SUBSETS:
            font = TTFont(SOURCE / f"jetbrains-mono-{subset}-{weight}-normal.woff")
            font.flavor = None
            path = Path(temporary) / f"{subset}.ttf"
            font.save(path)
            paths.append(str(path))
        merged = Merger().merge(paths)
        family = "Locdoc Social Mono"
        names = {1: family, 2: label, 3: f"{family} {label}", 4: f"{family} {label}",
                 6: f"LocdocSocialMono-{label}", 16: family, 17: label}
        for record in merged["name"].names:
            if record.nameID in names:
                record.string = names[record.nameID].encode(record.getEncoding())
        merged.save(OUTPUT / f"Mono-{label}.ttf")
        print(f"assets/social/Mono-{label}.ttf")
