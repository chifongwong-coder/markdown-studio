// Edit mode: replace the rendered article with a split textarea + live
// preview, plus a small toolbar (Save / Cancel). "Save" triggers a Blob
// download of the edited markdown using the original filename; the
// extension can't write to file:// or http(s) origins from a content
// script, so this is the cleanest "save back" path available.
//
// Public API (exposed on window.MarkdownStudio):
//   mountEditor(initialMd)
//     Take the rendered article out of the DOM and put the split
//     editor in its place. `initialMd` seeds the textarea. Self-
//     contained -- mount stashes the article + scroll position
//     internally so unmount can put everything back. No-op when
//     already mounted.
//   unmountEditor()
//     Restore the article, drop the body.md-editing class, and
//     scroll the page back to the reader's pre-edit position.
//     Bound to the Cancel button and the Escape key.
//
// While mounted, the file-URL tip banner, TOC, and TOC handles all get
// hidden via the body.md-editing class (CSS in styles/viewer.css). The
// preview pane reuses the full render pipeline (renderMarkdown ->
// highlightCode -> mermaid + KaTeX) so the preview matches the final
// rendered output.

(function () {
  'use strict';

  /** Debounce — fire `fn` only after `ms` has passed since the last call.
   *  Editor uses this on textarea input so we don't re-run the render
   *  pipeline on every keystroke. */
  function debounce(fn, ms) {
    let t = null;
    return function (...args) {
      if (t) clearTimeout(t);
      t = setTimeout(() => { t = null; fn.apply(this, args); }, ms);
    };
  }

  /** Guess a sensible download filename for the edited markdown from the
   *  document URL. file:///foo/bar.md -> "bar.md"; http://x/notes/spec.md
   *  -> "spec.md"; fallback "edited.md". */
  function filenameFromUrl() {
    try {
      const path = new URL(location.href).pathname;
      const base = path.split('/').pop() || '';
      if (/\.(md|markdown|mdown)$/i.test(base)) return base;
    } catch (e) { /* fall through */ }
    return 'edited.md';
  }

  /** Render the markdown source into the preview pane. Mirrors the full
   *  pipeline used on initial page load: extractMath + extractMermaid
   *  happen inside renderMarkdown, then DOMPurify, KaTeX, highlight.js
   *  and mermaid all run on the resulting article. */
  async function renderPreview(md, previewHost) {
    if (!window.MarkdownStudio || !window.MarkdownStudio.renderMarkdown) return;
    const result = window.MarkdownStudio.renderMarkdown(md);
    const html = typeof result === 'string' ? result : result.html;
    const mermaidSources = (result && result.mermaidSources) || [];
    previewHost.innerHTML = '';
    const article = document.createElement('article');
    article.className = 'markdown-studio-content';
    article.innerHTML = html;
    previewHost.appendChild(article);
    if (window.MarkdownStudio.highlightCode) {
      try { window.MarkdownStudio.highlightCode(article); }
      catch (e) { /* ignore highlight failures */ }
    }
    // Mermaid: content.js owns the renderer; if it exposed a renderer
    // we can call, use it. Otherwise skip diagrams in the preview --
    // textual fallback is acceptable for an editor.
    if (mermaidSources.length > 0 &&
        window.MarkdownStudio.renderMermaidInto) {
      try {
        await window.MarkdownStudio.renderMermaidInto(article, mermaidSources);
      } catch (e) { /* ignore mermaid failures in preview */ }
    }
  }

  /** Build the editor DOM. Returns the root element to insert in place
   *  of the article, plus references to the textarea and preview host. */
  function buildEditorDom(initialMd) {
    const root = document.createElement('div');
    root.className = 'md-editor';

    const toolbar = document.createElement('div');
    toolbar.className = 'md-editor-toolbar';

    const label = document.createElement('span');
    label.className = 'md-editor-label';
    label.textContent = 'Editing — changes stay in-memory until you click Download';

    const fileName = document.createElement('code');
    fileName.className = 'md-editor-filename';
    fileName.textContent = filenameFromUrl();

    const spacer = document.createElement('span');
    spacer.className = 'md-editor-spacer';

    // Labeled "Download" rather than "Save": the action triggers a Blob
    // download with the edited content as a *new* .md file. A content
    // script can't write to the original file:// path (no FS permission)
    // and can't PUT back to an http(s) origin -- so "Save" was misleading.
    const saveBtn = document.createElement('button');
    saveBtn.className = 'md-editor-save';
    saveBtn.type = 'button';
    saveBtn.textContent = 'Download';
    saveBtn.title = 'Download the edited markdown as a .md file';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'md-editor-cancel';
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.title = 'Discard edits and return to view mode';

    toolbar.appendChild(label);
    toolbar.appendChild(fileName);
    toolbar.appendChild(spacer);
    toolbar.appendChild(saveBtn);
    toolbar.appendChild(cancelBtn);

    const split = document.createElement('div');
    split.className = 'md-editor-split';

    const textareaWrap = document.createElement('div');
    textareaWrap.className = 'md-editor-textarea-wrap';
    const textarea = document.createElement('textarea');
    textarea.className = 'md-editor-textarea';
    textarea.value = initialMd;
    textarea.spellcheck = false;
    textarea.setAttribute('aria-label', 'Markdown source');
    textareaWrap.appendChild(textarea);

    const previewWrap = document.createElement('div');
    previewWrap.className = 'md-editor-preview-wrap';
    const preview = document.createElement('div');
    preview.className = 'md-editor-preview';
    preview.setAttribute('aria-label', 'Live preview');
    previewWrap.appendChild(preview);

    split.appendChild(textareaWrap);
    split.appendChild(previewWrap);

    root.appendChild(toolbar);
    root.appendChild(split);

    return { root, textarea, preview, saveBtn, cancelBtn, fileName };
  }

  /** Save via the File System Access API — opens a native "Save As"
   *  dialog so the user can pick the path and filename (and overwrite
   *  the original file directly if they choose). Returns true on
   *  success, false if the API is unavailable or errored. Silently
   *  returns false on user-cancel (AbortError). */
  async function saveWithPicker(text, suggestedName) {
    if (typeof window.showSaveFilePicker !== 'function') return false;
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{
          description: 'Markdown',
          accept: { 'text/markdown': ['.md', '.markdown', '.mdown'] },
        }],
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

  /** Fallback: trigger a Blob download into the browser's default
   *  download folder. Used when showSaveFilePicker is unavailable. */
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

  // Module state — at most one editor mounted at a time. The previous
  // article + body class state are stashed here so unmount can restore
  // exactly what mount displaced. _stashedScrollY captures the reader's
  // position before the article was detached so we can put them back
  // where they were when they cancel.
  let _editorRoot = null;
  let _stashedArticle = null;
  let _stashedFollowing = null;
  let _stashedScrollY = 0;

  /** Mount the editor: take the rendered article out of the DOM, put
   *  the editor in its place, and start the debounced preview loop.
   *  Self-contained -- mount stashes everything unmount needs to put
   *  the page back together. */
  function mountEditor(initialMd) {
    if (_editorRoot) return; // already mounted, no-op
    const article = document.body.querySelector('article.markdown-studio-content');
    if (!article) {
      console.warn('[markdown-studio] mountEditor: no article in body');
      return;
    }
    const parts = buildEditorDom(initialMd);

    // Stash the article + its next sibling so unmount can re-insert at
    // the exact same DOM position (don't disturb the file-tip banner or
    // anything else around the article). Also stash scrollY: detaching
    // the article collapses body height to ~0 and the browser snaps
    // scroll to 0, so without remembering we'd lose the reader's
    // position when they Cancel.
    _stashedArticle = article;
    _stashedFollowing = article.nextSibling;
    _stashedScrollY = window.scrollY || window.pageYOffset || 0;
    // Capture the reader's scroll as a [0,1] ratio so the editor panes
    // can land at the same proportional position. Without this, the
    // textarea opens at top *and* focus() then snaps it to the caret
    // (default at end-of-text), so the editor appears to jump to the
    // bottom of the document the moment you click Edit.
    const readerRange = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    const readerRatio = Math.min(1, Math.max(0, _stashedScrollY / readerRange));
    article.parentNode.removeChild(article);

    document.body.appendChild(parts.root);
    document.body.classList.add('md-editing');
    _editorRoot = parts.root;

    const renderPreviewDebounced = debounce(() => {
      renderPreview(parts.textarea.value, parts.preview)
        .catch((e) => console.warn('[markdown-studio] preview render failed:', e));
    }, 300);

    parts.textarea.addEventListener('input', renderPreviewDebounced);
    // First render immediately so the preview isn't empty. Restore the
    // reader's scroll ratio on both panes once the preview has rendered
    // -- deferring to .then() makes sure preview.scrollHeight is final
    // (otherwise applyRatio on an empty preview lands at scrollTop=0).
    renderPreview(parts.textarea.value, parts.preview)
      .then(() => {
        applyRatio(parts.textarea, readerRatio);
        applyRatio(parts.preview, readerRatio);
      })
      .catch((e) => console.warn('[markdown-studio] preview render failed:', e));

    // Proportional scroll sync between the two panes.
    //
    // Setting scrollTop on one pane fires a scroll event on that pane,
    // which would otherwise try to sync BACK and start a feedback loop.
    // _scrollSyncSource records who initiated the current sync; the
    // other pane's handler short-circuits when it sees the flag set to
    // anything other than null. A rAF clears the flag so the next
    // genuine user scroll on either pane processes normally.
    //
    // Proportional (not line-mapped) is intentional: math blocks,
    // tables, images and mermaid SVGs change vertical size between raw
    // source and rendered HTML, so 1:1 line mapping requires an index
    // that's a lot more code for marginally better UX. Ratio is close
    // enough for ~99% of scrolling and survives any content shape.
    let _scrollSyncSource = null;
    function ratioOf(el) {
      const range = Math.max(1, el.scrollHeight - el.clientHeight);
      return el.scrollTop / range;
    }
    function applyRatio(el, ratio) {
      const range = Math.max(0, el.scrollHeight - el.clientHeight);
      el.scrollTop = ratio * range;
    }
    function syncFrom(src, dst, tag) {
      if (_scrollSyncSource && _scrollSyncSource !== tag) return;
      _scrollSyncSource = tag;
      applyRatio(dst, ratioOf(src));
      requestAnimationFrame(() => { _scrollSyncSource = null; });
    }
    parts.textarea.addEventListener('scroll', () =>
      syncFrom(parts.textarea, parts.preview, 'textarea'));
    parts.preview.addEventListener('scroll', () =>
      syncFrom(parts.preview, parts.textarea, 'preview'));

    parts.saveBtn.addEventListener('click', async () => {
      const name = parts.fileName.textContent || 'edited.md';
      const saved = await saveWithPicker(parts.textarea.value, name);
      if (!saved) downloadAsFile(parts.textarea.value, name);
    });

    parts.cancelBtn.addEventListener('click', () => {
      unmountEditor();
    });

    // Esc as a keyboard shortcut for Cancel. Save deliberately has no
    // shortcut since Ctrl/Cmd+S in a content script collides with the
    // browser's own "Save page as" dialog.
    parts.textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        unmountEditor();
      }
    });

    // Place the caret roughly where the reader was so typing inserts
    // near the scrolled region instead of at the start of the document.
    // preventScroll: true keeps focus() from snapping the textarea to
    // the caret -- the proportional scroll restored in the renderPreview
    // .then() above is the source of truth for the landing position.
    const caretPos = Math.floor(parts.textarea.value.length * readerRatio);
    parts.textarea.setSelectionRange(caretPos, caretPos);
    parts.textarea.focus({ preventScroll: true });
  }

  /** Unmount: restore the original article + drop the editing class +
   *  land the reader at the same proportional spot the editor was at
   *  when the user exited. (Mount captured the reader's ratio so the
   *  editor opened where they were reading; unmount mirrors that so
   *  Cancel returns them where they were *editing*.) */
  function unmountEditor() {
    if (!_editorRoot) return;
    // Capture the editor's exit ratio BEFORE detaching it -- a detached
    // textarea's layout numbers are no longer guaranteed to be valid.
    // Use the textarea (the primary editor pane); the preview is kept
    // proportionally in sync with it by the scroll-sync handlers.
    let exitRatio = null;
    const textarea = _editorRoot.querySelector('textarea.md-editor-textarea');
    if (textarea) {
      const range = Math.max(1, textarea.scrollHeight - textarea.clientHeight);
      exitRatio = Math.min(1, Math.max(0, textarea.scrollTop / range));
    }
    document.body.removeChild(_editorRoot);
    if (_stashedArticle) {
      if (_stashedFollowing && _stashedFollowing.parentNode === document.body) {
        document.body.insertBefore(_stashedArticle, _stashedFollowing);
      } else {
        document.body.appendChild(_stashedArticle);
      }
    }
    document.body.classList.remove('md-editing');
    // Restore scroll AFTER the article is back in the DOM and the
    // editing class is gone (CSS layout has to settle first so the
    // body has enough height for our target scroll value to be valid).
    // Apply the editor's exit ratio to the reader's scroll range so we
    // land on the same section the user was editing. Fall back to the
    // pre-edit position if the editor's textarea was missing.
    if (exitRatio !== null) {
      const readerRange = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      window.scrollTo(0, exitRatio * readerRange);
    } else {
      window.scrollTo(0, _stashedScrollY);
    }
    _editorRoot = null;
    _stashedArticle = null;
    _stashedFollowing = null;
    _stashedScrollY = 0;
  }

  // Expose to toc.js + content.js.
  window.MarkdownStudio = window.MarkdownStudio || {};
  window.MarkdownStudio.mountEditor = mountEditor;
  window.MarkdownStudio.unmountEditor = unmountEditor;
})();
