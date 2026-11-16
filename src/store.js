'use strict';
// Metadata only: workspace labels, session labels, partition names, last path.
// Never passwords, cookies, tokens, page titles or URL query strings.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

function isHttp(u) { try { const p = new URL(u).protocol; return p === 'http:' || p === 'https:'; } catch { return false; } }

const Engines = require('./ui/engines.js');
// Words typed instead of an address go to the chosen search engine. searchUrl is that engine's template (see engines.js).
function normalizeUrl(input, { strict = false, searchUrl = null } = {}) {
  const s = String(input || '').trim();
  if (!s) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[a-z0-9.-]+:\d+/i.test(s);
  if (hasScheme) { return isHttp(s) ? new URL(s).toString() : null; }
  const looksLikeHost = !/\s/.test(s) && (/^localhost(:\d+)?([/?#]|$)/i.test(s) || /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/.test(s));
  if (looksLikeHost) {
    const local = /^(localhost|127\.|\d+\.\d+\.\d+\.\d+)/i.test(s);
    try { return new URL((local ? 'http://' : 'https://') + s).toString(); } catch { return null; }
  }
  return strict ? null : Engines.searchUrl(searchUrl || Engines.template(null), s);
}

// Persist origin + path only. Query strings and fragments can carry tokens.
function persistedUrl(u) {
  try { const x = new URL(u); return (x.protocol === 'http:' || x.protocol === 'https:') ? x.origin + x.pathname : null; } catch { return null; }
}

class Store {
  constructor(file) { this.file = file; this.recovered = false; this.data = this._load(); }
  _empty() { return { version: 1, workspaces: [], sessions: [], googleAccounts: [], downloads: [], history: [], ui: { activeWorkspaceId: null, sidebarOpen: true, theme: 'system', homeUrl: '' } }; }
  _load() {
    let raw;
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return this._empty(); raw = null; }
    try {
      const d = JSON.parse(raw);
      if (!d || !Array.isArray(d.workspaces) || !Array.isArray(d.sessions)) throw new Error('shape');
      d.ui = d.ui || { activeWorkspaceId: null };
      d.ui.theme = d.ui.theme || 'system';
      d.ui.homeUrl = d.ui.homeUrl || '';
      d.googleAccounts = d.googleAccounts || [];
      for (const g of d.googleAccounts) g.provider = g.provider || 'google';   // 'googleAccounts' now holds saved sessions of any provider
      d.downloads = Array.isArray(d.downloads) ? d.downloads : [];
      { const m = d.ui.maxDownloadSpeed;   // the peak speed record: drop anything that is not a plain record
        if (!(m && Number.isFinite(m.bps) && m.bps > 0 && Number.isFinite(m.at))) delete d.ui.maxDownloadSpeed;
        else d.ui.maxDownloadSpeed = { bps: m.bps, at: m.at, name: String(m.name || '').slice(0, 150) }; }
      if (d.ui.searchEngine !== undefined && d.ui.searchEngine !== 'custom' && !Engines.byId(d.ui.searchEngine)) delete d.ui.searchEngine;
      d.history = Array.isArray(d.history) ? d.history : [];
      return d;
    } catch {
      try { fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch {}
      this.recovered = true;
      return this._empty();
    }
  }
  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  get workspaces() { return [...this.data.workspaces].sort((a, b) => a.sortOrder - b.sortOrder); }
  workspace(id) { return this.data.workspaces.find(w => w.id === id) || null; }
  session(id) { return this.data.sessions.find(s => s.id === id) || null; }
  sessionsOf(wsId) {
    return this.data.sessions.filter(s => s.workspaceId === wsId)
      .sort((a, b) => (a.sortOrder - b.sortOrder) || (a.createdAt - b.createdAt));
  }
  get activeWorkspaceId() { return this.data.ui.activeWorkspaceId; }
  addWorkspace(label, startUrl) {
    const ws = { id: randomUUID(), label: String(label).trim().slice(0, 40), startUrl,
      sortOrder: Math.max(0, ...this.data.workspaces.map(w => w.sortOrder)) + 1, lastSessionId: null };
    this.data.workspaces.push(ws); this._save(); return ws;
  }
  // Removes the history that belongs to an account. Visits made in a tab with no account (a waiting session) are only detached from it, so
  // the list of websites you visited stays complete. `all` forces removal of every match.
  _dropHistory(match, all = false) {
    const accounts = new Set(this.data.sessions.filter(x => x.status === 'assigned').map(x => x.id));
    this.data.history = this.data.history.filter(h => {
      if (!match(h)) return true;
      if (all || accounts.has(h.sessionId)) return false;
      h.sessionId = null; h.workspaceId = null; return true;
    });
  }
  removeWorkspace(id) {
    const removed = this.sessionsOf(id);
    this._dropHistory(h => h.workspaceId === id);   // before the sessions go: it needs to know which were accounts
    this.data.sessions = this.data.sessions.filter(s => s.workspaceId !== id);
    this.data.workspaces = this.data.workspaces.filter(w => w.id !== id);
    if (this.data.ui.activeWorkspaceId === id) this.data.ui.activeWorkspaceId = this.workspaces[0]?.id || null;
    this._save(); return removed;
  }
  // Drag-and-drop tab order: put the website at position toIndex (0-based) of the tab strip.
  updateWorkspace(id, patch) { const w = this.workspace(id); if (w) { Object.assign(w, patch); this._save(); } return w; }
  moveWorkspace(id, toIndex) {
    const list = this.workspaces, from = list.findIndex(w => w.id === id);
    const to = Math.max(0, Math.min(list.length - 1, Number(toIndex)));
    if (from < 0 || !Number.isInteger(to) || from === to) return null;
    const [moved] = list.splice(from, 1); list.splice(to, 0, moved);
    list.forEach((w, i) => { w.sortOrder = i + 1; });
    this._save(); return moved;
  }
  addSession(wsId) {
    const now = Date.now();
    const s = { id: randomUUID(), workspaceId: wsId, label: null, status: 'pending', partition: 'sb-' + randomUUID(),
      createdAt: now, lastUsedAt: now, lastUrl: null, sortOrder: 0, isPinned: false };
    this.data.sessions.push(s); this._save(); return s;
  }
  assign(id, label) {
    const s = this.session(id); if (!s) throw new Error('Session not found');
    const l = String(label || '').trim().slice(0, 40); if (!l) throw new Error('Enter a name for this account');
    s.label = l; s.status = 'assigned';
    s.sortOrder = Math.max(0, ...this.sessionsOf(s.workspaceId).filter(x => x.status === 'assigned').map(x => x.sortOrder)) + 1;
    this._save(); return s;
  }
  updateSession(id, patch) { const s = this.session(id); if (s) { Object.assign(s, patch); this._save(); } return s; }
  moveSession(id, dir) {
    const s = this.session(id);
    if (!s || s.status !== 'assigned') return null;
    const list = this.sessionsOf(s.workspaceId).filter(x => x.status === 'assigned');
    const idx = list.findIndex(x => x.id === id);
    if (idx < 0) return null;
    const target = dir === 'up' ? idx - 1 : dir === 'down' ? idx + 1 : -1;
    if (target < 0 || target >= list.length) return null;
    const [moved] = list.splice(idx, 1);
    list.splice(target, 0, moved);
    list.forEach((x, i) => { x.sortOrder = i + 1; });
    this._save();
    return s;
  }
  // Drag-and-drop order: put the account at position toIndex among its website's accounts.
  moveSessionTo(id, toIndex) {
    const s = this.session(id);
    if (!s || s.status !== 'assigned') return null;
    const list = this.sessionsOf(s.workspaceId).filter(x => x.status === 'assigned');
    const from = list.findIndex(x => x.id === id), to = Math.max(0, Math.min(list.length - 1, Number(toIndex)));
    if (from < 0 || !Number.isInteger(to) || from === to) return null;
    const [moved] = list.splice(from, 1); list.splice(to, 0, moved);
    list.forEach((x, i) => { x.sortOrder = i + 1; });
    this._save(); return s;
  }
  // Recent pages, per account. The address has no query or fragment (the caller passes the cleaned URL), so tokens never land here.
  touchHistory(sessionId, url, title = '') {
    // Every page opened in any tab is kept, whether or not the tab has an account (sessionId may even be gone later).
    const s = this.session(sessionId); if (!s || this.data.ui.saveHistory === false || !/^https?:\/\//i.test(String(url))) return null;
    title = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const h = this.data.history, i = h.findIndex(x => x.sessionId === sessionId && x.url === url);
    const now = Date.now();
    if (i >= 0) {
      const e = h[i];
      if (i === 0 && (!title || title === e.title) && now - e.at < 30000) return e;   // nothing new: no disk write
      if (title) e.title = title; e.at = now; h.splice(i, 1); h.unshift(e);
    } else h.unshift({ sessionId, workspaceId: s.workspaceId, url: String(url).slice(0, 500), title, at: now });
    if (h.length > 1000) h.length = 1000;
    this._save(); return h[0];
  }
  setHello(on) { this.data.ui.requireHello = !!on; this._save(); }
  clearHistory() { this.data.history = []; this._save(); }
  removeSession(id) {
    const s = this.session(id); if (!s) return null;
    this.data.sessions = this.data.sessions.filter(x => x.id !== id);
    this._dropHistory(h => h.sessionId === id, s.status === 'assigned');   // an account's pages go with it; a tab without an account keeps its visits
    const ws = this.workspace(s.workspaceId);
    if (ws && ws.lastSessionId === id) ws.lastSessionId = this.sessionsOf(ws.id)[0]?.id || null;
    this._save(); return s;
  }
  googleAccount(id) { return this.data.googleAccounts.find(x => x.id === id) || null; }
  findGoogleByEmail(email, exceptId) {
    const e = String(email || '').toLowerCase();
    return (e && this.data.googleAccounts.find(x => x.email === e && x.id !== exceptId)) || null;
  }
  addGoogle(label, email = null, provider = 'google') {
    const g = { id: randomUUID(), provider, label: String(label).trim().slice(0, 80), email: email ? String(email).toLowerCase() : null,
      partition: 'google-' + randomUUID(), signedIn: false, addedAt: Date.now() };
    this.data.googleAccounts.push(g); this._save(); return g;
  }
  updateGoogle(id, patch) { const g = this.googleAccount(id); if (g) { Object.assign(g, patch); this._save(); } return g; }
  removeGoogle(id) {
    this.data.googleAccounts = this.data.googleAccounts.filter(x => x.id !== id);
    for (const s of this.data.sessions) if (s.googleId === id) s.googleId = null;
    this._save();
  }
  // Download history: file name, saved path, source host, size, state, and the address WITHOUT its query or fragment (the part
  // that can carry tokens). The full address lives in memory only, for the current run.
  upsertDownload(rec) {
    const i = this.data.downloads.findIndex(d => d.id === rec.id);
    if (i >= 0) this.data.downloads[i] = rec; else this.data.downloads.unshift(rec);
    this.data.downloads = this.data.downloads.slice(0, 200); this._save();
  }
  removeDownload(id) { this.data.downloads = this.data.downloads.filter(d => d.id !== id); this._save(); }
  clearDownloads(keep) { this.data.downloads = this.data.downloads.filter(d => keep(d.id)); this._save(); }
  // The fastest download speed ever seen (bytes per second, smoothed by the download manager). Returns true if this is a new record.
  // save=false only updates memory (the manager flushes now and then, so a fast download does not write the file every half second).
  noteMaxSpeed(bps, name, at = Date.now(), { save = true } = {}) {
    const cur = this.data.ui.maxDownloadSpeed;
    if (!Number.isFinite(bps) || bps <= 0 || (cur && cur.bps >= bps)) return false;
    this.data.ui.maxDownloadSpeed = { bps: Math.round(bps), at, name: String(name || '').slice(0, 150) };
    if (save) this._save();
    return true;
  }
  flush() { this._save(); }
  setSidebar(open) { this.data.ui.sidebarOpen = !!open; this._save(); }
  // Appearance settings are validated here so a bad value (from the UI or a damaged file) can never reach a page as CSS.
  setSettings(patch) {
    const ui = this.data.ui, Themes = require('./ui/themes.js');
    const oneOf = (v, list) => list.includes(v);
    const id = v => /^[a-z0-9-]{1,40}$/.test(String(v));
    if (patch.theme !== undefined && (patch.theme === 'system' || id(patch.theme))) ui.theme = String(patch.theme);
    if (patch.themeLight !== undefined && id(patch.themeLight)) ui.themeLight = String(patch.themeLight);
    if (patch.themeDark !== undefined && id(patch.themeDark)) ui.themeDark = String(patch.themeDark);
    if (patch.homeUrl !== undefined) ui.homeUrl = String(patch.homeUrl).trim();
    if (typeof patch.saveHistory === 'boolean') ui.saveHistory = patch.saveHistory;
    if (patch.helloMinutes !== undefined && [1, 5, 15, 60].includes(Number(patch.helloMinutes))) ui.helloMinutes = Number(patch.helloMinutes);
    // NOTE: requireHello is deliberately NOT settable here. It changes only through setHello(), after Windows has verified the user.
    if (patch.maxDownloadSpeed === null) delete ui.maxDownloadSpeed;   // the record can only be cleared from the UI, never set
    if (patch.searchEngine !== undefined && (patch.searchEngine === 'custom' || Engines.byId(patch.searchEngine))) ui.searchEngine = patch.searchEngine;
    if (patch.searchCustom !== undefined) { const c = Engines.checkTemplate(patch.searchCustom); if (c.ok) ui.searchCustom = c.url; }
    if (patch.downloadDir !== undefined) ui.downloadDir = patch.downloadDir === null ? null : (require('path').isAbsolute(String(patch.downloadDir)) ? String(patch.downloadDir) : ui.downloadDir);
    if (patch.accent !== undefined) ui.accent = patch.accent === null ? null : (Themes.HEX.test(String(patch.accent)) ? String(patch.accent).toLowerCase() : ui.accent);
    if (patch.density !== undefined && oneOf(patch.density, ['compact', 'comfortable', 'spacious'])) ui.density = patch.density;
    if (patch.radius !== undefined && oneOf(patch.radius, ['sharp', 'subtle', 'rounded'])) ui.radius = patch.radius;
    if (patch.fontScale !== undefined && oneOf(patch.fontScale, ['small', 'default', 'large', 'xl'])) ui.fontScale = patch.fontScale;
    if (patch.motion !== undefined && oneOf(patch.motion, ['system', 'reduced', 'off'])) ui.motion = patch.motion;
    if (Array.isArray(patch.customThemes)) ui.customThemes = patch.customThemes.map(Themes.validateCustom).filter(Boolean).slice(0, 30);
    if (Array.isArray(patch.recentThemes)) ui.recentThemes = patch.recentThemes.filter(id).map(String).slice(0, 6);
    this._save();
  }
  select(wsId, sessionId) { const ws = this.workspace(wsId); if (ws) { ws.lastSessionId = sessionId; this._save(); } }
  setActive(wsId) { this.data.ui.activeWorkspaceId = wsId; this._save(); }
}

module.exports = { Store, normalizeUrl, persistedUrl, isHttp };
