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
      // Sentinel uses Private Use Area characters (U+E000 / U+E001) -- they
      // survive HTML parsing and DOMPurify intact (unlike U+0000, which the
      // HTML parser normalizes), so sanitization can run on the marked
      // output BEFORE the placeholders are spliced back. The PUA wrapping
      // also ensures the placeholder cannot collide with anything the user
      // wrote (PUA chars are vanishingly rare in real markdown).
      const key = '\ue000KATEXPH' + counter + 'END\ue001';
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
    //     inside a ```markdown block is NOT a close -- it's content.
    // CommonMark allows up to 3 spaces of indent before a fence -- NOT tabs.
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
      text = text.replace(/(?<!\\)\\\[([\s\S]+?)\\\]/g, (m) => collect(m, true));
      // Inline \(..\): content cannot span newlines and cannot contain $.
      text = text.replace(/\\\(([^\n$]+?)\\\)/g, (m) => collect(m, false));
      // Inline $..$: the opening $ must be immediately followed by a non-space
      // and the closing $ immediately preceded by a non-space (pandoc / CommonMark
      // math convention). This stops prose like "costs $5 and $10" from pairing
      // the two dollar signs and rendering "5 and " as math. Trade-off: padded
      // delimiters ("$ x $") are no longer treated as math -- write "$x$".
      text = text.replace(
        /(?<![\\$])\$(?!\$)(?=\S)([^\n$]+?)(?<=\S)(?<![\\$])\$(?!\$)/g,
        (m) => collect(m, false));
      return text;
    }

    const processed = chunks
      .map((c) => (c.isCode ? c.text : applyOutsideInlineCode(c.text, replaceMath)))
      .join('\n');

    if (formulas.length === 0) {
      return { text: processed, replacements: {}, literals: {} };
    }

    // Step 2: render each formula via KaTeX. Build two parallel maps:
    //   replacements[key] = rendered KaTeX HTML (used when the placeholder
    //                       lives in normal text content)
    //   literals[key]     = HTML-escaped original source (used as a fallback
    //                       when the placeholder ends up inside <pre>/<code>
    //                       or an attribute value)
    const replacements = {};
    const literals = {};
    for (const f of formulas) {
      let html;
      try {
        html = katex.renderToString(f.latex, {
          displayMode: f.display,
          throwOnError: false,
          strict: false,
          // htmlAndMathml: ships both the visible HTML rendering AND a hidden
          // <math> tree (CSS clips it to 1px) -- the latter is used by screen
          // readers, semantic copy-paste, and the Word exporter, which reads
          // the MathML out of the DOM, runs it through mathml2omml, and
          // embeds the resulting OMML so Word users get editable equations.
          output: 'htmlAndMathml',
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
        const msg = htmlEscape(String(e && e.message || e).slice(0, 200));
        html = `<span style="color:#e74c3c;font-size:0.85em">[Math Error: ${msg}]</span>`;
      }
      const tag = f.display ? 'div' : 'span';
      const cls = f.display ? 'math-display' : 'math-inline';
      replacements[f.key] = `<${tag} class="${cls}">${html}</${tag}>`;
      const lit = f.display ? '$$' + f.latex + '$$' : '$' + f.latex + '$';
      literals[f.key] = htmlEscape(lit);
    }
    return { text: processed, replacements, literals };
  }

  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function htmlEscape(s) {
    return String(s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
  }

  /** Swap placeholders for the real KaTeX HTML.
   *  Display formulas need extra care: marked wraps a placeholder in <p>..</p>,
   *  but KaTeX renders display math as a <div>, and <div> inside <p> is
   *  invalid HTML -- the browser auto-closes the <p> and shifts subsequent
   *  DOM positions. We do all substitutions first, then split any <p> that
   *  ends up containing a math-display <div> into proper siblings.
   *
   *  Substitution is one regex pass with a lookup, so the work is O(html-size)
   *  rather than O(formulas × html-size). */
  const PLACEHOLDER_RE = /\ue000KATEXPH(\d+)END\ue001/g;
  // Constrain X and Z to not span <p> or </p>. Without the lookaheads, after
  // the first split the regex would re-match the resulting siblings ("<p>X</p>
  // <div>...</div><p>Z</p>") and grow without bound.
  const MIXED_P_DISPLAY_RE =
    /<p>((?:(?!<\/?p\b)[\s\S])*?)(<div class="math-display">[\s\S]*?<\/div>)((?:(?!<\/?p\b)[\s\S])*?)<\/p>/;
  // Scrub passes \u2014 restore placeholders that ended up inside <pre>, <code>,
  // or an HTML attribute value to their literal source. Marked already
  // decided those regions are not prose, so the user's expectation is that
  // dollar-delimited content stays as text.
  const PRE_BLOCK_RE = /<pre\b[^>]*>[\s\S]*?<\/pre>/g;
  const CODE_BLOCK_RE = /<code\b[^>]*>[\s\S]*?<\/code>/g;
  const DQ_ATTR_WITH_PH_RE =
    /(<[^>]+\s\w[\w-]*=")([^"]*\ue000KATEXPH\d+END\ue001[^"]*)(")/g;
  const SQ_ATTR_WITH_PH_RE =
    /(<[^>]+\s\w[\w-]*=')([^']*\ue000KATEXPH\d+END\ue001[^']*)(')/g;

  function applyMathReplacements(html, replacements, literals) {
    // Helper: substitute placeholders with the literal-source fallback.
    function substLiteral(s) {
      return s.replace(PLACEHOLDER_RE, (m, n) => {
        const key = '\ue000KATEXPH' + n + 'END\ue001';
        return Object.prototype.hasOwnProperty.call(literals || {}, key)
          ? literals[key] : m;
      });
    }
    // Step A: restore placeholders inside <pre>/<code> contexts.
    html = html.replace(PRE_BLOCK_RE, substLiteral);
    html = html.replace(CODE_BLOCK_RE, substLiteral);
    // Step B: restore placeholders inside attribute values (link titles,
    // alt text, etc.). Pure regex \u2014 works as long as marked doesn't emit
    // attribute values containing literal " or ' alongside the placeholder.
    html = html.replace(DQ_ATTR_WITH_PH_RE, (_, p1, val, p3) => p1 + substLiteral(val) + p3);
    html = html.replace(SQ_ATTR_WITH_PH_RE, (_, p1, val, p3) => p1 + substLiteral(val) + p3);

    // Step C: substitute remaining placeholders with rendered KaTeX HTML.
    html = html.replace(PLACEHOLDER_RE, (m, n) => {
      const key = '\ue000KATEXPH' + n + 'END\ue001';
      return Object.prototype.hasOwnProperty.call(replacements, key)
        ? replacements[key]
        : m;
    });

    // Step D: split any <p>...<div class="math-display">...</div>...</p>
    // produced by step C, since <div> inside <p> is invalid HTML.
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

  /** DOMPurify config for the user-content half of the pipeline. KaTeX HTML
   *  is spliced in AFTER sanitization, so it never enters DOMPurify's scope.
   *  Inline style stays forbidden here because user markdown never needs it
   *  and allowing it would open CSS-based exfiltration / clickjacking. */
  const PURIFY_CONFIG = {
    // data-mermaid-id is our internal cross-pipeline marker; the renderer in
    // content.js looks for it to dispatch to mermaid. data-footnote* are
    // produced by marked-footnote and used as both CSS and JS hooks. All
    // other data-* attributes still get stripped (ALLOW_DATA_ATTR: false).
    ADD_ATTR: [
      'aria-hidden', 'role',
      'data-mermaid-id',
      'data-footnote-ref', 'data-footnote-backref', 'data-footnotes',
    ],
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form'],
    ALLOW_DATA_ATTR: false,
  };

  // Marked options + plugins are configured once on first render. setOptions
  // was deprecated in marked v14 in favor of marked.use().
  let markedConfigured = false;
  function configureMarked() {
    if (markedConfigured) return;
    if (typeof marked.use === 'function') {
      marked.use({ gfm: true, breaks: false });
      // Enable [^id] footnote syntax (https://github.com/bent10/marked-extensions).
      // Use a project-specific prefix so the footnote section's id="md-fn-1"
      // can never collide with a heading whose slugified id happens to be
      // "fn-1" or "footnote-1".
      if (typeof markedFootnote !== 'undefined') {
        try { marked.use(markedFootnote({ prefixId: 'md-fn-' })); }
        catch (e) { /* plugin shape mismatch */ }
      }
    } else if (typeof marked.setOptions === 'function') {
      marked.setOptions({ gfm: true, breaks: false });
    }
    markedConfigured = true;
  }

  /** Pull ```mermaid fenced blocks out of the markdown source before
   *  anything else touches them. Each block becomes a placeholder div that
   *  content.js later swaps for the rendered SVG.
   *
   *  Walks lines with a small fence state machine so that:
   *    - ```mermaidish, ```mermaid-cli, ```mermaidly etc. are NOT mistaken
   *      for mermaid (info string is matched on a word boundary).
   *    - A ```mermaid block that lives *inside* a larger fenced block
   *      (e.g. a 4-backtick code sample documenting mermaid syntax) is
   *      left alone — its enclosing fence keeps it as literal content.
   */
  function extractMermaid(mdText) {
    const sources = [];
    const OPEN_BACKTICK = /^ {0,3}(`{3,})([^`]*)$/;
    const OPEN_TILDE = /^ {0,3}(~{3,})(.*)$/;
    function matchOpen(line) {
      const b = line.match(OPEN_BACKTICK);
      if (b) return { char: '`', len: b[1].length, info: b[2].trim() };
      const t = line.match(OPEN_TILDE);
      if (t) return { char: '~', len: t[1].length, info: t[2].trim() };
      return null;
    }
    function closeReFor(char, len) {
      return new RegExp(
        '^ {0,3}' + (char === '`' ? '`' : '~') + '{' + len + ',}\\s*$'
      );
    }
    const lines = mdText.split('\n');
    const out = [];
    let inFence = false;
    let fenceChar = null;
    let fenceLen = 0;
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!inFence) {
        const open = matchOpen(line);
        if (open) {
          // Word-boundary match: info string is exactly "mermaid" or
          // "mermaid" followed by whitespace + extras (theme args, etc.).
          if (/^mermaid(?:[ \t]|$)/.test(open.info)) {
            // Find the matching closer for this fence.
            const closeRe = closeReFor(open.char, open.len);
            let j = i + 1;
            while (j < lines.length && !closeRe.test(lines[j])) j++;
            const body = lines.slice(i + 1, j).join('\n');
            sources.push(body);
            const id = sources.length;
            out.push(`<div class="md-mermaid" data-mermaid-id="${id}"></div>`);
            i = j + 1;
            continue;
          }
          // Non-mermaid fence: enter fence-content mode, leave the line.
          inFence = true;
          fenceChar = open.char;
          fenceLen = open.len;
        }
      } else if (closeReFor(fenceChar, fenceLen).test(line)) {
        inFence = false;
        fenceChar = null;
        fenceLen = 0;
      }
      out.push(line);
      i++;
    }
    return { text: out.join('\n'), sources };
  }

  /** Pipeline: markdown text -> sanitized HTML string + mermaid sources. */
  function renderMarkdown(mdText) {
    // Normalize line endings (CRLF / CR -> LF) and strip a leading BOM so
    // downstream regexes see consistent input.
    mdText = String(mdText || '')
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
      // Strip any pre-existing Private Use Area sentinels (U+E000 / U+E001)
      // so they can't collide with our internal math placeholders. Real
      // markdown effectively never contains these characters.
      .replace(/[\ue000-\ue001]/g, '');
    const mermaid = extractMermaid(mdText);
    const { text, replacements, literals } = extractMath(mermaid.text);
    configureMarked();
    let html = marked.parse(text);
    // Sanitize FIRST, while math placeholders are still inert tokens.
    // The KaTeX HTML we splice in below never enters DOMPurify, so its
    // inline styles (positioning, font-size) survive intact. Mermaid
    // placeholder divs survive sanitize as-is because they have only
    // class + data-mermaid-id attributes.
    if (typeof DOMPurify !== 'undefined') {
      html = DOMPurify.sanitize(html, PURIFY_CONFIG);
    }
    html = applyMathReplacements(html, replacements, literals);
    return { html, mermaidSources: mermaid.sources };
  }

  // Expose to content.js.
  window.MarkdownStudio = {
    applyOutsideInlineCode,
    extractMath,
    applyMathReplacements,
    highlightCode,
    renderMarkdown,
  };
})();
