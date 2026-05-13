// 注入入口：从页面里抓取原始 markdown 文本，跑渲染流水线，把页面替换成 HTML。
//
// Chrome 默认行为：把 .md 文件当 text/plain 显示——内容包在 <body><pre>...</pre></body> 里。
// 我们只在「页面看起来是纯文本展示」时才接管；如果服务器已经返回了渲染好的 HTML（比如
// GitHub raw 之外的 markdown 站），就什么都不做，避免破坏用户内容。

(function () {
  'use strict';

  /** 判断当前页面是不是 Chrome 默认的 text/plain markdown 展示。 */
  function getRawMarkdown() {
    const body = document.body;
    if (!body) return null;

    // 典型形态：<body><pre>...</pre></body>，可能 body 还有空白文本节点
    const pre = body.querySelector(':scope > pre');
    if (pre && body.children.length === 1) {
      return pre.textContent || '';
    }

    // 另一种可能：内容直接挂在 body 上（很少见）
    if (body.children.length === 0) {
      const text = body.textContent || '';
      if (text.trim().length > 0) return text;
    }

    return null;
  }

  function renderInto(md) {
    const html = window.MdViewer.renderMarkdown(md);

    // 用 article 包裹便于 CSS 定位
    const article = document.createElement('article');
    article.className = 'md-viewer-content';
    article.innerHTML = html;

    document.body.innerHTML = '';
    document.body.appendChild(article);
    document.body.classList.add('md-viewer-body');

    // 代码高亮
    window.MdViewer.highlightCode(article);

    // 修正 <title>：用第一个 h1 作为标题（如果有）
    const h1 = article.querySelector('h1');
    if (h1) {
      const t = h1.textContent.trim();
      if (t) document.title = t;
    }
  }

  /** 运行时注入扩展内的 CSS（用 chrome.runtime.getURL，让 CSS 内的相对 URL
   *  正确解析到 chrome-extension://<id>/...，而不是当前文档所在的 file://...）。 */
  function injectExtensionCSS(path) {
    return new Promise((resolve) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = chrome.runtime.getURL(path);
      link.onload = () => resolve();
      link.onerror = () => resolve(); // 失败也继续，至少能用系统字体兜底
      (document.head || document.documentElement).appendChild(link);
    });
  }

  async function main() {
    const md = getRawMarkdown();
    if (!md) return;
    // 先把 KaTeX / 代码高亮的 CSS 准备好，避免渲染后字体 FOUC
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

  // document_end 时 DOM 已就绪
  main();
})();
