// Reading-font presets + a small picker for the TOC header.
//
// The on-screen body font used to be a hard-coded serif stack that read as
// old-fashioned on screen. This module:
//   1. ships a few presets and a sensible sans-serif default ("normal"), and
//   2. lets the reader switch fonts from the TOC toolbar, persisting the
//      choice in localStorage so it sticks across files.
//
// Presets name Latin faces only. Each stack ends in a generic family keyword
// (sans-serif / serif / monospace), so Chinese and any other script the named
// faces don't cover fall through to the system default for that family. We
// don't ship explicit CJK font names.

(function () {
  'use strict';

  const STORAGE_KEY = 'markdown-studio-font';

  // id -> { label, body, heading }. `body`/`heading` are full font-family
  // values assigned to the --md-font-body / --md-font-heading custom
  // properties on <html>. 'sans' is the default and must stay first.
  const PRESETS = [
    {
      id: 'sans',
      label: 'Sans',
      body:
        '-apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", ' +
        'Arial, sans-serif',
      heading:
        '-apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", ' +
        'Arial, sans-serif',
    },
    {
      id: 'serif',
      label: 'Serif',
      body: 'Georgia, Cambria, "Times New Roman", Times, serif',
      heading: 'Georgia, Cambria, "Times New Roman", Times, serif',
    },
    {
      id: 'mono',
      label: 'Mono',
      body:
        '"JetBrains Mono", "Fira Code", "Source Code Pro", Menlo, Consolas, ' +
        '"Liberation Mono", monospace',
      heading:
        '"JetBrains Mono", "Fira Code", "Source Code Pro", Menlo, Consolas, ' +
        '"Liberation Mono", monospace',
    },
  ];

  const DEFAULT_ID = PRESETS[0].id;

  function presetById(id) {
    return PRESETS.find((p) => p.id === id) || PRESETS[0];
  }

  /** Read the saved font id, falling back to the default. */
  function getSavedFontId() {
    try {
      const v = window.localStorage && window.localStorage.getItem(STORAGE_KEY);
      if (v && PRESETS.some((p) => p.id === v)) return v;
    } catch (e) { /* localStorage blocked => use default */ }
    return DEFAULT_ID;
  }

  /** Apply a preset by setting the CSS custom properties on <html>. The CSS
   *  defaults already match the 'sans' preset, so applying the default is a
   *  harmless no-op that keeps JS and CSS in sync. */
  function applyFont(id) {
    const preset = presetById(id);
    const root = document.documentElement;
    if (!root) return;
    root.style.setProperty('--md-font-body', preset.body);
    root.style.setProperty('--md-font-heading', preset.heading);
  }

  function saveFontId(id) {
    try {
      if (window.localStorage) window.localStorage.setItem(STORAGE_KEY, id);
    } catch (e) { /* localStorage blocked => choice just won't persist */ }
  }

  /** Build a labelled <select> for the TOC toolbar. Returns the wrapper so the
   *  caller can drop it straight into the actions cluster. */
  function buildFontPicker() {
    const wrap = document.createElement('label');
    wrap.className = 'md-toc-font';
    wrap.title = 'Reading font';
    wrap.setAttribute('aria-label', 'Reading font');

    const select = document.createElement('select');
    select.className = 'md-toc-font-select';
    PRESETS.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.label;
      select.appendChild(opt);
    });
    select.value = getSavedFontId();
    select.addEventListener('change', () => {
      applyFont(select.value);
      saveFontId(select.value);
    });
    wrap.appendChild(select);
    return wrap;
  }

  // Apply the saved font as soon as this script runs (document_end, before
  // content.js renders the article) so readers never see a flash of the
  // default face. The vars live on <html>, which content.js never replaces.
  applyFont(getSavedFontId());

  window.MarkdownStudio = window.MarkdownStudio || {};
  window.MarkdownStudio.applyFont = applyFont;
  window.MarkdownStudio.buildFontPicker = buildFontPicker;
})();
