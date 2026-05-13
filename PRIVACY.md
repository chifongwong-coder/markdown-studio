# Privacy Policy

_Last updated: 2026-05-13_

## Summary

**This extension does not collect, transmit, or share any personal data.**
All Markdown rendering happens locally inside your browser tab. No content
from your `.md` files leaves your machine.

## What data the extension touches

| Data | What | Where it lives |
|------|------|----------------|
| The text of the `.md` file you opened | Parsed and rendered into HTML | In-memory only, inside the browser tab. Discarded when the tab closes. |
| TOC collapse/expand preference | A single boolean (`md-viewer-toc-hidden`) | `localStorage` of the current origin. Never transmitted. |

That is everything. There is no other data the extension reads, writes, or
sends.

## What the extension does NOT do

- No cookies, no analytics, no advertising.
- No telemetry or crash reporting.
- No remote API calls. The bundled libraries (marked, KaTeX, highlight.js,
  DOMPurify) execute entirely locally.
- No third-party tracking pixels or beacons.
- No reading of pages other than `.md`, `.markdown`, `.mdown` files in the
  declared content-script match patterns.

## Permissions

The extension declares only `content_scripts` matching `*.md` URLs (HTTP,
HTTPS, and `file://`). It does not request `tabs`, `history`, `storage`,
`webRequest`, or any other Chrome API permission.

## Open source

The extension's source code is open and auditable. You can verify these
claims by reading the source directly.

## Contact

If you have questions about this policy, open an issue on the project's
GitHub repository.
