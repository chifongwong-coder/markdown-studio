# Changelog

All notable changes to this extension are documented here. Versions follow
the `manifest.json` `version` field.

## 0.7.0 (in progress on `feat/word-export`)

### Added
- **Save as Word (.docx).** New "Word" button in the TOC header next
  to PDF / Edit. The rendered article downloads as a Word document
  with **editable equations** -- math is converted from KaTeX's
  MathML through mathml2omml to OMML and embedded as native Word
  equation primitives (not images), so users can click a formula
  in Word and edit it in the equation editor. Mermaid SVG, tables,
  images, footnotes, and real hyperlinks are not yet supported;
  placeholders ship for those.

### Math conversion pipeline (lib/exporter-docx.js)
The path from KaTeX-rendered math to Word-editable equation is built
out of these post-processors, in order:
- `stripUnsupportedMathMLElements` -- drop <annotation>, unwrap
  <mpadded>, drop <mphantom>. Pre-cleaning silences ~60 spurious
  `Type not supported` warnings per math-heavy article that mml2omml
  would otherwise spam to the console.
- `normalizeMathVariants` -- replace `<mi mathvariant="script">N</mi>`
  with the Unicode math script letter (`𝒩`). mml2omml emits an
  invalid `<m:sty m:val="undefined"/>` for script/double-struck/
  fraktur/sans-serif variants; Word falls back to body-text font
  on the bad value. Using the pre-styled codepoint sidesteps the
  bug entirely.
- `preserveMtextBoundarySpace` -- smuggle <mtext> trailing whitespace
  through mml2omml's whitespace-stripping XML parser via a PUA
  sentinel so `\text{if } x < 0` doesn't render as `ifx<0`.
- `mml2omml` -- the actual MathML→OMML conversion (vendor lib).
- `escapeMTextInOMML` -- mml2omml leaves raw '<' and '&' in <m:t>
  content. Word's XML parser then truncates the math at the bad
  byte; any inequality with `<` would silently disappear.
- `fixEmptyNary` -- right-to-left fill of empty <m:e/> in n-ary
  operators (integrals, sums). KaTeX puts the integrand as a sibling
  of the operator, not a child, leaving the OMML integrand slot
  empty. The right-to-left walk handles nested cases (∑∫f dx) in a
  single pass.
- `restoreSentinelSpaces` -- PUA → space.
- `stripInvisibleMathOperators` -- drop U+2061-U+2064 (function
  application, invisible times, invisible separator, invisible plus).
  Pages renders them invisibly per the Unicode spec; Word's Cambria
  Math has no glyph for U+2063 and substitutes a comma-shaped fallback,
  surfacing as a "phantom comma" next to `\\mathcal{N}\\!\\left(...`.
- `stripOmmlNamespaceDecl` -- drop per-element xmlns:m / xmlns:w
  declarations (the document.xml root declares them).

### Build
- Two new vendor libraries:
  - `vendor/jszip.min.js`         (MIT/GPL dual, UMD from jsdelivr)
  - `vendor/mathml2omml.min.js`   (LGPL-3.0, ESM upstream, bundled
                                   to IIFE locally via esbuild;
                                   install.sh runs the bundle step)
- `vendor/LGPL-3.0.txt` ships next to LICENSES.txt for compliance.
- `lib/render.js`: KaTeX output mode 'html' → 'htmlAndMathml' so the
  MathML the exporter reads is present in the DOM. CSS-clipped, no
  visible change.

### Deferred to later 0.7.x
- Tables (currently placeholder text)
- Images (currently placeholder text)
- Mermaid SVG → PNG → ImageRun
- Real <w:hyperlink> (link text inlined, URL dropped)
- Word native <w:footnote> wiring
- Real `<w:numbering>` lists (currently fake bullets / numeric prefix)

## 0.6.1

### Added
- **Edit mode: proportional scroll sync.** Scrolling either pane
  (source textarea or preview) updates the other to the same
  proportional position. Uses ratio rather than line-mapping --
  math, tables, images, and mermaid SVGs change vertical size
  between source and rendered HTML, so a 1:1 line map would need
  a costly index for marginally better behaviour. A flag breaks
  the would-be feedback loop where setting `scrollTop` on one
  pane fires `scroll` on that pane and tries to sync back.

### Fixed
- **Edit mode no longer jumps to the bottom when opened.** Previous
  builds called `textarea.focus()` after `textarea.value = source`,
  so the browser snapped the textarea to the caret (which defaults
  to end-of-text), making the editor open at the bottom of the
  document. The mount path now captures the reader's scroll
  position as a `[0,1]` ratio before swapping the article out,
  uses `focus({ preventScroll: true })`, places the caret roughly
  where the reader was, and explicitly restores the ratio on both
  panes once the preview has rendered. Opening Edit now lands
  on the same section the reader was looking at.
- **Exiting Edit lands the reader where the editor was scrolled to,
  not where they originally started.** Previously unmountEditor
  restored the pre-edit scrollY captured at mount time. If the user
  scrolled around in source mode, hitting Cancel would teleport
  them back. The exit path now reads the textarea's scroll ratio
  before the editor is detached and applies it to the reader's
  scrollable range, so Mount and Cancel form a symmetric pair --
  both preserve "where you were looking" across the swap.

### Changed (internal -- no user-visible impact beyond the build zip name)
- Internal identifiers renamed from `md-viewer` / `MdViewer` to
  `markdown-studio` / `MarkdownStudio`. Affects the `window`
  global, CSS class prefixes used in `viewer.css` and JS,
  console log prefix, and the two `localStorage` keys
  (`...-toc-hidden`, `...-file-tip-dismissed-v1`).
- `package.sh` now writes `build/markdown-studio-<version>.zip`
  instead of `build/md-viewer-<version>.zip`.

### Migration
- A one-time idempotent migration in `content.js` moves any
  existing `md-viewer-*` localStorage values to the new
  `markdown-studio-*` keys so upgrading users keep their TOC
  collapse state and don't see the file-access tip again. Safe to
  delete in a future release once enough users have upgraded.

## 0.5.0

### Renamed
- **Extension renamed from "Markdown Viewer with Math" to "Markdown
  Studio"** (short_name `MD Viewer` -> `MD Studio`). With viewer +
  PDF export + edit mode all in the same package, "viewer" is no
  longer accurate; "Studio" matches the broader feature surface and
  differentiates from the crowded "Markdown Viewer / Reader / Preview"
  entries on the Chrome Web Store. The extension's internal Chrome
  ID is unchanged so existing users keep their installations and
  receive the new name on the next listing refresh.

### Added
- **Edit mode.** An `Edit` button in the TOC header swaps the
  rendered article for a full-viewport split view: a textarea with
  the raw markdown on the left, a live preview that mirrors the
  reading view on the right. Edits debounce-render to the preview
  every 300 ms (math, mermaid, syntax highlighting, footnotes all
  refresh). The toolbar exposes:
  - `Save` -- creates a Blob of the textarea contents and triggers
    a browser download with the original `.md` filename. The
    extension cannot write back to the original file (no `file://`
    write privilege; no remote-host privilege for http(s)), so
    "save" is a download. Existing files are not modified.
  - `Cancel` (or `Esc`) -- exits edit mode and restores the
    previously-rendered article + the reader's scroll position.
    In-memory edits are lost.
  Edit mode hides the TOC sidebar, the show/hide tabs, and the
  file-URL tip banner via a `body.md-editing` class; the raw
  markdown that seeds the textarea is cached from the initial
  render so it's still available after `document.body` has been
  rewritten with the rendered HTML.

### Build / tooling
- New file `lib/editor.js` added to `content_scripts.js` in
  manifest.json (and to `package.sh`'s required-files allowlist).
  The pre-existing `lib/` directory inclusion in `package.sh`'s zip
  command picks it up automatically.

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
