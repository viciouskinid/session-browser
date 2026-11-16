'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { Store, normalizeUrl, persistedUrl } = require('../src/store');

test('normalizeUrl', () => {
  assert.equal(normalizeUrl('mail.google.com', { strict: true }), 'https://mail.google.com/');
  assert.equal(normalizeUrl('localhost:3000'), 'http://localhost:3000/');
  assert.equal(normalizeUrl('javascript:alert(1)'), null);
  assert.equal(normalizeUrl('file:///etc/passwd'), null);
  assert.equal(normalizeUrl('hello world', { strict: true }), null);
  assert.match(normalizeUrl('hello world'), /^https:\/\/duckduckgo\.com\/\?q=hello%20world$/);
});
test('persistedUrl drops query and fragment', () => {
  assert.equal(persistedUrl('https://a.com/x/y?token=1#frag'), 'https://a.com/x/y');
  assert.equal(persistedUrl('data:text/html,hi'), null);
});

test('accounts panel preference is remembered', () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const { Store } = require('../src/store');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-store-')), 'm.json');
  const a = new Store(f);
  assert.notEqual(a.data.ui.sidebarOpen, false);          // open by default
  a.setSidebar(false);
  assert.equal(new Store(f).data.ui.sidebarOpen, false);
});

test('moveWorkspace reorders tabs and persists the order', () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const { Store } = require('../src/store');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ws-')), 'm.json');
  const st = new Store(file);
  const [a, b, c] = ['a.example', 'b.example', 'c.example'].map(h => st.addWorkspace(h, 'https://' + h));
  assert.ok(st.moveWorkspace(c.id, 0));
  assert.deepEqual(st.workspaces.map(w => w.id), [c.id, a.id, b.id]);
  assert.ok(st.moveWorkspace(c.id, 2));
  assert.deepEqual(st.workspaces.map(w => w.id), [a.id, b.id, c.id]);
  assert.equal(st.moveWorkspace(a.id, 0), null);                       // no-op
  assert.deepEqual(new Store(file).workspaces.map(w => w.id), [a.id, b.id, c.id]);   // survives a restart
});

test('recent pages are kept per account, de-duplicated, capped, removable and switchable off', () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const { Store } = require('../src/store');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-hist-')), 'm.json');
  const st = new Store(file), w = st.addWorkspace('a', 'https://a.example');
  const a = st.addSession(w.id), b = st.addSession(w.id);
  st.touchHistory(a.id, 'https://a.example/x', 'X page'); st.touchHistory(b.id, 'https://a.example/x', 'X page');
  st.touchHistory(a.id, 'https://a.example/y', 'Y'); st.touchHistory(a.id, 'https://a.example/x', 'X page renamed');
  assert.deepEqual(st.data.history.map(h => [h.sessionId === a.id ? 'a' : 'b', h.url, h.title]), [['a', 'https://a.example/x', 'X page renamed'], ['a', 'https://a.example/y', 'Y'], ['b', 'https://a.example/x', 'X page']]);
  assert.equal(st.touchHistory(a.id, 'javascript:alert(1)', 't'), null);
  assert.equal(new Store(file).data.history.length, 3);                       // survives a restart
  st.removeSession(b.id); assert.equal(st.data.history.filter(h => h.sessionId === b.id).length, 0);
  st.setSettings({ saveHistory: false }); assert.equal(st.touchHistory(a.id, 'https://a.example/z', 'Z'), null);
  st.setSettings({ saveHistory: true }); for (let i = 0; i < 1020; i++) st.touchHistory(a.id, 'https://a.example/p' + i, 'P');
  assert.equal(st.data.history.length, 1000);
  st.clearHistory(); assert.equal(st.data.history.length, 0);
});

test('Windows Hello requirement cannot be switched by an ordinary settings save', () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const { Store } = require('../src/store');
  const st = new Store(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-hello-')), 'm.json'));
  st.setSettings({ requireHello: true, helloMinutes: 15 });
  assert.notEqual(st.data.ui.requireHello, true); assert.equal(st.data.ui.helloMinutes, 15);
  st.setSettings({ helloMinutes: 7 }); assert.equal(st.data.ui.helloMinutes, 15);   // only the offered choices
  st.setHello(true); assert.equal(st.data.ui.requireHello, true); st.setHello(false); assert.equal(st.data.ui.requireHello, false);
});

test('appearance settings are validated before they are stored', () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const { Store } = require('../src/store');
  const st = new Store(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-set-')), 'm.json'));
  st.setSettings({ theme: 'nord', accent: '#AABBCC', density: 'compact', radius: 'rounded', fontScale: 'large', motion: 'reduced', recentThemes: ['nord', 'bad id!', 'dark'] });
  const ui = st.data.ui;
  assert.deepEqual([ui.theme, ui.accent, ui.density, ui.radius, ui.fontScale, ui.motion], ['nord', '#aabbcc', 'compact', 'rounded', 'large', 'reduced']);
  assert.deepEqual(ui.recentThemes, ['nord', 'dark']);
  st.setSettings({ theme: 'x; y', accent: 'red', density: 'huge', radius: '99px', fontScale: 3, motion: 'sometimes', customThemes: [{ id: 'custom-abc', name: 'A', mode: 'dark', bg: '#000000', panel: '#111111', ink: '#ffffff', accent: '#ff0000' }, { id: 'bad' }] });
  assert.deepEqual([ui.theme, ui.accent, ui.density, ui.radius, ui.fontScale, ui.motion], ['nord', '#aabbcc', 'compact', 'rounded', 'large', 'reduced']);   // bad values ignored
  assert.equal(ui.customThemes.length, 1);
  st.setSettings({ accent: null }); assert.equal(ui.accent, null);
  const abs = path.join(os.tmpdir(), 'dl');
  st.setSettings({ downloadDir: abs }); assert.equal(ui.downloadDir, abs);
  st.setSettings({ downloadDir: 'relative/dir' }); assert.equal(ui.downloadDir, abs);   // only absolute paths
  st.setSettings({ downloadDir: null }); assert.equal(ui.downloadDir, null);               // back to the default folder
});

test('moveSessionTo reorders accounts by drag and drop and persists', () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const { Store } = require('../src/store');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ms-')), 'm.json');
  const st = new Store(file), w = st.addWorkspace('a', 'https://a.example');
  const ids = ['x', 'y', 'z'].map(n => { const s = st.addSession(w.id); st.updateSession(s.id, { status: 'assigned', label: n }); return s.id; });
  const order = () => st.sessionsOf(w.id).filter(x => x.status === 'assigned').map(x => x.label);
  assert.ok(st.moveSessionTo(ids[2], 0)); assert.deepEqual(order(), ['z', 'x', 'y']);
  assert.ok(st.moveSessionTo(ids[2], 2)); assert.deepEqual(order(), ['x', 'y', 'z']);
  assert.equal(st.moveSessionTo(ids[0], 0), null);
  assert.equal(st.addGoogle('G').provider, 'google'); assert.equal(st.addGoogle('F', null, 'facebook').provider, 'facebook');
});

test('typed words go to the chosen search engine, and a custom engine is validated', () => {
  const E = require('../src/ui/engines.js');
  assert.equal(normalizeUrl('two words', { searchUrl: E.byId('google').url }), 'https://www.google.com/search?q=two%20words');
  assert.equal(normalizeUrl('a&b=c', { searchUrl: 'https://x.example/s?q=%s&hl=en' }), 'https://x.example/s?q=a%26b%3Dc&hl=en');
  assert.equal(normalizeUrl('mail.google.com', { searchUrl: E.byId('bing').url }), 'https://mail.google.com/');   // an address is still an address
  for (const bad of ['', 'https://x.example/', 'ftp://x.example/?q=%s', 'javascript:%s', 'https://u:p@x.example/?q=%s', 'not a url %s'])
    assert.equal(E.checkTemplate(bad).ok, false, bad);
  assert.equal(E.template({ searchEngine: 'custom', searchCustom: 'https://x.example/?q=%s' }), 'https://x.example/?q=%s');
  assert.equal(E.template({ searchEngine: 'custom', searchCustom: 'oops' }), E.byId(E.DEFAULT_ID).url);        // a bad custom value falls back
  assert.equal(E.template({ searchEngine: 'nope' }), E.byId(E.DEFAULT_ID).url);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-eng-')), st = new Store(path.join(dir, 'm.json'));
  st.setSettings({ searchEngine: 'brave' }); assert.equal(st.data.ui.searchEngine, 'brave');
  st.setSettings({ searchEngine: 'evil' }); assert.equal(st.data.ui.searchEngine, 'brave');                   // unknown ids are ignored
  st.setSettings({ searchCustom: 'javascript:%s' }); assert.equal(st.data.ui.searchCustom, undefined);
  st.setSettings({ searchEngine: 'custom', searchCustom: 'https://x.example/?q=%s' }); assert.equal(E.template(st.data.ui), 'https://x.example/?q=%s');
});

test('the peak download speed is a record: it only goes up, survives a restart, and can only be cleared', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-max-')), file = path.join(dir, 'm.json'), st = new Store(file);
  assert.equal(st.noteMaxSpeed(1000, 'a.zip', 5), true);
  assert.equal(st.noteMaxSpeed(900, 'b.zip', 6), false);
  assert.equal(st.noteMaxSpeed(NaN, 'c.zip', 7), false);
  assert.equal(st.noteMaxSpeed(2500.4, 'd.zip', 8), true);
  assert.deepEqual(new Store(file).data.ui.maxDownloadSpeed, { bps: 2500, at: 8, name: 'd.zip' });
  st.setSettings({ maxDownloadSpeed: 99999999 });                                                              // cannot be set from settings
  assert.equal(st.data.ui.maxDownloadSpeed.bps, 2500);
  st.setSettings({ maxDownloadSpeed: null }); assert.equal(st.data.ui.maxDownloadSpeed, undefined);
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ui: { maxDownloadSpeed: { bps: 'fast' } } }));
  assert.equal(new Store(file).data.ui.maxDownloadSpeed, undefined);                                            // a damaged record is dropped
});

test('history keeps visits from tabs without an account; removing an account still removes its pages', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-hist-')), st = new Store(path.join(dir, 'm.json'));
  const ws = st.addWorkspace('Site', 'https://a.example/'), acct = st.addSession(ws.id), waiting = st.addSession(ws.id);
  st.assign(acct.id, 'Me');
  st.touchHistory(acct.id, 'https://a.example/mine', 'Mine');
  st.touchHistory(waiting.id, 'https://other.example/seen', 'Seen');           // a tab with no account, on another site
  assert.equal(st.data.history.length, 2);
  st.removeSession(waiting.id);
  assert.deepEqual(st.data.history.map(h => h.url).sort(), ['https://a.example/mine', 'https://other.example/seen']);   // kept, detached
  assert.equal(st.data.history.find(h => h.url.endsWith('/seen')).sessionId, null);
  st.removeWorkspace(ws.id);
  assert.deepEqual(st.data.history.map(h => h.url), ['https://other.example/seen']);                                    // the account's pages went with it
});
