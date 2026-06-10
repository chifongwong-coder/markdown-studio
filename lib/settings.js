// Reader display settings: a gear button in the TOC toolbar opens a popover
// for reading font, font size, content width, and colour theme. Each setting
// persists in localStorage and is applied to <html> (CSS custom properties +
// the data-md-theme attribute) so the stylesheet reacts live. Settings are
// applied on load before content.js renders, so there's no flash of defaults.

(function () {
  'use strict';

  // ---- presets & bounds ----------------------------------------------------

  // Reading-font presets. Latin faces only; each stack ends in a generic family
  // keyword so Chinese and other scripts fall through to the system default.
  const FONTS = [
    {
      id: 'sans', label: 'Sans',
      stack: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif',
    },
    {
      id: 'serif', label: 'Serif',
      stack: 'Georgia, Cambria, "Times New Roman", Times, serif',
    },
    {
      id: 'mono', label: 'Mono',
      stack: '"JetBrains Mono", "Fira Code", "Source Code Pro", Menlo, Consolas, "Liberation Mono", monospace',
    },
  ];

  const THEMES = [
    { id: 'auto', label: 'Auto' },
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
    { id: 'sepia', label: 'Sepia' },
  ];

  const SIZE = { min: 13, max: 22, step: 1, def: 16 };       // px
  const WIDTH = { min: 600, max: 1280, step: 40, def: 860 }; // px

  const KEY = {
    font: 'markdown-studio-font',
    theme: 'markdown-studio-theme',
    size: 'markdown-studio-font-size',
    width: 'markdown-studio-content-width',
  };

  // ---- persistence ---------------------------------------------------------

  function lsGet(key) {
    try { return window.localStorage ? window.localStorage.getItem(key) : null; }
    catch (e) { return null; }
  }
  function lsSet(key, val) {
    try { if (window.localStorage) window.localStorage.setItem(key, val); }
    catch (e) { /* blocked => won't persist, fine */ }
  }

  function clampInt(v, lo, hi, fallback) {
    const n = parseInt(v, 10);
    if (!isFinite(n)) return fallback;
    return n < lo ? lo : (n > hi ? hi : n);
  }

  function getFont() {
    const v = lsGet(KEY.font);
    return FONTS.some((f) => f.id === v) ? v : FONTS[0].id;
  }
  function getTheme() {
    const v = lsGet(KEY.theme);
    return THEMES.some((t) => t.id === v) ? v : 'auto';
  }
  function getSize() { return clampInt(lsGet(KEY.size), SIZE.min, SIZE.max, SIZE.def); }
  function getWidth() { return clampInt(lsGet(KEY.width), WIDTH.min, WIDTH.max, WIDTH.def); }

  // ---- apply to <html> -----------------------------------------------------

  function applyFont(id) {
    const f = FONTS.find((x) => x.id === id) || FONTS[0];
    const root = document.documentElement;
    if (!root) return;
    root.style.setProperty('--md-font-body', f.stack);
    root.style.setProperty('--md-font-heading', f.stack);
  }
  function applyTheme(id) {
    const root = document.documentElement;
    if (root) root.setAttribute('data-md-theme', THEMES.some((t) => t.id === id) ? id : 'auto');
  }
  function applySize(px) {
    const root = document.documentElement;
    if (root) root.style.setProperty('--md-font-size', clampInt(px, SIZE.min, SIZE.max, SIZE.def) + 'px');
  }
  function applyWidth(px) {
    const root = document.documentElement;
    if (root) root.style.setProperty('--md-content-width', clampInt(px, WIDTH.min, WIDTH.max, WIDTH.def) + 'px');
  }

  function applyAll() {
    applyFont(getFont());
    applyTheme(getTheme());
    applySize(getSize());
    applyWidth(getWidth());
  }

  // ---- panel UI ------------------------------------------------------------

  let panel = null;      // the open popover, or null
  let openerBtn = null;  // gear button to restore focus to on close

  /** A segmented control: one button per option, aria-pressed on the active. */
  function segmented(options, current, onPick) {
    const seg = document.createElement('div');
    seg.className = 'md-settings-seg';
    seg.setAttribute('role', 'group');
    options.forEach((opt) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = opt.label;
      b.setAttribute('aria-pressed', String(opt.id === current));
      b.addEventListener('click', () => {
        seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', 'false'));
        b.setAttribute('aria-pressed', 'true');
        onPick(opt.id);
      });
      seg.appendChild(b);
    });
    return seg;
  }

  /** A −/value/+ stepper bound to [bounds.min, bounds.max]. */
  function stepper(bounds, current, format, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'md-settings-step';
    let value = clampInt(current, bounds.min, bounds.max, bounds.def);

    const dec = document.createElement('button');
    dec.type = 'button'; dec.textContent = '−'; // minus sign
    dec.setAttribute('aria-label', 'Decrease');
    const val = document.createElement('span');
    val.className = 'md-settings-value';
    const inc = document.createElement('button');
    inc.type = 'button'; inc.textContent = '+';
    inc.setAttribute('aria-label', 'Increase');

    function refresh() {
      val.textContent = format(value);
      dec.disabled = value <= bounds.min;
      inc.disabled = value >= bounds.max;
    }
    function bump(delta) {
      value = clampInt(value + delta, bounds.min, bounds.max, bounds.def);
      refresh();
      onChange(value);
    }
    dec.addEventListener('click', () => bump(-bounds.step));
    inc.addEventListener('click', () => bump(bounds.step));
    refresh();

    wrap.appendChild(dec);
    wrap.appendChild(val);
    wrap.appendChild(inc);
    // Expose a setter so Reset can drive it without rebuilding the panel.
    wrap._set = (v) => { value = clampInt(v, bounds.min, bounds.max, bounds.def); refresh(); };
    return wrap;
  }

  function makeRow(labelText, control) {
    const row = document.createElement('div');
    row.className = 'md-settings-row';
    const label = document.createElement('span');
    label.className = 'md-settings-label';
    label.textContent = labelText;
    row.appendChild(label);
    row.appendChild(control);
    return row;
  }

  function buildPanel() {
    const p = document.createElement('div');
    p.className = 'md-settings-panel';
    p.setAttribute('role', 'dialog');
    p.setAttribute('aria-label', 'Display settings');

    const themeSeg = segmented(THEMES, getTheme(), (id) => { applyTheme(id); lsSet(KEY.theme, id); });
    const fontSeg = segmented(FONTS, getFont(), (id) => { applyFont(id); lsSet(KEY.font, id); });
    const sizeStep = stepper(SIZE, getSize(), (v) => v + ' px',
      (v) => { applySize(v); lsSet(KEY.size, String(v)); });
    const widthStep = stepper(WIDTH, getWidth(), (v) => v + ' px',
      (v) => { applyWidth(v); lsSet(KEY.width, String(v)); });

    p.appendChild(makeRow('Theme', themeSeg));
    p.appendChild(makeRow('Font', fontSeg));
    p.appendChild(makeRow('Size', sizeStep));
    p.appendChild(makeRow('Width', widthStep));

    const footer = document.createElement('div');
    footer.className = 'md-settings-footer';
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'md-settings-reset';
    reset.textContent = 'Reset to defaults';
    reset.addEventListener('click', () => {
      // Clear storage and re-apply defaults, then sync the controls.
      [KEY.font, KEY.theme, KEY.size, KEY.width].forEach((k) => {
        try { if (window.localStorage) window.localStorage.removeItem(k); } catch (e) { /* ignore */ }
      });
      applyAll();
      syncSeg(themeSeg, 'auto');
      syncSeg(fontSeg, FONTS[0].id);
      sizeStep._set(SIZE.def);
      widthStep._set(WIDTH.def);
    });
    footer.appendChild(reset);
    p.appendChild(footer);
    return p;
  }

  function syncSeg(seg, id) {
    const buttons = Array.prototype.slice.call(seg.querySelectorAll('button'));
    // The Nth option's label order matches THEMES/FONTS; match by index via id.
    // Simpler: clear all, then set the one whose text matches the option label.
    const opt = THEMES.concat(FONTS).find((o) => o.id === id);
    buttons.forEach((b) => b.setAttribute('aria-pressed',
      String(opt ? b.textContent === opt.label : false)));
  }

  // ---- open / close --------------------------------------------------------

  function positionPanel() {
    if (!panel || !openerBtn) return;
    const r = openerBtn.getBoundingClientRect();
    const pw = panel.offsetWidth, ph = panel.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    let left = r.left;
    if (left + pw > vw - 8) left = vw - 8 - pw;
    if (left < 8) left = 8;
    let top = r.bottom + 6;
    if (top + ph > vh - 8) top = Math.max(8, r.top - 6 - ph); // flip above if no room below
    panel.style.left = Math.round(left) + 'px';
    panel.style.top = Math.round(top) + 'px';
  }

  function onDocMouseDown(e) {
    if (!panel) return;
    if (panel.contains(e.target) || (openerBtn && openerBtn.contains(e.target))) return;
    closePanel();
  }
  function onKeyDown(e) {
    if (e.key === 'Escape' && panel) { e.preventDefault(); closePanel(); }
  }
  function onReflow() { positionPanel(); }

  function openPanel(btn) {
    if (panel) return;
    openerBtn = btn;
    panel = buildPanel();
    document.body.appendChild(panel);
    positionPanel();
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', onDocMouseDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onReflow);
    window.addEventListener('scroll', onReflow, true);
    // Move focus into the panel for keyboard users.
    const first = panel.querySelector('button');
    if (first) first.focus();
  }

  function closePanel() {
    if (!panel) return;
    document.removeEventListener('mousedown', onDocMouseDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('resize', onReflow);
    window.removeEventListener('scroll', onReflow, true);
    if (panel.parentNode) panel.parentNode.removeChild(panel);
    panel = null;
    if (openerBtn) {
      openerBtn.setAttribute('aria-expanded', 'false');
      openerBtn.focus();
      openerBtn = null;
    }
  }

  /** Build the gear button for the TOC toolbar. */
  function buildSettingsButton() {
    const btn = document.createElement('button');
    btn.className = 'md-toc-settings';
    btn.type = 'button';
    btn.title = 'Display settings';
    btn.setAttribute('aria-label', 'Display settings');
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.setAttribute('aria-expanded', 'false');
    btn.textContent = '⚙'; // gear
    btn.addEventListener('click', () => {
      if (panel) closePanel(); else openPanel(btn);
    });
    return btn;
  }

  // Apply saved settings immediately (document_end, before render).
  applyAll();

  window.MarkdownStudio = window.MarkdownStudio || {};
  window.MarkdownStudio.buildSettingsButton = buildSettingsButton;
  window.MarkdownStudio.applySettings = applyAll;
})();
