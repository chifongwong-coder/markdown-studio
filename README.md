# Markdown Viewer with Math

A Chrome extension that renders `.md` files directly in the browser:

- **LaTeX math** — `$...$`, `$$...$$`, `\(...\)`, `\[...\]` rendered with KaTeX
- **Formula boundary handling** — `$` inside fenced code blocks or inline code is left alone; escaped `\$` does not trigger extraction
- **Syntax highlighting** — highlight.js, language auto-detected
- **GFM** — tables, task lists, strikethrough
- **Collapsible sidebar TOC** — auto-built from headings, click to scroll, scroll-driven active section tracking, persists collapsed/expanded state
- **Dark mode** — follows `prefers-color-scheme`
- **Local files** — supports `file:///` paths (requires opt-in on the extension page)
- **XSS safe** — output is sanitized with DOMPurify before being written to the DOM

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

## Chrome Web Store submission checklist

| Item | Status | Notes |
|------|--------|-------|
| Manifest V3 | ✅ | `manifest.json` |
| No remote code | ✅ | All dependencies vendored |
| Minimal permissions | ✅ | Just `content_scripts`; no `tabs` / `history` / `storage` |
| Icons 16/48/128 | ⚠️ | Replace placeholders before submitting |
| Screenshot 1280×800 | ⚠️ | Capture a math-rich .md preview |
| Privacy policy URL | ⚠️ | Write a short page stating "no data is collected; all rendering happens locally" |
| Developer registration | ⚠️ | $5 one-time fee |

Steps once the above are ready:

1. Register at [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
2. Zip the entire `md-viewer/` directory (vendor included) and upload.
3. Fill in description, screenshots, and the privacy policy URL.
4. Submit. Review typically takes 1–7 days.

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
