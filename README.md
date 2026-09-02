# Teracopia website

Static site deployed via Cloudflare Workers — every push to `main` goes live.

## Editing pages

The nav and footer used to be copy-pasted into all 14 HTML files, which made
even small shared changes (like the mobile menu) risky multi-file edits.
That's fixed now:

- **`src/`** is the source of truth. Each page there is the full page with
  the nav and footer replaced by two markers: `{{NAV:<active>}}` (e.g.
  `{{NAV:about}}`, `{{NAV:home}}`, `{{NAV:none}}` for pages with no matching
  nav item) and `{{FOOTER}}`.
- **`partials/nav.html`** and **`partials/footer.html`** are the shared nav
  and footer markup, edited once.
- **`build.py`** renders the partials into each `src/` page and writes the
  finished HTML to the matching path at the repo root — the actual files
  Cloudflare serves.

### Workflow

1. Edit content in `src/<page>.html`, or edit shared nav/footer in
   `partials/`.
2. Run `python3 build.py` from the repo root.
3. Commit both the `src/`/`partials/` changes and the regenerated root
   HTML files together, then push.

Never hand-edit the root-level HTML files (`index.html`, `about.html`,
etc.) directly — those are generated output and any manual edit there
will be silently overwritten the next time `build.py` runs.

Everything else (styling in `assets/style.css`, images, the PDF lead
magnet, `nav.js`) works exactly as before.
