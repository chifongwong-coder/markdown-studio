# Changelog

All notable changes to this extension are documented here. Versions follow
the `manifest.json` `version` field.

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
