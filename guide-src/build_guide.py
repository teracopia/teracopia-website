#!/usr/bin/env python3
"""
Builds the Teracopia Lucid Dreaming Quick-Start Guide PDF (the free lead
magnet delivered on signup) from its HTML/CSS source in this folder.

Source of truth: guide-src/quick-start-guide.html
Output: downloads/teracopia-lucid-dreaming-quick-start-guide.pdf
        (also copied to assets/downloads/ to match the mirrored asset path)

Requires: pip install weasyprint
Fonts (Jost, Manrope) are expected to be available to the system (e.g.
installed under ~/.fonts or /usr/share/fonts) since this renders without
network access to Google Fonts.

Usage:
    python3 guide-src/build_guide.py
"""
import shutil
import sys
from pathlib import Path

from weasyprint import HTML

ROOT = Path(__file__).parent.parent
SRC = Path(__file__).parent / "quick-start-guide.html"
OUT_PRIMARY = ROOT / "downloads" / "teracopia-lucid-dreaming-quick-start-guide.pdf"
OUT_MIRROR = ROOT / "assets" / "downloads" / "teracopia-lucid-dreaming-quick-start-guide.pdf"


def main():
    if not SRC.exists():
        print(f"ERROR: source not found at {SRC}")
        sys.exit(1)

    print(f"Rendering {SRC} -> {OUT_PRIMARY}")
    HTML(filename=str(SRC)).write_pdf(str(OUT_PRIMARY))

    OUT_MIRROR.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(OUT_PRIMARY, OUT_MIRROR)
    print(f"Copied to {OUT_MIRROR}")

    print("Done. Commit guide-src/, downloads/, and assets/downloads/ together.")


if __name__ == "__main__":
    main()
