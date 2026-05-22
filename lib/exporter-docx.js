// Word (.docx) exporter for the rendered article. Mirrors the Save-as-PDF
// button: one click, downloads <filename>.docx.
//
// Strategy is to hand-build the OOXML inside a JSZip, not lean on an opinionated
// docx library, because the value-add of this export is *editable math* via
// raw OMML injection -- and that's exactly what the high-level docx libraries
// don't expose well.
//
// Math pipeline (ported from the M5 PoC):
//   KaTeX MathML in DOM
//     -> preserveMtextBoundarySpace  (smuggle <mtext> trailing space through
//                                     mml2omml's whitespace-stripping parser
//                                     via a PUA sentinel)
//     -> window.MathML2OMML.mml2omml (npm mathml2omml, IIFE-bundled in
//                                     vendor/mathml2omml.min.js, LGPL-3.0)
//     -> escapeMTextInOMML           (mml2omml leaves raw '<' and '&' inside
//                                     <m:t> text -- Word's XML parser then
//                                     truncates the formula at the bad byte)
//     -> fixEmptyNary                (right-to-left fill of empty <m:e/> in
//                                     n-ary operators -- KaTeX's MathML puts
//                                     the integrand as a sibling rather than
//                                     a child of the operator, leaving the
//                                     integrand slot empty)
//     -> restoreSentinelSpaces       (PUA back to normal ' ')

(function () {
  'use strict';

  // ---- math conversion pipeline --------------------------------------------

  // U+E000 is a Private Use Area character: never whitespace, never a real
  // math glyph. Survives mml2omml's XML parser intact; we swap it back to a
  // normal space in the OMML.
  const SPACE_SENTINEL = '';

  // mml2omml emits <m:sty m:val="undefined"/> for MathML mathvariant values it
  // doesn't recognise (script, double-struck, fraktur, sans-serif). Word reads
  // the invalid m:val and falls back to body-text rendering for that run, so
  // the letter shows up in Times/Calibri instead of the expected math glyph.
  //
  // Sidestep mml2omml entirely by replacing the styled <mi> with the
  // pre-styled Unicode math alphanumeric character (𝒩 for \mathcal{N},
  // 𝔸 for \mathbb{A}, etc.). mml2omml then sees a plain <mi> and emits
  // clean OMML; Word renders the codepoint in Cambria Math with the
  // intended style baked in.
  const MATH_ALPHA = {
    'script': {
      upper: 0x1D49C, lower: 0x1D4B6,
      // These letters exist in the Letterlike Symbols block (U+2100-214F)
      // rather than in the Mathematical Alphanumeric Symbols block; using
      // the math-block codepoints for them would land on reserved/unassigned
      // positions.
      except: {
        B: 'ℬ', E: 'ℰ', F: 'ℱ', H: 'ℋ',
        I: 'ℐ', L: 'ℒ', M: 'ℳ', R: 'ℛ',
        e: 'ℯ', g: 'ℊ', o: 'ℴ',
      },
    },
    'double-struck': {
      upper: 0x1D538, lower: 0x1D552,
      except: { C: 'ℂ', H: 'ℍ', N: 'ℕ', P: 'ℙ', Q: 'ℚ', R: 'ℝ', Z: 'ℤ' },
    },
    'fraktur': {
      upper: 0x1D504, lower: 0x1D51E,
      except: { C: 'ℭ', H: 'ℌ', I: 'ℑ', R: 'ℜ', Z: 'ℨ' },
    },
    'sans-serif':  { upper: 0x1D5A0, lower: 0x1D5BA, except: {} },
  };

  function letterToMathVariant(letter, variant) {
    const m = MATH_ALPHA[variant];
    if (!m) return null;
    if (m.except[letter]) return m.except[letter];
    if (letter >= 'A' && letter <= 'Z') {
      return String.fromCodePoint(m.upper + letter.charCodeAt(0) - 0x41);
    }
    if (letter >= 'a' && letter <= 'z') {
      return String.fromCodePoint(m.lower + letter.charCodeAt(0) - 0x61);
    }
    return null;
  }

  function normalizeMathVariants(mml) {
    return mml.replace(
      /<mi([^>]*?)\s*mathvariant="([^"]+)"([^>]*?)>([A-Za-z])<\/mi>/g,
      function (full, before, variant, after, letter) {
        const sub = letterToMathVariant(letter, variant);
        if (sub === null) return full;
        const merged = (before + after).replace(/\s+/g, ' ').trim();
        return '<mi' + (merged ? ' ' + merged : '') + '>' + sub + '</mi>';
      }
    );
  }

  // Strip MathML elements that mml2omml doesn't handle. Pre-cleaning is the
  // right layer to do this -- otherwise mml2omml warns to console.warn on
  // every encounter ("Type not supported: <tag>"), Chrome's extension error
  // page surfaces those as runtime errors, and a math-heavy article (one
  // <annotation> per equation) drowns the console in ~60 'errors' that
  // aren't bugs in our code or theirs.
  //   <annotation>  -- KaTeX preserves the original LaTeX source as an
  //                    accessibility annotation. mml2omml has no equivalent
  //                    in OMML; strip entirely. We've already used the
  //                    rendered visible HTML for screen display, this is
  //                    metadata only.
  //   <mpadded>     -- fine-grained spacing wrapper (KaTeX's \\! and friends).
  //                    Unwrap to keep the children inline; OMML's structural
  //                    spacing carries the math-tradition equivalent.
  //   <mphantom>    -- invisible placeholder for alignment; drop entirely.
  function stripUnsupportedMathMLElements(mml) {
    return mml
      .replace(/<annotation\b[^>]*>[\s\S]*?<\/annotation>/g, '')
      .replace(/<mpadded\b[^>]*>([\s\S]*?)<\/mpadded>/g, '$1')
      .replace(/<mphantom\b[^>]*>[\s\S]*?<\/mphantom>/g, '');
  }

  function preserveMtextBoundarySpace(mml) {
    return mml.replace(
      /(<mtext\b[^>]*>)([\s\S]*?)(<\/mtext>)/g,
      (_m, open, text, close) =>
        open +
        text.replace(/^\s+/, SPACE_SENTINEL).replace(/\s+$/, SPACE_SENTINEL) +
        close
    );
  }

  function escapeMTextInOMML(omml) {
    return omml.replace(
      /(<m:t\b[^>]*>)([\s\S]*?)(<\/m:t>)/g,
      (_m, open, text, close) => {
        const escaped = text
          .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
          .replace(/&(?!(amp|lt|gt|quot|apos);)/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        return open + escaped + close;
      }
    );
  }

  function splitTopLevelElements(s) {
    const out = [];
    let depth = 0;
    let start = 0;
    let i = 0;
    while (i < s.length) {
      if (s[i] === '<') {
        const end = s.indexOf('>', i);
        if (end < 0) break;
        const tag = s.substring(i, end + 1);
        const isClose = tag.startsWith('</');
        const isSelfClose = tag.endsWith('/>');
        if (depth === 0 && !isClose) start = i;
        if (!isClose && !isSelfClose) depth++;
        else if (isClose) depth--;
        if (depth === 0) out.push(s.substring(start, end + 1));
        i = end + 1;
      } else {
        i++;
      }
    }
    return out;
  }

  function fixEmptyNary(omml) {
    const startMatch = omml.match(/<m:oMath[^>]*>/);
    const endIdx = omml.lastIndexOf('</m:oMath>');
    if (!startMatch || endIdx < 0) return omml;
    const prefix = omml.substring(0, startMatch.index + startMatch[0].length);
    const suffix = omml.substring(endIdx);
    const inner = omml.substring(startMatch.index + startMatch[0].length, endIdx);
    const kids = splitTopLevelElements(inner);
    // Right-to-left so inner n-ary gets its integrand absorbed first, and the
    // outer n-ary then absorbs the now-populated inner. Single pass suffices
    // for any depth of nesting.
    for (let i = kids.length - 2; i >= 0; i--) {
      const ch = kids[i];
      if (ch.startsWith('<m:nary>') && /<m:e\s*\/>/.test(ch)) {
        const next = kids[i + 1];
        kids[i] = ch.replace(/<m:e\s*\/>/, '<m:e>' + next + '</m:e>');
        kids.splice(i + 1, 1);
      }
    }
    return prefix + kids.join('') + suffix;
  }

  function restoreSentinelSpaces(omml) {
    return omml.split(SPACE_SENTINEL).join(' ');
  }

  // MathML uses four "invisible operator" code points to carry semantics that
  // structural OMML doesn't need:
  //   U+2061 FUNCTION APPLICATION  (after f in "f(x)")
  //   U+2062 INVISIBLE TIMES       (between juxtaposed factors, "ab" = a*b)
  //   U+2063 INVISIBLE SEPARATOR   (between list items where a comma is implied)
  //   U+2064 INVISIBLE PLUS        (between integer and fraction, "1 1/2")
  // mml2omml leaves them in <m:t> as literal characters. Pages renders them
  // invisibly per the Unicode standard; Word's Cambria Math falls back to a
  // visible glyph (often comma-shaped) for the ones it has no real glyph
  // for. Strip them from <m:t> text content -- the surrounding OMML structure
  // already encodes the same semantics.
  function stripInvisibleMathOperators(omml) {
    return omml.replace(/(<m:t\b[^>]*>)([\s\S]*?)(<\/m:t>)/g,
      (_m, open, text, close) =>
        open + text.replace(/[⁡-⁤]/g, '') + close);
  }

  function stripOmmlNamespaceDecl(omml) {
    // mml2omml's <m:oMath> declares xmlns:m and xmlns:w on every element.
    // Document.xml will declare these at the root, so the per-element decls
    // are redundant noise. Drop them.
    return omml
      .replace(/\sxmlns:m="[^"]*"/g, '')
      .replace(/\sxmlns:w="[^"]*"/g, '');
  }

  // Take a KaTeX-rendered MathML element from the DOM and produce an OMML
  // string ready to drop into a <w:p>. Returns '' if conversion fails.
  //
  // Pipeline order is load-bearing -- don't reorder lightly:
  //   1. stripUnsupportedMathMLElements  remove tags mml2omml warns on
  //                                       (annotation, mpadded, mphantom).
  //                                       Must run on MathML, before (4).
  //   2. normalizeMathVariants           <mi mathvariant="script">N</mi>
  //                                       -> <mi>𝒩</mi>. MathML-level.
  //   3. preserveMtextBoundarySpace      smuggle <mtext> boundary spaces
  //                                       through (4)'s whitespace-stripping
  //                                       parser via a U+E000 sentinel.
  //                                       Must run on MathML, before (4).
  //   4. mml2omml                        the vendored MathML -> OMML pass.
  //   5. escapeMTextInOMML               escape raw '<' / '&' in <m:t>.
  //                                       Must run BEFORE (6) because (6)'s
  //                                       structural walker is fooled by raw
  //                                       '<' into thinking it's a tag.
  //   6. fixEmptyNary                    right-to-left fill of empty <m:e/>
  //                                       in n-ary operators (∫ / ∑).
  //   7. restoreSentinelSpaces           swap the U+E000 from (3) back to ' '.
  //                                       Order vs (8) doesn't matter --
  //                                       sentinel is U+E000, (8) only
  //                                       touches U+2061..U+2064.
  //   8. stripInvisibleMathOperators     drop U+2061..U+2064 from <m:t>
  //                                       (Word renders some as comma-shaped
  //                                       fallback; Pages is fine).
  //   9. stripOmmlNamespaceDecl          remove per-element xmlns:m / xmlns:w
  //                                       declarations -- document root
  //                                       declares them. Pure cleanup; runs
  //                                       last so the structural walks above
  //                                       still see the namespaced strings.
  function mathmlToOmml(mathElement) {
    if (!window.MathML2OMML || !window.MathML2OMML.mml2omml) return '';
    let mml = mathElement.outerHTML;
    mml = stripUnsupportedMathMLElements(mml);
    mml = normalizeMathVariants(mml);
    mml = preserveMtextBoundarySpace(mml);
    let omml;
    // mml2omml emits `Type not supported: <tag>` via console.warn for tags it
    // skips. Most are pre-cleaned by stripUnsupportedMathMLElements above, but
    // the silencing is kept as defence-in-depth for any tag we miss. Stub both
    // warn and log around the call, restore in finally so an exception path
    // can't permanently lose the originals.
    const _warn = console.warn;
    const _log = console.log;
    console.warn = function () {};
    console.log = function () {};
    let _err = null;
    try {
      omml = window.MathML2OMML.mml2omml(mml);
    } catch (e) {
      _err = e;
    } finally {
      console.warn = _warn;
      console.log = _log;
    }
    if (_err) {
      console.warn('[markdown-studio] mml2omml failed:', _err);
      return '';
    }
    omml = escapeMTextInOMML(omml);
    omml = fixEmptyNary(omml);
    omml = restoreSentinelSpaces(omml);
    omml = stripInvisibleMathOperators(omml);
    omml = stripOmmlNamespaceDecl(omml);
    return omml;
  }

  // ---- OOXML helpers -------------------------------------------------------

  // C0 control characters other than tab/LF/CR are forbidden in XML 1.0
  // text content. A stray BEL or NUL anywhere in <w:t> would make Word
  // (and every other parser) reject the entire document. Strip first,
  // escape after.
  function escXml(s) {
    return s
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Build one <w:r> with optional formatting.
  function makeRun(text, fmt) {
    fmt = fmt || {};
    const parts = [];
    if (fmt.bold || fmt.italic || fmt.monospace || fmt.size || fmt.shade
        || fmt.color || fmt.underline || fmt.superscript || fmt.subscript) {
      parts.push('<w:rPr>');
      if (fmt.bold) parts.push('<w:b/>');
      if (fmt.italic) parts.push('<w:i/>');
      if (fmt.monospace) parts.push(
        '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/>'
      );
      if (fmt.color) parts.push('<w:color w:val="' + fmt.color + '"/>');
      if (fmt.underline) parts.push('<w:u w:val="single"/>');
      if (fmt.superscript) parts.push('<w:vertAlign w:val="superscript"/>');
      else if (fmt.subscript) parts.push('<w:vertAlign w:val="subscript"/>');
      if (fmt.size) parts.push('<w:sz w:val="' + fmt.size + '"/>');
      if (fmt.shade) parts.push(
        '<w:shd w:val="clear" w:color="auto" w:fill="' + fmt.shade + '"/>'
      );
      parts.push('</w:rPr>');
    }
    parts.push('<w:t xml:space="preserve">' + escXml(text) + '</w:t>');
    return '<w:r>' + parts.join('') + '</w:r>';
  }

  function makeParagraph(contentParts, opts) {
    opts = opts || {};
    const inner = contentParts.join('');
    let pPr = '';
    if (opts.spacingBefore || opts.spacingAfter) {
      pPr = '<w:pPr><w:spacing'
        + (opts.spacingBefore ? ' w:before="' + opts.spacingBefore + '"' : '')
        + (opts.spacingAfter ? ' w:after="' + opts.spacingAfter + '"' : '')
        + '/></w:pPr>';
    }
    return '<w:p>' + pPr + inner + '</w:p>';
  }

  // ---- DOM walking ---------------------------------------------------------

  // Half-point font sizes for headings (matches the visual hierarchy).
  const HEADING_SIZES = { 1: 36, 2: 30, 3: 26, 4: 24, 5: 22, 6: 20 };

  // Walk inline children, emitting an array of OOXML parts (<w:r> strings,
  // possibly mixed with raw <m:oMath> for inline math, and inline <w:drawing>
  // for images). `ctx` carries the image registry + namespace flags and is
  // threaded through every recursive call so an <img> anywhere in the tree
  // can claim its own relId / picture id.
  function walkInline(el, ctx, fmt) {
    fmt = fmt || {};
    const out = [];
    for (let i = 0; i < el.childNodes.length; i++) {
      const node = el.childNodes[i];
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent;
        if (t) out.push(makeRun(t, fmt));
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName.toLowerCase();
        if (tag === 'strong' || tag === 'b') {
          appendAll(out, walkInline(node, ctx, Object.assign({}, fmt, { bold: true })));
        } else if (tag === 'em' || tag === 'i') {
          appendAll(out, walkInline(node, ctx, Object.assign({}, fmt, { italic: true })));
        } else if (tag === 'code') {
          appendAll(out, walkInline(node, ctx, Object.assign({}, fmt, { monospace: true })));
        } else if (tag === 'a') {
          // marked-footnote ships <a data-footnote-backref>↩</a> at the end
          // of each footnote body, pointing back to the citation. Word
          // generates back-navigation natively, so drop them.
          if (node.hasAttribute('data-footnote-backref')) continue;
          // Footnote reference: <sup><a data-footnote-ref href="#footnote-X">N</a></sup>.
          // The <sup> handler dispatches to the footnote when ctx is set;
          // the <a> may also be visited directly here. Emit nothing -- the
          // wrapping <sup> already handled it.
          if (node.hasAttribute('data-footnote-ref')) continue;
          const href = node.getAttribute('href');
          // Skip in-document anchors (#section-id) -- Word can't follow them
          // without a corresponding bookmark, and the markdown source's
          // anchors point at heading slugs we haven't materialised in OOXML.
          // Skip mailto: / tel: too unless they look real; defer to inline
          // text to keep the export safe for any host.
          const isExternal = href && /^(https?:|mailto:|ftp:)/i.test(href);
          if (isExternal && ctx && ctx.useHyperlink) {
            const relId = ctx.useHyperlink(href);
            const linkFmt = Object.assign({}, fmt, {
              color: '0563C1',    // Word's default hyperlink colour
              underline: true,
            });
            const inner = walkInline(node, ctx, linkFmt);
            // <w:hyperlink r:id="..."> is a direct child of <w:p>, sibling
            // of <w:r> -- valid wherever a run is valid.
            out.push('<w:hyperlink r:id="' + relId + '" w:history="1">'
              + inner.join('') + '</w:hyperlink>');
          } else {
            // Same-page anchors and unknown schemes: just inline the text.
            appendAll(out, walkInline(node, ctx, fmt));
          }
        } else if (tag === 'sup') {
          // marked-footnote wraps the inline citation: <sup><a data-footnote-ref href="#footnote-foo">N</a></sup>.
          // Emit a real Word footnote reference and dispatch the body to ctx.
          const refA = node.querySelector('a[data-footnote-ref]');
          if (refA && ctx && ctx.useFootnote) {
            const href = refA.getAttribute('href') || '';
            const key = href.replace(/^#/, '');
            const wordId = ctx.useFootnote(key);
            if (wordId !== null) {
              out.push(
                '<w:r>'
                + '<w:rPr><w:vertAlign w:val="superscript"/></w:rPr>'
                + '<w:footnoteReference w:id="' + wordId + '"/>'
                + '</w:r>'
              );
              continue;
            }
          }
          // Plain <sup> (not a footnote citation) or footnote setup failed:
          // emit children with real <w:vertAlign w:val="superscript"/>.
          appendAll(out, walkInline(node, ctx, Object.assign({}, fmt, { superscript: true })));
        } else if (tag === 'sub') {
          appendAll(out, walkInline(node, ctx, Object.assign({}, fmt, { subscript: true })));
        } else if (tag === 'br') {
          out.push('<w:r><w:br/></w:r>');
        } else if (tag === 'img') {
          const meta = ctx && ctx.useImage && ctx.useImage(node.src);
          if (meta) {
            out.push(makeImageDrawingRun(meta));
          } else {
            // Unsupported format / fetch failure: fall back to italic alt.
            const alt = node.getAttribute('alt') || '[image]';
            out.push(makeRun(alt, Object.assign({}, fmt, { italic: true })));
          }
        } else if (node.classList && node.classList.contains('katex')) {
          // Inline math: emit raw <m:oMath> sibling to <w:r>s inside the <w:p>.
          const mathEl = node.querySelector('.katex-mathml math');
          if (mathEl) {
            const omml = mathmlToOmml(mathEl);
            if (omml) out.push(omml);
          }
        } else {
          // Anything else: descend, picking up text content.
          appendAll(out, walkInline(node, ctx, fmt));
        }
      }
    }
    return out;
  }

  function appendAll(target, parts) {
    for (let i = 0; i < parts.length; i++) target.push(parts[i]);
  }

  function blockToParagraphs(el, ctx) {
    const tag = el.tagName.toLowerCase();

    // --- headings ---
    if (/^h[1-6]$/.test(tag)) {
      const lvl = +tag[1];
      const size = HEADING_SIZES[lvl];
      const runs = walkInline(el, ctx, { bold: true, size: size });
      return [makeParagraph(runs, { spacingBefore: 240, spacingAfter: 120 })];
    }

    // --- paragraphs ---
    if (tag === 'p') {
      // Display math sits inside <p> as <span class="katex-display"> when
      // marked produces a stand-alone math block. Promote to its own
      // paragraph wrapped in <m:oMathPara>.
      const disp = el.querySelector('.katex-display');
      if (disp && disp.parentNode === el && el.children.length === 1) {
        const mathEl = disp.querySelector('.katex-mathml math');
        if (mathEl) {
          const omml = mathmlToOmml(mathEl);
          if (omml) return ['<w:p><m:oMathPara>' + omml + '</m:oMathPara></w:p>'];
        }
      }
      const runs = walkInline(el, ctx);
      return [makeParagraph(runs)];
    }

    // --- preformatted code blocks ---
    if (tag === 'pre') {
      return codeBlockToParagraphs(el);
    }

    // --- lists -> numbering.xml-driven bullets / numbers ---
    if (tag === 'ul' || tag === 'ol') {
      return buildList(el, ctx, 0);
    }

    // --- blockquote -> one paragraph per child, italic prefix ---
    if (tag === 'blockquote') {
      const out = [];
      for (let i = 0; i < el.children.length; i++) {
        const sub = el.children[i];
        const runs = walkInline(sub, ctx, { italic: true });
        out.push(makeParagraph([makeRun('“', { italic: true })].concat(runs)
          .concat([makeRun('”', { italic: true })])));
      }
      return out;
    }

    // --- horizontal rule ---
    if (tag === 'hr') {
      return ['<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr></w:p>'];
    }

    // --- footnotes section: collected into footnotes.xml, drop from body ---
    if (tag === 'section' && el.classList && el.classList.contains('footnotes')) {
      return [];
    }

    // --- mermaid (block-level diagram, pre-rasterised to PNG) ---
    if (el.classList && el.classList.contains('md-mermaid')) {
      const meta = ctx && ctx.useMermaid && ctx.useMermaid(el);
      if (meta) return [makeParagraph([makeImageDrawingRun(meta)])];
      return [makeParagraph([makeRun('[mermaid diagram]', { italic: true })])];
    }

    // --- tables ---
    if (tag === 'table') {
      // Empty paragraph after the table -- Word otherwise can't park the
      // cursor below the table, and some renderers complain about a body
      // that ends with <w:tbl>.
      return [buildTable(el, ctx), '<w:p/>'];
    }

    // --- images / figure ---
    if (tag === 'img') {
      // Standalone <img> directly under article (rare from markdown but possible).
      const meta = ctx && ctx.useImage && ctx.useImage(el.src);
      if (meta) return [makeParagraph([makeImageDrawingRun(meta)])];
      return [makeParagraph([makeRun(el.getAttribute('alt') || '[image]', { italic: true })])];
    }
    if (tag === 'figure') {
      // <figure> with <img> + optional <figcaption>. Emit one para for the
      // image and one para for the caption (if present). Anything else
      // inside the figure: walkInline fallback.
      const out = [];
      const img = el.querySelector('img');
      if (img) {
        const meta = ctx && ctx.useImage && ctx.useImage(img.src);
        if (meta) out.push(makeParagraph([makeImageDrawingRun(meta)]));
        else out.push(makeParagraph([makeRun(img.getAttribute('alt') || '[image]', { italic: true })]));
      }
      const cap = el.querySelector('figcaption');
      if (cap) {
        const runs = walkInline(cap, ctx, { italic: true });
        if (runs.length) out.push(makeParagraph(runs));
      }
      return out.length ? out : [makeParagraph(walkInline(el, ctx))];
    }

    // --- fallback: walk inline ---
    const runs = walkInline(el, ctx);
    return runs.length ? [makeParagraph(runs)] : [];
  }

  // ---- images --------------------------------------------------------------

  // Magic-byte sniff for the common raster formats. Used as a fallback when
  // the server (or file:// loader) doesn't return a Content-Type header.
  function guessMimeFromBytes(bytes) {
    if (bytes.length >= 8 &&
        bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
      return 'image/png';
    }
    if (bytes.length >= 3 &&
        bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
      return 'image/jpeg';
    }
    if (bytes.length >= 6 &&
        bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
      return 'image/gif';
    }
    return null;
  }

  const MIME_TO_EXT = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
  };

  // Walk the article, fetch every <img> we can handle, and return a
  // Map<src, {bytes, mime, ext, w, h}>. SVG, webp, and any unrecognised
  // format are silently skipped -- the walker falls back to italic alt-text
  // for those. Same src appearing multiple times in the article is fetched
  // once (de-duped by URL) but referenced separately in the docx.
  async function prefetchImages(article) {
    const map = new Map();
    const imgs = Array.from(article.querySelectorAll('img'));
    for (const img of imgs) {
      const src = img.src;
      if (!src || map.has(src)) continue;
      try {
        const res = await fetch(src);
        if (!res.ok) {
          console.warn('[markdown-studio] image fetch ' + res.status + ':', src);
          continue;
        }
        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);
        const ctHeader = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        const mime = MIME_TO_EXT[ctHeader] ? ctHeader : guessMimeFromBytes(bytes);
        if (!mime || !MIME_TO_EXT[mime]) {
          // SVG / webp / unknown -- skip rather than risk a Word-incompatible drawing.
          continue;
        }
        map.set(src, {
          bytes,
          mime,
          ext: MIME_TO_EXT[mime],
          w: img.naturalWidth || img.width || 320,
          h: img.naturalHeight || img.height || 240,
        });
      } catch (e) {
        console.warn('[markdown-studio] image fetch failed:', src, e);
      }
    }
    return map;
  }

  // Inline image drawing XML. EMU (English Metric Units): 1 inch = 914400
  // EMU; 1 pixel @ 96dpi = 9525 EMU. Constrain width to the text-area
  // width on a 1in-margins US Letter page so giant screenshots don't
  // overflow off the right edge.
  function makeImageDrawingRun(meta) {
    const MAX_CX = 5769360; // 6.3in in EMU
    let cx = Math.round(meta.w * 9525);
    let cy = Math.round(meta.h * 9525);
    if (cx > MAX_CX) {
      cy = Math.round(cy * MAX_CX / cx);
      cx = MAX_CX;
    }
    const id = meta.num;
    const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
    const PIC_NS = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
    return (
      '<w:r><w:drawing>' +
      '<wp:inline distT="0" distB="0" distL="0" distR="0">' +
        '<wp:extent cx="' + cx + '" cy="' + cy + '"/>' +
        '<wp:docPr id="' + id + '" name="Picture ' + id + '"/>' +
        '<wp:cNvGraphicFramePr>' +
          '<a:graphicFrameLocks xmlns:a="' + A_NS + '" noChangeAspect="1"/>' +
        '</wp:cNvGraphicFramePr>' +
        '<a:graphic xmlns:a="' + A_NS + '">' +
          '<a:graphicData uri="' + PIC_NS + '">' +
            '<pic:pic xmlns:pic="' + PIC_NS + '">' +
              '<pic:nvPicPr>' +
                '<pic:cNvPr id="' + id + '" name="Picture ' + id + '"/>' +
                '<pic:cNvPicPr/>' +
              '</pic:nvPicPr>' +
              '<pic:blipFill>' +
                '<a:blip r:embed="' + meta.relId + '"/>' +
                '<a:stretch><a:fillRect/></a:stretch>' +
              '</pic:blipFill>' +
              '<pic:spPr>' +
                '<a:xfrm>' +
                  '<a:off x="0" y="0"/>' +
                  '<a:ext cx="' + cx + '" cy="' + cy + '"/>' +
                '</a:xfrm>' +
                '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
              '</pic:spPr>' +
            '</pic:pic>' +
          '</a:graphicData>' +
        '</a:graphic>' +
      '</wp:inline>' +
      '</w:drawing></w:r>'
    );
  }

  // ---- mermaid: SVG -> PNG -------------------------------------------------

  // Rasterise an SVG element to a PNG Blob via a Canvas. The SVG is
  // serialised, base64-wrapped into a data: URL, loaded into an off-DOM
  // <img>, and painted to a canvas at 2x scale so the embedded PNG holds
  // up at the display size we pick.
  function svgToPng(svgEl) {
    return new Promise(function (resolve, reject) {
      let svgStr;
      try {
        svgStr = new XMLSerializer().serializeToString(svgEl);
      } catch (e) { return reject(e); }
      // Many mermaid SVGs use width="100%" with explicit viewBox; pin width
      // and height attrs from getBoundingClientRect so the canvas knows how
      // big to be (otherwise <img>.naturalWidth comes back 0).
      const rect = svgEl.getBoundingClientRect();
      const w = Math.max(64, Math.round(rect.width)  || 800);
      const h = Math.max(64, Math.round(rect.height) || 600);
      // Ensure width/height are baked into the serialised SVG, otherwise
      // some browsers ignore the data-URL <img>'s intrinsic size.
      if (!/\swidth=/.test(svgStr)) svgStr = svgStr.replace('<svg', '<svg width="' + w + '"');
      if (!/\sheight=/.test(svgStr)) svgStr = svgStr.replace('<svg', '<svg height="' + h + '"');
      const svgB64 = btoa(unescape(encodeURIComponent(svgStr)));
      const dataUrl = 'data:image/svg+xml;base64,' + svgB64;
      const img = new Image();
      img.onload = function () {
        const SCALE = 2;
        const canvas = document.createElement('canvas');
        canvas.width  = w * SCALE;
        canvas.height = h * SCALE;
        const ctx2 = canvas.getContext('2d');
        ctx2.fillStyle = '#ffffff';   // Word prints opaque PNGs better than transparent
        ctx2.fillRect(0, 0, canvas.width, canvas.height);
        ctx2.scale(SCALE, SCALE);
        ctx2.drawImage(img, 0, 0, w, h);
        canvas.toBlob(function (blob) {
          if (!blob) { reject(new Error('canvas.toBlob returned null')); return; }
          blob.arrayBuffer().then(function (buf) {
            resolve({ bytes: new Uint8Array(buf), w: w, h: h });
          }).catch(reject);
        }, 'image/png');
      };
      img.onerror = function (e) { reject(e || new Error('svg image load failed')); };
      img.src = dataUrl;
    });
  }

  // Walk article, rasterise every <div class="md-mermaid"> SVG, return a
  // WeakMap<divElement, {bytes, w, h}> for the walker to look up.
  async function prefetchMermaid(article) {
    const map = new WeakMap();
    const divs = Array.from(article.querySelectorAll('.md-mermaid'));
    for (const div of divs) {
      const svg = div.querySelector('svg');
      if (!svg) continue;
      try {
        const png = await svgToPng(svg);
        map.set(div, png);
      } catch (e) {
        console.warn('[markdown-studio] mermaid SVG -> PNG failed:', e);
      }
    }
    return map;
  }

  // ---- lists ---------------------------------------------------------------

  // Build a list (ul or ol) into one paragraph per <li>, with <w:numPr>
  // wired to a numId allocated by ctx.useList. Each list gets its OWN
  // numId so an ordered list always restarts at 1.
  //
  // Nested lists: a <li> may contain a nested <ul>/<ol>. We recurse with
  // ilvl+1; the same kind of list (bullet/decimal) reuses the parent's
  // numId so Word's "continue numbering" semantics work; a different kind
  // (a <ol> nested inside a <ul>) gets a fresh numId.
  function buildList(listEl, ctx, ilvl) {
    const kind = listEl.tagName.toLowerCase() === 'ol' ? 'ol' : 'ul';
    const numId = ctx && ctx.useList ? ctx.useList(kind) : null;
    const out = [];
    let fallbackN = 1;
    for (let i = 0; i < listEl.children.length; i++) {
      const li = listEl.children[i];
      if (li.tagName.toLowerCase() !== 'li') continue;

      // Split the <li>'s children into:
      //   - inline content (text + leading inline elements) for the first paragraph
      //   - any nested block elements (sub-list, blockquote, ...) for subsequent paragraphs
      const inlineNodes = [];
      const blockNodes = [];
      for (let k = 0; k < li.childNodes.length; k++) {
        const ch = li.childNodes[k];
        if (ch.nodeType === Node.ELEMENT_NODE) {
          const ct = ch.tagName.toLowerCase();
          if (ct === 'ul' || ct === 'ol' || ct === 'pre' || ct === 'blockquote' || ct === 'table' || ct === 'figure') {
            blockNodes.push(ch);
            continue;
          }
        }
        inlineNodes.push(ch);
      }

      // First paragraph: the li's own text content.
      const runs = walkInlineNodes(inlineNodes, ctx, null);
      if (numId !== null) {
        out.push(makeListParagraph(runs, numId, ilvl));
      } else {
        const prefix = kind === 'ol' ? (fallbackN++ + '. ') : '• ';
        out.push(makeParagraph([makeRun(prefix)].concat(runs)));
      }

      // Subsequent paragraphs from nested blocks. Sub-lists recurse with
      // ilvl+1; other blocks fall through blockToParagraphs as usual.
      for (const blk of blockNodes) {
        const bt = blk.tagName.toLowerCase();
        if (bt === 'ul' || bt === 'ol') {
          for (const p of buildList(blk, ctx, ilvl + 1)) out.push(p);
        } else {
          for (const p of blockToParagraphs(blk, ctx)) out.push(p);
        }
      }
    }
    return out;
  }

  // Helper that runs walkInline over an arbitrary list of childNodes (not
  // an Element). Used by buildList where we split the <li> into "inline"
  // and "block" partitions.
  function walkInlineNodes(nodes, ctx, fmt) {
    const synthetic = document.createElement('span');
    for (const n of nodes) synthetic.appendChild(n.cloneNode(true));
    return walkInline(synthetic, ctx, fmt || {});
  }

  function makeListParagraph(runs, numId, ilvl) {
    const inner = runs.length > 0 ? runs.join('') : '';
    return '<w:p>'
      + '<w:pPr>'
      +   '<w:numPr>'
      +     '<w:ilvl w:val="' + ilvl + '"/>'
      +     '<w:numId w:val="' + numId + '"/>'
      +   '</w:numPr>'
      + '</w:pPr>'
      + inner
      + '</w:p>';
  }

  function buildFootnotesXml(ctx) {
    // Two system entries are required by the schema: separator (the short
    // horizontal line between body and footnotes) and continuationSeparator
    // (the full-width line when footnotes spill onto the next page).
    let body = ''
      + '<w:footnote w:type="separator" w:id="-1">'
      +   '<w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>'
      +     '<w:r><w:separator/></w:r></w:p>'
      + '</w:footnote>'
      + '<w:footnote w:type="continuationSeparator" w:id="0">'
      +   '<w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>'
      +     '<w:r><w:continuationSeparator/></w:r></w:p>'
      + '</w:footnote>';

    // Each user footnote: paragraph with the auto-marker (<w:footnoteRef/>)
    // followed by the walked content. Multi-paragraph footnotes get extra
    // <w:p>s without the marker, mirroring how Word authors multi-line
    // footnote text.
    // _footnotes is a Map keyed in insertion order, and wordId is assigned
    // monotonically in useFootnote -- so keys() is already citation order;
    // no sort step needed.
    for (const key of ctx._footnotes.keys()) {
      const fn = ctx._footnotes.get(key);
      body += '<w:footnote w:id="' + fn.wordId + '">';
      for (let i = 0; i < fn.contentParas.length; i++) {
        const runs = fn.contentParas[i];
        if (i === 0) {
          body +=
            '<w:p>' +
              '<w:r>' +
                '<w:rPr><w:vertAlign w:val="superscript"/></w:rPr>' +
                '<w:footnoteRef/>' +
              '</w:r>' +
              '<w:r><w:t xml:space="preserve"> </w:t></w:r>' +
              runs.join('') +
            '</w:p>';
        } else {
          body += '<w:p>' + runs.join('') + '</w:p>';
        }
      }
      if (fn.contentParas.length === 0) {
        // empty body -- still emit the marker
        body +=
          '<w:p>' +
            '<w:r>' +
              '<w:rPr><w:vertAlign w:val="superscript"/></w:rPr>' +
              '<w:footnoteRef/>' +
            '</w:r>' +
          '</w:p>';
      }
      body += '</w:footnote>';
    }
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:footnotes xmlns:w="' + W_NS + '"'
      +   ' xmlns:m="' + M_NS + '"'
      +   ' xmlns:r="' + R_NS + '"'
      +   ' xmlns:wp="' + WP_NS + '">'
      +   body
      + '</w:footnotes>';
  }

  function buildNumberingXml(ctx) {
    // 9 levels of indent for each abstract format, hanging marker style.
    function lvls(format, marker) {
      let out = '';
      for (let i = 0; i < 9; i++) {
        const left = 720 + i * 360;
        // For decimal, marker template is per-level (%1. at lvl0, %2. at lvl1, ...).
        const text = format === 'decimal' ? '%' + (i + 1) + '.' : marker;
        out += '<w:lvl w:ilvl="' + i + '">'
          + '<w:start w:val="1"/>'
          + '<w:numFmt w:val="' + format + '"/>'
          + '<w:lvlText w:val="' + text + '"/>'
          + '<w:lvlJc w:val="left"/>'
          + '<w:pPr><w:ind w:left="' + left + '" w:hanging="360"/></w:pPr>'
          + '</w:lvl>';
      }
      return out;
    }
    let nums = '';
    for (const inst of ctx._listInstances) {
      const abstractId = inst.kind === 'ol' ? 1 : 0;
      nums += '<w:num w:numId="' + inst.numId + '">'
            +   '<w:abstractNumId w:val="' + abstractId + '"/>'
            + '</w:num>';
    }
    // <w:multiLevelType w:val="hybridMultilevel"/> is the modern default
    // and Word for Mac specifically falls back to "singleLevel" (collapsing
    // every nested level to ilvl=0) when this is absent. Required.
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:numbering xmlns:w="' + W_NS + '">'
      +   '<w:abstractNum w:abstractNumId="0">'
      +     '<w:multiLevelType w:val="hybridMultilevel"/>'
      +     lvls('bullet', '•')
      +   '</w:abstractNum>'
      +   '<w:abstractNum w:abstractNumId="1">'
      +     '<w:multiLevelType w:val="hybridMultilevel"/>'
      +     lvls('decimal', '')
      +   '</w:abstractNum>'
      +   nums
      + '</w:numbering>';
  }

  // ---- code blocks: preserve highlight.js colours -------------------------

  // GitHub-Light palette, matching the @media print rules in viewer.css.
  // hex strings without '#' -- OOXML <w:color w:val=""> expects 6 hex digits.
  const HLJS_COLOR = {
    'hljs-comment': '6a737d', 'hljs-quote': '6a737d',
    'hljs-keyword': 'd73a49', 'hljs-selector-tag': 'd73a49',
    'hljs-doctag':  'd73a49', 'hljs-section': 'd73a49', 'hljs-name': 'd73a49',
    'hljs-string':  '032f62', 'hljs-bullet': '032f62',
    'hljs-symbol':  '032f62', 'hljs-regexp': '032f62',
    'hljs-number':  '005cc5', 'hljs-literal': '005cc5',
    'hljs-variable': '005cc5', 'hljs-template-variable': '005cc5',
    'hljs-attr':    '005cc5', 'hljs-attribute': '005cc5',
    'hljs-tag':     '005cc5', 'hljs-type': '005cc5',
    'hljs-title':   '6f42c1', 'hljs-built_in': '6f42c1',
    'hljs-class':   '6f42c1',
    'hljs-deletion': 'b31d28', 'hljs-addition': '22863a',
  };
  const HLJS_ITALIC = new Set(['hljs-comment', 'hljs-quote']);

  function classifySpan(spanEl) {
    if (!spanEl.classList) return null;
    for (const cls of spanEl.classList) {
      if (HLJS_COLOR[cls]) {
        return { color: HLJS_COLOR[cls], italic: HLJS_ITALIC.has(cls) };
      }
    }
    return null;
  }

  // Walk a code block into a flat sequence of {text, color, italic} fragments,
  // then split on newlines into one <w:p> per source line.
  function codeBlockToParagraphs(preEl) {
    const codeEl = preEl.querySelector('code') || preEl;
    const fragments = [];
    function walk(el, color, italic) {
      for (let i = 0; i < el.childNodes.length; i++) {
        const node = el.childNodes[i];
        if (node.nodeType === Node.TEXT_NODE) {
          if (node.textContent) fragments.push({ text: node.textContent, color, italic });
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          const c = classifySpan(node);
          walk(node, c ? c.color : color, c && c.italic || italic);
        }
      }
    }
    walk(codeEl, null, false);

    const SHADE = 'F4F4F4';
    const DEFAULT = '24292e';
    const paragraphs = [];
    let line = [];
    for (const frag of fragments) {
      const pieces = frag.text.split('\n');
      for (let i = 0; i < pieces.length; i++) {
        const piece = pieces[i];
        if (piece) {
          line.push(makeRun(piece, {
            monospace: true,
            shade: SHADE,
            color: frag.color || DEFAULT,
            italic: frag.italic,
          }));
        }
        if (i < pieces.length - 1) {
          if (line.length === 0) {
            line.push(makeRun(' ', { monospace: true, shade: SHADE }));
          }
          paragraphs.push(makeParagraph(line));
          line = [];
        }
      }
    }
    if (line.length) paragraphs.push(makeParagraph(line));
    return paragraphs.length ? paragraphs : [makeParagraph([makeRun(' ', { monospace: true, shade: SHADE })])];
  }

  // ---- tables --------------------------------------------------------------

  // OOXML table: <w:tbl> with <w:tblPr>, <w:tblGrid> (column widths),
  // and a series of <w:tr> (row) / <w:tc> (cell) elements. Cell content is
  // <w:p> with the cell's run sequence, so walkInline gives us everything
  // it does in any other block (bold/italic/code/inline math).
  //
  // Widths are in dxa (1/20 of a point). 9070 dxa ≈ 6.3 in -- matches the
  // text column on US Letter with 1in side margins. Columns are equal width;
  // markdown doesn't carry per-column sizing.
  function buildTable(tableEl, ctx) {
    // Markdown table layouts: <table><thead><tr>...<tbody><tr>... (most
    // common) OR rows directly under <table>. Cover both.
    const rows = [];
    const headerRows = new Set();
    for (const child of tableEl.children) {
      const t = child.tagName.toLowerCase();
      if (t === 'thead') {
        for (const tr of child.children) {
          if (tr.tagName.toLowerCase() === 'tr') {
            rows.push(tr);
            headerRows.add(tr);
          }
        }
      } else if (t === 'tbody' || t === 'tfoot') {
        for (const tr of child.children) {
          if (tr.tagName.toLowerCase() === 'tr') rows.push(tr);
        }
      } else if (t === 'tr') {
        rows.push(child);
        // Bare <tr> directly under <table>: treat as header if first row of
        // a header-less table OR all its cells are <th>.
        if (child.children.length && child.children[0].tagName.toLowerCase() === 'th') {
          headerRows.add(child);
        }
      }
    }
    if (rows.length === 0) {
      return makeParagraph([makeRun('[empty table]', { italic: true })]);
    }

    const colCount = Math.max.apply(null, rows.map(r => r.children.length));
    const TABLE_TOTAL_DXA = 9070;
    const colW = Math.max(100, Math.floor(TABLE_TOTAL_DXA / colCount));

    let grid = '<w:tblGrid>';
    for (let i = 0; i < colCount; i++) grid += '<w:gridCol w:w="' + colW + '"/>';
    grid += '</w:tblGrid>';

    let rowsXml = '';
    for (const tr of rows) {
      const isHeader = headerRows.has(tr);
      rowsXml += '<w:tr>';
      for (const cell of tr.children) {
        const ct = cell.tagName.toLowerCase();
        if (ct !== 'td' && ct !== 'th') continue;
        const fmt = isHeader ? { bold: true } : {};
        const runs = walkInline(cell, ctx, fmt);
        // OOXML requires at least one paragraph inside w:tc, and at least
        // one run with content; a totally empty cell is invalid in some
        // renderers. Substitute a single space if walkInline returned empty.
        const inner = runs.length > 0 ? runs.join('') : '<w:r><w:t xml:space="preserve"> </w:t></w:r>';
        const shading = isHeader
          ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>'
          : '';
        rowsXml +=
          '<w:tc>' +
            '<w:tcPr><w:tcW w:w="' + colW + '" w:type="dxa"/>' + shading + '</w:tcPr>' +
            '<w:p>' + inner + '</w:p>' +
          '</w:tc>';
      }
      rowsXml += '</w:tr>';
    }

    const tblPr =
      '<w:tblPr>' +
        '<w:tblW w:w="0" w:type="auto"/>' +
        '<w:tblBorders>' +
          '<w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/>' +
          '<w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/>' +
          '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/>' +
          '<w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/>' +
          '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/>' +
          '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/>' +
        '</w:tblBorders>' +
      '</w:tblPr>';

    return '<w:tbl>' + tblPr + grid + rowsXml + '</w:tbl>';
  }

  // ---- docx assembly -------------------------------------------------------

  const W_NS  = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const M_NS  = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
  const R_NS  = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const WP_NS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
  const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
  const OFFICE_DOC_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
  const IMAGE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
  const HYPERLINK_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';
  const NUMBERING_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering';
  const NUMBERING_CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml';
  const FOOTNOTES_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes';
  const FOOTNOTES_CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml';
  const DOC_CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';

  // Per-export bookkeeping for image relationships + media bytes. One ctx
  // is created in buildDocxBlob and threaded through the walker; useImage()
  // is the only mutation entry point. relIds start at 10 so they don't
  // collide with rId1 (the document part) or any reserved low numbers.
  function newDocxCtx(imageMap, mermaidPngMap, footnoteLisById) {
    const ctx = {
      relationships: [],
      media: [],
      nextRelId: 10,
      nextPicId: 1,
      mermaidPngMap: mermaidPngMap,
      footnoteLisById: footnoteLisById || new Map(),
    };
    // Shared registration helper for any source of image bytes.
    ctx._registerImage = function (bytes, ext, w, h) {
      const num = ctx.media.length + 1;
      const name = 'image' + num + '.' + ext;
      const relId = 'rId' + (ctx.nextRelId++);
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
                 : ext === 'gif' ? 'image/gif' : 'image/png';
      ctx.media.push({ name: name, bytes: bytes, mime: mime });
      ctx.relationships.push({ id: relId, type: IMAGE_REL, target: 'media/' + name });
      return { relId: relId, num: ctx.nextPicId++, w: w, h: h };
    };
    ctx.useImage = function (src) {
      const data = imageMap.get(src);
      if (!data) return null;
      return ctx._registerImage(data.bytes, data.ext, data.w, data.h);
    };
    ctx.useMermaid = function (divEl) {
      const png = ctx.mermaidPngMap && ctx.mermaidPngMap.get(divEl);
      if (!png) return null;
      return ctx._registerImage(png.bytes, 'png', png.w, png.h);
    };
    // Hyperlinks are external relationships (TargetMode="External"). Each
    // unique URL gets one relId reused across all links pointing to it,
    // matching how Word itself authors the docx.
    ctx._urlRelId = new Map();
    ctx.useHyperlink = function (url) {
      if (!url) return null;
      const cached = ctx._urlRelId.get(url);
      if (cached) return cached;
      const relId = 'rId' + (ctx.nextRelId++);
      ctx.relationships.push({
        id: relId, type: HYPERLINK_REL, target: url, mode: 'External',
      });
      ctx._urlRelId.set(url, relId);
      return relId;
    };
    // Lists: each <ul>/<ol> in the source gets its own <w:num> instance so
    // that <ol> counts restart at 1 for each list (Word would otherwise
    // continue counting across reuses of a numId). abstractNumId 0 is the
    // bullet definition, 1 is the decimal definition; both live in
    // numbering.xml and cover 9 indent levels each.
    ctx._listInstances = [];   // [{ kind: 'ul'|'ol', numId }]
    ctx.useList = function (kind) {
      const numId = ctx._listInstances.length + 1;
      ctx._listInstances.push({ kind: kind, numId: numId });
      return numId;
    };
    // Footnotes: <a data-footnote-ref href="#footnote-foo"> in the body
    // points at <li id="footnote-foo"> in <section.footnotes>. The first
    // time we see a given key we assign a Word footnote id, walk the li's
    // body to OOXML runs (skipping the auto back-link), and stash both.
    // Subsequent refs to the same key reuse the same Word footnote.
    ctx._footnotes = new Map(); // key -> { wordId, contentParas }
    ctx.useFootnote = function (key) {
      if (ctx._footnotes.has(key)) return ctx._footnotes.get(key).wordId;
      const li = ctx.footnoteLisById.get(key);
      if (!li) return null;
      const wordId = ctx._footnotes.size + 1;
      // Walk each child paragraph of the li into its own <w:p>. Skip the
      // marked-footnote 'back to reference' link (handled by Word natively).
      const paras = [];
      for (let i = 0; i < li.children.length; i++) {
        const ch = li.children[i];
        if (ch.tagName.toLowerCase() === 'p') {
          const runs = walkInline(ch, ctx, {});
          paras.push(runs);
        }
      }
      ctx._footnotes.set(key, { wordId: wordId, contentParas: paras });
      return wordId;
    };
    return ctx;
  }

  function buildDocumentXml(article, ctx) {
    const paragraphs = [];
    for (let i = 0; i < article.children.length; i++) {
      const child = article.children[i];
      // Skip our own UI grafts inside the article (TOC handle, file tip, ...).
      if (child.classList && (
        child.classList.contains('md-toc') ||
        child.classList.contains('md-toc-handle') ||
        child.classList.contains('md-toc-hide') ||
        child.classList.contains('md-file-tip')
      )) continue;
      const ps = blockToParagraphs(child, ctx);
      for (let j = 0; j < ps.length; j++) paragraphs.push(ps[j]);
    }
    const body = paragraphs.join('');
    // Declare the wp + r namespaces at the root so inline images don't have
    // to redeclare them on every <w:drawing>.
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:document'
      +   ' xmlns:w="' + W_NS + '"'
      +   ' xmlns:m="' + M_NS + '"'
      +   ' xmlns:r="' + R_NS + '"'
      +   ' xmlns:wp="' + WP_NS + '">'
      +   '<w:body>'
      +     body
      +     '<w:sectPr>'
      +       '<w:pgSz w:w="12240" w:h="15840"/>'
      +       '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440"'
      +              ' w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>'
      +     '</w:sectPr>'
      +   '</w:body>'
      + '</w:document>';
  }

  function buildContentTypesXml() {
    // Default Extension entries declare the MIME type for any file in the
    // zip whose name ends with that extension. Declaring png/jpg/gif/jpeg
    // unconditionally is harmless when there are no images and required
    // when there are.
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="' + CT_NS + '">'
      +   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      +   '<Default Extension="xml" ContentType="application/xml"/>'
      +   '<Default Extension="png" ContentType="image/png"/>'
      +   '<Default Extension="jpg" ContentType="image/jpeg"/>'
      +   '<Default Extension="jpeg" ContentType="image/jpeg"/>'
      +   '<Default Extension="gif" ContentType="image/gif"/>'
      +   '<Override PartName="/word/document.xml" ContentType="' + DOC_CT + '"/>'
      +   '<Override PartName="/word/numbering.xml" ContentType="' + NUMBERING_CT + '"/>'
      +   '<Override PartName="/word/footnotes.xml" ContentType="' + FOOTNOTES_CT + '"/>'
      + '</Types>';
  }

  function buildRootRelsXml() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="' + REL_NS + '">'
      +   '<Relationship Id="rId1" Type="' + OFFICE_DOC_REL + '" Target="word/document.xml"/>'
      + '</Relationships>';
  }

  function buildDocumentRelsXml(ctx) {
    // Numbering + footnotes are always present (rId2 / rId3 reserved) so
    // list paragraphs and footnote refs can name them unconditionally.
    let body = ''
      + '<Relationship Id="rId2" Type="' + NUMBERING_REL + '" Target="numbering.xml"/>'
      + '<Relationship Id="rId3" Type="' + FOOTNOTES_REL + '" Target="footnotes.xml"/>';
    for (const r of ctx.relationships) {
      const mode = r.mode ? ' TargetMode="' + r.mode + '"' : '';
      const target = r.mode ? escXml(r.target) : r.target;
      body += '<Relationship Id="' + r.id + '" Type="' + r.type + '"'
            + ' Target="' + target + '"' + mode + '/>';
    }
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="' + REL_NS + '">' + body + '</Relationships>';
  }

  async function buildDocxBlob(article) {
    if (!window.JSZip) throw new Error('JSZip not available');
    const imageMap = await prefetchImages(article);
    const mermaidPngMap = await prefetchMermaid(article);
    // Pre-index footnote bodies by id so the walker can resolve refs
    // without doing one document.getElementById per <sup>.
    const footnoteLisById = new Map();
    const fnSection = article.querySelector('section.footnotes, section[data-footnotes]');
    if (fnSection) {
      const lis = fnSection.querySelectorAll('li[id]');
      for (const li of lis) footnoteLisById.set(li.id, li);
    }
    const ctx = newDocxCtx(imageMap, mermaidPngMap, footnoteLisById);

    const documentXml = buildDocumentXml(article, ctx);

    const zip = new window.JSZip();
    zip.file('[Content_Types].xml', buildContentTypesXml());
    zip.folder('_rels').file('.rels', buildRootRelsXml());
    const wordDir = zip.folder('word');
    wordDir.file('document.xml', documentXml);
    // document.xml.rels is required whenever document.xml references rIds.
    // Always emit (even if empty) -- Word silently tolerates either way and
    // unconditional emission keeps the structure consistent.
    wordDir.folder('_rels').file('document.xml.rels', buildDocumentRelsXml(ctx));
    wordDir.file('numbering.xml', buildNumberingXml(ctx));
    wordDir.file('footnotes.xml', buildFootnotesXml(ctx));
    if (ctx.media.length > 0) {
      const mediaDir = wordDir.folder('media');
      for (const item of ctx.media) {
        mediaDir.file(item.name, item.bytes);
      }
    }
    return zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoke async so the click has time to start the download.
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function suggestFilename() {
    let base;
    try {
      base = decodeURIComponent(
        (window.location.pathname.split('/').pop() || 'document').split('?')[0].split('#')[0]
      );
    } catch (e) {
      base = 'document';
    }
    base = base.replace(/\.(md|markdown|mdown)$/i, '') || 'document';
    return base + '.docx';
  }

  async function exportToWord(article, filename) {
    const blob = await buildDocxBlob(article);
    triggerDownload(blob, filename || suggestFilename());
  }

  window.MarkdownStudio = window.MarkdownStudio || {};
  window.MarkdownStudio.exportToWord = exportToWord;
})();
