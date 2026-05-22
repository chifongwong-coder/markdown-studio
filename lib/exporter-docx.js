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
  function mathmlToOmml(mathElement) {
    if (!window.MathML2OMML || !window.MathML2OMML.mml2omml) return '';
    let mml = mathElement.outerHTML;
    mml = stripUnsupportedMathMLElements(mml);
    mml = normalizeMathVariants(mml);
    mml = preserveMtextBoundarySpace(mml);
    let omml;
    // mml2omml emits `Type not supported: <tag>` via console.warn for tags it
    // skips (annotation, mpadded, semantics styling, etc.). These are
    // intentional skips -- annotation is the LaTeX source preserved for
    // a11y, mpadded is fine-grained spacing OMML doesn't need. For a
    // math-heavy article it fills DevTools with ~60 'errors' and the
    // chrome://extensions page surfaces them as runtime errors against
    // the extension. Stub both warn and log around the call; real
    // exceptions still go through the catch and our own warn below.
    const _warn = console.warn;
    const _log = console.log;
    console.warn = function () {};
    console.log = function () {};
    try {
      omml = window.MathML2OMML.mml2omml(mml);
    } catch (e) {
      console.warn = _warn;
      console.log = _log;
      _warn.call(console, '[markdown-studio] mml2omml failed:', e);
      return '';
    }
    console.warn = _warn;
    console.log = _log;
    omml = escapeMTextInOMML(omml);
    omml = fixEmptyNary(omml);
    omml = restoreSentinelSpaces(omml);
    omml = stripInvisibleMathOperators(omml);
    omml = stripOmmlNamespaceDecl(omml);
    return omml;
  }

  // ---- OOXML helpers -------------------------------------------------------

  function escXml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Build one <w:r> with optional formatting.
  function makeRun(text, fmt) {
    fmt = fmt || {};
    const parts = [];
    if (fmt.bold || fmt.italic || fmt.monospace || fmt.size || fmt.shade) {
      parts.push('<w:rPr>');
      if (fmt.bold) parts.push('<w:b/>');
      if (fmt.italic) parts.push('<w:i/>');
      if (fmt.monospace) parts.push(
        '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/>'
      );
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
  // possibly mixed with raw <m:oMath> for inline math).
  function walkInline(el, fmt) {
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
          appendAll(out, walkInline(node, Object.assign({}, fmt, { bold: true })));
        } else if (tag === 'em' || tag === 'i') {
          appendAll(out, walkInline(node, Object.assign({}, fmt, { italic: true })));
        } else if (tag === 'code') {
          appendAll(out, walkInline(node, Object.assign({}, fmt, { monospace: true })));
        } else if (tag === 'a') {
          // v1: render link text only, no hyperlink. Real <w:hyperlink>
          // requires a relationship entry; defer to M2.
          appendAll(out, walkInline(node, fmt));
        } else if (tag === 'sup') {
          // Footnote markers and similar. v1: just inline the text.
          appendAll(out, walkInline(node, fmt));
        } else if (tag === 'br') {
          out.push('<w:r><w:br/></w:r>');
        } else if (node.classList && node.classList.contains('katex')) {
          // Inline math: emit raw <m:oMath> sibling to <w:r>s inside the <w:p>.
          const mathEl = node.querySelector('.katex-mathml math');
          if (mathEl) {
            const omml = mathmlToOmml(mathEl);
            if (omml) out.push(omml);
          }
        } else {
          // Anything else: descend, picking up text content.
          appendAll(out, walkInline(node, fmt));
        }
      }
    }
    return out;
  }

  function appendAll(target, parts) {
    for (let i = 0; i < parts.length; i++) target.push(parts[i]);
  }

  function blockToParagraphs(el) {
    const tag = el.tagName.toLowerCase();

    // --- headings ---
    if (/^h[1-6]$/.test(tag)) {
      const lvl = +tag[1];
      const size = HEADING_SIZES[lvl];
      const runs = walkInline(el, { bold: true, size: size });
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
      const runs = walkInline(el);
      return [makeParagraph(runs)];
    }

    // --- preformatted code blocks ---
    if (tag === 'pre') {
      const codeEl = el.querySelector('code') || el;
      const text = codeEl.textContent || '';
      // One paragraph per logical line, monospace, light-grey shaded.
      const lines = text.split('\n');
      // Don't render a trailing empty line for the common "ends with newline" case.
      while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      return lines.map(function (line) {
        const runs = [makeRun(line || ' ', { monospace: true, shade: 'F4F4F4' })];
        return makeParagraph(runs);
      });
    }

    // --- lists (fake bullets/numbers via prefix; proper numbering deferred) ---
    if (tag === 'ul' || tag === 'ol') {
      const isOl = (tag === 'ol');
      const out = [];
      let n = 1;
      for (let i = 0; i < el.children.length; i++) {
        const li = el.children[i];
        if (li.tagName.toLowerCase() !== 'li') continue;
        const prefix = isOl ? (n + '. ') : '• ';
        n += 1;
        const runs = [makeRun(prefix)].concat(walkInline(li));
        out.push(makeParagraph(runs));
      }
      return out;
    }

    // --- blockquote -> one paragraph per child, italic prefix ---
    if (tag === 'blockquote') {
      const out = [];
      for (let i = 0; i < el.children.length; i++) {
        const sub = el.children[i];
        const runs = walkInline(sub, { italic: true });
        out.push(makeParagraph([makeRun('“', { italic: true })].concat(runs)
          .concat([makeRun('”', { italic: true })])));
      }
      return out;
    }

    // --- horizontal rule ---
    if (tag === 'hr') {
      return ['<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr></w:p>'];
    }

    // --- tables ---
    if (tag === 'table') {
      // Empty paragraph after the table -- Word otherwise can't park the
      // cursor below the table, and some renderers complain about a body
      // that ends with <w:tbl>.
      return [buildTable(el), '<w:p/>'];
    }

    // --- images: deferred to M2b ---
    if (tag === 'figure' || tag === 'img') {
      return [makeParagraph([makeRun('[image omitted in v1]', { italic: true })])];
    }

    // --- fallback: walk inline ---
    const runs = walkInline(el);
    return runs.length ? [makeParagraph(runs)] : [];
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
  function buildTable(tableEl) {
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
        const runs = walkInline(cell, fmt);
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
  const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
  const OFFICE_DOC_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
  const DOC_CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';

  function buildDocumentXml(article) {
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
      const ps = blockToParagraphs(child);
      for (let j = 0; j < ps.length; j++) paragraphs.push(ps[j]);
    }
    const body = paragraphs.join('');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:document xmlns:w="' + W_NS + '" xmlns:m="' + M_NS + '">'
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
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="' + CT_NS + '">'
      +   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      +   '<Default Extension="xml" ContentType="application/xml"/>'
      +   '<Override PartName="/word/document.xml" ContentType="' + DOC_CT + '"/>'
      + '</Types>';
  }

  function buildRootRelsXml() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="' + REL_NS + '">'
      +   '<Relationship Id="rId1" Type="' + OFFICE_DOC_REL + '" Target="word/document.xml"/>'
      + '</Relationships>';
  }

  async function buildDocxBlob(article) {
    if (!window.JSZip) throw new Error('JSZip not available');
    const zip = new window.JSZip();
    zip.file('[Content_Types].xml', buildContentTypesXml());
    zip.folder('_rels').file('.rels', buildRootRelsXml());
    zip.folder('word').file('document.xml', buildDocumentXml(article));
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
