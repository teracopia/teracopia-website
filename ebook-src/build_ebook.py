#!/usr/bin/env python3
"""
Builds "Your Simple Guide to Lucid Dreaming" PDF (the paid ebook) from its
self-contained HTML/CSS source in this folder.

Source of truth: ebook-src/simple-guide.html (CSS is inlined in the file;
rem_chart.svg here is kept only as a readable copy of the chart markup
embedded in the HTML, for reference).
Output: secure/your-simple-guide-to-lucid-dreaming.pdf

This lives under secure/, NOT downloads/, on purpose: it's the paid book,
gated behind Stripe payment verification in worker.js (see /download/ebook).
secure/ is excluded from direct public access (wrangler.toml's
run_worker_first blocks it), and is only ever read internally via the
Worker's ASSETS binding. Do not add a public-facing copy of this file.

Requires: pip install weasyprint
Fonts (Jost, Manrope) are expected to be available to the system (e.g.
installed under ~/.fonts or /usr/share/fonts) since this renders without
network access to Google Fonts.

Usage:
    python3 ebook-src/build_ebook.py
"""
import sys
from pathlib import Path

from weasyprint import HTML

ROOT = Path(__file__).parent.parent
SRC = Path(__file__).parent / "simple-guide.html"
OUT = ROOT / "secure" / "your-simple-guide-to-lucid-dreaming.pdf"


def main():
    if not SRC.exists():
        print(f"ERROR: source not found at {SRC}")
        sys.exit(1)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    print(f"Rendering {SRC} -> {OUT}")
    HTML(filename=str(SRC)).write_pdf(str(OUT))

    print("Done. Commit ebook-src/ and secure/ together.")


if __name__ == "__main__":
    main()
