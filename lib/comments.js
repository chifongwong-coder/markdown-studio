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
//     from --md-comment-dash: teal on light, yellow on dark).
//     NOTE: the dashed underline only paints on Chrome 124+ (the Highlight
//     API itself shipped in 105; painting text-decoration inside ::highlight()
//     landed in 124). minimum_chrome_version stays at 88 deliberately: on
//     older Chrome the underline simply doesn't show, but everything else
//     (create / list / edit / download / persistence) still works. The
//     missing underline is an accepted cosmetic gap, not a broken feature.
//   * Anchoring: W3C-style text anchor -- exact quote + prefix/suffix context
//     + nearest heading + a char offset into the article's textContent. No
//     fragile markdown source byte offsets; the quote + heading is plenty for
//     "locate or quote the passage elsewhere".
//   * Persistence is split by protocol, to sidestep the fact that
//     localStorage is origin-scoped (not path-scoped or secret) -- on a
//     shared http(s) host any same-origin page script could otherwise read
//     or forge another document's annotations:
//       - file://  -> persisted in localStorage keyed by path. The whole
//                     file:// origin is effectively the single local user,
//                     so this is safe and survives reloads.
//       - http(s) -> kept in memory ONLY. Nothing is written to or read
//                     from page storage, so no same-origin script can see or
//                     tamper with comments. Trade-off: comments are
//                     session-only and vanish on refresh.
//
// Public API (on window.MarkdownStudio):
//   mountComments(article)          wire everything up (idempotent)
//   refreshCommentHighlights()      re-anchor + repaint (called after async
//                                   mermaid render shifts rendered-text offsets)

(function () {
  'use strict';

  // Characters of context captured on either side of the quote.
  const CONTEXT_LEN = 40;
  const HL_NAME = 'md-comment';
  // Below this length a quote is too generic to re-anchor by bare-text search
  // without risking attaching the comment to the wrong occurrence.
  const MIN_UNIQUE_QUOTE = 12;

  let _idCounter = 0;
  function newId() {
    return 'c' + Date.now().toString(36) + '-' + (_idCounter++).toString(36);
  }

  /** Small debounce so high-frequency selectionchange events don't thrash. */
  function debounce(fn, ms) {
    let t = null;
    return function () { if (t) clearTimeout(t); t = setTimeout(fn, ms); };
  }

  /** The READER article -- a direct child of <body>. Scoped with ':scope >' so
   *  we never resolve to the editor's live-preview article (same class, but
   *  nested inside .md-editor). During edit mode the reader article is
   *  detached, so this returns null and the comment handlers safely no-op. */
  function getArticle() {
    return document.body.querySelector(':scope > article.markdown-studio-content');
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

  // Persist to localStorage only for local files; web pages stay in-memory.
  const IS_LOCAL = location.protocol === 'file:';

  /** Key by origin + pathname only (drop query AND fragment): the same file
   *  served with a cache-buster (?v=2) shouldn't fragment its comments. Only
   *  used on file:// (see IS_LOCAL). */
  function storageKey() {
    try {
      const u = new URL(location.href);
      return 'markdown-studio-comments::' + u.origin + u.pathname;
    } catch (e) {
      return 'markdown-studio-comments::' + location.href.split(/[?#]/)[0];
    }
  }

  /** In-memory list of comment records. Each persisted field: {id, quote,
   *  prefix, suffix, startOffset, endOffset, heading:{id,text}|null, body,
   *  createdAt}. Runtime-only (not persisted): _range, orphan, _liveStart,
   *  _liveEnd. */
  let comments = [];

  /** Reject malformed/hostile records rather than feeding them to the offset
   *  math, the panel renderer, or the sidecar export. */
  function isValidRecord(c) {
    return !!c && typeof c === 'object' &&
      typeof c.quote === 'string' &&
      typeof c.prefix === 'string' && typeof c.suffix === 'string' &&
      typeof c.body === 'string' &&
      Number.isInteger(c.startOffset) && c.startOffset >= 0 &&
      Number.isInteger(c.endOffset) && c.endOffset >= c.startOffset &&
      (c.heading == null ||
        (typeof c.heading === 'object' &&
         typeof c.heading.id === 'string' && typeof c.heading.text === 'string'));
  }

  function loadComments() {
    if (!IS_LOCAL) return []; // web pages: in-memory only, nothing persisted
    try {
      const raw = localStorage.getItem(storageKey());
      if (!raw) return [];
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr.filter(isValidRecord).map((c) => ({
        id: typeof c.id === 'string' ? c.id : newId(),
        quote: c.quote, prefix: c.prefix, suffix: c.suffix,
        startOffset: c.startOffset, endOffset: c.endOffset,
        heading: c.heading || null, body: c.body,
        createdAt: typeof c.createdAt === 'string' ? c.createdAt : '',
      }));
    } catch (e) { return []; }
  }

  function saveComments() {
    if (!IS_LOCAL) return; // web pages: in-memory only, never touch page storage
    try {
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

  /** Build a one-shot index of the article's text nodes: {text, nodes, length}
   *  where nodes is a contiguous, document-ordered array of {node, start, len}.
   *  Computing this ONCE per renderHighlights (instead of reading textContent
   *  and re-walking the tree per comment) keeps re-anchoring O(comments x
   *  log nodes) rather than O(comments x textLength). */
  function buildTextIndex(article) {
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT, null);
    const nodes = [];
    let pos = 0, node;
    while ((node = walker.nextNode())) {
      const len = node.nodeValue.length;
      nodes.push({ node, start: pos, len });
      pos += len;
    }
    return { text: article.textContent, nodes, length: pos };
  }

  /** First node index whose [start, start+len] span reaches `target`. Binary
   *  search; matches the original linear scan's boundary rule (a target at an
   *  exact node boundary binds to the earlier node at offset == len). */
  function nodeIndexAt(nodes, target) {
    let lo = 0, hi = nodes.length - 1, ans = nodes.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (nodes[mid].start + nodes[mid].len >= target) { ans = mid; hi = mid - 1; }
      else lo = mid + 1;
    }
    return ans;
  }

  /** Build a Range spanning [start,end) using the prebuilt index. */
  function offsetToRange(idx, start, end) {
    const nodes = idx.nodes;
    if (!nodes.length) return null;
    if (start < 0 || end > idx.length || end < start) return null;
    const si = nodeIndexAt(nodes, start);
    const ei = nodeIndexAt(nodes, end);
    const range = document.createRange();
    range.setStart(nodes[si].node, start - nodes[si].start);
    range.setEnd(nodes[ei].node, end - nodes[ei].start);
    return range;
  }

  /** Nearest heading at or before the range start. Headings come back from
   *  querySelectorAll in document order, so we keep the last one that precedes
   *  the selection start and break as soon as one follows it. */
  function nearestHeading(article, range) {
    const heads = article.querySelectorAll('h1, h2, h3, h4, h5, h6');
    let best = null;
    for (const h of heads) {
      const rel = h.compareDocumentPosition(range.startContainer);
      if (h.contains(range.startContainer) || (rel & Node.DOCUMENT_POSITION_FOLLOWING)) {
        best = h; // h precedes (or contains) the selection start
      } else {
        break;    // document order: everything after here follows the selection
      }
    }
    return best ? { id: best.id || '', text: (best.textContent || '').trim() } : null;
  }

  function isUnique(text, q) {
    return text.indexOf(q) === text.lastIndexOf(q);
  }

  /** Re-find a saved comment's passage in the current article (idx is the
   *  prebuilt text index). (1) trust the stored offset if the text still
   *  matches; (2) search prefix+quote+suffix; (3) ONLY for a long-or-unique
   *  quote, fall back to the occurrence nearest the old offset. A short or
   *  repeated quote is left to orphan rather than silently mis-attached. */
  function locate(idx, c) {
    const text = idx.text;
    if (text.slice(c.startOffset, c.endOffset) === c.quote) {
      return offsetToRange(idx, c.startOffset, c.endOffset);
    }
    if (c.quote) {
      const withCtx = c.prefix + c.quote + c.suffix;
      const i = text.indexOf(withCtx);
      if (i >= 0) {
        const s = i + c.prefix.length;
        return offsetToRange(idx, s, s + c.quote.length);
      }
      if (c.quote.length >= MIN_UNIQUE_QUOTE || isUnique(text, c.quote)) {
        let from = 0, k, best = -1;
        while ((k = text.indexOf(c.quote, from)) >= 0) {
          if (best < 0 || Math.abs(k - c.startOffset) < Math.abs(best - c.startOffset)) best = k;
          from = k + 1;
        }
        if (best >= 0) return offsetToRange(idx, best, best + c.quote.length);
      }
    }
    return null;
  }

  // ---- Highlight rendering -------------------------------------------------

  const supportsHighlight = (typeof Highlight !== 'undefined') &&
                            (typeof CSS !== 'undefined') && !!CSS.highlights;

  /** Re-locate every comment and rebuild the single shared Highlight. Sets the
   *  runtime fields c._range, c.orphan, and c._liveStart/_liveEnd (the offsets
   *  of the *resolved* range, which may differ from the persisted ones after
   *  content drift -- used for click hit-testing). */
  function renderHighlights() {
    const article = getArticle();
    if (!article) return;
    const idx = buildTextIndex(article);
    const hl = supportsHighlight ? new Highlight() : null;
    comments.forEach((c) => {
      const r = locate(idx, c);
      if (r) {
        c._range = r;
        c.orphan = false;
        const lo = rangeOffsets(article, r);
        c._liveStart = lo.start;
        c._liveEnd = lo.end;
        if (hl) hl.add(r);
      } else {
        c._range = null;
        c.orphan = true;
        c._liveStart = c._liveEnd = -1;
      }
    });
    if (supportsHighlight) CSS.highlights.set(HL_NAME, hl);
  }

  // ---- Add button (floating over a fresh selection) ------------------------

  let addBtn = null;
  let pendingRange = null;
  let _addBtnSize = null; // cached {w,h}; the label is constant so size is stable

  function activateAddButton(e) {
    // mousedown/touchstart (not click): a click would first collapse the
    // selection. preventDefault keeps the selection alive.
    e.preventDefault();
    e.stopPropagation();
    if (pendingRange) startNewComment(pendingRange);
    hideAddButton();
  }

  function ensureAddButton() {
    if (addBtn) return addBtn;
    addBtn = document.createElement('button');
    addBtn.className = 'md-comment-add';
    addBtn.type = 'button';
    addBtn.textContent = '💬 Comment';
    addBtn.title = 'Add a comment on the selected text';
    addBtn.style.display = 'none';
    addBtn.addEventListener('mousedown', activateAddButton);
    addBtn.addEventListener('touchstart', activateAddButton, { passive: false });
    document.body.appendChild(addBtn);
    return addBtn;
  }

  function hideAddButton() {
    if (addBtn) addBtn.style.display = 'none';
    pendingRange = null;
  }

  /** The selection as a single Range spanning all of it (covers multi-range
   *  selections, e.g. multi-cell table selection). Returns null if collapsed,
   *  empty, or outside the reader article. */
  function selectionRange() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const article = getArticle();
    if (!article) return null;
    const first = sel.getRangeAt(0);
    const last = sel.getRangeAt(sel.rangeCount - 1);
    if (!article.contains(first.commonAncestorContainer)) return null;
    let range;
    try {
      range = document.createRange();
      range.setStart(first.startContainer, first.startOffset);
      range.setEnd(last.endContainer, last.endOffset);
      if (range.collapsed) range = first.cloneRange();
    } catch (e) {
      range = first.cloneRange();
    }
    if (!range.toString().trim()) return null;
    return range;
  }

  /** Show the add button just above the current selection. */
  function updateAddButton() {
    if (document.body.classList.contains('md-editing')) return hideAddButton();
    const range = selectionRange();
    if (!range) return hideAddButton();
    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return hideAddButton();
    pendingRange = range.cloneRange();
    const btn = ensureAddButton();
    btn.style.display = 'block';
    if (!_addBtnSize) _addBtnSize = { w: btn.offsetWidth, h: btn.offsetHeight };
    const bw = _addBtnSize.w, bh = _addBtnSize.h;
    let left = rect.left + rect.width / 2 - bw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - bw - 8));
    const above = rect.top - bh - 8;
    let top = above < 8 ? rect.bottom + 8 : above;
    // Don't cover the sticky file-tip banner if it's at the top of the page.
    const tip = document.querySelector('.md-file-tip');
    if (tip) {
      const tr = tip.getBoundingClientRect();
      if (top < tr.bottom && rect.bottom + 8 + bh < window.innerHeight) {
        top = Math.max(top, rect.bottom + 8);
      }
    }
    btn.style.top = top + 'px';
    btn.style.left = left + 'px';
  }

  // ---- Comment popover (create / edit) -------------------------------------

  let popover = null;
  let _popoverOpener = null;

  function restoreFocus(el) {
    if (el && el.isConnected && typeof el.focus === 'function') {
      try { el.focus(); } catch (e) { /* ignore */ }
    }
  }

  function closePopover() {
    if (popover) { popover.remove(); popover = null; }
    const opener = _popoverOpener;
    _popoverOpener = null;
    restoreFocus(opener);
  }

  /** Keep Tab focus inside `container`. */
  function trapFocus(container, e) {
    if (e.key !== 'Tab') return;
    const f = container.querySelectorAll(
      'textarea, button, a[href], input, select, [tabindex]:not([tabindex="-1"])');
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  /** Open the editing popover near `rect`. `existing` is the comment being
   *  edited, or null when creating; `draft` carries the pending anchor for a
   *  new comment. `opener` (optional) gets focus back when the popover closes. */
  function openPopover(rect, existing, draft, opener) {
    closePopover();
    _popoverOpener = (opener && opener.isConnected) ? opener : null;

    popover = document.createElement('div');
    popover.className = 'md-comment-popover';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-modal', 'true');
    popover.setAttribute('aria-label', existing ? 'Edit comment' : 'Add comment');

    const quoteEl = document.createElement('div');
    quoteEl.className = 'md-comment-quote';
    quoteEl.textContent = (existing ? existing.quote : draft.quote) || '';

    const ta = document.createElement('textarea');
    ta.className = 'md-comment-input';
    ta.placeholder = 'Add a comment...';
    ta.value = existing ? existing.body : '';
    ta.rows = 3;
    ta.setAttribute('aria-label', 'Comment text');

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

    // Esc (from anywhere in the dialog) closes; Cmd/Ctrl+Enter saves; Tab is
    // trapped within the dialog.
    popover.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closePopover(); return; }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save.click(); return; }
      trapFocus(popover, e);
    });
    ta.focus();
  }

  /** Capture anchor fields from a fresh selection range, then open the create
   *  popover. */
  function startNewComment(range, opener) {
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
    openPopover(range.getBoundingClientRect(), null, draft, opener);
  }

  // ---- Bottom-right launcher + panel --------------------------------------

  let fab = null;
  let panel = null;
  // Panel sub-element refs + id->element map for incremental updates.
  let panelListEl = null;
  let panelCountEl = null;
  let panelDownloadBtn = null;
  const itemEls = new Map();

  function ensureFab() {
    if (fab) return;
    fab = document.createElement('button');
    fab.className = 'md-comment-fab';
    fab.type = 'button';
    fab.title = 'Comments';
    fab.setAttribute('aria-label', 'Open comments panel');
    fab.setAttribute('aria-expanded', 'false');
    fab.addEventListener('click', togglePanel);
    document.body.appendChild(fab);
    updateFab();
  }

  function updateFab() {
    if (!fab) return;
    fab.textContent = '💬 ' + comments.length;
  }

  function togglePanel() {
    if (panel) {
      panel.remove();
      panel = null;
      panelListEl = panelCountEl = panelDownloadBtn = null;
      itemEls.clear();
      if (fab) fab.setAttribute('aria-expanded', 'false');
      restoreFocus(fab);
      return;
    }
    buildPanel();
    if (fab) fab.setAttribute('aria-expanded', 'true');
  }

  function buildPanel() {
    panel = document.createElement('div');
    panel.className = 'md-comment-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Comments');

    const header = document.createElement('div');
    header.className = 'md-comment-panel-header';
    panelCountEl = document.createElement('span');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'md-comment-panel-close';
    close.setAttribute('aria-label', 'Close comments panel');
    close.textContent = '×';
    close.addEventListener('click', togglePanel);
    header.appendChild(panelCountEl);
    header.appendChild(close);

    panelListEl = document.createElement('div');
    panelListEl.className = 'md-comment-list';

    const footer = document.createElement('div');
    footer.className = 'md-comment-panel-footer';
    // A non-floating entry point for touch users (who get no reliable mouseup
    // selection flow): comment on whatever is currently selected.
    const addSel = document.createElement('button');
    addSel.type = 'button';
    addSel.className = 'md-comment-add-selection';
    addSel.textContent = 'Comment on selection';
    addSel.addEventListener('click', () => {
      const range = selectionRange();
      if (range) startNewComment(range, fab);
    });
    panelDownloadBtn = document.createElement('button');
    panelDownloadBtn.type = 'button';
    panelDownloadBtn.className = 'md-comment-download';
    panelDownloadBtn.textContent = 'Download comments';
    panelDownloadBtn.addEventListener('click', downloadComments);
    footer.appendChild(addSel);
    footer.appendChild(panelDownloadBtn);

    panel.appendChild(header);
    // On web pages, comments are session-only -- tell the user so the lack of
    // persistence isn't a surprise.
    if (!IS_LOCAL) {
      const note = document.createElement('div');
      note.className = 'md-comment-session-note';
      note.textContent = 'Comments on web pages are not saved and clear on refresh.';
      panel.appendChild(note);
    }
    panel.appendChild(panelListEl);
    panel.appendChild(footer);

    // Esc closes the panel; Tab is trapped within it.
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); togglePanel(); return; }
      trapFocus(panel, e);
    });

    document.body.appendChild(panel);
    syncPanel();
    close.focus();
  }

  /** Reconcile the open panel with `comments` in place (no full teardown):
   *  remove dropped items, add new ones in order, update changed bodies. */
  function syncPanel() {
    if (!panel) return;
    panelCountEl.textContent = 'Comments (' + comments.length + ')';
    panelDownloadBtn.disabled = comments.length === 0;

    if (comments.length === 0) {
      itemEls.clear();
      panelListEl.textContent = '';
      const empty = document.createElement('div');
      empty.className = 'md-comment-empty';
      empty.textContent = 'Select any text in the document to add a comment.';
      panelListEl.appendChild(empty);
      return;
    }
    const emptyNode = panelListEl.querySelector('.md-comment-empty');
    if (emptyNode) emptyNode.remove();

    const liveIds = new Set(comments.map((c) => c.id));
    itemEls.forEach((el, id) => {
      if (!liveIds.has(id)) { el.remove(); itemEls.delete(id); }
    });
    comments.forEach((c) => {
      let el = itemEls.get(c.id);
      if (!el) { el = buildListItem(c); itemEls.set(c.id, el); }
      else updateListItem(el, c);
      panelListEl.appendChild(el); // appendChild moves an existing node into order
    });
  }

  function buildListItem(c) {
    const item = document.createElement('div');
    item.className = 'md-comment-item' + (c.orphan ? ' md-comment-item-orphan' : '');

    const quote = document.createElement('div');
    quote.className = 'md-comment-item-quote';
    quote.textContent = '"' + (c.quote.length > 60 ? c.quote.slice(0, 60) + '...' : c.quote) + '"';

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
    if (c.orphan) item.appendChild(makeWarn());

    // Look the comment up by id at click time (the object is mutated in place
    // on edit, so this closure stays valid across edits).
    item.addEventListener('click', () => {
      if (c._range) {
        const node = c._range.startContainer;
        const target = node.nodeType === 1 ? node : node.parentElement;
        const openAt = () => openPopover(c._range.getBoundingClientRect(), c, null, item);
        if (target && target.scrollIntoView) {
          // Open the editor only once the smooth scroll settles, so the rect
          // is final. scrollend where available; a timeout otherwise / as a
          // fallback for the no-scroll-needed case.
          let done = false;
          const finish = () => { if (done) return; done = true; openAt(); };
          if ('onscrollend' in window) {
            window.addEventListener('scrollend', finish, { once: true });
            setTimeout(finish, 800);
          } else {
            setTimeout(finish, 350);
          }
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
          openAt();
        }
      } else {
        openPopover(item.getBoundingClientRect(), c, null, item);
      }
    });
    return item;
  }

  function makeWarn() {
    const warn = document.createElement('div');
    warn.className = 'md-comment-item-warn';
    warn.textContent = 'Passage not found on this page';
    return warn;
  }

  function updateListItem(el, c) {
    const bodyEl = el.querySelector('.md-comment-item-body');
    if (bodyEl && bodyEl.textContent !== c.body) bodyEl.textContent = c.body;
    el.classList.toggle('md-comment-item-orphan', !!c.orphan);
    const warn = el.querySelector('.md-comment-item-warn');
    if (c.orphan && !warn) el.appendChild(makeWarn());
    else if (!c.orphan && warn) warn.remove();
  }

  /** Recompute highlights + UI after any change, and persist. */
  function afterChange() {
    saveComments();
    renderHighlights();
    updateFab();
    syncPanel();
  }

  // ---- Download (sidecar .comments.md) ------------------------------------

  function sidecarName() {
    const base = filenameFromUrl().replace(/\.(md|markdown|mdown)$/i, '');
    return (base || 'document') + '.comments.md';
  }

  /** Collapse whitespace + trim. Used for fields emitted on a single sidecar
   *  line so page-derived text can't inject newlines and forge structure. */
  function escapeInline(s) {
    return String(s).replace(/\s+/g, ' ').trim();
  }

  /** Neutralise a comment-body line so it can't forge markdown block structure
   *  (heading, list item, blockquote, fence) inside the sidecar. */
  function escapeBodyLine(l) {
    return l.replace(/^(\s*)([#>\-*+]|\d+\.|`{3,})/, '$1\\$2');
  }

  function buildSidecar() {
    const lines = [];
    lines.push('# Comments on ' + escapeInline(filenameFromUrl()));
    lines.push('');
    lines.push('> ' + comments.length + ' comment(s). Generated by Markdown Studio. ' +
               'The original file is unchanged.');
    lines.push('');
    comments.forEach((c, i) => {
      lines.push('## Comment ' + (i + 1));
      lines.push('');
      if (c.heading && c.heading.text) lines.push('- **Section:** ' + escapeInline(c.heading.text));
      lines.push('- **Quote:** ' + JSON.stringify(c.quote));
      const ctx = (c.prefix ? '...' + c.prefix : '') + '>>' + c.quote + '<<' +
                  (c.suffix ? c.suffix + '...' : '');
      lines.push('- **Context:** ' + escapeInline(ctx));
      lines.push('- **Char range:** ' + c.startOffset + '-' + c.endOffset + ' (rendered text)');
      if (c.orphan) {
        lines.push('- **Note:** this passage was not found on the current page; ' +
                   'the document may have changed since the comment was made.');
      }
      lines.push('- **Comment:**');
      lines.push('');
      c.body.split('\n').forEach((l) => lines.push('  ' + escapeBodyLine(l)));
      lines.push('');
    });
    return lines.join('\n');
  }

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

  /** Map a viewport point to a caret Range, preferring the (Blink) legacy
   *  caretRangeFromPoint and falling back to the standard caretPositionFromPoint. */
  function caretFromPoint(x, y) {
    if (typeof document.caretRangeFromPoint === 'function') {
      return document.caretRangeFromPoint(x, y);
    }
    if (typeof document.caretPositionFromPoint === 'function') {
      const p = document.caretPositionFromPoint(x, y);
      if (p && p.offsetNode) {
        const r = document.createRange();
        try { r.setStart(p.offsetNode, p.offset); } catch (e) { return null; }
        return r;
      }
    }
    return null;
  }

  /** Clicking dashed-underlined text opens its comment for editing. We map the
   *  click point to a caret offset and test it against each comment's LIVE
   *  range offsets (not the persisted ones, which can be stale after drift). */
  function onArticleClick(e) {
    if (comments.length === 0) return;       // nothing to hit-test; skip the work
    if (e.target.closest('a')) return;       // let links navigate
    const article = getArticle();
    if (!article) return;
    const caret = caretFromPoint(e.clientX, e.clientY);
    if (!caret || !article.contains(caret.startContainer)) return;
    const pre = document.createRange();
    pre.selectNodeContents(article);
    pre.setEnd(caret.startContainer, caret.startOffset);
    const off = pre.toString().length;
    const hit = comments.find((c) => !c.orphan && off >= c._liveStart && off < c._liveEnd);
    if (hit && hit._range) {
      e.preventDefault();
      openPopover(hit._range.getBoundingClientRect(), hit, null, null);
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

    // Show the add button after a selection settles. mouseup covers drag-select;
    // keyup(shift) covers keyboard selection; touchend + a debounced
    // selectionchange cover touch / long-press selection. All gated on not
    // being in edit mode (getArticle() is null then anyway).
    const onSelect = () => {
      if (document.body.classList.contains('md-editing')) return;
      setTimeout(updateAddButton, 0);
    };
    document.addEventListener('mouseup', onSelect);
    document.addEventListener('touchend', onSelect);
    document.addEventListener('keyup', (e) => {
      if (e.shiftKey || e.key === 'Shift') onSelect();
    });
    document.addEventListener('selectionchange', debounce(() => {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) onSelect();
    }, 250));

    // Dismiss the add button / popover when clicking away.
    document.addEventListener('mousedown', (e) => {
      if (addBtn && !addBtn.contains(e.target)) {
        setTimeout(() => {
          const sel = window.getSelection();
          if (!sel || sel.isCollapsed) hideAddButton();
        }, 0);
      }
      if (popover && !popover.contains(e.target) &&
          !(addBtn && addBtn.contains(e.target))) {
        if (!e.target.closest('.md-comment-item')) closePopover();
      }
    });

    article.addEventListener('click', onArticleClick);
  }

  /** Re-anchor + repaint highlights. content.js calls this after the async
   *  mermaid render injects SVG label text, which shifts rendered-text offsets
   *  for any comment positioned after a diagram. */
  function refreshCommentHighlights() {
    if (_mounted) renderHighlights();
  }

  window.MarkdownStudio = window.MarkdownStudio || {};
  window.MarkdownStudio.mountComments = mountComments;
  window.MarkdownStudio.refreshCommentHighlights = refreshCommentHighlights;
})();
