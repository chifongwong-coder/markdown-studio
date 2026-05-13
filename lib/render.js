// Core rendering algorithm.
//
// Strategy: pull math formulas out of the markdown first, replace each with a
// plain-text placeholder, let marked process the remaining markdown, then swap
// the placeholders for the rendered KaTeX HTML. This is what keeps math syntax
// from colliding with markdown syntax.
//
// Boundary cases handled:
//   1. $..$ inside fenced code (``` / ~~~) is left alone.
//   2. $..$ inside inline code (`..`) is left alone.
//   3. Escaped \$ and \$$ do not trigger extraction.
//   4. Inline `$..$` does not span newlines; display `$$..$$` may.
//   5. Alternate delimiters \(..\) and \[..\] are also supported.

(function () {
  'use strict';

  /** Apply `func` only to text OUTSIDE markdown inline-code spans.
   *  Follows the CommonMark rule: an opening run of N backticks closes with a
   *  run of exactly N. */
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
        // No matching close run — treat the remainder as plain text.
        out.push(func(text.slice(start)));
        break;
      }
      const end = start + n + cm.index + n;
      out.push(text.slice(start, end));
      i = end;
    }
    return out.join('');
  }

  /** Extract math formulas, render them with KaTeX, return {text, replacements}. */
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

    // Step 1: split by fenced code blocks. Only non-fenced chunks get math
    // extraction; fence delimiters and code bodies pass through.
    //
    // CommonMark fence rules we honor:
    //   * Opening fence: indented up to 3 spaces, then 3+ backticks or tildes,
    //     optionally followed by an info string. CRITICAL: the info string
    //     after a BACKTICK fence may not contain backticks. Without this rule,
    //     a paragraph that quotes a fence marker inline (e.g. an explanatory
    //     sentence containing ```` ```python ````) would be mistaken for an
    //     opening fence at line start.
    //   * Closing fence: same character, length >= the opener, NO info
    //     string (only optional whitespace after). A line like ```python
    //     inside a ```markdown block is NOT a close — it's content.
    const OPEN_BACKTICK = /^\s{0,3}(`{3,})([^`]*)$/;
    const OPEN_TILDE = /^\s{0,3}(~{3,})(.*)$/;
    function matchOpen(line) {
      const b = line.match(OPEN_BACKTICK);
      if (b) return { char: '`', len: b[1].length };
      const t = line.match(OPEN_TILDE);
      if (t) return { char: '~', len: t[1].length };
      return null;
    }

    const lines = mdText.split('\n');
    const chunks = [];
    let buf = [];
    let inFence = false;
    let fenceChar = null;
    let fenceLen = 0;
    function flush(isCode) {
      if (buf.length > 0) {
        chunks.push({ isCode, text: buf.join('\n') });
        buf = [];
      }
    }
    for (const line of lines) {
      if (!inFence) {
        const open = matchOpen(line);
        if (open) {
          flush(false);
          chunks.push({ isCode: true, text: line });
          inFence = true;
          fenceChar = open.char;
          fenceLen = open.len;
          continue;
        }
      } else {
        const closeRe = new RegExp(
          '^\\s{0,3}' + (fenceChar === '`' ? '`' : '~') +
          '{' + fenceLen + ',}\\s*$'
        );
        if (closeRe.test(line)) {
          flush(true);
          chunks.push({ isCode: true, text: line });
          inFence = false;
          fenceChar = null;
          fenceLen = 0;
          continue;
        }
      }
      buf.push(line);
    }
    flush(inFence);

    function replaceMath(text) {
      // Order matters: display delimiters before inline so $$..$$ doesn't get
      // chopped up by the single-$ rule.
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

    // Step 2: render each formula via KaTeX.
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

  /** Swap placeholders for the real KaTeX HTML.
   *  Display formulas get special treatment: marked wraps a lone placeholder
   *  in <p>..</p>, but a KaTeX display block renders as <div>, and <div>
   *  inside <p> is invalid HTML. We unwrap the <p> first. */
  function applyMathReplacements(html, replacements) {
    for (const [key, replacement] of Object.entries(replacements)) {
      const isDisplay = replacement.startsWith('<div');
      if (isDisplay) {
        const wrapped = new RegExp(`<p>\\s*${key}\\s*</p>`, 'g');
        html = html.replace(wrapped, replacement);
      }
      // Fall-through for inline math, or display math sharing a paragraph.
      html = html.split(key).join(replacement);
    }
    return html;
  }

  /** Apply highlight.js to <pre><code class="language-X">..</code></pre> blocks. */
  function highlightCode(root) {
    if (typeof hljs === 'undefined') return;
    root.querySelectorAll('pre code').forEach((block) => {
      try {
        const cls = block.className || '';
        const m = cls.match(/language-(\S+)/);
        if (m && hljs.getLanguage(m[1])) {
          hljs.highlightElement(block);
        } else {
          // No language hint — let hljs autodetect.
          const result = hljs.highlightAuto(block.textContent || '');
          block.innerHTML = result.value;
          block.classList.add('hljs');
        }
      } catch (e) {
        /* Silent: if highlighting fails, keep the raw code. */
      }
    });
  }

  /** DOMPurify config. KaTeX's `output: 'html'` produces nested <span> with
   *  classes and inline styles; ADD_TAGS covers the MathML fallback path in
   *  case KaTeX ever emits semantic markup. */
  const PURIFY_CONFIG = {
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

  // Marked options are configured once; setOptions was deprecated in v14 in
  // favor of marked.use().
  let markedConfigured = false;
  function configureMarked() {
    if (markedConfigured) return;
    if (typeof marked.use === 'function') {
      marked.use({ gfm: true, breaks: false });
    } else if (typeof marked.setOptions === 'function') {
      marked.setOptions({ gfm: true, breaks: false });
    }
    markedConfigured = true;
  }

  /** Pipeline: markdown text -> sanitized HTML string. */
  function renderMarkdown(mdText) {
    const { text, replacements } = extractMath(mdText);
    configureMarked();
    let html = marked.parse(text);
    html = applyMathReplacements(html, replacements);
    // Sanitize: strip <script>, event handlers, javascript: URLs etc. The
    // placeholders are already replaced with trusted KaTeX HTML by this point,
    // so sanitization won't damage rendered formulas.
    if (typeof DOMPurify !== 'undefined') {
      html = DOMPurify.sanitize(html, PURIFY_CONFIG);
    }
    return html;
  }

  // Expose to content.js.
  window.MdViewer = {
    applyOutsideInlineCode,
    extractMath,
    applyMathReplacements,
    highlightCode,
    renderMarkdown,
  };
})();
