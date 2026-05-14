#!/usr/bin/env bash
# Download all vendor dependencies into vendor/.
# Chrome Web Store policy forbids loading remote scripts, so every dependency
# must ship inside the extension bundle.

set -euo pipefail

cd "$(dirname "$0")"
mkdir -p vendor/fonts

MARKED_VERSION="14.1.3"
KATEX_VERSION="0.16.11"
HLJS_VERSION="11.10.0"
DOMPURIFY_VERSION="3.2.4"
MARKED_FOOTNOTE_VERSION="1.2.4"
MERMAID_VERSION="10.9.3"

JSD="https://cdn.jsdelivr.net/npm"

echo "==> marked@${MARKED_VERSION}"
curl -sSL "${JSD}/marked@${MARKED_VERSION}/marked.min.js" -o vendor/marked.min.js

echo "==> katex@${KATEX_VERSION} (js + css)"
curl -sSL "${JSD}/katex@${KATEX_VERSION}/dist/katex.min.js" -o vendor/katex.min.js
curl -sSL "${JSD}/katex@${KATEX_VERSION}/dist/katex.min.css" -o vendor/katex.min.css

echo "==> katex fonts"
# KaTeX ships ~20 font families. Only woff2 is fetched because every browser
# that runs MV3 supports it; the CSS lists woff/ttf fallbacks but they're never
# requested when woff2 succeeds.
FONTS=(
  KaTeX_AMS-Regular
  KaTeX_Caligraphic-Bold KaTeX_Caligraphic-Regular
  KaTeX_Fraktur-Bold KaTeX_Fraktur-Regular
  KaTeX_Main-Bold KaTeX_Main-BoldItalic KaTeX_Main-Italic KaTeX_Main-Regular
  KaTeX_Math-BoldItalic KaTeX_Math-Italic
  KaTeX_SansSerif-Bold KaTeX_SansSerif-Italic KaTeX_SansSerif-Regular
  KaTeX_Script-Regular
  KaTeX_Size1-Regular KaTeX_Size2-Regular KaTeX_Size3-Regular KaTeX_Size4-Regular
  KaTeX_Typewriter-Regular
)
for f in "${FONTS[@]}"; do
  curl -sSL "${JSD}/katex@${KATEX_VERSION}/dist/fonts/${f}.woff2" -o "vendor/fonts/${f}.woff2"
done

# The font url() entries in katex.min.css are relative (./fonts/...), which
# resolve correctly because the CSS itself sits next to vendor/fonts/.

echo "==> highlight.js@${HLJS_VERSION}"
curl -sSL "${JSD}/@highlightjs/cdn-assets@${HLJS_VERSION}/highlight.min.js" -o vendor/highlight.min.js
curl -sSL "${JSD}/@highlightjs/cdn-assets@${HLJS_VERSION}/styles/monokai.min.css" -o vendor/highlight-monokai.css

echo "==> dompurify@${DOMPURIFY_VERSION}"
curl -sSL "${JSD}/dompurify@${DOMPURIFY_VERSION}/dist/purify.min.js" -o vendor/purify.min.js

echo "==> marked-footnote@${MARKED_FOOTNOTE_VERSION}"
curl -sSL "${JSD}/marked-footnote@${MARKED_FOOTNOTE_VERSION}/dist/index.umd.js" -o vendor/marked-footnote.min.js

echo "==> mermaid@${MERMAID_VERSION}"
curl -sSL "${JSD}/mermaid@${MERMAID_VERSION}/dist/mermaid.min.js" -o vendor/mermaid.min.js

echo
echo "Done. vendor/ size:"
du -sh vendor/
echo
echo "Next: open chrome://extensions, enable Developer mode,"
echo "click 'Load unpacked', and pick this directory."
