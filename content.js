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

  /** Insert a one-line tip pointing users at the file-URL permission
   *  toggle in chrome://extensions. Shown only on http(s) renders --
   *  if the user is already on a file:// page, the access is by
   *  definition enabled and there's nothing to remind them about.
   *  Dismissal persists in localStorage so a tip appears at most once
   *  per user-per-origin. Hidden in print via @media print rule. */
  const FILE_TIP_KEY = 'md-viewer-file-tip-dismissed-v1';
  function maybeMountFileAccessTip(host) {
    try {
      const proto = window.location.protocol;
      if (proto !== 'http:' && proto !== 'https:') return;
      if (window.localStorage && window.localStorage.getItem(FILE_TIP_KEY)) return;
    } catch (e) { /* localStorage blocked => still show; that's fine */ }
    const bar = document.createElement('div');
    bar.className = 'md-file-tip';
    bar.setAttribute('role', 'status');
    const icon = document.createElement('span');
    icon.className = 'md-file-tip-icon';
    icon.textContent = 'i';
    icon.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'md-file-tip-text';
    text.appendChild(document.createTextNode('Local '));
    const codeMd = document.createElement('code');
    codeMd.textContent = '.md';
    text.appendChild(codeMd);
    text.appendChild(document.createTextNode(' files won’t render until you enable '));
    const strong = document.createElement('strong');
    strong.textContent = 'Allow access to file URLs';
    text.appendChild(strong);
    text.appendChild(document.createTextNode(' on this extension’s details page at '));
    const codeUrl = document.createElement('code');
    codeUrl.textContent = 'chrome://extensions';
    text.appendChild(codeUrl);
    text.appendChild(document.createTextNode('.'));
    const close = document.createElement('button');
    close.className = 'md-file-tip-close';
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    close.addEventListener('click', () => {
      try { if (window.localStorage) window.localStorage.setItem(FILE_TIP_KEY, '1'); }
      catch (e) { /* swallow -- next page load will re-show; acceptable */ }
      bar.remove();
    });
    bar.appendChild(icon);
    bar.appendChild(text);
    bar.appendChild(close);
    host.insertBefore(bar, host.firstChild);
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
    maybeMountFileAccessTip(document.body);
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

    // Render any mermaid diagrams asynchronously. Stash sources +
    // article reference so the PDF print buttons can re-render with
    // a different theme later without re-parsing the .md.
    if (mermaidSources.length > 0) {
      _mermaidSources = mermaidSources;
      _mermaidArticle = article;
      renderMermaidDiagrams(article, mermaidSources, screenMermaidTheme())
        .catch((e) => console.warn('[md-viewer] mermaid render failed:', e));
    }
  }

  // Expose the print-time rerender entry to lib/toc.js's print buttons.
  // Defined here (not in render.js / toc.js) because content.js owns the
  // mermaid lifecycle and the source cache. Also expose:
  //   - getRawMarkdown(): for the editor to seed its textarea with the
  //     original .md text. Cached from the initial pass so it's still
  //     available after document.body gets replaced.
  //   - renderMermaidInto(article, sources): editor preview's mermaid
  //     renderer, calls the same pipeline as initial render with the
  //     current screen theme.
  let _cachedRawMarkdown = '';
  function exposeMermaidRerender() {
    if (window.MdViewer) {
      window.MdViewer.rerenderMermaidForTheme = rerenderMermaidForTheme;
      window.MdViewer.getRawMarkdown = () => _cachedRawMarkdown;
      window.MdViewer.renderMermaidInto = (article, sources) =>
        renderMermaidDiagrams(article, sources, screenMermaidTheme());
    }
  }

  // Module-scoped state used by the rerender path (PDF print button).
  // _mermaidSources keeps the source markdown for each diagram so we can
  // ask mermaid to re-render with a different theme without re-parsing
  // the whole .md document. _mermaidArticle is the live host element.
  let _mermaidSources = [];
  let _mermaidArticle = null;

  /** Initialise mermaid with a theme name and re-render all placeholders
   *  using the cached sources. Returns when every diagram has finished
   *  rendering (or failed). Safe to call repeatedly; the call is a no-op
   *  when there are no diagrams. */
  async function renderMermaidDiagrams(article, sources, theme) {
    if (typeof mermaid === 'undefined' || !mermaid.initialize) return;
    const placeholders = article.querySelectorAll('.md-mermaid[data-mermaid-id]');
    if (placeholders.length === 0) return;
    mermaid.initialize({
      startOnLoad: false,
      theme,
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
      // Salt the id so successive renders don't collide (mermaid keeps a
      // module-level registry of rendered diagram ids).
      const renderId = 'md-mermaid-' + idx + '-' + i + '-' + Date.now();
      try {
        const { svg } = await mermaid.render(renderId, src);
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

  /** Return the theme name mermaid should use for the current screen
   *  scheme (i.e. the on-load default). */
  function screenMermaidTheme() {
    const dark = window.matchMedia &&
                 window.matchMedia('(prefers-color-scheme: dark)').matches;
    return dark ? 'dark' : 'default';
  }

  /** Public entry for the print button: re-render every diagram with the
   *  requested theme ('light' / 'dark' / 'screen'). With 'screen' we use
   *  whatever matchMedia(prefers-color-scheme) currently reports, which
   *  lets the afterprint handler easily restore the on-screen theme.
   *  CSS-only attempts to recolour mermaid output for print were unable
   *  to reach every span/tspan reliably; a real re-render is the only
   *  bulletproof path. */
  async function rerenderMermaidForTheme(mode) {
    if (!_mermaidArticle || _mermaidSources.length === 0) return;
    const theme = mode === 'light' ? 'default'
                 : mode === 'dark' ? 'dark'
                 : screenMermaidTheme();
    await renderMermaidDiagrams(_mermaidArticle, _mermaidSources, theme);
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
    // Cache so the editor module can re-seed its textarea later, even
    // after document.body's original <pre> has been swapped out.
    _cachedRawMarkdown = md;
    // Inject KaTeX / highlight CSS up front to avoid a flash of unstyled
    // math when rendering completes.
    await Promise.all([
      injectExtensionCSS('vendor/katex.min.css'),
      injectExtensionCSS('vendor/highlight-monokai.css'),
    ]);
    try {
      renderInto(md);
      // Expose the mermaid re-render entry for the PDF buttons in toc.js
      // after the article + sources are populated.
      exposeMermaidRerender();
    } catch (e) {
      console.error('[md-viewer] render failed:', e);
    }
  }

  // At document_end the DOM is already in place.
  main();
})();
