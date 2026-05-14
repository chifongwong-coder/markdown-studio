# Markdown Viewer with Math

> Browse `.md` files in Chrome the way they're supposed to look — with proper
> LaTeX math, syntax highlighting, and a collapsible table of contents.

A Chrome extension that renders any `.md` file you open in Chrome (`.md`,
`.markdown`, `.mdown`, served over `http(s)` **or** opened locally via
`file://`) into a clean typographic page. Built around the one thing most
existing viewers get wrong: dollar signs inside code blocks must stay
literal, and escaped `\$` must not trigger formula extraction.

## Features

- **LaTeX math** — `$...$`, `$$...$$`, `\(...\)`, `\[...\]` rendered with KaTeX
- **Formula boundary handling** — `$` inside fenced code blocks or inline code is left alone; escaped `\$` does not trigger extraction
- **Syntax highlighting** — highlight.js, language auto-detected
- **GFM** — tables, task lists, strikethrough, autolinks
- **Pandoc-style footnotes** — `[^id]` references + a collected footnotes section
- **Collapsible sidebar TOC** — auto-built from headings, click to scroll, scroll-driven active-section tracking, persists collapsed/expanded state
- **Dark mode** — follows `prefers-color-scheme`
- **Local files** — supports `file:///` paths (requires opt-in on the extension page)
- **Sanitized output** — rendered HTML passes through DOMPurify before being written to the DOM
- **Local rendering** — no analytics, no telemetry, no remote requests; every dependency ships inside the extension package

## Repository

<https://github.com/chifongwong-coder/markdown-viewer-math>

## Local development

```bash
# 1. Download vendor dependencies (marked / KaTeX / highlight.js / DOMPurify).
./install.sh

# 2. Open chrome://extensions, enable "Developer mode",
#    click "Load unpacked", and pick this directory.

# 3. To open local .md files: on the extension's details page,
#    enable "Allow access to file URLs".
```

## Layout

```
md-viewer/
├── manifest.json            Manifest V3 declaration
├── content.js               Entry point: grab raw markdown, render, replace
├── lib/render.js            Core algorithm: math extraction + placeholder pipeline
├── lib/toc.js               Collapsible sidebar TOC
├── styles/viewer.css        Theme (light/dark auto)
├── vendor/                  Bundled dependencies (download via install.sh)
│   ├── marked.min.js
│   ├── katex.min.js + katex.min.css + fonts/
│   ├── highlight.min.js + highlight-monokai.css
│   └── purify.min.js
├── icons/                   16/48/128 PNG icons
└── install.sh               One-shot dependency fetcher
```

## How math extraction works

Math syntax colliding with markdown syntax is the typical failure mode of
naive Markdown-with-math viewers. This extension's pipeline:

1. **Fenced-code state machine.** Lines inside ``` ``` ``` or ``` ~~~ ``` blocks are passed through unchanged.
2. **`applyOutsideInlineCode`.** In non-fenced segments, runs of N backticks
   (CommonMark-correct equal-length matching) are skipped — formula extraction
   only runs on the text between code spans.
3. **Regex extraction** in this order so display delimiters win over inline:
   - `$$...$$` — display, may span newlines, lookbehind excludes `\$`
   - `\[...\]` — display
   - `\(...\)` — inline
   - `$...$` — inline, neither delimiter can be preceded by `\` or `$`
4. **Placeholders.** Each formula is replaced with `KATEXPHnEND`, then the
   markdown body is parsed normally by marked.
5. **Re-substitution.** Placeholders are swapped back for the KaTeX HTML.
   Display formulas are unwrapped from their surrounding `<p>` first
   (avoiding invalid `<div>` inside `<p>`).
6. **Sanitization.** Final HTML is run through DOMPurify with a permissive
   allowlist covering KaTeX/MathML elements.

See `lib/render.js` for the implementation.

## Building the Chrome Web Store zip

Run `./package.sh`. It reads the version from `manifest.json`, validates
that every runtime file is present, and writes
`build/md-viewer-<version>.zip` containing only what Chrome needs at
runtime plus `LICENSE` and `vendor/LICENSES.txt`. Development assets
(this README, test fixtures, screenshots, install scripts, icon
sources, etc.) are excluded automatically.

## Known limits

- The HTTP server must let Chrome treat `.md` as `text/plain`. If the server
  returns `Content-Type: text/html`, the extension steps aside to avoid
  clobbering server-rendered content.
- Inline code with unusual nested-backtick patterns relies on the CommonMark
  matching rules.
- No support for Mermaid / PlantUML / footnote extensions — add a marked
  plugin if you need them.

## Debugging

Open any `.md` file, hit F12, look at the console. Errors from the extension
are prefixed with `[md-viewer]`.

If rendering misbehaves, check:

- `chrome://extensions` → the extension card → **Errors** button for startup logs
- `ls vendor/` — confirm `install.sh` was actually run
- Local files don't render? Verify "Allow access to file URLs" is enabled.
