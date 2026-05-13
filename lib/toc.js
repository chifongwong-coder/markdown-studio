// Collapsible TOC sidebar: scans the article for h1–h6, slugifies them into
// anchor IDs, builds a nested <nav>, and wires up per-item collapse,
// smooth-scroll on click, and scroll-driven active-section highlight.

(function () {
  'use strict';

  /** Honor the user's reduced-motion setting for scroll animations. */
  function prefersReducedMotion() {
    return !!(window.matchMedia &&
              window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /** Slugify heading text into an anchor id. Preserves common East-Asian
   *  scripts (CJK Unified Ideographs + Extension A, Hiragana, Katakana,
   *  Hangul syllables) so headings written in Chinese / Japanese / Korean
   *  produce readable anchor URLs. */
  function slugify(text) {
    return (text || '')
      .toLowerCase()
      .trim()
      .replace(/[\s\t\n]+/g, '-')
      .replace(/[^\w\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /** Assign unique ids to every h1–h6 in `article` and return a flat list. */
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
      // Respect an existing id if present.
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

  /** Build the nested <ul> sidebar with a stack-based walker. */
  function buildSidebar(items) {
    const nav = document.createElement('nav');
    nav.className = 'md-toc';
    nav.id = 'md-toc';
    nav.setAttribute('aria-label', 'Table of contents');

    const header = document.createElement('div');
    header.className = 'md-toc-header';
    // Use a heading element so screen readers announce it as a landmark
    // heading and JAWS/VoiceOver "next heading" navigation lands here.
    const title = document.createElement('h2');
    title.className = 'md-toc-title';
    title.textContent = 'Contents';
    header.appendChild(title);

    const toggleAll = document.createElement('button');
    toggleAll.className = 'md-toc-toggle-all';
    toggleAll.type = 'button';
    toggleAll.title = 'Collapse / expand all';
    toggleAll.setAttribute('aria-label', 'Collapse or expand all sections');
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
      caret.setAttribute('aria-label', 'Toggle subsection');
      // Default expanded; click handler keeps this in sync with .md-toc-collapsed.
      caret.setAttribute('aria-expanded', 'true');
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
        if (li) {
          li.classList.toggle('md-toc-collapsed');
          t.setAttribute('aria-expanded',
            li.classList.contains('md-toc-collapsed') ? 'false' : 'true');
        }
      } else if (t.classList.contains('md-toc-link')) {
        e.preventDefault();
        const href = t.getAttribute('href');
        // Use getElementById, not querySelector: CSS selectors disallow ids
        // starting with a digit, but HTML id attributes allow it (e.g. "1-intro").
        const id = href ? href.slice(1) : '';
        const dest = id && document.getElementById(id);
        if (dest) {
          dest.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
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
          const caret = li.querySelector(':scope > .md-toc-row > .md-toc-caret');
          if (caret) caret.setAttribute('aria-expanded', anyExpanded ? 'false' : 'true');
        });
      }
    });
  }

  /** Hide or show the whole sidebar. State persists per origin via localStorage. */
  const STORAGE_KEY = 'md-viewer-toc-hidden';
  function setSidebarHidden(hidden) {
    document.body.classList.toggle('md-toc-hidden', hidden);
    syncHandleAria(hidden);
    try { localStorage.setItem(STORAGE_KEY, hidden ? '1' : '0'); } catch (e) {}
  }
  function loadSidebarHidden() {
    try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch (e) { return false; }
  }

  /** Keep the « / » handles' ARIA state in sync with the visible one so screen
   *  readers don't announce both buttons or focus the hidden one. */
  function syncHandleAria(hidden) {
    const hide = document.querySelector('.md-toc-hide');
    const show = document.querySelector('.md-toc-handle');
    if (hide) {
      hide.setAttribute('aria-hidden', hidden ? 'true' : 'false');
      hide.tabIndex = hidden ? -1 : 0;
    }
    if (show) {
      show.setAttribute('aria-hidden', hidden ? 'false' : 'true');
      show.tabIndex = hidden ? 0 : -1;
    }
  }

  /** Two floating tabs vertically centered on screen: a « hide handle
   *  (attached to the TOC's right edge) and a » show handle (resting on the
   *  screen's left edge). They fade in/out symmetrically. */
  function buildHandles() {
    const hide = document.createElement('button');
    hide.className = 'md-toc-hide';
    hide.type = 'button';
    hide.title = 'Hide outline';
    hide.setAttribute('aria-label', 'Hide outline');
    hide.setAttribute('aria-controls', 'md-toc');
    hide.setAttribute('aria-expanded', 'true');
    hide.textContent = '«';
    hide.addEventListener('click', () => setSidebarHidden(true));

    const show = document.createElement('button');
    show.className = 'md-toc-handle';
    show.type = 'button';
    show.title = 'Show outline';
    show.setAttribute('aria-label', 'Show outline');
    show.setAttribute('aria-controls', 'md-toc');
    show.setAttribute('aria-expanded', 'false');
    show.textContent = '»';
    show.addEventListener('click', () => setSidebarHidden(false));

    return [hide, show];
  }

  /** Highlight the current section as the user scrolls, and keep the TOC's
   *  scroll position in sync so the active item stays visible.
   *
   *  Uses IntersectionObserver instead of a scroll listener so cost is
   *  O(visible-headings) per frame regardless of document size. */
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
      // Expand any collapsed ancestor of the active item.
      let li = link.closest('.md-toc-item');
      while (li) {
        li.classList.remove('md-toc-collapsed');
        const caret = li.querySelector(':scope > .md-toc-row > .md-toc-caret');
        if (caret) caret.setAttribute('aria-expanded', 'true');
        li = li.parentElement && li.parentElement.closest('.md-toc-item');
      }
      // Keep the active link visible inside the TOC viewport.
      const linkRect = link.getBoundingClientRect();
      const navRect = nav.getBoundingClientRect();
      if (linkRect.top < navRect.top + 30 || linkRect.bottom > navRect.bottom - 30) {
        link.scrollIntoView({ block: 'nearest' });
      }
    }

    if (!('IntersectionObserver' in window)) {
      setActive(items[0].id);
      return;
    }

    // A heading counts as "active" while its top edge sits in the upper 25%
    // of the viewport. When more than one heading is in that band (subsections
    // close together) the earliest in document order wins.
    const visibleIds = new Set();
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const id = entry.target.id;
        if (entry.isIntersecting) visibleIds.add(id);
        else visibleIds.delete(id);
      }
      const first = items.find((it) => visibleIds.has(it.id));
      if (first) setActive(first.id);
    }, { rootMargin: '0px 0px -75% 0px', threshold: 0 });

    items.forEach((it) => io.observe(it.el));
  }

  /** Entry point: scan `article`, build and mount the TOC, wire interactions. */
  function mountTOC(article) {
    // Idempotency guard: a second call would otherwise append a second <nav>
    // and a duplicate scroll listener.
    if (document.querySelector('nav.md-toc')) return null;
    const items = annotateHeadings(article);
    if (items.length < 2) return null; // Not worth a TOC for one heading.
    const nav = buildSidebar(items);
    attachInteractions(nav);
    document.body.appendChild(nav);
    buildHandles().forEach((b) => document.body.appendChild(b));
    document.body.classList.add('md-viewer-with-toc');
    const hidden = loadSidebarHidden();
    if (hidden) document.body.classList.add('md-toc-hidden');
    syncHandleAria(hidden);
    setupActiveTracking(items, nav);
    return nav;
  }

  window.MdViewer = window.MdViewer || {};
  window.MdViewer.mountTOC = mountTOC;
})();
