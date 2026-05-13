// 核心渲染算法。从 md2pdf_revise.py 的 Python 实现移植。
// 关键设计：先把数学公式抽出来用占位符替代，让 marked 处理纯 Markdown，
// 最后再把渲染好的 KaTeX HTML 插回去——以此绕开 markdown 与公式语法的冲突。
//
// 边界处理：
//   1. fenced code (``` / ~~~) 内的 $...$ 不当公式
//   2. inline code (`...`) 内的 $...$ 不当公式
//   3. 转义 \$ 和 \$$ 不触发提取
//   4. inline `$...$` 不跨行；display `$$...$$` 可跨行
//   5. 同时支持 \(...\) \[...\] 形式

(function () {
  'use strict';

  /** Apply func only to text OUTSIDE Markdown inline-code spans.
   *  CommonMark rule: an opening run of N backticks closes with a run of EXACTLY N.
   *  从 md2pdf_revise.py:61 移植。 */
  function applyOutsideInlineCode(text, func) {
    const out = [];
    let i = 0;
    while (i < text.length) {
      const m = text.slice(i).match(/`+/);
      if (!m) {
        out.push(func(text.slice(i)));
        break;
      }
      const start = i + m.index;
      const n = m[0].length;
      out.push(func(text.slice(i, start)));
      const closeRe = new RegExp('(?<!`)' + '`'.repeat(n) + '(?!`)');
      const cm = text.slice(start + n).match(closeRe);
      if (!cm) {
        // 未找到等长闭合 → 后续当作普通文本
        out.push(func(text.slice(start)));
        break;
      }
      const end = start + n + cm.index + n;
      out.push(text.slice(start, end));
      i = end;
    }
    return out.join('');
  }

  /** 从 md 文本里抽取公式，渲染为 KaTeX HTML，返回 {text, replacements}。 */
  function extractMath(mdText) {
    const formulas = [];
    let counter = 0;

    function collect(raw, display) {
      counter += 1;
      const key = `KATEXPH${counter}END`;
      let latex;
      if (raw.startsWith('$$')) latex = raw.slice(2, -2).trim();
      else if (raw.startsWith('\\[') || raw.startsWith('\\(')) latex = raw.slice(2, -2).trim();
      else latex = raw.slice(1, -1).trim();
      formulas.push({ key, latex, display });
      return key;
    }

    // Step 1: fenced code 状态机切块，仅在非代码段做公式提取
    const FENCE_RE = /^(\s*)(```|~~~)/;
    const lines = mdText.split('\n');
    const chunks = [];
    let buf = [];
    let inFence = false;
    for (const line of lines) {
      if (FENCE_RE.test(line)) {
        if (buf.length > 0) {
          chunks.push({ isCode: inFence, text: buf.join('\n') });
          buf = [];
        }
        inFence = !inFence;
        chunks.push({ isCode: true, text: line });
        continue;
      }
      buf.push(line);
    }
    if (buf.length > 0) chunks.push({ isCode: inFence, text: buf.join('\n') });

    function replaceMath(text) {
      // 顺序很重要：先 display 再 inline，避免 $$..$$ 被 $..$ 切开
      text = text.replace(/(?<!\\)\$\$([\s\S]+?)(?<!\\)\$\$/g, (m) => collect(m, true));
      text = text.replace(/\\\[([\s\S]+?)\\\]/g, (m) => collect(m, true));
      text = text.replace(/\\\((.+?)\\\)/g, (m) => collect(m, false));
      text = text.replace(/(?<![\\$])\$(?!\$)(.+?)(?<![\\$])\$(?!\$)/g, (m) => collect(m, false));
      return text;
    }

    const processed = chunks
      .map((c) => (c.isCode ? c.text : applyOutsideInlineCode(c.text, replaceMath)))
      .join('\n');

    if (formulas.length === 0) return { text: processed, replacements: {} };

    // Step 2: 渲染 KaTeX
    const replacements = {};
    for (const f of formulas) {
      let html;
      try {
        html = katex.renderToString(f.latex, {
          displayMode: f.display,
          throwOnError: false,
          strict: false,
          output: 'html',
          trust: true,
        });
      } catch (e) {
        const msg = String(e && e.message || e).slice(0, 200).replace(/</g, '&lt;');
        html = `<span style="color:#e74c3c;font-size:0.85em">[Math Error: ${msg}]</span>`;
      }
      const tag = f.display ? 'div' : 'span';
      const cls = f.display ? 'math-display' : 'math-inline';
      replacements[f.key] = `<${tag} class="${cls}">${html}</${tag}>`;
    }
    return { text: processed, replacements };
  }

  /** 把占位符替换回真实的 KaTeX HTML。
   *  对 display 公式特殊处理：marked 会把孤立的占位符包进 <p>...</p>，
   *  而 KaTeX display 渲染产物是 <div>，div-in-p 是非法 HTML。我们先解开外层 <p>。 */
  function applyMathReplacements(html, replacements) {
    for (const [key, replacement] of Object.entries(replacements)) {
      const isDisplay = replacement.startsWith('<div');
      if (isDisplay) {
        const wrapped = new RegExp(`<p>\\s*${key}\\s*</p>`, 'g');
        html = html.replace(wrapped, replacement);
      }
      // 残留的（inline 公式 或 display 公式与其他文字同行）走普通替换
      html = html.split(key).join(replacement);
    }
    return html;
  }

  /** 调用 highlight.js 给 <pre><code class="language-X">...</code></pre> 上色。 */
  function highlightCode(root) {
    if (typeof hljs === 'undefined') return;
    root.querySelectorAll('pre code').forEach((block) => {
      try {
        const cls = block.className || '';
        const m = cls.match(/language-(\S+)/);
        if (m && hljs.getLanguage(m[1])) {
          hljs.highlightElement(block);
        } else {
          // 未指定语言时自动检测
          const result = hljs.highlightAuto(block.textContent || '');
          block.innerHTML = result.value;
          block.classList.add('hljs');
        }
      } catch (e) {
        /* 静默：高亮失败时保留原文 */
      }
    });
  }

  /** DOMPurify 配置：保留 KaTeX 必要的元素/属性，去掉脚本/事件处理器/危险协议。
   *  KaTeX `output: 'html'` 产出的是 <span class="katex">..</span> 嵌套结构，
   *  使用 class、style（内联定位）；不含 SVG/MathML。 */
  const PURIFY_CONFIG = {
    // 默认白名单已涵盖标准 Markdown 输出和 KaTeX 的 span/div
    ADD_TAGS: ['math', 'semantics', 'annotation', 'mrow', 'mi', 'mn', 'mo',
               'msup', 'msub', 'msubsup', 'mfrac', 'msqrt', 'mroot',
               'mtext', 'mspace', 'munder', 'mover', 'munderover',
               'mtable', 'mtr', 'mtd', 'mlabeledtr'],
    ADD_ATTR: ['style', 'aria-hidden', 'role'],
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur',
                  'onkeydown', 'onkeyup', 'onkeypress', 'onchange', 'onsubmit'],
    ALLOW_DATA_ATTR: false,
  };

  /** 完整流水线：md 文本 → HTML 字符串。 */
  function renderMarkdown(mdText) {
    const { text, replacements } = extractMath(mdText);
    // marked v14 配置：GFM、不强制 line-break
    if (typeof marked.setOptions === 'function') {
      marked.setOptions({ gfm: true, breaks: false });
    }
    let html = marked.parse(text);
    html = applyMathReplacements(html, replacements);
    // XSS 防护：清洗用户内容里的 <script>、事件处理器、危险协议（javascript:）等。
    // 占位符已经在上面替换为 KaTeX 渲染的可信 HTML，所以现在 sanitize 不会误伤公式。
    if (typeof DOMPurify !== 'undefined') {
      html = DOMPurify.sanitize(html, PURIFY_CONFIG);
    }
    return html;
  }

  // 暴露给 content.js
  window.MdViewer = {
    applyOutsideInlineCode,
    extractMath,
    applyMathReplacements,
    highlightCode,
    renderMarkdown,
  };
})();
