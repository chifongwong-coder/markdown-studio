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
   *  Follows the CommonMark rule: an opening run of N backticks closes with
   *  a run of exactly N.
   *
   *  Scans forward using regex `lastIndex` instead of slicing the remainder
   *  of the string on every iteration. With many backtick spans this turns
   *  O(N×K) into O(N), keeping 1MB+ documents responsive. */
  const OPEN_RUN_RE = /`+/g;
  function applyOutsideInlineCode(text, func) {
    const out = [];
    let i = 0;
    OPEN_RUN_RE.lastIndex = 0;
    while (i < text.length) {
      OPEN_RUN_RE.lastIndex = i;
      const m = OPEN_RUN_RE.exec(text);
      if (!m) {
        out.push(func(text.slice(i)));
        break;
      }
      const start = m.index;
      const n = m[0].length;
      out.push(func(text.slice(i, start)));
      // Matching close: same number of backticks, not bracketed by more.
      const closeRe = new RegExp('(?<!`)' + '`'.repeat(n) + '(?!`)', 'g');
      closeRe.lastIndex = start + n;
      const cm = closeRe.exec(text);
      if (!cm) {
        out.push(func(text.slice(start)));
        break;
      }
      const end = cm.index + n;
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
      // Wrap the placeholder in NUL bytes (U+0000). Plain markdown text and
      // KaTeX output never contain NUL, so the placeholder is guaranteed not
      // to collide with anything the user wrote (e.g. a code block that
      // happens to mention the string KATEXPH1END).
      const key = '\u0000KATEXPH' + counter + 'END\u0000';
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
    // CommonMark allows up to 3 spaces of indent before a fence — NOT tabs.
    const OPEN_BACKTICK = /^ {0,3}(`{3,})([^`]*)$/;
    const OPEN_TILDE = /^ {0,3}(~{3,})(.*)$/;
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
          '^ {0,3}' + (fenceChar === '`' ? '`' : '~') +
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
      // Inline delimiters: content cannot span newlines and cannot itself
      // contain $, so [^\n$]+? prevents accidentally swallowing a stray $
      // (e.g. "var $x and $y" pairing $x with $y).
      text = text.replace(/\\\(([^\n$]+?)\\\)/g, (m) => collect(m, false));
      text = text.replace(/(?<![\\$])\$(?!\$)([^\n$]+?)(?<![\\$])\$(?!\$)/g, (m) => collect(m, false));
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
          // Trust only safe \href / \url targets. Reject other "trusted"
          // KaTeX commands (e.g. \includegraphics) entirely.
          trust: (ctx) => {
            if (ctx.command === '\\href' || ctx.command === '\\url') {
              return /^(https?:|mailto:|#|\/)/i.test(ctx.url || '');
            }
            return false;
          },
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
   *  Display formulas need extra care: marked wraps a placeholder in <p>..</p>,
   *  but KaTeX renders display math as a <div>, and <div> inside <p> is
   *  invalid HTML — the browser auto-closes the <p> and shifts subsequent
   *  DOM positions. We do all substitutions first, then split any <p> that
   *  ends up containing a math-display <div> into proper siblings.
   *
   *  Substitution is one regex pass with a lookup, so the work is O(html-size)
   *  rather than O(formulas × html-size). */
  const PLACEHOLDER_RE = /\u0000KATEXPH(\d+)END\u0000/g;
  const MIXED_P_DISPLAY_RE =
    /<p>([\s\S]*?)(<div class="math-display">[\s\S]*?<\/div>)([\s\S]*?)<\/p>/;
  function applyMathReplacements(html, replacements) {
    html = html.replace(PLACEHOLDER_RE, (m, n) => {
      const key = '\u0000KATEXPH' + n + 'END\u0000';
      return Object.prototype.hasOwnProperty.call(replacements, key)
        ? replacements[key]
        : m;
    });
    // Iteratively split <p>...<div class="math-display">...</div>...</p>.
    // The loop handles multiple display blocks sharing a paragraph.
    let prev;
    do {
      prev = html;
      html = html.replace(MIXED_P_DISPLAY_RE, (_m, before, div, after) => {
        const parts = [];
        if (before.trim()) parts.push(`<p>${before}</p>`);
        parts.push(div);
        if (after.trim()) parts.push(`<p>${after}</p>`);
        return parts.join('');
      });
    } while (html !== prev);
    return html;
  }

  /** Apply highlight.js to <pre><code class="language-X">..</code></pre> blocks.
   *  Idempotent: marks each block with data-highlighted so a re-entry (e.g.
   *  if renderInto runs twice) does not double-escape the source. */
  function highlightCode(root) {
    if (typeof hljs === 'undefined') return;
    root.querySelectorAll('pre code').forEach((block) => {
      if (block.dataset && block.dataset.highlighted === 'yes') return;
      try {
        const cls = block.className || '';
        const m = cls.match(/language-(\S+)/);
        if (m && hljs.getLanguage(m[1])) {
          hljs.highlightElement(block);
        } else {
          const result = hljs.highlightAuto(block.textContent || '');
          block.innerHTML = result.value;
          block.classList.add('hljs');
        }
        if (block.dataset) block.dataset.highlighted = 'yes';
      } catch (e) {
        /* Silent: if highlighting fails, keep the raw code. */
      }
    });
  }

  /** DOMPurify config. KaTeX's `output: 'html'` produces nested <span> with
   *  classes and inline styles; ADD_TAGS covers the MathML fallback path.
   *
   *  We deliberately do NOT add `style` to ADD_ATTR globally — that would let
   *  hostile markdown smuggle CSS for fingerprinting / clickjacking. Instead
   *  a sanitize-attribute hook (installed once on first use) keeps `style`
   *  only on elements whose class indicates KaTeX-generated content. */
  const PURIFY_CONFIG = {
    ADD_TAGS: ['math', 'semantics', 'annotation', 'mrow', 'mi', 'mn', 'mo',
               'msup', 'msub', 'msubsup', 'mfrac', 'msqrt', 'mroot',
               'mtext', 'mspace', 'munder', 'mover', 'munderover',
               'mtable', 'mtr', 'mtd', 'mlabeledtr'],
    ADD_ATTR: ['aria-hidden', 'role'],
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form'],
    ALLOW_DATA_ATTR: false,
  };

  let purifyHookInstalled = false;
  function installPurifyHooks() {
    if (purifyHookInstalled || typeof DOMPurify === 'undefined') return;
    DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
      if (data.attrName !== 'style') return;
      const cls = (node && node.className) || '';
      const className = typeof cls === 'string' ? cls : (cls.baseVal || '');
      // Allow inline style only on KaTeX-rendered descendants or our own
      // math wrappers; strip everywhere else.
      const ok = /\bkatex(\b|-)/.test(className) ||
                 /\bmath-(display|inline)\b/.test(className);
      if (!ok) data.keepAttr = false;
    });
    purifyHookInstalled = true;
  }

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
    // Normalize line endings (CRLF / CR -> LF) and strip a leading BOM so
    // downstream regexes see consistent input.
    mdText = String(mdText || '')
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
      // Strip any pre-existing NUL bytes so they can't collide with our
      // internal math placeholder sentinels (which are wrapped in U+0000).
      .replace(/\u0000/g, '');
    const { text, replacements } = extractMath(mdText);
    configureMarked();
    let html = marked.parse(text);
    html = applyMathReplacements(html, replacements);
    // Sanitize: strip <script>, event handlers, javascript: URLs etc.
    // Inline KaTeX styles are preserved via the hook installed below; styles
    // anywhere else are stripped.
    if (typeof DOMPurify !== 'undefined') {
      installPurifyHooks();
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
