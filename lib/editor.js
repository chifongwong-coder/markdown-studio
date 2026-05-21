// Edit mode: replace the rendered article with a split textarea + live
// preview, plus a small toolbar (Save / Cancel). "Save" triggers a Blob
// download of the edited markdown using the original filename; the
// extension can't write to file:// or http(s) origins from a content
// script, so this is the cleanest "save back" path available.
//
// Public API (exposed on window.MdViewer):
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
    if (!window.MdViewer || !window.MdViewer.renderMarkdown) return;
    const result = window.MdViewer.renderMarkdown(md);
    const html = typeof result === 'string' ? result : result.html;
    const mermaidSources = (result && result.mermaidSources) || [];
    previewHost.innerHTML = '';
    const article = document.createElement('article');
    article.className = 'md-viewer-content';
    article.innerHTML = html;
    previewHost.appendChild(article);
    if (window.MdViewer.highlightCode) {
      try { window.MdViewer.highlightCode(article); }
      catch (e) { /* ignore highlight failures */ }
    }
    // Mermaid: content.js owns the renderer; if it exposed a renderer
    // we can call, use it. Otherwise skip diagrams in the preview --
    // textual fallback is acceptable for an editor.
    if (mermaidSources.length > 0 &&
        window.MdViewer.renderMermaidInto) {
      try {
        await window.MdViewer.renderMermaidInto(article, mermaidSources);
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
    label.textContent = 'Editing — changes are in-memory until you Save';

    const fileName = document.createElement('code');
    fileName.className = 'md-editor-filename';
    fileName.textContent = filenameFromUrl();

    const spacer = document.createElement('span');
    spacer.className = 'md-editor-spacer';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'md-editor-save';
    saveBtn.type = 'button';
    saveBtn.textContent = 'Save';
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

  /** Trigger a browser download of `text` as a Blob using `name`. */
  function downloadAsFile(text, name) {
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    // Some browsers require the anchor to be in-document to honour the
    // download attribute. Append, click, remove.
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Free the blob URL after the download is queued. setTimeout 0 is
    // enough; we don't need to wait for the download to actually start.
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
    const article = document.body.querySelector('article.md-viewer-content');
    if (!article) {
      console.warn('[md-viewer] mountEditor: no article in body');
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
    article.parentNode.removeChild(article);

    document.body.appendChild(parts.root);
    document.body.classList.add('md-editing');
    _editorRoot = parts.root;

    const renderPreviewDebounced = debounce(() => {
      renderPreview(parts.textarea.value, parts.preview)
        .catch((e) => console.warn('[md-viewer] preview render failed:', e));
    }, 300);

    parts.textarea.addEventListener('input', renderPreviewDebounced);
    // First render immediately so the preview isn't empty.
    renderPreview(parts.textarea.value, parts.preview)
      .catch((e) => console.warn('[md-viewer] preview render failed:', e));

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

    parts.saveBtn.addEventListener('click', () => {
      downloadAsFile(parts.textarea.value, parts.fileName.textContent || 'edited.md');
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

    // Focus the textarea so the user can start typing immediately.
    parts.textarea.focus();
  }

  /** Unmount: restore the original article + drop the editing class +
   *  put the reader back where they were before they entered editing. */
  function unmountEditor() {
    if (!_editorRoot) return;
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
    window.scrollTo(0, _stashedScrollY);
    _editorRoot = null;
    _stashedArticle = null;
    _stashedFollowing = null;
    _stashedScrollY = 0;
  }

  // Expose to toc.js + content.js.
  window.MdViewer = window.MdViewer || {};
  window.MdViewer.mountEditor = mountEditor;
  window.MdViewer.unmountEditor = unmountEditor;
})();
