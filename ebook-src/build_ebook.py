#!/usr/bin/env python3
"""
Builds "Your Simple Guide to Lucid Dreaming" PDF (the paid ebook) from its
self-contained HTML/CSS source in this folder.

Source of truth: ebook-src/simple-guide.html (CSS is inlined in the file;
rem_chart.svg here is kept only as a readable copy of the chart markup
embedded in the HTML, for reference).
Output: downloads/your-simple-guide-to-lucid-dreaming.pdf
        (also copied to assets/downloads/ to match the mirrored asset path)

Requires: pip install weasyprint
Fonts (Jost, Manrope) are expected to be available to the system (e.g.
installed under ~/.fonts or /usr/share/fonts) since this renders without
network access to Google Fonts.

Usage:
    python3 ebook-src/build_ebook.py
"""
import shutil
import sys
from pathlib import Path

from weasyprint import HTML

ROOT = Path(__file__).parent.parent
SRC = Path(__file__).parent / "simple-guide.html"
OUT_PRIMARY = ROOT / "downloads" / "your-simple-guide-to-lucid-dreaming.pdf"
OUT_MIRROR = ROOT / "assets" / "downloads" / "your-simple-guide-to-lucid-dreaming.pdf"


def main():
    if not SRC.exists():
        print(f"ERROR: source not found at {SRC}")
        sys.exit(1)

    print(f"Rendering {SRC} -> {OUT_PRIMARY}")
    HTML(filename=str(SRC)).write_pdf(str(OUT_PRIMARY))

    OUT_MIRROR.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(OUT_PRIMARY, OUT_MIRROR)
    print(f"Copied to {OUT_MIRROR}")

    print("Done. Commit ebook-src/, downloads/, and assets/downloads/ together.")


if __name__ == "__main__":
    main()
