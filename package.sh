#!/usr/bin/env bash
# package.sh — build the Chrome Web Store upload zip.
#
# Outputs build/markdown-studio-<version>.zip. The version is read from
# manifest.json so bumping manifest.json's "version" is the only change
# needed between releases.
#
# What ends up in the zip:
#   manifest.json, content.js, lib/, styles/, vendor/, icons/{16,48,128}.png,
#   LICENSE.
#
# Excluded: git metadata, README, PRIVACY, STORE_LISTING, CHANGELOG,
# test fixtures, install/package scripts, screenshots/, icon source files
# (image.png, logo-draft.svg), and previously built zips.

set -euo pipefail

cd "$(dirname "$0")"

# --- read version from manifest.json ---
VERSION=$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])')

# --- sanity-check that every runtime file is present ---
REQUIRED=(
  manifest.json
  content.js
  lib/render.js
  lib/toc.js
  lib/editor.js
  lib/exporter-docx.js
  lib/comments.js
  styles/viewer.css
  vendor/marked.min.js
  vendor/marked-footnote.min.js
  vendor/katex.min.js
  vendor/katex.min.css
  vendor/highlight.min.js
  vendor/highlight-monokai.css
  vendor/purify.min.js
  vendor/mermaid.min.js
  vendor/jszip.min.js
  vendor/mathml2omml.min.js
  vendor/LICENSES.txt
  vendor/LGPL-3.0.txt
  icons/16.png
  icons/48.png
  icons/128.png
  LICENSE
)
missing=0
for f in "${REQUIRED[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "MISSING: $f" >&2
    missing=1
  fi
done
[[ $missing -eq 0 ]] || { echo "abort: required files missing" >&2; exit 1; }

# --- verify icon dimensions (just in case someone swapped files) ---
python3 - <<'PY'
from PIL import Image
sizes = {"icons/16.png": 16, "icons/48.png": 48, "icons/128.png": 128}
bad = []
for path, expected in sizes.items():
    w, h = Image.open(path).size
    if (w, h) != (expected, expected):
        bad.append(f"{path} is {w}x{h}, expected {expected}x{expected}")
if bad:
    import sys
    print("\n".join(bad), file=sys.stderr)
    sys.exit(1)
PY

# --- ensure mermaid.min.js is free of Chrome-rejected codepoints ---
# Defense in depth: if someone re-downloaded mermaid without re-running
# install.sh, the bundle may still embed U+FFFF / U+0001 and Chrome will
# refuse to load the extension. Re-run the (idempotent) patch before zipping
# so we never ship a broken build.
python3 vendor/patch-mermaid.py

# --- vendor font count sanity ---
fonts=$(find vendor/fonts -name '*.woff2' 2>/dev/null | wc -l | tr -d ' ')
if [[ "$fonts" -lt 18 ]]; then
  echo "warn: only $fonts KaTeX woff2 fonts in vendor/fonts (expected ~20). Run ./install.sh?" >&2
fi

# --- prepare output dir ---
mkdir -p build
OUT="build/markdown-studio-${VERSION}.zip"
rm -f "$OUT"

# --- build the zip via an explicit allowlist (not exclude list) so a future
#     stray file (.env, .vscode/, secret.txt, etc.) cannot accidentally ship. ---
zip -r "$OUT" \
  manifest.json \
  content.js \
  LICENSE \
  lib \
  styles \
  icons/16.png \
  icons/48.png \
  icons/128.png \
  vendor/marked.min.js \
  vendor/marked-footnote.min.js \
  vendor/katex.min.js \
  vendor/katex.min.css \
  vendor/highlight.min.js \
  vendor/highlight-monokai.css \
  vendor/purify.min.js \
  vendor/mermaid.min.js \
  vendor/jszip.min.js \
  vendor/mathml2omml.min.js \
  vendor/LICENSES.txt \
  vendor/LGPL-3.0.txt \
  vendor/fonts \
  -x '*.DS_Store' \
  >/dev/null

# --- report ---
size=$(du -h "$OUT" | awk '{print $1}')
files=$(unzip -l "$OUT" | tail -1 | awk '{print $2}')
echo "built: $OUT (${size}, ${files} files)"
echo
echo "top-level entries:"
# Keep only the data rows: first column is a digit (file size), last column
# is the file name. Drops both the header and the summary lines.
unzip -l "$OUT" | awk '$1 ~ /^[0-9]+$/ && $NF !~ /^files$/ {print $NF}' | \
  awk -F/ '{print $1}' | sort -u | sed 's/^/  /'
echo
echo "double-check: nothing leaked in?"
leaked=$(unzip -l "$OUT" | awk '{print $NF}' | grep -E '\.(md|sh|mjs)$|\.git|\.DS_Store|screenshots/|image\.png|logo-draft' || true)
if [[ -n "$leaked" ]]; then
  echo "  ⚠️  unexpected entries:"
  echo "$leaked" | sed 's/^/    /'
else
  echo "  ok — only runtime assets + LICENSE."
fi
