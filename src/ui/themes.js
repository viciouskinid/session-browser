'use strict';
// Theme registry and token generator (shared by the main process and the app's pages).
// A theme is four colours (background, surface, text, accent) plus a mode. Every other token (chrome, borders, muted text,
// status colours, hover tints) is DERIVED from them and nudged until text and accents meet WCAG contrast, so no theme can ship
// with unreadable text. Components only ever use the semantic tokens (--bg, --panel, --ink, --accent, ...).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Themes = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // ---- colour maths
  const hex2rgb = h => { h = String(h).replace('#', ''); if (h.length === 3) h = h.split('').map(c => c + c).join(''); const n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const rgb2hex = a => '#' + a.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
  const mix = (a, b, t) => { const x = hex2rgb(a), y = hex2rgb(b); return rgb2hex(x.map((v, i) => v + (y[i] - v) * t)); };
  const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = h => { const [r, g, b] = hex2rgb(h); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
  const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  function hsl(h, s, l) {
    s /= 100; l /= 100;
    const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return rgb2hex([f(0) * 255, f(8) * 255, f(4) * 255]);
  }
  // Move a colour toward black or white (whichever the backgrounds need) until it reaches the contrast on every background.
  function readable(fg, bgs, min) {
    bgs = [].concat(bgs);
    const worst = f => Math.min(...bgs.map(b => contrast(f, b)));
    if (worst(fg) >= min) return fg;
    const target = bgs.reduce((s, b) => s + lum(b), 0) / bgs.length > 0.4 ? '#000000' : '#ffffff';
    for (let t = 0.05; t <= 1.0001; t += 0.05) { const c = mix(fg, target, t); if (worst(c) >= min) return c; }
    return target;
  }

  // ---- catalogue
  const T = (id, name, mode, family, bg, panel, ink, accent) => ({ id, name, mode, family, bg, panel, ink, accent });
  const HAND = [
    // neutral and professional
    T('light', 'Classic Light', 'light', 'neutral', '#eef1f5', '#f5f7fa', '#18202c', '#0b6b63'),
    T('dark', 'Classic Dark', 'dark', 'neutral', '#12171f', '#171d26', '#e6ebf2', '#4fd1c0'),
    T('soft-grey', 'Soft Grey', 'light', 'neutral', '#f0f0f2', '#fafafb', '#1f2328', '#3f51b5'),
    T('graphite', 'Graphite', 'dark', 'neutral', '#1c1d20', '#25262a', '#e8e9ec', '#8ab4f8'),
    T('slate', 'Slate', 'light', 'neutral', '#e8ecf1', '#f4f6f9', '#1e293b', '#2563eb'),
    T('charcoal', 'Charcoal', 'dark', 'neutral', '#181818', '#222222', '#eaeaea', '#e0a526'),
    T('paper', 'Paper', 'light', 'neutral', '#faf8f3', '#fffefb', '#2b2b2b', '#b45309'),
    T('warm-paper', 'Warm Paper', 'light', 'neutral', '#f5ecd9', '#fbf5e8', '#3a2e1f', '#a0522d'),
    T('platinum', 'Platinum', 'light', 'neutral', '#e6e8eb', '#f3f4f6', '#1f2933', '#0e7490'),
    T('steel', 'Steel', 'dark', 'neutral', '#20262d', '#2a323b', '#dfe6ee', '#6aa6d6'),
    T('minimal', 'Minimal', 'light', 'neutral', '#ffffff', '#f7f7f7', '#111111', '#222222'),
    T('monochrome', 'Monochrome', 'dark', 'neutral', '#0e0e0e', '#171717', '#f0f0f0', '#d0d0d0'),
    T('office-blue', 'Office Blue', 'light', 'professional', '#eaf1fb', '#f7faff', '#13233a', '#1f6feb'),
    T('corporate-navy', 'Corporate Navy', 'dark', 'professional', '#0f1b2d', '#15263d', '#e3ebf6', '#5aa9ff'),
    T('midnight', 'Midnight Blue', 'dark', 'professional', '#090b10', '#0f131a', '#f0f4fc', '#3b82f6'),
    T('solarized-light', 'Solarized Light', 'light', 'professional', '#fdf6e3', '#f7f1de', '#073642', '#268bd2'),
    T('solarized-dark', 'Solarized Dark', 'dark', 'professional', '#002b36', '#073642', '#eee8d5', '#2aa198'),
    T('nord', 'Nord', 'dark', 'professional', '#2e3440', '#3b4252', '#eceff4', '#88c0d0'),
    // named, recognisable families (original palettes, not official copies)
    T('dracula', 'Dracula-inspired', 'dark', 'retro', '#282a36', '#343746', '#f8f8f2', '#ff79c6'),
    T('gruvbox-dark', 'Gruvbox-inspired Dark', 'dark', 'retro', '#282828', '#32302f', '#ebdbb2', '#fabd2f'),
    T('gruvbox-light', 'Gruvbox-inspired Light', 'light', 'retro', '#fbf1c7', '#f9f5d7', '#3c3836', '#b57614'),
    T('tokyo-night', 'Tokyo Night-inspired', 'dark', 'retro', '#1a1b26', '#24283b', '#c0caf5', '#7aa2f7'),
    T('monokai', 'Monokai-inspired', 'dark', 'retro', '#272822', '#31322b', '#f8f8f2', '#a6e22e'),
    T('atom', 'Atom-inspired', 'dark', 'retro', '#282c34', '#2f343f', '#abb2bf', '#61afef'),
    // retro, terminal, vivid
    T('terminal', 'Terminal', 'dark', 'retro', '#0a0f0a', '#101810', '#33ff66', '#33ff66'),
    T('retro-amber', 'Retro Amber', 'dark', 'retro', '#140c00', '#1d1300', '#ffb000', '#ffb000'),
    T('matrix', 'Matrix', 'dark', 'retro', '#000a00', '#021402', '#9dffb0', '#00ff41'),
    T('cyberpunk', 'Cyberpunk', 'dark', 'retro', '#0b0a1a', '#14122b', '#f2f2ff', '#ff2a6d'),
    T('synthwave', 'Synthwave', 'dark', 'retro', '#1a1033', '#241446', '#f6e9ff', '#ff6ac1'),
    T('neon', 'Neon', 'dark', 'retro', '#0a0a12', '#12121f', '#eaffff', '#00f0ff'),
    T('arcade', 'Arcade', 'dark', 'retro', '#10101c', '#1a1a2e', '#fff7d6', '#ffd23f'),
    // high contrast
    T('hc-light', 'High Contrast Light', 'light', 'contrast', '#ffffff', '#ffffff', '#000000', '#0033cc'),
    T('hc-dark', 'High Contrast Dark', 'dark', 'contrast', '#000000', '#0a0a0a', '#ffffff', '#ffeb3b'),
    // colourful and nature
    T('forest', 'Forest', 'dark', 'green', '#141e18', '#1b2820', '#e3efe7', '#52b788'),
    T('rose', 'Rosé', 'light', 'purple', '#fff5f7', '#fff9fa', '#3b131e', '#d6336c'),
    T('sunset', 'Sunset', 'dark', 'warm', '#1f1518', '#2b1d21', '#fceeed', '#f97316'),
    T('lavender', 'Lavender', 'light', 'purple', '#f4f2fa', '#faf9fd', '#231b38', '#7c3aed'),
    T('coffee', 'Coffee', 'dark', 'warm', '#1c1714', '#261f1b', '#efe6dd', '#d97706'),
    T('candy', 'Candy', 'light', 'colourful', '#fff0f6', '#fff9fc', '#4a1d36', '#e11d78'),
    T('pastel', 'Pastel', 'light', 'colourful', '#f3f4ff', '#fbfbff', '#2f3150', '#6366f1'),
    T('sunrise', 'Sunrise', 'light', 'colourful', '#fff6ec', '#fffbf5', '#3d2412', '#ea580c'),
    T('tropical', 'Tropical', 'light', 'colourful', '#effcf6', '#fafffc', '#0f3a2b', '#0d9488'),
    T('aurora', 'Aurora', 'dark', 'colourful', '#0b1620', '#112230', '#e4f4ff', '#4ade80'),
    T('cosmic', 'Cosmic', 'dark', 'colourful', '#120f24', '#1b1736', '#ece8ff', '#a78bfa')
  ];
  // Colour families, each in a light and a dark variant generated from one hue: [id, name, family, hue, saturation]
  const HUES = [
    ['ocean', 'Ocean', 'blue', 205, 60], ['cobalt', 'Cobalt', 'blue', 226, 62], ['indigo', 'Indigo', 'blue', 246, 55],
    ['lagoon', 'Lagoon', 'blue', 186, 58], ['glacier', 'Glacier', 'blue', 196, 24],
    ['violet', 'Violet', 'purple', 264, 58], ['amethyst', 'Amethyst', 'purple', 282, 52], ['orchid', 'Orchid', 'purple', 300, 50],
    ['plum', 'Plum', 'purple', 318, 46], ['magenta', 'Magenta', 'purple', 330, 60], ['blush', 'Blush', 'purple', 350, 38],
    ['raspberry', 'Raspberry', 'purple', 338, 58],
    ['emerald', 'Emerald', 'green', 150, 55], ['jade', 'Jade', 'green', 168, 52], ['moss', 'Moss', 'green', 92, 38],
    ['sage', 'Sage', 'green', 134, 20], ['mint', 'Mint', 'green', 158, 66], ['fern', 'Fern', 'green', 118, 48],
    ['eucalyptus', 'Eucalyptus', 'green', 176, 22],
    ['amber', 'Amber', 'warm', 40, 64], ['honey', 'Honey', 'warm', 48, 52], ['terracotta', 'Terracotta', 'warm', 14, 50],
    ['copper', 'Copper', 'warm', 26, 54], ['coral', 'Coral', 'warm', 6, 62], ['peach', 'Peach', 'warm', 20, 70],
    ['autumn', 'Autumn', 'warm', 32, 48], ['crimson', 'Crimson', 'warm', 352, 58]
  ];
  const GENERATED = [];
  for (const [id, name, family, h, s] of HUES) {
    GENERATED.push(T(id + '-light', name + ' Light', 'light', family, hsl(h, s * 0.7, 95), hsl(h, s * 0.6, 98.5), hsl(h, s * 0.5, 12), hsl(h, 72, 38)));
    GENERATED.push(T(id + '-dark', name + ' Dark', 'dark', family, hsl(h, s * 0.5, 10.5), hsl(h, s * 0.45, 14.5), hsl(h, s * 0.35 + 8, 92), hsl(h, 80, 66)));
  }
  const BUILTIN = HAND.concat(GENERATED).map(t => Object.freeze({ ...t, builtin: true }));

  const FAMILIES = [['all', 'All'], ['light', 'Light'], ['dark', 'Dark'], ['neutral', 'Neutral'], ['professional', 'Professional'],
    ['blue', 'Blue'], ['purple', 'Purple & pink'], ['green', 'Green'], ['warm', 'Warm'], ['contrast', 'High contrast'],
    ['retro', 'Retro & terminal'], ['colourful', 'Colourful'], ['custom', 'Custom']];
  const ACCENTS = [['Blue', '#2563eb'], ['Indigo', '#4f46e5'], ['Violet', '#7c3aed'], ['Purple', '#9333ea'], ['Magenta', '#c026d3'],
    ['Pink', '#db2777'], ['Rose', '#e11d48'], ['Red', '#dc2626'], ['Coral', '#f0654a'], ['Orange', '#ea580c'], ['Amber', '#d97706'],
    ['Gold', '#ca8a04'], ['Yellow', '#eab308'], ['Lime', '#65a30d'], ['Green', '#16a34a'], ['Emerald', '#059669'], ['Teal', '#0d9488'],
    ['Cyan', '#0891b2'], ['Sky', '#0284c7'], ['Navy', '#1e3a8a'], ['Slate', '#475569'], ['Graphite', '#374151'], ['Brown', '#92400e'],
    ['Copper', '#b45309']];

  const HEX = /^#[0-9a-f]{6}$/i;
  const find = (id, custom = []) => BUILTIN.find(t => t.id === id) || (custom || []).find(t => t && t.id === id) || null;
  const all = (custom = []) => BUILTIN.concat((custom || []).map(t => ({ ...t, family: 'custom', builtin: false })));

  // Everything a page needs, derived from the four base colours. accentOverride replaces the theme's accent only.
  function tokens(t, accentOverride) {
    const dark = t.mode === 'dark', bg = t.bg, panel = t.panel;
    const ink = readable(t.ink, [bg, panel], 7);
    const accent = readable(HEX.test(accentOverride || '') ? accentOverride : t.accent, [bg, panel], 3);
    const muted = readable(mix(ink, bg, dark ? 0.32 : 0.36), [bg, panel], 4.5);
    const warn = readable(dark ? '#f0b44c' : '#8a5200', [bg, panel], 4.5);
    return {
      '--bg': bg, '--panel': panel, '--ink': ink, '--muted': muted,
      '--chrome': dark ? mix(bg, '#000000', 0.38) : mix(bg, ink, 0.09),
      '--line': mix(bg, ink, dark ? 0.22 : 0.2),
      '--accent': accent, '--accent-bg': mix(bg, accent, dark ? 0.3 : 0.16),
      '--on-accent': contrast(accent, '#ffffff') >= contrast(accent, '#000000') ? '#ffffff' : '#000000',
      '--warn': warn, '--warn-bg': mix(bg, warn, 0.2),
      '--danger': readable(dark ? '#ff8a80' : '#b3261e', [bg, panel], 4.5),
      '--ok': readable(dark ? '#5fd08a' : '#1f7a4a', [bg, panel], 4.5)
    };
  }
  // A user-made theme from untrusted data (settings file or the builder). Returns a clean theme or null.
  function validateCustom(o) {
    if (!o || typeof o !== 'object') return null;
    const name = String(o.name || '').trim().slice(0, 40), id = String(o.id || '');
    if (!name || !/^custom-[a-z0-9]{3,16}$/.test(id) || (o.mode !== 'light' && o.mode !== 'dark')) return null;
    for (const k of ['bg', 'panel', 'ink', 'accent']) if (!HEX.test(String(o[k] || ''))) return null;
    return { id, name, mode: o.mode, bg: o.bg.toLowerCase(), panel: o.panel.toLowerCase(), ink: o.ink.toLowerCase(), accent: o.accent.toLowerCase() };
  }

  return { BUILTIN, FAMILIES, ACCENTS, HEX, find, all, tokens, validateCustom, contrast, mix, readable, hsl };
});
