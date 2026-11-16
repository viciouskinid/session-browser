'use strict';
// Search engines for the address bar (what happens when you type words instead of an address). Shared by the main process, the
// settings page and the tests. An engine is a URL template with %s where the search words go. A custom engine typed by the
// user is checked here too, so a bad value (from the UI or a damaged settings file) can never become a navigation target.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Engines = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const ENGINES = [
    { id: 'duckduckgo', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
    { id: 'google', name: 'Google', url: 'https://www.google.com/search?q=%s' },
    { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q=%s' },
    { id: 'brave', name: 'Brave Search', url: 'https://search.brave.com/search?q=%s' },
    { id: 'startpage', name: 'Startpage', url: 'https://www.startpage.com/do/search?q=%s' },
    { id: 'ecosia', name: 'Ecosia', url: 'https://www.ecosia.org/search?q=%s' },
    { id: 'qwant', name: 'Qwant', url: 'https://www.qwant.com/?q=%s' },
    { id: 'yahoo', name: 'Yahoo', url: 'https://search.yahoo.com/search?p=%s' },
    { id: 'kagi', name: 'Kagi', url: 'https://kagi.com/search?q=%s' },
    { id: 'wikipedia', name: 'Wikipedia', url: 'https://en.wikipedia.org/w/index.php?search=%s' }
  ];
  const DEFAULT_ID = 'duckduckgo';
  const MAX = 500;

  // A custom template must be an http(s) address that contains %s (where the words go). Returns { ok, url } or { ok:false, error }.
  function checkTemplate(t) {
    const s = String(t == null ? '' : t).trim();
    if (!s) return { ok: false, error: 'Enter the search address, for example https://example.com/search?q=%s' };
    if (s.length > MAX) return { ok: false, error: 'That address is too long.' };
    if (!s.includes('%s')) return { ok: false, error: 'The address must contain %s where the search words go, for example https://example.com/search?q=%s' };
    let u;
    try { u = new URL(s.split('%s').join('test')); } catch { return { ok: false, error: 'That is not a valid address. Start it with https://' }; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: 'Only http and https search addresses are supported.' };
    if (u.username || u.password) return { ok: false, error: 'Leave user names and passwords out of the address.' };
    if (!u.hostname) return { ok: false, error: 'That address has no website name.' };
    return { ok: true, url: s };
  }
  const byId = id => ENGINES.find(e => e.id === id) || null;
  // The template in force for the saved settings (ui.searchEngine: an id or 'custom', ui.searchCustom: the typed template).
  function template(ui) {
    ui = ui || {};
    if (ui.searchEngine === 'custom') { const c = checkTemplate(ui.searchCustom); if (c.ok) return c.url; }
    return (byId(ui.searchEngine) || byId(DEFAULT_ID)).url;
  }
  function label(ui) {
    ui = ui || {};
    if (ui.searchEngine === 'custom' && checkTemplate(ui.searchCustom).ok) { try { return new URL(String(ui.searchCustom).split('%s').join('x')).hostname.replace(/^www\./, ''); } catch { /* fall through */ } }
    return (byId(ui.searchEngine) || byId(DEFAULT_ID)).name;
  }
  const searchUrl = (tpl, words) => String(tpl).split('%s').join(encodeURIComponent(String(words)));

  return { ENGINES, DEFAULT_ID, checkTemplate, byId, template, label, searchUrl };
});
