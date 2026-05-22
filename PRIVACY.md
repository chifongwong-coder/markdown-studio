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
| TOC collapse/expand preference | A single boolean (`markdown-studio-toc-hidden`) | `localStorage` of the current origin. Never transmitted. |

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

## User-data categories (matching the Chrome Web Store form)

None of the following categories are collected, used, or transferred by
this extension:

- Personally identifiable information
- Health information
- Financial and payment information
- Authentication information
- Personal communications
- Location
- Web browsing history
- User activity
- Website content

In addition, the developer certifies that:

- We do not sell or transfer user data to third parties, outside the
  approved use cases.
- We do not use or transfer user data for purposes unrelated to the
  extension's single purpose (rendering Markdown locally).
- We do not use or transfer user data to determine creditworthiness or
  for lending purposes.

## Permissions

The extension declares only `content_scripts` matching `*.md` URLs (HTTP,
HTTPS, and `file://`). It does not request `tabs`, `history`, `storage`,
`webRequest`, or any other Chrome API permission.

## Open source

The extension's source code is open and auditable. You can verify these
claims by reading the source directly.

## Contact

For questions about this policy or about the extension, you can:

- open an issue at <https://github.com/chifongwong-coder/markdown-studio/issues>
- email **wongchifong0223@gmail.com**

The developer responds to issues and email within a reasonable window.
