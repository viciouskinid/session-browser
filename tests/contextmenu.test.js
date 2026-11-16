'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildTemplate } = require('../src/contextmenu');

const log = [];
const acts = new Proxy({ canGoBack: true, canGoForward: false }, { get: (t, k) => k in t ? t[k] : (...args) => log.push([k, ...args]) });
const labels = t => t.filter(i => i.type !== 'separator').map(i => i.label);
const click = (t, label) => t.find(i => i.label === label).click();

test('a misspelled word offers ALL corrections in one submenu, then Add to dictionary, then the edit commands', () => {
  const t = buildTemplate({ isEditable: true, misspelledWord: 'recieve', dictionarySuggestions: ['receive', 'relieve', 'deceive'], editFlags: { canUndo: true, canCut: true, canCopy: true, canPaste: true, canSelectAll: true } }, acts);
  assert.deepEqual(labels(t).slice(0, 2), ['Spelling', 'Add to dictionary']);
  const sub = t[0].submenu; assert.deepEqual(sub.map(i => i.label), ['receive', 'relieve', 'deceive']);
  assert.ok(labels(t).includes('Paste as plain text'));
  log.length = 0; sub[0].click(); click(t, 'Add to dictionary');
  assert.deepEqual(log, [['replaceMisspelling', 'receive'], ['addToDictionary', 'recieve']]);
  assert.equal(t.find(i => i.label === 'Redo').enabled, false);
});

test('a misspelling with no suggestions still says so and offers the dictionary; non-editable text never shows spelling', () => {
  const t = buildTemplate({ isEditable: true, misspelledWord: 'zzxq', dictionarySuggestions: [], editFlags: {} }, acts);
  assert.equal(t[0].label, 'No spelling suggestions'); assert.equal(t[0].enabled, false);
  assert.ok(!labels(buildTemplate({ isEditable: false, misspelledWord: 'zzxq', selectionText: 'zzxq' }, acts)).includes('Add to dictionary'));
});

test('links, email links, images and media get their own items; no page navigation over them', () => {
  const l = buildTemplate({ linkURL: 'https://example.com/a?b=1', pageURL: 'https://x.test/' }, acts);
  assert.deepEqual(labels(l), ['Open link in new tab', 'Copy link address']);
  assert.deepEqual(labels(buildTemplate({ linkURL: 'mailto:dana@example.com?subject=hi' }, acts)), ['Copy email address']);
  log.length = 0; click(buildTemplate({ linkURL: 'mailto:dana@example.com?subject=hi' }, acts), 'Copy email address');
  assert.deepEqual(log, [['copyText', 'dana@example.com']]);
  assert.deepEqual(labels(buildTemplate({ linkURL: 'javascript:alert(1)' }, acts)), ['Copy link address']);   // never opened as a tab
  assert.deepEqual(labels(buildTemplate({ mediaType: 'image', srcURL: 'https://x.test/p.png', x: 5, y: 6 }, acts)), ['Open image in new tab', 'Copy image', 'Copy image address', 'Save image as…']);
  assert.deepEqual(labels(buildTemplate({ mediaType: 'image', srcURL: 'data:image/png;base64,AAAA' }, acts)), ['Copy image']);
  assert.deepEqual(labels(buildTemplate({ mediaType: 'video', srcURL: 'https://x.test/v.mp4' }, acts)), ['Copy video address', 'Save video as…']);
  assert.deepEqual(labels(buildTemplate({ mediaType: 'image', srcURL: 'https://x.test/p.png', linkURL: 'https://x.test/' }, acts)).slice(0, 2), ['Open link in new tab', 'Copy link address']);
});

test('selected text offers Copy and a web search; a password field never offers Cut or Copy', () => {
  const t = buildTemplate({ selectionText: '  how do tabs work in this browser, really?  ' }, acts);
  assert.equal(labels(t)[0], 'Copy'); assert.match(labels(t)[1], /^Search the web for “how do tabs work in this br…”$/);
  log.length = 0; click(t, labels(t)[1]); assert.deepEqual(log, [['search', 'how do tabs work in this browser, really?']]);
  const pw = labels(buildTemplate({ isEditable: true, inputFieldType: 'password', editFlags: { canPaste: true } }, acts));
  assert.ok(!pw.includes('Copy') && !pw.includes('Cut') && !pw.includes('Paste as plain text') && pw.includes('Paste'));
});

test('a plain page area shows navigation, with Forward disabled when there is nothing ahead', () => {
  const t = buildTemplate({ pageURL: 'https://x.test/' }, acts);
  assert.deepEqual(labels(t), ['Back', 'Forward', 'Reload', 'Copy page address', 'Print…', 'Select all']);
  assert.equal(t.find(i => i.label === 'Back').enabled, true); assert.equal(t.find(i => i.label === 'Forward').enabled, false);
  assert.ok(t[t.length - 1].type !== 'separator');
});

test('a long list of suggestions is still one submenu entry', () => {
  const many = Array.from({ length: 20 }, (_, i) => 'word' + i);
  const t = buildTemplate({ isEditable: true, misspelledWord: 'wrod', dictionarySuggestions: many, editFlags: {} }, acts);
  assert.equal(t.filter(i => i.submenu).length, 1); assert.equal(t[0].submenu.length, 12);
  assert.equal(labels(t).filter(l => /^word/.test(l)).length, 0);   // none leak into the top level
});
