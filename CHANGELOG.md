# Changelog

All notable changes to this extension are documented here. Versions follow
the `manifest.json` `version` field.

## 0.4.0

### Added
- **Save as PDF / print (light-themed).** A `PDF` button in the
  TOC header calls `window.print()`. The print output always uses
  a light theme regardless of the on-screen mode (white page,
  GitHub-Light syntax colours, light-themed mermaid) because that
  produces a printable, paper-friendly artefact and matches how
  most users share PDFs. The button does three things on click:
  (1) await a mermaid re-render with the default light theme so
  the SVG itself uses dark text on light fills, (2) trigger
  `window.print()`, and (3) on `afterprint`, re-render mermaid
  back to the on-screen theme so the live page is unchanged.
  KaTeX math, mermaid SVGs, syntax highlighting, and footnotes
  paginate with the same fidelity as on screen.

  *(An earlier iteration shipped a parallel "Dark PDF" button. It
  was removed -- the CSS-paged-media path for full-bleed dark page
  bg hit one fundamental wall after another: Chrome strips `body`
  / `html` background in print, `position: fixed` pseudo-element
  bg gets clipped by `@page` margins, and `padding` on a content
  div doesn't apply per-page on continuation pages so page 2+
  always butted the very paper edge. Single button + always-light
  is the honest fix.)*

### Onboarding
- **File-URL access reminder banner.** Chrome ships extensions with
  file:// access disabled, and the toggle to enable it is buried in
  `chrome://extensions` -> Details. New users typically install the
  extension, double-click a local `.md` file, see nothing happen, and
  conclude the extension is broken. We can't open the chrome:// page
  programmatically and we have no popup, so on every http(s) render
  the content script now prepends a single-line dismissible tip
  pointing at the toggle. Hidden in print, hidden on file:// renders
  (where access is by definition already on), and dismissal persists
  via localStorage so the banner appears at most once per
  user-per-origin. STORE_LISTING gets the same instruction promoted
  to the top of the description.

### Print pipeline polish
- `@page { margin: 0.7in 0.6in }` standardises page margins across
  Chrome / Edge / Firefox so identical input produces identical PDFs.
- `pre` blocks wrap long lines in print (`white-space: pre-wrap`) so
  nothing is silently chopped at the paper edge -- scrollable on
  screen, wrapping on paper.
- **Code blocks now have a visible border in print, even when
  "Background graphics" is disabled.** Print dialogs default that
  setting off, which previously stripped our light-grey `pre`
  background and left fenced code floating bare on white with no
  edge cue. Added an explicit 1px border plus `print-color-adjust:
  exact` so the boundary survives both ways the print path can drop
  backgrounds.
- **Mermaid diagrams print as a light-themed drawing regardless of
  the on-screen theme.** When the page was rendered in dark mode the
  mermaid SVG baked dark fills as inline `fill=` attributes, which
  the print pipeline cannot strip via "Background graphics" (those
  aren't CSS background colours). Added print-only overrides that
  force node fills to white and strokes / text / arrow heads to
  near-black, with `print-color-adjust: exact` so the overrides
  apply with or without backgrounds enabled. Without this the
  printed diagram was black boxes on black-leaning rectangles.
- **Syntax highlighting recoloured for paper.** highlight.js ships
  with Monokai, designed for dark backgrounds; on the white print
  page the keyword pinks / function greens / number oranges became
  near-invisible. Added a print-only set of `.hljs-*` overrides
  using GitHub-Light-style dark hues (keyword `#d73a49`, string
  `#032f62`, number/type `#005cc5`, title `#6f42c1`, comment
  `#6a737d`) plus `print-color-adjust: exact`, so printed code
  is readable without giving up the on-screen Monokai look.
- Mermaid SVG capped at 4in tall in print so a tall flowchart can't
  consume a whole page on its own.
- Footnotes section uses `break-inside: avoid-page` to keep itself
  together where possible.

## 0.3.2

### Fixed
- Chrome refused to load v0.3.1 in some environments with
  `Could not load JavaScript 'vendor/mermaid.min.js' ... is not UTF-8 encoded`.
  Mermaid's bundle embeds a raw U+FFFF and U+0001 inside string literals;
  Chrome's content-script UTF-8 check (strict `base::IsStringUTF8`) rejects
  Unicode non-characters and C0 control bytes even when the byte stream is
  valid UTF-8. Rewriting those two characters as JS escape sequences
  (`￿`, `\x01`) leaves runtime behavior identical and lets the manifest
  load.

### Build / tooling
- Added `vendor/patch-mermaid.py`: idempotently rewrites Chrome-rejected
  codepoints in `vendor/mermaid.min.js`. `install.sh` runs it after
  downloading mermaid; `package.sh` runs it again before zipping as defense
  in depth, so a stale or hand-replaced bundle can't ship broken.
- Regression coverage for the patcher added to `test-extract.mjs`.

### Docs
- README "Known limits" and STORE_LISTING "KNOWN LIMITATIONS" no longer
  claim mermaid/footnotes are unsupported.
- README layout diagram updated to reflect current `vendor/` and scripts.

## 0.3.1

- Defensive fixes from the mermaid + footnote review pass.

## 0.3.0

- Mermaid diagrams: fenced ` ```mermaid ` blocks render to inline SVG;
  diagram theme follows the page's light/dark mode.
- Word-boundary detection on the fence info string so `mermaidish` /
  `mermaid-cli` are not mistaken for mermaid blocks; nested fences
  (e.g. a 4-backtick documentation block) leave inner ` ```mermaid `
  blocks as literal content.

## 0.2.0

- Pandoc-style footnotes: `[^id]` references render as superscript links
  plus a collected footnotes section. IDs are namespaced (`md-fn-…`) so
  they can't collide with heading slugs.

## 0.1.2

- Render pipeline hardening: sanitize the marked output before splicing
  in KaTeX HTML; switch placeholders to Private Use Area sentinels so they
  survive sanitization intact.
- O(n) scans for math extraction and placeholder substitution (previous
  slicing was O(n²) on large documents).
- Defense-in-depth scrubs: placeholders that land inside `<pre>`, `<code>`,
  or HTML attribute contexts fall back to the literal source.
- Tablet drawer, IntersectionObserver-based TOC active tracking, extended
  CJK heading slugs, a11y / print polish.

## 0.1.1

- Manifest description shortened to fit Chrome Web Store's 132-char limit.
- Third-party notices added under `vendor/LICENSES.txt`.

## 0.1.0

- Initial release: LaTeX math (KaTeX), syntax highlighting (highlight.js),
  GFM tables / task lists, collapsible sidebar TOC, light/dark auto theme,
  local file support, DOMPurify sanitization, fully offline (no remote
  requests at runtime).
