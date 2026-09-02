#!/usr/bin/env python3
"""
Teracopia site builder.

Source of truth lives under src/ — each page there is the full HTML file
with the nav and footer replaced by two markers:
  {{NAV:<active>}}   e.g. {{NAV:about}}, {{NAV:home}}, {{NAV:none}}
  {{FOOTER}}

This script renders partials/nav.html and partials/footer.html into those
markers and writes the finished, deployable HTML to the matching path at
the repo root (the same files Cloudflare serves).

Usage:
    python3 build.py

After editing anything under src/ or partials/, run this, then commit
both the src/ changes and the regenerated output files together.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).parent
SRC = ROOT / "src"
PARTIALS = ROOT / "partials"

NAV_KEYS = ["HOME", "ABOUT", "BLOG", "FAQ", "BOOK"]
ACTIVE_MAP = {
    "home": "HOME",
    "about": "ABOUT",
    "blog": "BLOG",
    "faq": "FAQ",
    "book": "BOOK",
    "none": None,
}

NAV_TEMPLATE = (PARTIALS / "nav.html").read_text()
FOOTER_HTML = (PARTIALS / "footer.html").read_text()

NAV_MARKER_RE = re.compile(r"\{\{NAV:(\w+)\}\}\n")
FOOTER_MARKER_RE = re.compile(r"\{\{FOOTER\}\}\n")


def render_nav(active):
    if active not in ACTIVE_MAP:
        raise ValueError(f"Unknown nav active key: {active!r}")
    active_key = ACTIVE_MAP[active]
    out = NAV_TEMPLATE
    for key in NAV_KEYS:
        token = "{{ACTIVE_%s}}" % key
        value = ' aria-current="page"' if key == active_key else ""
        out = out.replace(token, value)
    return out


def build_file(src_path: Path, out_path: Path):
    content = src_path.read_text()

    nav_matches = NAV_MARKER_RE.findall(content)
    if len(nav_matches) != 1:
        print(f"ERROR: {src_path} has {len(nav_matches)} NAV markers (expected 1)")
        return False
    footer_count = len(FOOTER_MARKER_RE.findall(content))
    if footer_count != 1:
        print(f"ERROR: {src_path} has {footer_count} FOOTER markers (expected 1)")
        return False

    active = nav_matches[0]
    content = NAV_MARKER_RE.sub(lambda m: render_nav(active), content, count=1)
    content = FOOTER_MARKER_RE.sub(FOOTER_HTML, content, count=1)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(content)
    return True


def main():
    src_files = sorted(SRC.rglob("*.html"))
    if not src_files:
        print("No source files found under src/")
        sys.exit(1)

    ok = True
    for src_path in src_files:
        rel = src_path.relative_to(SRC)
        out_path = ROOT / rel
        if build_file(src_path, out_path):
            print(f"built {rel}")
        else:
            ok = False

    if not ok:
        print("\nBuild finished with errors.")
        sys.exit(1)
    print(f"\nBuilt {len(src_files)} pages.")


if __name__ == "__main__":
    main()
