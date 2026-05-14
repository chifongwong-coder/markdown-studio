// Injection entry point: grab the raw markdown text the page is displaying,
// run it through the render pipeline, and replace the page body with the
// rendered HTML.
//
// Chrome's default behavior for .md files is to serve them as text/plain,
// wrapping the file content in <body><pre>...</pre></body>. We only take over
// when the page looks like that plain-text view. If a server pre-rendered the
// markdown to HTML (which would have many body children), we leave it alone
// so we don't trash the user's content.

(function () {
  'use strict';

  /** Decide whether this page is Chrome's default text/plain markdown view.
   *  We only take over if the URL really looks like a Markdown file or the
   *  Content-Type is text/markdown / text/plain — otherwise some other
   *  extension (or server-rendered HTML) might already own the page. */
  function isMarkdownUrl() {
    try {
      const path = new URL(location.href).pathname.toLowerCase();
      return /\.(md|markdown|mdown)$/.test(path);
    } catch (e) {
      return false;
    }
  }
  function isMarkdownLike() {
    if (isMarkdownUrl()) return true;
    const ct = (document.contentType || '').toLowerCase();
    return ct === 'text/markdown' || ct === 'text/x-markdown';
  }

  function getRawMarkdown() {
    if (!isMarkdownLike()) return null;
    const body = document.body;
    if (!body) return null;

    // Typical shape: <body><pre>...</pre></body>, possibly with stray whitespace.
    const pre = body.querySelector(':scope > pre');
    if (pre && body.children.length === 1) {
      return pre.textContent || '';
    }

    // Less common: content sitting directly on body.
    if (body.children.length === 0) {
      const text = body.textContent || '';
      if (text.trim().length > 0) return text;
    }

    return null;
  }

  /** Resolve a packaged asset URL, or null if the extension context has
   *  been invalidated (e.g. the user just disabled or updated the extension
   *  while the page is still open). */
  function extensionAsset(path) {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
        return null;
      }
      return chrome.runtime.getURL(path);
    } catch (e) {
      return null;
    }
  }

  /** Replace the page's favicon with our bundled icon. Necessary because
   *  Chrome caches favicons keyed by URL and may continue showing an old
   *  icon set by a previously-installed Markdown extension even after that
   *  extension is uninstalled. Explicitly setting a new <link rel="icon">
   *  overrides the cached entry. */
  function setFavicon() {
    const url = extensionAsset('icons/48.png');
    if (!url) return;
    document.querySelectorAll('link[rel~="icon"]').forEach((l) => l.remove());
    const link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/png';
    link.href = url;
    (document.head || document.documentElement).appendChild(link);
  }

  /** Insert a <base href> matching the document URL so relative paths in
   *  the rendered markdown (most commonly <img src="./pic.png">) keep
   *  resolving correctly after we replace document.body's contents.
   *  No-op when a <base> already exists. */
  function ensureBaseHref() {
    if (document.querySelector('base[href]')) return;
    const base = document.createElement('base');
    // Strip the fragment so relative anchor links (`<a href="#section">`)
    // resolve against the document URL itself, not URL#fragment.
    base.href = location.href.split('#')[0];
    const head = document.head || document.documentElement;
    head.insertBefore(base, head.firstChild);
  }

  function renderInto(md) {
    const result = window.MdViewer.renderMarkdown(md);
    // renderMarkdown switched in v0.3 to returning {html, mermaidSources}.
    // Earlier versions returned a bare string; keep a shim for safety.
    const html = typeof result === 'string' ? result : result.html;
    const mermaidSources = (result && result.mermaidSources) || [];

    // Wrap in <article> so CSS can target our root easily.
    const article = document.createElement('article');
    article.className = 'md-viewer-content';
    article.innerHTML = html;

    // Insert <base href="..."> so relative image / link paths in the
    // rendered markdown resolve against the original document URL even
    // after we replace document.body.
    ensureBaseHref();

    document.body.innerHTML = '';
    document.body.appendChild(article);
    document.body.classList.add('md-viewer-body');
    setFavicon();

    // Syntax highlighting.
    window.MdViewer.highlightCode(article);

    // Wrap each table in a scrollable container so wide tables on narrow
    // viewports scroll horizontally inside the table area instead of pushing
    // the whole article off-screen.
    article.querySelectorAll('table').forEach((tbl) => {
      if (tbl.parentElement && tbl.parentElement.classList.contains('md-table-wrap')) return;
      const wrap = document.createElement('div');
      wrap.className = 'md-table-wrap';
      tbl.parentNode.insertBefore(wrap, tbl);
      wrap.appendChild(tbl);
    });

    // Use the first h1 as the document title when available.
    const h1 = article.querySelector('h1');
    if (h1) {
      const t = h1.textContent.trim();
      if (t) document.title = t;
    }

    // Mount the sidebar TOC (auto-skips when fewer than 2 headings).
    if (window.MdViewer.mountTOC) {
      try { window.MdViewer.mountTOC(article); }
      catch (e) { console.warn('[md-viewer] TOC mount failed:', e); }
    }

    // Render any mermaid diagrams asynchronously.
    if (mermaidSources.length > 0) {
      renderMermaidDiagrams(article, mermaidSources).catch((e) =>
        console.warn('[md-viewer] mermaid render failed:', e));
    }
  }

  /** Find <div class="md-mermaid" data-mermaid-id> placeholders inserted by
   *  the renderer and ask the bundled mermaid library to fill each with an
   *  SVG diagram. Theme follows the user's system color-scheme. */
  async function renderMermaidDiagrams(article, sources) {
    if (typeof mermaid === 'undefined' || !mermaid.initialize) return;
    const placeholders = article.querySelectorAll('.md-mermaid[data-mermaid-id]');
    if (placeholders.length === 0) return;
    const dark = window.matchMedia &&
                 window.matchMedia('(prefers-color-scheme: dark)').matches;
    mermaid.initialize({
      startOnLoad: false,
      theme: dark ? 'dark' : 'default',
      // 'strict' makes mermaid HTML-escape labels and refuses any HTML inside
      // text labels. Mermaid also runs DOMPurify on its own output before
      // returning the SVG string.
      securityLevel: 'strict',
    });
    let i = 0;
    for (const el of placeholders) {
      // Defensive: only honor numeric ids. /^\d+$/ rejects "<svg>" / "0x1"
      // and other coerce-to-number tricks a hostile markdown could plant in
      // a placeholder smuggled past sanitize.
      const idStr = el.dataset.mermaidId;
      if (!/^\d+$/.test(idStr)) continue;
      const idx = parseInt(idStr, 10);
      const src = sources[idx - 1];
      if (!src) continue;
      // Tab navigation / bfcache eviction may have detached the article
      // before we get here. Don't write innerHTML into a stranded node.
      if (!el.isConnected) continue;
      i += 1;
      try {
        const { svg } = await mermaid.render('md-mermaid-' + idx + '-' + i, src);
        if (!el.isConnected) continue;
        // Second-pass sanitize: mermaid runs DOMPurify internally with its
        // own allowlist, but a future CVE could slip through. We re-run with
        // the SVG-friendly profile so any unexpected <script> or event
        // handler gets stripped before insertion.
        const safe = (typeof DOMPurify !== 'undefined')
          ? DOMPurify.sanitize(svg, {
              USE_PROFILES: { svg: true, svgFilters: true },
              ADD_TAGS: ['foreignObject'],
              FORBID_ATTR: ['onload', 'onclick', 'onerror', 'onmouseover'],
            })
          : svg;
        el.innerHTML = safe;
      } catch (e) {
        const msg = String(e && e.message || e).slice(0, 200);
        if (!el.isConnected) continue;
        el.textContent = 'Mermaid error: ' + msg;
        el.classList.add('md-mermaid-error');
      }
    }
  }

  /** Inject a stylesheet bundled with the extension via chrome.runtime.getURL,
   *  so relative urls inside the CSS resolve under chrome-extension://<id>/...
   *  rather than the current document's file:// origin. */
  function injectExtensionCSS(path) {
    return new Promise((resolve) => {
      const url = extensionAsset(path);
      if (!url) { resolve(); return; }
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = url;
      link.onload = () => resolve();
      link.onerror = () => resolve(); // Press on even if a stylesheet fails.
      (document.head || document.documentElement).appendChild(link);
    });
  }

  async function main() {
    // Idempotency: if we (or a bfcache restore) have already rendered this
    // page, skip. document.body carries the .md-viewer-body marker class
    // exactly when render succeeded.
    if (document.body && document.body.classList.contains('md-viewer-body')) {
      return;
    }
    const md = getRawMarkdown();
    if (!md) return;
    // Inject KaTeX / highlight CSS up front to avoid a flash of unstyled
    // math when rendering completes.
    await Promise.all([
      injectExtensionCSS('vendor/katex.min.css'),
      injectExtensionCSS('vendor/highlight-monokai.css'),
    ]);
    try {
      renderInto(md);
    } catch (e) {
      console.error('[md-viewer] render failed:', e);
    }
  }

  // At document_end the DOM is already in place.
  main();
})();
