// 可伸缩侧栏目录（TOC）：扫描文章里的 h1–h6，生成 slug ID，
// 构建嵌套 <nav>，支持折叠/展开、点击平滑滚动、滚动联动高亮当前章节。

(function () {
  'use strict';

  /** 把标题文本转成 slug（保留中文）。 */
  function slugify(text) {
    return (text || '')
      .toLowerCase()
      .trim()
      .replace(/[\s\t\n]+/g, '-')
      .replace(/[^\w一-鿿㐀-䶿-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /** 为文章里的 h1–h6 分配唯一 id，并返回平铺列表。 */
  function annotateHeadings(article) {
    const headings = article.querySelectorAll('h1, h2, h3, h4, h5, h6');
    const used = new Map();
    const items = [];
    headings.forEach((h) => {
      let base = slugify(h.textContent || '');
      if (!base) base = 'section';
      const count = used.get(base) || 0;
      const slug = count === 0 ? base : `${base}-${count}`;
      used.set(base, count + 1);
      // 如果原 HTML 已经有 id 就尊重它，否则赋值
      if (!h.id) h.id = slug;
      items.push({
        level: parseInt(h.tagName.slice(1), 10),
        text: h.textContent || '',
        id: h.id,
        el: h,
      });
    });
    return items;
  }

  /** 用栈构建嵌套 <ul> 结构。 */
  function buildSidebar(items) {
    const nav = document.createElement('nav');
    nav.className = 'md-toc';
    nav.setAttribute('aria-label', 'Table of contents');

    const header = document.createElement('div');
    header.className = 'md-toc-header';
    const title = document.createElement('span');
    title.className = 'md-toc-title';
    title.textContent = '目录';
    header.appendChild(title);

    const toggleAll = document.createElement('button');
    toggleAll.className = 'md-toc-toggle-all';
    toggleAll.type = 'button';
    toggleAll.title = '折叠 / 展开全部';
    toggleAll.setAttribute('aria-label', '折叠 / 展开全部');
    toggleAll.textContent = '⇅';
    header.appendChild(toggleAll);
    nav.appendChild(header);

    const rootList = document.createElement('ul');
    rootList.className = 'md-toc-list';
    nav.appendChild(rootList);

    const stack = [{ level: 0, ul: rootList }];
    for (const item of items) {
      while (stack.length > 1 && stack[stack.length - 1].level >= item.level) {
        stack.pop();
      }
      const parent = stack[stack.length - 1].ul;

      const li = document.createElement('li');
      li.className = `md-toc-item md-toc-level-${item.level}`;

      const row = document.createElement('span');
      row.className = 'md-toc-row';

      const caret = document.createElement('button');
      caret.className = 'md-toc-caret';
      caret.type = 'button';
      caret.setAttribute('aria-label', '折叠 / 展开');
      row.appendChild(caret);

      const link = document.createElement('a');
      link.className = 'md-toc-link';
      link.href = `#${item.id}`;
      link.textContent = item.text;
      row.appendChild(link);

      li.appendChild(row);
      parent.appendChild(li);

      const childUl = document.createElement('ul');
      childUl.className = 'md-toc-children';
      li.appendChild(childUl);
      stack.push({ level: item.level, ul: childUl });
    }

    return nav;
  }

  function attachInteractions(nav) {
    nav.addEventListener('click', (e) => {
      const t = e.target;
      if (t.classList.contains('md-toc-caret')) {
        const li = t.closest('.md-toc-item');
        if (li) li.classList.toggle('md-toc-collapsed');
      } else if (t.classList.contains('md-toc-link')) {
        e.preventDefault();
        const href = t.getAttribute('href');
        // 用 getElementById 而非 querySelector：CSS 选择器不允许 ID 以数字开头，
        // 但 HTML id 属性本身允许（如 "1-背景"）。
        const id = href ? href.slice(1) : '';
        const dest = id && document.getElementById(id);
        if (dest) {
          dest.scrollIntoView({ behavior: 'smooth', block: 'start' });
          history.replaceState(null, '', href);
        }
      } else if (t.classList.contains('md-toc-toggle-all')) {
        const items = nav.querySelectorAll('.md-toc-item');
        const anyExpanded = Array.from(items).some(
          (li) => !li.classList.contains('md-toc-collapsed') &&
                  li.querySelector(':scope > .md-toc-children > .md-toc-item')
        );
        items.forEach((li) => {
          if (anyExpanded) li.classList.add('md-toc-collapsed');
          else li.classList.remove('md-toc-collapsed');
        });
      }
    });
  }

  /** 滚动时高亮当前章节，并让 TOC 自动滚到可见位置。 */
  function setupActiveTracking(items, nav) {
    if (items.length === 0) return;
    const linkById = new Map();
    nav.querySelectorAll('.md-toc-link').forEach((a) => {
      linkById.set(a.getAttribute('href').slice(1), a);
    });

    let lastActiveId = null;
    function setActive(id) {
      if (id === lastActiveId) return;
      lastActiveId = id;
      nav.querySelectorAll('.md-toc-link.md-toc-active').forEach((a) =>
        a.classList.remove('md-toc-active'));
      const link = linkById.get(id);
      if (!link) return;
      link.classList.add('md-toc-active');
      // 折叠时自动展开包含此 link 的父链
      let li = link.closest('.md-toc-item');
      while (li) {
        li.classList.remove('md-toc-collapsed');
        li = li.parentElement && li.parentElement.closest('.md-toc-item');
      }
      // 让 link 在 TOC 内可见
      const linkRect = link.getBoundingClientRect();
      const navRect = nav.getBoundingClientRect();
      if (linkRect.top < navRect.top + 30 || linkRect.bottom > navRect.bottom - 30) {
        link.scrollIntoView({ block: 'nearest' });
      }
    }

    function update() {
      const threshold = 100; // viewport 顶部 100px 处的标题视为当前
      let active = items[0];
      for (const it of items) {
        if (it.el.getBoundingClientRect().top <= threshold) active = it;
        else break;
      }
      setActive(active.id);
    }

    let ticking = false;
    window.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        update();
        ticking = false;
      });
    }, { passive: true });
    update();
  }

  /** 入口：扫描 article，构建并挂载 TOC，配置交互。 */
  function mountTOC(article) {
    const items = annotateHeadings(article);
    if (items.length < 2) return null; // 标题太少不值得
    const nav = buildSidebar(items);
    attachInteractions(nav);
    document.body.appendChild(nav);
    document.body.classList.add('md-viewer-with-toc');
    setupActiveTracking(items, nav);
    return nav;
  }

  window.MdViewer = window.MdViewer || {};
  window.MdViewer.mountTOC = mountTOC;
})();
