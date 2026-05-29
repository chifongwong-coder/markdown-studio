// Comments mode: let the reader select any span of rendered text (a single
// character, a symbol, or a whole paragraph), attach a short text comment to
// it, and download all comments as a sidecar `.comments.md` file WITHOUT
// touching the original markdown. The sidecar records, per comment, the
// selected quote, surrounding context, the nearest heading, and the comment
// body -- enough for a reader or tool to locate the passage in the source.
//
// Design decisions (settled with the user):
//   * Highlight: CSS Custom Highlight API (CSS.highlights + ::highlight()),
//     so the article DOM is never mutated -- Word/PDF export and the editor
//     keep working untouched. Rendered as a dashed underline (colour comes
//     from --md-comment-dash: blue on light, yellow on dark). Browsers
//     without the API simply show no underline; everything else still works.
//   * Anchoring: W3C-style text anchor -- exact quote + prefix/suffix context
//     + nearest heading + a char offset into the article's textContent. No
//     attempt at fragile markdown source byte offsets; the quote + heading is
//     plenty for "locate or quote the passage elsewhere".
//   * Persistence: comments are saved in localStorage keyed by the page URL
//     (sans #fragment), so they survive reload until the user deletes them.
//
// Public API (on window.MarkdownStudio):
//   mountComments(article)
//     Wire up selection handling, restore any saved comments, render their
//     highlights, and mount the bottom-right launcher. Idempotent.

(function () {
  'use strict';

  // Characters of context captured on either side of the quote. Used both to
  // re-locate the passage when the exact offset drifts and to give the
  // downloaded sidecar enough surrounding text to disambiguate.
  const CONTEXT_LEN = 40;
  const HL_NAME = 'md-comment';

  let _idCounter = 0;
  function newId() {
    return 'c' + Date.now().toString(36) + '-' + (_idCounter++).toString(36);
  }

  /** The rendered article, or null if it isn't in the DOM (e.g. while the
   *  editor is mounted -- it detaches the article). */
  function getArticle() {
    return document.body.querySelector('article.markdown-studio-content');
  }

  /** Guess the source filename from the URL, mirroring editor.js. */
  function filenameFromUrl() {
    try {
      const path = new URL(location.href).pathname;
      const base = path.split('/').pop() || '';
      if (/\.(md|markdown|mdown)$/i.test(base)) return base;
    } catch (e) { /* fall through */ }
    return 'document.md';
  }

  // ---- Persistence ---------------------------------------------------------

  function storageKey() {
    return 'markdown-studio-comments::' + location.href.split('#')[0];
  }
  /** In-memory list of comment records. Each: {id, quote, prefix, suffix,
   *  startOffset, endOffset, heading:{id,text}|null, body, createdAt}.
   *  `_range` and `orphan` are runtime-only and not persisted. */
  let comments = [];
  function loadComments() {
    try {
      const raw = localStorage.getItem(storageKey());
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function saveComments() {
    try {
      // Strip runtime-only fields before persisting.
      const slim = comments.map((c) => ({
        id: c.id, quote: c.quote, prefix: c.prefix, suffix: c.suffix,
        startOffset: c.startOffset, endOffset: c.endOffset,
        heading: c.heading, body: c.body, createdAt: c.createdAt,
      }));
      localStorage.setItem(storageKey(), JSON.stringify(slim));
    } catch (e) { /* storage blocked -- comments stay in memory this session */ }
  }

  // ---- Text <-> Range mapping ---------------------------------------------

  /** Global character offset of a range's start/end within article.textContent.
   *  Uses Range.toString(), which concatenates the same raw text-node data
   *  textContent does, so the two index spaces line up exactly. */
  function rangeOffsets(article, range) {
    const pre = document.createRange();
    pre.selectNodeContents(article);
    pre.setEnd(range.startContainer, range.startOffset);
    const start = pre.toString().length;
    const len = range.toString().length;
    return { start, end: start + len };
  }

  /** Build a Range spanning [start,end) in article.textContent index space by
   *  walking text nodes and accumulating lengths. Returns null if the offsets
   *  fall outside the current text (e.g. content changed). */
  function offsetToRange(article, start, end) {
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT, null);
    const range = document.createRange();
    let pos = 0, node, haveStart = false, haveEnd = false;
    while ((node = walker.nextNode())) {
      const len = node.nodeValue.length;
      if (!haveStart && start <= pos + len) {
        range.setStart(node, start - pos);
        haveStart = true;
      }
      if (haveStart && !haveEnd && end <= pos + len) {
        range.setEnd(node, end - pos);
        haveEnd = true;
        break;
      }
      pos += len;
    }
    return (haveStart && haveEnd) ? range : null;
  }

  /** Nearest heading at or before the range start, for the sidecar's
   *  "Section:" line and the panel list. */
  function nearestHeading(article, range) {
    const heads = article.querySelectorAll('h1, h2, h3, h4, h5, h6');
    let best = null;
    heads.forEach((h) => {
      const rel = h.compareDocumentPosition(range.startContainer);
      // h is before (or contains) the selection start.
      if (h.contains(range.startContainer) || (rel & Node.DOCUMENT_POSITION_FOLLOWING)) {
        best = h;
      }
    });
    return best ? { id: best.id || '', text: (best.textContent || '').trim() } : null;
  }

  /** Re-find a saved comment's passage in the current article. Strategy:
   *  (1) trust the stored offset if the text still matches; (2) search for
   *  prefix+quote+suffix; (3) fall back to the occurrence of the bare quote
   *  closest to the old offset. Returns a Range or null (orphaned). */
  function locate(article, c) {
    const text = article.textContent;
    if (text.slice(c.startOffset, c.endOffset) === c.quote) {
      return offsetToRange(article, c.startOffset, c.endOffset);
    }
    if (c.quote) {
      const withCtx = c.prefix + c.quote + c.suffix;
      const i = text.indexOf(withCtx);
      if (i >= 0) {
        const s = i + c.prefix.length;
        return offsetToRange(article, s, s + c.quote.length);
      }
      // Bare-quote occurrences, pick the one nearest the original offset.
      let from = 0, k, best = -1;
      while ((k = text.indexOf(c.quote, from)) >= 0) {
        if (best < 0 || Math.abs(k - c.startOffset) < Math.abs(best - c.startOffset)) best = k;
        from = k + 1;
      }
      if (best >= 0) return offsetToRange(article, best, best + c.quote.length);
    }
    return null;
  }

  // ---- Highlight rendering -------------------------------------------------

  const supportsHighlight = (typeof Highlight !== 'undefined') &&
                            (typeof CSS !== 'undefined') && !!CSS.highlights;

  /** Re-locate every comment and rebuild the single shared Highlight. Sets
   *  c._range (live Range) and c.orphan (couldn't be located) as a side
   *  effect -- the panel and edit-on-click use these. */
  function renderHighlights() {
    const article = getArticle();
    if (!article) return;
    const hl = supportsHighlight ? new Highlight() : null;
    comments.forEach((c) => {
      const r = locate(article, c);
      if (r) { c._range = r; c.orphan = false; if (hl) hl.add(r); }
      else { c._range = null; c.orphan = true; }
    });
    if (supportsHighlight) CSS.highlights.set(HL_NAME, hl);
  }

  // ---- Add button (floating over a fresh selection) ------------------------

  let addBtn = null;
  let pendingRange = null;

  function ensureAddButton() {
    if (addBtn) return addBtn;
    addBtn = document.createElement('button');
    addBtn.className = 'md-comment-add';
    addBtn.type = 'button';
    addBtn.textContent = '💬 Comment';
    addBtn.title = 'Add a comment on the selected text';
    addBtn.style.display = 'none';
    addBtn.addEventListener('mousedown', (e) => {
      // mousedown (not click): clicking would first collapse the selection.
      e.preventDefault();
      e.stopPropagation();
      if (pendingRange) startNewComment(pendingRange);
      hideAddButton();
    });
    document.body.appendChild(addBtn);
    return addBtn;
  }

  function hideAddButton() {
    if (addBtn) addBtn.style.display = 'none';
    pendingRange = null;
  }

  /** Show the add button just above the current selection, if it's a
   *  non-empty range inside the article and not inside our own UI. */
  function updateAddButton() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return hideAddButton();
    const range = sel.getRangeAt(0);
    const article = getArticle();
    if (!article || !article.contains(range.commonAncestorContainer)) return hideAddButton();
    if (!sel.toString().trim()) return hideAddButton();
    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return hideAddButton();
    pendingRange = range.cloneRange();
    const btn = ensureAddButton();
    btn.style.display = 'block';
    // Position above the selection; clamp into the viewport. Measured after
    // display so offsetWidth/Height are real.
    const top = rect.top - btn.offsetHeight - 8;
    let left = rect.left + rect.width / 2 - btn.offsetWidth / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - btn.offsetWidth - 8));
    btn.style.top = (top < 8 ? rect.bottom + 8 : top) + 'px';
    btn.style.left = left + 'px';
  }

  // ---- Comment popover (create / edit) -------------------------------------

  let popover = null;

  function closePopover() {
    if (popover) { popover.remove(); popover = null; }
  }

  /** Open the editing popover near `rect`. `existing` is the comment being
   *  edited, or null when creating a new one; `draft` carries the pending
   *  anchor fields for a new comment. */
  function openPopover(rect, existing, draft) {
    closePopover();
    popover = document.createElement('div');
    popover.className = 'md-comment-popover';

    const quoteEl = document.createElement('div');
    quoteEl.className = 'md-comment-quote';
    quoteEl.textContent = (existing ? existing.quote : draft.quote) || '';

    const ta = document.createElement('textarea');
    ta.className = 'md-comment-input';
    ta.placeholder = 'Add a comment…';
    ta.value = existing ? existing.body : '';
    ta.rows = 3;

    const actions = document.createElement('div');
    actions.className = 'md-comment-actions';

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'md-comment-save';
    save.textContent = 'Save';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'md-comment-cancel';
    cancel.textContent = 'Cancel';

    actions.appendChild(save);
    if (existing) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'md-comment-delete';
      del.textContent = 'Delete';
      del.addEventListener('click', () => {
        comments = comments.filter((c) => c.id !== existing.id);
        afterChange();
        closePopover();
      });
      actions.appendChild(del);
    }
    actions.appendChild(cancel);

    popover.appendChild(quoteEl);
    popover.appendChild(ta);
    popover.appendChild(actions);
    document.body.appendChild(popover);

    // Position near the anchor, clamped to the viewport.
    let top = rect.bottom + 8;
    let left = rect.left;
    left = Math.max(8, Math.min(left, window.innerWidth - popover.offsetWidth - 8));
    if (top + popover.offsetHeight > window.innerHeight - 8) {
      top = Math.max(8, rect.top - popover.offsetHeight - 8);
    }
    popover.style.top = top + 'px';
    popover.style.left = left + 'px';

    save.addEventListener('click', () => {
      const body = ta.value.trim();
      if (!body) { ta.focus(); return; }
      if (existing) {
        existing.body = body;
      } else {
        comments.push({
          id: newId(),
          quote: draft.quote,
          prefix: draft.prefix,
          suffix: draft.suffix,
          startOffset: draft.startOffset,
          endOffset: draft.endOffset,
          heading: draft.heading,
          body,
          createdAt: new Date().toISOString(),
        });
      }
      afterChange();
      closePopover();
    });
    cancel.addEventListener('click', closePopover);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closePopover(); }
      // Cmd/Ctrl+Enter saves.
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save.click(); }
    });
    ta.focus();
  }

  /** Capture anchor fields from a fresh selection range, then open the
   *  create popover. */
  function startNewComment(range) {
    const article = getArticle();
    if (!article) return;
    const { start, end } = rangeOffsets(article, range);
    const text = article.textContent;
    const draft = {
      quote: text.slice(start, end),
      prefix: text.slice(Math.max(0, start - CONTEXT_LEN), start),
      suffix: text.slice(end, end + CONTEXT_LEN),
      startOffset: start,
      endOffset: end,
      heading: nearestHeading(article, range),
    };
    if (!draft.quote) return;
    openPopover(range.getBoundingClientRect(), null, draft);
  }

  // ---- Bottom-right launcher + panel --------------------------------------

  let fab = null;
  let panel = null;

  function ensureFab() {
    if (fab) return;
    fab = document.createElement('button');
    fab.className = 'md-comment-fab';
    fab.type = 'button';
    fab.title = 'Comments';
    fab.setAttribute('aria-label', 'Open comments panel');
    fab.addEventListener('click', togglePanel);
    document.body.appendChild(fab);
    updateFab();
  }

  function updateFab() {
    if (!fab) return;
    fab.textContent = '💬 ' + comments.length;
  }

  function togglePanel() {
    if (panel) { panel.remove(); panel = null; return; }
    buildPanel();
  }

  function buildPanel() {
    panel = document.createElement('div');
    panel.className = 'md-comment-panel';

    const header = document.createElement('div');
    header.className = 'md-comment-panel-header';
    const title = document.createElement('span');
    title.textContent = 'Comments (' + comments.length + ')';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'md-comment-panel-close';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    close.addEventListener('click', togglePanel);
    header.appendChild(title);
    header.appendChild(close);

    const list = document.createElement('div');
    list.className = 'md-comment-list';
    if (comments.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'md-comment-empty';
      empty.textContent = 'Select any text in the document to add a comment.';
      list.appendChild(empty);
    } else {
      comments.forEach((c, i) => list.appendChild(buildListItem(c, i)));
    }

    const footer = document.createElement('div');
    footer.className = 'md-comment-panel-footer';
    const dl = document.createElement('button');
    dl.type = 'button';
    dl.className = 'md-comment-download';
    dl.textContent = 'Download comments';
    dl.disabled = comments.length === 0;
    dl.addEventListener('click', downloadComments);
    footer.appendChild(dl);

    panel.appendChild(header);
    panel.appendChild(list);
    panel.appendChild(footer);
    document.body.appendChild(panel);
  }

  function refreshPanel() {
    if (panel) { panel.remove(); panel = null; buildPanel(); }
  }

  function buildListItem(c, i) {
    const item = document.createElement('div');
    item.className = 'md-comment-item' + (c.orphan ? ' md-comment-item-orphan' : '');

    const quote = document.createElement('div');
    quote.className = 'md-comment-item-quote';
    quote.textContent = '“' + (c.quote.length > 60 ? c.quote.slice(0, 60) + '…' : c.quote) + '”';

    const body = document.createElement('div');
    body.className = 'md-comment-item-body';
    body.textContent = c.body;

    item.appendChild(quote);
    item.appendChild(body);

    if (c.heading && c.heading.text) {
      const sec = document.createElement('div');
      sec.className = 'md-comment-item-section';
      sec.textContent = c.heading.text;
      item.appendChild(sec);
    }
    if (c.orphan) {
      const warn = document.createElement('div');
      warn.className = 'md-comment-item-warn';
      warn.textContent = 'Passage not found on this page';
      item.appendChild(warn);
    }

    // Click a list item -> scroll to the passage and open its editor.
    item.addEventListener('click', () => {
      if (c._range) {
        const node = c._range.startContainer;
        const target = node.nodeType === 1 ? node : node.parentElement;
        if (target && target.scrollIntoView) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        // Open the editor after the scroll using the (now on-screen) rect.
        setTimeout(() => openPopover(c._range.getBoundingClientRect(), c, null), 350);
      } else {
        // Orphaned: edit anchored to the panel item itself.
        openPopover(item.getBoundingClientRect(), c, null);
      }
    });
    return item;
  }

  /** Recompute highlights + UI after any change, and persist. */
  function afterChange() {
    saveComments();
    renderHighlights();
    updateFab();
    refreshPanel();
  }

  // ---- Download (sidecar .comments.md) ------------------------------------

  function sidecarName() {
    const base = filenameFromUrl().replace(/\.(md|markdown|mdown)$/i, '');
    return (base || 'document') + '.comments.md';
  }

  function buildSidecar() {
    const lines = [];
    lines.push('# Comments on ' + filenameFromUrl());
    lines.push('');
    lines.push('> ' + comments.length + ' comment(s). Generated by Markdown Studio. ' +
               'The original file is unchanged.');
    lines.push('');
    comments.forEach((c, i) => {
      lines.push('## Comment ' + (i + 1));
      lines.push('');
      if (c.heading && c.heading.text) lines.push('- **Section:** ' + c.heading.text);
      lines.push('- **Quote:** ' + JSON.stringify(c.quote));
      const ctx = (c.prefix ? '…' + c.prefix : '') + '【' + c.quote + '】' +
                  (c.suffix ? c.suffix + '…' : '');
      lines.push('- **Context:** ' + ctx.replace(/\s+/g, ' ').trim());
      lines.push('- **Char range:** ' + c.startOffset + '–' + c.endOffset +
                 ' (rendered text)');
      if (c.orphan) {
        lines.push('- **Note:** this passage was not found on the current page; ' +
                   'the document may have changed since the comment was made.');
      }
      lines.push('- **Comment:**');
      lines.push('');
      c.body.split('\n').forEach((l) => lines.push('  ' + l));
      lines.push('');
    });
    return lines.join('\n');
  }

  /** Save via the File System Access API (native Save As), mirroring
   *  editor.js. Falls back to a Blob download. */
  async function saveWithPicker(text, suggestedName) {
    if (typeof window.showSaveFilePicker !== 'function') return false;
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      return true;
    } catch (e) {
      if (e && e.name === 'AbortError') return true;
      return false;
    }
  }

  function downloadAsFile(text, name) {
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function downloadComments() {
    if (comments.length === 0) return;
    const text = buildSidecar();
    const name = sidecarName();
    const saved = await saveWithPicker(text, name);
    if (!saved) downloadAsFile(text, name);
  }

  // ---- Edit-on-click over an existing highlight ----------------------------

  /** Clicking dashed-underlined text opens its comment for editing. The
   *  Custom Highlight API doesn't make highlights hit-testable, so we map the
   *  click point to a caret offset and test it against each comment's range. */
  function onArticleClick(e) {
    if (e.target.closest('a')) return; // let links navigate
    const article = getArticle();
    if (!article) return;
    if (typeof document.caretRangeFromPoint !== 'function') return;
    const caret = document.caretRangeFromPoint(e.clientX, e.clientY);
    if (!caret || !article.contains(caret.startContainer)) return;
    const pre = document.createRange();
    pre.selectNodeContents(article);
    pre.setEnd(caret.startContainer, caret.startOffset);
    const off = pre.toString().length;
    const hit = comments.find((c) => !c.orphan && off >= c.startOffset && off < c.endOffset);
    if (hit && hit._range) {
      e.preventDefault();
      openPopover(hit._range.getBoundingClientRect(), hit, null);
    }
  }

  // ---- Mount ---------------------------------------------------------------

  let _mounted = false;
  function mountComments(article) {
    if (_mounted) return; // idempotent (bfcache / double-render guard)
    if (!article) return;
    _mounted = true;

    comments = loadComments();
    renderHighlights();
    ensureFab();

    // Show the add button after a selection settles. mouseup covers
    // drag-select; keyup covers shift-arrow keyboard selection.
    const onSelect = () => setTimeout(updateAddButton, 0);
    document.addEventListener('mouseup', onSelect);
    document.addEventListener('keyup', (e) => {
      if (e.shiftKey || e.key === 'Shift') onSelect();
    });

    // Dismiss the add button when the user clicks away into empty space.
    document.addEventListener('mousedown', (e) => {
      if (addBtn && !addBtn.contains(e.target)) {
        // Defer: a click that starts a new selection should still re-show it.
        setTimeout(() => {
          const sel = window.getSelection();
          if (!sel || sel.isCollapsed) hideAddButton();
        }, 0);
      }
      if (popover && !popover.contains(e.target) &&
          !(addBtn && addBtn.contains(e.target))) {
        // Close the popover when clicking outside it (but not on a fresh
        // selection inside the article -- that re-anchors via the add button).
        if (!e.target.closest('.md-comment-item')) closePopover();
      }
    });

    article.addEventListener('click', onArticleClick);
  }

  window.MarkdownStudio = window.MarkdownStudio || {};
  window.MarkdownStudio.mountComments = mountComments;
})();
