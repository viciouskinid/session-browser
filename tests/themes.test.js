'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Themes = require('../src/ui/themes.js');

test('the catalogue has 80+ distinct themes, unique ids, valid modes, and keeps the original theme ids', () => {
  const ids = Themes.BUILTIN.map(t => t.id);
  assert.ok(Themes.BUILTIN.length >= 80, 'count ' + Themes.BUILTIN.length);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ['light', 'dark', 'midnight', 'nord', 'dracula', 'solarized-light', 'solarized-dark', 'forest', 'rose', 'sunset', 'lavender', 'coffee']) assert.ok(ids.includes(id), id);
  for (const t of Themes.BUILTIN) { assert.ok(['light', 'dark'].includes(t.mode), t.id); for (const k of ['bg', 'panel', 'ink', 'accent']) assert.match(t[k], Themes.HEX, t.id + '.' + k); }
  const palettes = new Set(Themes.BUILTIN.map(t => [t.bg, t.panel, t.ink, t.accent].join()));
  assert.equal(palettes.size, Themes.BUILTIN.length);   // no two themes are the same palette
  assert.ok(Themes.BUILTIN.filter(t => t.mode === 'light').length >= 30 && Themes.BUILTIN.filter(t => t.mode === 'dark').length >= 30);
});

test('every theme meets contrast: text on background and surface, muted text, accent, and text on the accent', () => {
  for (const t of Themes.BUILTIN) {
    const k = Themes.tokens(t);
    assert.ok(Themes.contrast(k['--ink'], k['--bg']) >= 4.5, t.id + ' ink/bg');
    assert.ok(Themes.contrast(k['--ink'], k['--panel']) >= 4.5, t.id + ' ink/panel');
    assert.ok(Themes.contrast(k['--muted'], k['--bg']) >= 4.5, t.id + ' muted/bg');
    assert.ok(Themes.contrast(k['--muted'], k['--panel']) >= 4.5, t.id + ' muted/panel');
    assert.ok(Themes.contrast(k['--accent'], k['--bg']) >= 3, t.id + ' accent/bg');
    assert.ok(Themes.contrast(k['--on-accent'], k['--accent']) >= 4.5, t.id + ' on-accent');
    assert.ok(Themes.contrast(k['--danger'], k['--panel']) >= 4.5 && Themes.contrast(k['--warn'], k['--panel']) >= 4.5, t.id + ' status');
    for (const v of Object.values(k)) assert.match(v, Themes.HEX);
  }
  assert.ok(Themes.contrast(Themes.tokens(Themes.find('hc-light'))['--ink'], '#ffffff') >= 15);
});

test('an accent override changes only the accent family, and bad overrides are ignored', () => {
  const t = Themes.find('ocean-light'), base = Themes.tokens(t), over = Themes.tokens(t, '#dc2626');
  assert.notEqual(over['--accent'], base['--accent']);
  assert.equal(over['--bg'], base['--bg']); assert.equal(over['--ink'], base['--ink']);
  assert.deepEqual(Themes.tokens(t, 'red; background:url(x)'), base);
});

test('custom themes are validated; unreadable colours are corrected, not shipped', () => {
  const good = { id: 'custom-abc123', name: ' Mine ', mode: 'dark', bg: '#101010', panel: '#181818', ink: '#EEEEEE', accent: '#FF8800' };
  assert.deepEqual(Themes.validateCustom(good), { ...good, name: 'Mine', ink: '#eeeeee', accent: '#ff8800' });
  for (const bad of [null, {}, { ...good, id: 'x' }, { ...good, mode: 'blue' }, { ...good, bg: 'red' }, { ...good, name: '' }, { ...good, accent: 'url(javascript:1)' }]) assert.equal(Themes.validateCustom(bad), null);
  const k = Themes.tokens({ ...good, ink: '#222222' });   // dark text on a dark background
  assert.ok(Themes.contrast(k['--ink'], k['--bg']) >= 4.5);
  assert.equal(Themes.all([good]).find(t => t.id === good.id).family, 'custom');
});
