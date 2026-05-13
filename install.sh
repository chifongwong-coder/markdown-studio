#!/usr/bin/env bash
# 下载所有 vendor 依赖到 vendor/ 目录。
# Chrome Web Store 政策禁止远程加载脚本，所以必须把依赖打包进扩展。

set -euo pipefail

cd "$(dirname "$0")"
mkdir -p vendor/fonts

MARKED_VERSION="14.1.3"
KATEX_VERSION="0.16.11"
HLJS_VERSION="11.10.0"
DOMPURIFY_VERSION="3.2.4"

JSD="https://cdn.jsdelivr.net/npm"

echo "==> marked@${MARKED_VERSION}"
curl -sSL "${JSD}/marked@${MARKED_VERSION}/marked.min.js" -o vendor/marked.min.js

echo "==> katex@${KATEX_VERSION} (js + css)"
curl -sSL "${JSD}/katex@${KATEX_VERSION}/dist/katex.min.js" -o vendor/katex.min.js
curl -sSL "${JSD}/katex@${KATEX_VERSION}/dist/katex.min.css" -o vendor/katex.min.css

echo "==> katex fonts"
# KaTeX 字体清单（来自其 dist/fonts/，共 60 个文件，按需挑常用 woff2）
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

# KaTeX CSS 里的字体 URL 默认是相对路径 ./fonts/...，我们的 vendor/katex.min.css 加载时
# 同样在 vendor/ 下，相对 vendor/fonts/ 正好——保持原样即可。

echo "==> highlight.js@${HLJS_VERSION}"
curl -sSL "${JSD}/@highlightjs/cdn-assets@${HLJS_VERSION}/highlight.min.js" -o vendor/highlight.min.js
curl -sSL "${JSD}/@highlightjs/cdn-assets@${HLJS_VERSION}/styles/monokai.min.css" -o vendor/highlight-monokai.css

echo "==> dompurify@${DOMPURIFY_VERSION}"
curl -sSL "${JSD}/dompurify@${DOMPURIFY_VERSION}/dist/purify.min.js" -o vendor/purify.min.js

echo
echo "完成。vendor/ 大小:"
du -sh vendor/
echo
echo "下一步：在 chrome://extensions 开启开发者模式 → 加载已解压扩展 → 选择此目录"
