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

  /** Replace the page's favicon with our bundled icon. Necessary because
   *  Chrome caches favicons in its local Favicons database and may continue
   *  showing an old icon set by a previously-installed Markdown extension
   *  even after that extension is uninstalled. Explicitly setting a new
   *  <link rel="icon"> overrides the cached entry. */
  function setFavicon() {
    document.querySelectorAll('link[rel~="icon"]').forEach((l) => l.remove());
    const link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/png';
    link.href = chrome.runtime.getURL('icons/48.png');
    (document.head || document.documentElement).appendChild(link);
  }

  function renderInto(md) {
    const html = window.MdViewer.renderMarkdown(md);

    // Wrap in <article> so CSS can target our root easily.
    const article = document.createElement('article');
    article.className = 'md-viewer-content';
    article.innerHTML = html;

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
  }

  /** Inject a stylesheet bundled with the extension via chrome.runtime.getURL,
   *  so relative urls inside the CSS resolve under chrome-extension://<id>/...
   *  rather than the current document's file:// origin. */
  function injectExtensionCSS(path) {
    return new Promise((resolve) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = chrome.runtime.getURL(path);
      link.onload = () => resolve();
      link.onerror = () => resolve(); // Press on even if a stylesheet fails.
      (document.head || document.documentElement).appendChild(link);
    });
  }

  async function main() {
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
