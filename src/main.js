'use strict';
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, WebContentsView, ipcMain, session, shell, Menu, nativeTheme, dialog, safeStorage, webContents, clipboard, systemPreferences } = require('electron');
// No QUIC/HTTP3: it opens UDP sockets, which is what makes Windows Firewall ask whether to allow the app.
app.commandLine.appendSwitch('disable-quic');
// Startup/runtime errors are written to startup-error.log in the app's data folder (no URLs or page data) so a silent failure can be diagnosed.
const bootLog = msg => { try { fs.appendFileSync(path.join(app.getPath('userData'), 'startup-error.log'), `${new Date().toISOString()} ${msg}\n`); } catch {} };
process.on('unhandledRejection', err => bootLog('unhandledRejection ' + (err && err.stack || err)));
process.on('uncaughtException', err => {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'startup-error.log'), `${new Date().toISOString()} ${err && err.stack || err}\n`); } catch {}
  console.error(err);
});
if (process.env.SB_USER_DATA) app.setPath('userData', process.env.SB_USER_DATA);
const { Store, normalizeUrl, persistedUrl, isHttp } = require('./store');
const sg = require('./signin');
const { Vault, eligibleOrigin } = require('./vault');
const scope = require('./sitescope');
const providers = require('./providers');
const ctxmenu = require('./contextmenu');
const APP = require('./appinfo');
const hello = require('./hello');
const { DownloadManager } = require('./downloads');
const Engines = require('./ui/engines.js');
const reveal = require('./reveal');
const searchTemplate = () => Engines.template(store && store.data.ui);   // where typed words go (Settings > General > Search engine)
const APP_ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const winIcon = () => (fs.existsSync(APP_ICON) ? APP_ICON : undefined);   // the application logo, for every window the app opens

const SIDEBAR_W = 240, TOP_H = 88;   // 42px tab strip + 46px toolbar
const DL_W = 320;   // docked Downloads panel on the right
// --- Appearance. The chosen theme (built in or custom) is turned into semantic tokens once, here, and the result is sent to
// every page (main UI, side panel, top-right box). The window buttons use the same tokens. Websites follow too: the page's
// "auto" appearance (prefers-color-scheme) is made to match the app, so an auto site is light under a light theme and dark
// under a dark one. With "System" the OS decides, for the app and for websites alike.
const Themes = require('./ui/themes.js');
const RADIUS = { sharp: [2, 3, 4], subtle: [6, 8, 12], rounded: [10, 14, 18] };
const FONT = { small: 0.92, default: 1, large: 1.12, xl: 1.25 };
function resolveTheme(ui) {
  const custom = ui.customThemes || [];
  let id = ui.theme || 'system';
  if (id === 'system') {
    if (nativeTheme.themeSource !== 'system') nativeTheme.themeSource = 'system';   // read the real OS setting
    id = nativeTheme.shouldUseDarkColors ? (ui.themeDark || 'dark') : (ui.themeLight || 'light');
  }
  return Themes.find(id, custom) || Themes.find('light');
}
function appearance() {
  const ui = (store && store.data.ui) || {}, t = resolveTheme(ui);
  if ((ui.theme || 'system') !== 'system' && nativeTheme.themeSource !== t.mode) nativeTheme.themeSource = t.mode;   // websites follow the app
  const r = RADIUS[ui.radius] || RADIUS.subtle;
  return { themeId: t.id, mode: t.mode, vars: Themes.tokens(t, ui.accent), density: ui.density || 'comfortable',
    radius: r, fontScale: FONT[ui.fontScale] || 1, motion: ui.motion || 'system' };
}
function applyTitleBarTheme() {
  if (process.platform === 'darwin' || !win || win.isDestroyed()) return;
  const v = appearance().vars;
  try { win.setTitleBarOverlay({ color: v['--chrome'], symbolColor: v['--ink'], height: 42 }); } catch {}
}

const ALLOWED_PERMS = ['fullscreen', 'clipboard-sanitized-write'];
let win, store, downloads, vault, modalOpen = false, quitting = false, pushQueued = false;
let panelTab = 'downloads';   // which tab the docked side panel shows: downloads | passwords | sessions
let panel = null, panelOpen = false;   // the docked Downloads panel (its own native view, to the right of the page)
const icons = new Map();      // workspaceId -> { url, data } favicon as a data: URL, in memory only
const views = new Map();       // sessionId -> WebContentsView (one isolated partition each)
const titles = new Map();      // in-memory only, never persisted
const errors = new Map();      // in-memory only
const hardened = new Set();
const pmSenders = new Set();       // webContents ids allowed to report logins to the password manager
const blankLoading = new Set();   // sessions whose page has not committed yet (nothing to show): the UI shows a spinner instead
const candidates = new Map();     // sessionId -> a submitted login waiting to be CONFIRMED as successful (memory only, 10 min)
const loginState = new Map();
const APP_START = Date.now();   // sessions created before this are 'restored' (see establishBaseline)
const pageAuthFirst = new Map();   // sessionId -> first storage-token report of a waiting session (to tell 'was already signed in' from 'just signed in')
const pageAuth = new Map();   // sessionId -> true/false: does the loaded page keep a login token in its own storage? (evidence, in memory)     // sessionId -> 'in' | 'out' | 'unknown' (shown as the dot on each account)
const pendingUser = new Map();    // webContents id -> { origin, username, at }: the username typed on a first sign-in step (memory only)
const offers = new Map();         // offerId -> { origin, username, password } waiting for the user's answer (memory only)
const baselines = new Map();           // sessionId -> Map(cookie name|domain -> value hash), in memory only
const authSeen = new Set();            // sessions where a new login-like cookie appeared
const sessionByPartition = new Map();
const googleWins = new Map();
let googleSuffixes = sg.GOOGLE_SUFFIXES;
let googleInfoUrl = sg.LIST_ACCOUNTS_URL;
const googleBusy = new Set(), googleTimers = new Map(), suppressGoogle = new Set(), googlePrompted = new Set();

// Logs carry event names and opaque ids only. Never URLs, titles, cookies or headers.
const log = (event, id) => console.log(`[sb] ${event}${id ? ' ' + id.slice(0, 8) : ''}`);
const partitionOf = s => 'persist:' + s.partition;
const hostOf = u => { try { return new URL(u).hostname; } catch { return ''; } };
const esc = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function hardenSession(part) {
  if (hardened.has(part)) return;
  hardened.add(part);
  const ses = session.fromPartition(part);
  ses.setPermissionRequestHandler((_wc, perm, cb) => cb(ALLOWED_PERMS.includes(perm)));
  ses.setPermissionCheckHandler((_wc, perm) => ALLOWED_PERMS.includes(perm));
  if (downloads) downloads.attach(ses);
}

// Every website always has one waiting (unassigned) session ready, created without opening a page.
function ensurePending(wsId) {
  if (!store.workspace(wsId)) return null;
  return store.sessionsOf(wsId).find(x => x.status === 'pending') || store.addSession(wsId);
}

// Every saved Google account that is signed in. Accounts already used by a session (open or Closed) are NOT excluded:
// choosing one switches to / reopens that session instead of creating a duplicate (see useGoogle).
function chooserAccounts(provider = 'google') {
  return store.data.googleAccounts.filter(g => g.signedIn && (g.provider || 'google') === provider);
}

// Downloads go to <your Downloads folder>\<application name> unless a folder was chosen in Settings.
const defaultDownloadDir = () => path.join(app.getPath('downloads'), APP.NAME);
const downloadDir = () => process.env.SB_DOWNLOADS_DIR || (store && store.data.ui.downloadDir) || defaultDownloadDir();
function setDownloadDir(dir) {
  let d = null;
  if (dir) {
    d = path.resolve(String(dir));
    fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK);   // throws a clear error if it cannot be written
  }
  store.setSettings({ downloadDir: d }); if (downloads) downloads.dir = downloadDir(); push();
}
function currentSession() {
  const ws = store.workspace(store.activeWorkspaceId);
  const s = ws && store.session(ws.lastSessionId);
  return s && s.workspaceId === ws.id ? s : null;
}

const currentWorkspace = () => store.workspace(store.activeWorkspaceId);
const sidebarOpen = () => store.data.ui.sidebarOpen !== false;
// A tab is LOCKED to its site once it has an account: its default address can no longer be edited, and other sites open in tabs of their own.
// Until then (a new tab, or only the Unassigned session) the address is free, and the tab's default follows where you go.
const wsLocked = ws => !!ws && /^https?:/i.test(ws.startUrl || '') && store.sessionsOf(ws.id).some(x => x.status === 'assigned');
// Point a tab at a different site (only while it is not locked). The label follows if it was derived from the old address.
function setDefaultAddress(ws, url) {
  const old = hostOf(ws.startUrl).replace(/^www\./, ''), next = persistedUrl(url) || url;
  const patch = { startUrl: next, loginUrl: null };
  if (ws.label === 'New Tab' || ws.label === old) patch.label = hostOf(next).replace(/^www\./, '') || ws.label;
  store.updateWorkspace(ws.id, patch); push();
}
function layout() {
  if (!win || win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  const sbw = sidebarOpen() ? SIDEBAR_W : 0, dlw = panelOpen ? DL_W : 0;
  const bounds = { x: sbw, y: TOP_H, width: Math.max(0, w - sbw - dlw), height: Math.max(0, h - TOP_H) };
  const cur = currentSession();
  for (const [id, v] of views) { v.setBounds(bounds); v.setVisible(!!cur && id === cur.id && !modalOpen && !blankLoading.has(id)); }
  if (panel) {
    panel.setBounds({ x: Math.max(0, w - DL_W), y: TOP_H, width: DL_W, height: Math.max(0, h - TOP_H) });
    panel.setVisible(panelOpen && !modalOpen);
  }
}

// --- Downloads popup (Chrome-style bubble under the toolbar)
function sendDownloads() {
  if (!downloads) return;
  const p = downloads.payload();
  for (const wc of [win && win.webContents, panel && panel.webContents]) if (wc && !wc.isDestroyed()) wc.send('downloads', p);
}
function createPanel() {
  panel = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  const wc = panel.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', e => e.preventDefault());
  win.contentView.addChildView(panel);
  panel.setVisible(false);
  wc.loadFile(path.join(__dirname, 'ui', 'downloads.html'));
}
function showPanel(tab) {
  if (!panel) createPanel();
  if (['downloads', 'passwords', 'sessions'].includes(tab)) panelTab = tab;
  downloads.checkFiles(); panelOpen = true; layout(); push(); sendDownloads();
  if (!panel.webContents.isDestroyed()) panel.webContents.send('side-tab', panelTab);
}
function hidePanel() { if (!panelOpen) return; panelOpen = false; layout(); push(); }
function togglePanel(tab = 'downloads') { if (panelOpen && panelTab === tab) hidePanel(); else showPanel(tab); }
function toggleSidebar() { store.setSidebar(!sidebarOpen()); layout(); push(); }

// --- Three-dot menu (replaces the application menu) and the accounts right-click menu. Native menus draw above web views.
function openMainMenu(pos) {
  const cur = currentSession(), v = cur && views.get(cur.id);
  const hasPage = !!(v && isHttp(v.webContents.getURL()));
  Menu.buildFromTemplate([
    { label: 'Settings', click: () => win.webContents.send('open-settings') },
    { type: 'separator' },
    { label: 'Open in system browser', enabled: hasPage, click: () => actions.external() },
    { type: 'separator' },
    { label: 'Exit', click: () => app.quit() }
  ]).popup({ window: win, x: Math.round(pos?.x || 0), y: Math.round(pos?.y || 0) });
}
function accountMenu(id) {
  const s = store.session(id); if (!s) return;
  const send = action => win.webContents.send('ctx', { action, id });
  if (s.status === 'assigned') {
    const siblings = store.sessionsOf(s.workspaceId).filter(x => x.status === 'assigned');
    const idx = siblings.findIndex(x => x.id === id);
    const state = loginState.get(id) || 'unknown';
    Menu.buildFromTemplate([
      { label: 'Rename…', click: () => send('rename') },
      { label: s.note ? 'Edit note…' : 'Add note…', click: () => send('note') },
      { type: 'separator' },
      { label: state === 'in' ? 'Log in again' : 'Log in', click: () => actions.loginSession(id).catch(e => notify(e.message)) },
      { label: 'Log out', click: () => actions.logoutSession(id).catch(e => notify(e.message)) },
      ...(views.has(id) ? [] : [{ type: 'separator' }, { label: 'Open', click: () => actions.selectSession(id) }]),
      { type: 'separator' },
      { label: 'Remove account…', click: () => send('remove') }
    ]).popup({ window: win });
  }
}

function snapshot() {
  const cur = currentSession();
  const v = cur && views.get(cur.id);
  let nav = { url: '', loading: false, canBack: false, canForward: false, googleAuth: false };
  if (v && !v.webContents.isDestroyed()) {
    const wc = v.webContents, h = wc.navigationHistory;
    const live = wc.getURL();
    nav = { url: isHttp(live) ? live : (cur.lastUrl || ''), loading: wc.isLoading(), canBack: h.canGoBack(), canForward: h.canGoForward(),
      googleAuth: cur.status === 'pending' && sg.isGoogleAuthPage(live), blankLoading: blankLoading.has(cur.id), home: store.workspace(cur.workspaceId)?.startUrl || '', locked: wsLocked(store.workspace(cur.workspaceId)) };
  }
  return {
    activeWorkspaceId: store.activeWorkspaceId,
    workspaces: store.workspaces.map(w => ({ ...w, icon: icons.get(w.id)?.data || null })),
    sessions: store.data.sessions.map(s => ({ ...s, open: views.has(s.id), title: titles.get(s.id) || '', error: errors.get(s.id) || '', login: s.status === 'assigned' ? (loginState.get(s.id) || 'unknown') : '', looksSignedIn: s.status === 'pending' && authSeen.has(s.id) })),
    historyCount: store.data.history.length, googleAccounts: store.data.googleAccounts, providers: providers.list(), nav, recovered: store.recovered,
    downloadDir: downloadDir(), downloadDirDefault: defaultDownloadDir(), helloSupported: process.platform === 'win32', helloOn: helloOn(), sidebarOpen: sidebarOpen(), downloadsOpen: panelOpen && panelTab === 'downloads', sidePanel: panelOpen ? panelTab : null, platform: process.platform,
    theme: store.data.ui.theme || 'system', homeUrl: store.data.ui.homeUrl || '', appearance: appearance(), ui: store.data.ui, appVersion: app.getVersion()
  };
}

function push() {
  if (pushQueued) return;
  pushQueued = true;
  setImmediate(() => {
    pushQueued = false;
    if (!win || win.isDestroyed()) return;
    const ws = store.workspace(store.activeWorkspaceId), cur = currentSession();
    win.setTitle(ws ? `${ws.label}${cur ? ' — ' + (cur.label || 'Unassigned session') : ''} · Session Browser` : 'Session Browser');
    const snap = snapshot();
    win.webContents.send('state', snap);
    if (panel && !panel.webContents.isDestroyed()) panel.webContents.send('state', snap);
  });
}

function errorPage(desc, host) {
  const html = `<!doctype html><meta charset=utf-8><title>Can’t load page</title><body style="font:16px system-ui;margin:12vh auto;max-width:480px;color:#333">
  <h2>Can’t reach ${esc(host || 'this site')}</h2><p>${esc(desc)}</p><p>Check your connection, then press reload.</p>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

// A session already tied to a Google account keeps using it, so only unbound sessions are offered the chooser.
// A session already tied to a saved session of THIS provider keeps using it, so only unbound sessions are offered the chooser.
const wantsChooser = (st, prov) => {
  if (!prov) return false;
  const bound = st.googleId && store.googleAccount(st.googleId);
  return !(bound && (bound.provider || 'google') === prov.id) && chooserAccounts(prov.id).length > 0;
};
const chooserPayload = (sid, prov) => ({ sid, provider: prov.id, label: prov.label });
const popups = new Map();   // sessionId -> BrowserWindow waiting (hidden) behind the account chooser

// Popups (Google sign-in, "Sign in with Google", OAuth) open as a modal window tied to the app window, sharing the
// opener's session so window.opener / postMessage / cookies work. Other new windows still become a website tab.
function isPopupLike(details) {
  return details.disposition === 'new-window' || sg.isGoogleAuthPage(details.url) || /\/(o\/oauth2|oauth2?|authorize)(\/|$|\?)/i.test(details.url);
}
function popupDecision(sessionId, details) {
  const { url } = details;
  if (url !== 'about:blank' && !isHttp(url)) return { action: 'deny' };
  if (!isPopupLike(details) && url !== 'about:blank') {
    actions.addWorkspace('', url).catch(() => {});
    return { action: 'deny' };
  }
  const st = store.session(sessionId);
  const prov = providers.forAuthUrl(url);
  const chooser = !!st && !!prov && wantsChooser(st, prov) && currentSession()?.id === sessionId;
  return { action: 'allow', overrideBrowserWindowOptions: { parent: win, modal: true, show: !chooser, width: 520, height: 740,
    autoHideMenuBar: true, title: 'Sign in', minimizable: false, icon: winIcon() } };
}
function adoptPopup(sessionId, child, details0) {
  child.setMenuBarVisibility(false);
  const wc = child.webContents;
  wc.on('context-menu', (_e, params) => showContextMenu(wc, params));
  pmSenders.add(wc.id); wc.once('destroyed', () => pmSenders.delete(wc.id));
  wc.setWindowOpenHandler(({ url }) => (isHttp(url) ? { action: 'allow', overrideBrowserWindowOptions: { parent: child, modal: true, width: 520, height: 740 } } : { action: 'deny' }));
  wc.on('will-navigate', (e, u) => { if (u !== 'about:blank' && !isHttp(u)) e.preventDefault(); });
  const prov = providers.forAuthUrl(details0 && details0.url || '');
  const needsChooser = !child.isVisible() && !!prov && wantsChooser(store.session(sessionId) || {}, prov);
  if (needsChooser) {
    popups.set(sessionId, child);
    if (win && !win.isDestroyed()) win.webContents.send('google-chooser', chooserPayload(sessionId, prov));
  }
  child.on('closed', () => {
    if (popups.get(sessionId) === child) popups.delete(sessionId);
    if (store.session(sessionId)) scheduleGoogleSync(sessionId, 800);   // pick up a sign-in the popup just completed
  });
}
function popupFor(sessionId) { const w = popups.get(sessionId); return w && !w.isDestroyed() ? w : null; }

function ensureView(s) {
  if (views.has(s.id)) return views.get(s.id);
  const part = partitionOf(s);
  hardenSession(part);
  watchCookies(s);
  const view = new WebContentsView({ webPreferences: { partition: part, preload: path.join(__dirname, 'sitepreload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const wc = view.webContents;
  pmSenders.add(wc.id); wc.once('destroyed', () => { pmSenders.delete(wc.id); pendingUser.delete(wc.id); });
  wc.setWindowOpenHandler(details => popupDecision(s.id, details));
  wc.on('did-create-window', (child, details) => adoptPopup(s.id, child, details));
  // A session stays on its website. Sign-in / OAuth trips are allowed (temporarily); a link to some other site opens as its own tab.
  wc.on('will-navigate', (e, url) => {
    if (!isHttp(url)) { e.preventDefault(); return; }
    if (e.isSameDocument || e.isMainFrame === false) return;
    const ws = store.workspace(s.workspaceId);
    if (ws && wsLocked(ws) && scope.decide(ws.startUrl, url, wc.getURL()) === 'newtab') {
      e.preventDefault();
      notify(`${hostOf(url).replace(/^www\./, '')} opened in its own tab. This account stays on ${hostOf(ws.startUrl).replace(/^www\./, '')}.`);
      actions.addWorkspace('', url).catch(() => {});
    }
  });
  const checkGoogleAuth = url => {
    const st = store.session(s.id), prov = providers.forAuthUrl(url);
    if (st && prov) {
      // Like Chrome's account chooser: offer every saved session of this provider when a session that is not yet tied to
      // one reaches its sign-in page. A session already bound to its own saved session is left alone.
      if (!googlePrompted.has(s.id) && currentSession()?.id === s.id && wantsChooser(st, prov)) {
        googlePrompted.add(s.id);
        if (win && !win.isDestroyed()) win.webContents.send('google-chooser', chooserPayload(s.id, prov));
      }
    } else if (isHttp(url) && !providers.forAuthUrl(url)) {
      googlePrompted.delete(s.id);
    }
  };
  wc.on('did-navigate', (_e, url) => {
    const p = persistedUrl(url), w = store.workspace(s.workspaceId);
    if (p) {
      // Only the site's own pages are remembered. Sign-in trips, popups' redirects and other sites are temporary and
      // never become this session's address, so its domain cannot drift.
      // A tab with no account yet follows you to another site (a redirect, or a link): its default becomes that site.
      if (w && !wsLocked(w) && /^https?:/i.test(w.startUrl || '') && !scope.sameSite(w.startUrl, url) && !scope.isTransient(url)) { try { setDefaultAddress(w, new URL(url).origin + '/'); } catch {} }
      if (w && scope.isLoginPage(w.startUrl, url) && w.loginUrl !== p) store.updateWorkspace(w.id, { loginUrl: p });   // where Log in takes you
      if (!scope.isAuthFlow(url)) store.touchHistory(s.id, p, '');   // every page you open is in the history, account or not
      if (w && scope.persistable(w.startUrl, url)) {
        store.updateSession(s.id, { lastUrl: p, lastUsedAt: Date.now() });
        // A blank tab takes its site from the first real page (never from a sign-in page).
        if (w.startUrl === 'about:blank') {
          w.startUrl = p;
          if (w.label === 'New Tab') w.label = hostOf(p).replace(/^www\./, '') || 'New Tab';
          store.setActive(store.activeWorkspaceId);   // persist
        }
      }
      errors.delete(s.id);
    }
    checkGoogleAuth(url);
    push();
  });
  wc.on('did-redirect-navigation', (_e, url, _isInPlace, isMainFrame) => {
    if (isMainFrame) checkGoogleAuth(url);
  });
  wc.on('did-navigate-in-page', push);
  wc.on('page-favicon-updated', (_e, favs) => { loadIcon(s.workspaceId, partitionOf(s), favs); });
  wc.on('page-title-updated', (_e, t) => {
    titles.set(s.id, t);
    const w = store.workspace(s.workspaceId);
    if (w && w.label === 'New Tab' && t && t.trim() && !scope.isTransient(wc.getURL())) w.label = t.trim().slice(0, 40);
    upgradePlaceholderName(s.id);
    { const u = persistedUrl(wc.getURL()); if (u && !scope.isAuthFlow(wc.getURL())) store.touchHistory(s.id, u, t); }
    push();
  });
  wc.on('did-start-loading', push);
  wc.on('did-stop-loading', () => { push(); establishBaseline(s.id); setTimeout(() => maybeAutoAssign(s.id), 1000); });
  wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (!isMain || code === -3) return;
    errors.set(s.id, desc); log('load-failed', s.id);
    wc.loadURL(errorPage(desc, hostOf(url))).catch(() => {});
    push();
  });
  wc.on('render-process-gone', () => { errors.set(s.id, 'The page crashed. Press reload.'); log('renderer-gone', s.id); push(); });
  wc.on('context-menu', (_e, params) => showContextMenu(wc, params));
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta)) return;
    const k = input.key.toLowerCase();
    if (k === 'l') { e.preventDefault(); win.webContents.focus(); win.webContents.send('focus-address'); }
    else if (k === 't') { e.preventDefault(); win.webContents.focus(); win.webContents.send('new-website'); }
    else if (k === 'r') { e.preventDefault(); actions.reload(); }
    else if (k === 'j') { e.preventDefault(); togglePanel(); }
    else if (k === 'k') { e.preventDefault(); win.webContents.focus(); win.webContents.send('open-search'); }
  });
  win.contentView.addChildView(view);
  view.setVisible(false);
  views.set(s.id, view);
  const ws = store.workspace(s.workspaceId);
  blankLoading.add(s.id);
  const clearBlank = () => { if (blankLoading.delete(s.id)) { layout(); push(); } };
  wc.once('did-navigate', clearBlank); wc.once('did-fail-load', clearBlank); wc.once('did-stop-loading', clearBlank);
  setTimeout(clearBlank, 20000);   // never hide a page for long
  wc.loadURL(scope.resumeUrl(ws.startUrl, s.lastUrl)).catch(clearBlank);
  return view;
}

// Tab icon: fetched once with no cookies, kept as a small data: URL in memory (the UI page may not load remote images).
async function loadIcon(wsId, part, favs) {
  const url = (favs || []).find(u => /^(https?:|data:image\/)/i.test(u));
  if (!url || icons.get(wsId)?.url === url) return;
  try {
    let data = null;
    if (url.startsWith('data:')) data = url.length < 60000 ? url : null;
    else {
      const r = await session.fromPartition(part).fetch(url, { credentials: 'omit' });
      const type = (r.headers.get('content-type') || '').split(';')[0].trim();
      const buf = Buffer.from(await r.arrayBuffer());
      if (r.ok && /^image\//.test(type) && buf.length && buf.length < 64 * 1024) data = `data:${type};base64,${buf.toString('base64')}`;
    }
    if (data && store.workspace(wsId)) { icons.set(wsId, { url, data }); push(); }
  } catch { /* a missing icon just shows the letter tile */ }
}

async function wipe(s) {
  const ses = session.fromPartition(partitionOf(s));
  await ses.clearStorageData();   // cookies, localStorage, IndexedDB, service workers, cache storage
  await ses.clearCache();
  await ses.clearAuthCache();
}

function destroyView(id) {
  blankLoading.delete(id);
  for (const k of [...suggested.keys()]) if (k.startsWith((views.get(id)?.webContents.id ?? -1) + '|')) suggested.delete(k);
  { const c = candidates.get(id); if (c) { clearTimeout(c.timer); clearTimeout(c.expire); candidates.delete(id); } }
  const v = views.get(id); if (!v) return;
  views.delete(id); titles.delete(id); errors.delete(id); baselines.delete(id); authSeen.delete(id); googlePrompted.delete(id); clearTimeout(assignRetry.get(id)?.timer); assignRetry.delete(id); pageAuth.delete(id); pageAuthFirst.delete(id);
  try { win.contentView.removeChildView(v); } catch {}
  if (!v.webContents.isDestroyed()) v.webContents.close();
}

async function deleteSessionData(s) {
  await wipe(s);
  destroyView(s.id);
  const ses = session.fromPartition(partitionOf(s));
  await ses.flushStorageData();
  fs.rm(path.join(app.getPath('userData'), 'Partitions', s.partition), { recursive: true, force: true }, () => {});
}

const actions = {
  async addWorkspace(label, url) {
    const raw = String(url || '').trim();
    const u = raw ? normalizeUrl(raw, { strict: true }) : 'about:blank';
    if (!u) throw new Error('Enter a website address such as mail.google.com');
    const defaultLabel = u === 'about:blank' ? 'New Tab' : hostOf(u).replace(/^www\./, '');
    const ws = store.addWorkspace(label || defaultLabel, u);
    store.setActive(ws.id);
    await actions.newSession(ws.id);
    return ws.id;
  },
  async closeWorkspace(id) {
    for (const s of store.removeWorkspace(id)) await deleteSessionData(s);
    const next = currentSession(); if (next) ensureView(next);
    layout(); push();
  },
  selectWorkspace(id) {
    if (!store.workspace(id)) return;
    store.setActive(id);
    const ws = store.workspace(id);
    let s = store.session(ws.lastSessionId) || store.sessionsOf(id)[0];
    if (s) { store.select(id, s.id); ensureView(s); }
    layout(); push();
  },
  async newSession(wsId) {
    const s = store.addSession(wsId);
    store.setActive(wsId); store.select(wsId, s.id);
    ensureView(s); layout(); push(); log('session-created', s.id);
    return s.id;
  },
  // The sidebar's single "Unassigned session" entry: show the website's waiting session (a signed-out page).
  // It is only created if there is none, so clicking it again never piles up extra sessions.
  async openUnassigned(wsId) {
    if (!store.workspace(wsId)) throw new Error('Website not found');
    const p = store.sessionsOf(wsId).find(x => x.status === 'pending') || store.addSession(wsId);
    actions.selectSession(p.id);
    return p.id;
  },
  selectSession(id) {
    const s = store.session(id); if (!s) return;
    store.setActive(s.workspaceId); store.select(s.workspaceId, id);
    store.updateSession(id, { lastUsedAt: Date.now() });
    const v = ensureView(s); layout(); push();
    if (!modalOpen) v.webContents.focus();
  },
  assignSession(id, label, source = 'manual') {
    const s = store.session(id);
    if (!s || s.status !== 'pending') throw new Error('Only a pending session can be named');
    store.assign(id, label);
    store.updateSession(id, { nameSource: source, assignedAt: Date.now() });
    authSeen.delete(id); ensurePending(s.workspaceId); push(); log('session-assigned', id);
  },
  renameSession(id, label) {
    const s = store.session(id), l = String(label || '').trim().slice(0, 40);
    if (!s || s.status !== 'assigned') throw new Error('Only a named account can be renamed');
    if (!l) throw new Error('Enter a name for this account');
    store.updateSession(id, { label: l, nameSource: 'manual' }); push();
  },
  moveSession(id, dir) {
    if (store.moveSession(id, dir)) push();
  },
  setNote(id, text) { const s = store.session(id); if (!s) throw new Error('Not found'); store.updateSession(id, { note: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120) }); push(); },
  moveSessionTo(id, toIndex) { if (store.moveSessionTo(id, toIndex)) push(); },
  // Log out: end the site's login for this account (its cookies and storage), keep the account listed as signed out.
  async logoutSession(id, { close = false } = {}) {
    const s = store.session(id); if (!s || s.status !== 'assigned') return;
    const wasCurrent = currentSession()?.id === id;
    noAuto.add(id);
    await clearSiteLogin(s);
    suppressForSession(id);
    loginState.set(id, 'out'); store.updateSession(id, { lastUrl: null, everSignedIn: true, loggedOut: true });
    if (close) {
      destroyView(id);
      if (wasCurrent) store.select(s.workspaceId, store.sessionsOf(s.workspaceId).find(x => x.id !== id && views.has(x.id))?.id || null);
      layout();
    } else { const v = views.get(id), ws = store.workspace(s.workspaceId); if (v && !v.webContents.isDestroyed()) v.webContents.loadURL(ws.startUrl).catch(() => {}); }
    push(); notify(`Logged out of ${s.label}${close ? ' and closed it' : ''}.`); log('session-logout', id);
  },
  // Log in: restore the saved session if this account has one, otherwise open the site's own page to sign in.
  async loginSession(id) {
    const s = store.session(id); if (!s || s.status !== 'assigned') return;
    actions.selectSession(id); suppressForSession(id); noAuto.delete(id);   // logging in on purpose: auto sign-in may help again
    const g = s.googleId && store.googleAccount(s.googleId);
    if (g && g.signedIn) {
      try { await actions.useGoogle(id, g.id, { quiet: true }); }
      catch (e) {
        if (e.code !== 'EXPIRED') throw e;
        // The saved session has lapsed: sign in again in a window of its own, then carry on with this account automatically.
        relogin.set(g.id, id); openGoogleWindow(g);
        notify(`Sign in to ${providers.get(g.provider || 'google').label} in the window that opened. ${s.label} continues automatically.`);
        return;
      }
      afterRestore(id, g); return;
    }
    goToLogin(id);
  },
  moveWorkspace(id, toIndex) { if (store.moveWorkspace(id, toIndex)) push(); },
  async removeSession(id) {
    const s = store.session(id); if (!s) return;
    const wasCurrent = currentSession()?.id === id;
    await deleteSessionData(s);
    store.removeSession(id);
    const fresh = s.status === 'pending' ? ensurePending(s.workspaceId) : null;   // discarding it starts a fresh one
    if (wasCurrent && fresh) store.select(s.workspaceId, fresh.id);
    if (wasCurrent) { const n = currentSession(); if (n) ensureView(n); }
    layout(); push(); log('session-removed', id);
  },
  // Close = unload the page and free its memory. The account and its login are kept; click it to reopen.
  // A pending (unassigned) session has nothing worth keeping, so closing it discards it.
  async closeSession(id) {
    const s = store.session(id); if (!s) return;
    if (s.status === 'pending') return actions.removeSession(id);
    const wasCurrent = currentSession()?.id === id;
    try { await session.fromPartition(partitionOf(s)).cookies.flushStore(); } catch {}
    destroyView(id);
    if (wasCurrent) store.select(s.workspaceId, store.sessionsOf(s.workspaceId).find(x => x.id !== id && views.has(x.id))?.id || null);
    layout(); push(); log('session-closed', id);
    notify(`Closed ${s.label}. It stays signed in. Click it to reopen.`);
  },
  async clearSession(id) {
    const s = store.session(id); if (!s) return;
    await wipe(s);
    const ws = store.workspace(s.workspaceId);
    store.updateSession(id, { lastUrl: null });
    errors.delete(id); titles.delete(id);
    views.get(id)?.webContents.loadURL(ws.startUrl).catch(() => {});
    push(); log('session-cleared', id);
  },
  go(input) {
    const cur = currentSession(); if (!cur) return;
    const u = normalizeUrl(input, { searchUrl: searchTemplate() }); if (!u) throw new Error('That address is not supported. Use http or https.');
    const ws = store.workspace(cur.workspaceId);
    if (!wsLocked(ws)) {   // no account yet: the address is free, and a different site becomes the tab's default
      if (!scope.sameSite(ws.startUrl, u) && !scope.isTransient(u) && persistedUrl(u)) setDefaultAddress(ws, u);
    } else if (scope.decideTyped(ws.startUrl, u) === 'newtab') {
      // Another site: give it its own tab. This account never changes domain.
      notify(`${hostOf(u).replace(/^www\./, '')} opened in its own tab. This account stays on ${hostOf(ws.startUrl).replace(/^www\./, '')}.`);
      actions.addWorkspace('', u).catch(() => {});
      return;
    }
    views.get(cur.id)?.webContents.loadURL(u).catch(() => {});
  },
  back() { const v = views.get(currentSession()?.id); if (v?.webContents.navigationHistory.canGoBack()) v.webContents.navigationHistory.goBack(); },
  forward() { const v = views.get(currentSession()?.id); if (v?.webContents.navigationHistory.canGoForward()) v.webContents.navigationHistory.goForward(); },
  reload() {
    const cur = currentSession(); const v = cur && views.get(cur.id); if (!v) return;
    errors.delete(cur.id);
    if (isHttp(v.webContents.getURL())) v.webContents.reload();
    else { const w = store.workspace(cur.workspaceId); v.webContents.loadURL(scope.resumeUrl(w.startUrl, cur.lastUrl)).catch(() => {}); }
  },
  external() {
    const cur = currentSession(); const v = cur && views.get(cur.id);
    const u = v && v.webContents.getURL();
    if (u && isHttp(u)) shell.openExternal(u);
  }
};

// Notices appear in the top-right box (it draws above the page). If a page is not showing, or the box is busy, they use the sidebar toast.
function notify(msg) {
  if (!win || win.isDestroyed()) return;
  const cur = currentSession(), visible = !!cur && views.has(cur.id) && !modalOpen;
  if (visible && showToast({ kind: 'info', id: require('crypto').randomUUID(), ttl: 6000, title: '', body: String(msg).slice(0, 300), buttons: [] })) return;
  win.webContents.send('notice', msg);
}
const siteHost = s => hostOf(store.workspace(s.workspaceId)?.startUrl || '');

// --- Automatic sign-in detection. Signals: login-like cookie NAMES (and a hash of the value, in memory,
// to notice a refreshed session id), plus navigation away from login-looking pages. Page content is never read.
async function establishBaseline(id) {
  const s = store.session(id);
  if (!s || s.status !== 'pending' || baselines.has(id)) return;
  baselines.set(id, null);
  const map = new Map(), host = siteHost(s), nowSec = Date.now() / 1000;
  let alreadyIn = false;
  for (const c of await session.fromPartition(partitionOf(s)).cookies.get({}))
    if (sg.isAuthLike(c) && sg.siteMatches(c.domain, host)) {
      map.set(c.name + '|' + c.domain, sg.hashValue(c.value));
      if (!c.expirationDate || c.expirationDate > nowSec) alreadyIn = true;
    }
  baselines.set(id, map);
  // A waiting session that was kept from an earlier run and already holds a live login (the person signed in, then closed the
  // app) is signed in NOW. A brand-new session starts empty, so there a login is only recognised when a cookie changes.
  if (alreadyIn && s.createdAt < APP_START) { authSeen.add(id); setTimeout(() => maybeAutoAssign(id), 1500); }
}
function watchCookies(s) {
  const part = partitionOf(s);
  if (sessionByPartition.has(part)) return;
  sessionByPartition.set(part, s.id);
  session.fromPartition(part).cookies.on('changed', (_e, c, _cause, removed) => {
    const id = sessionByPartition.get(part), cur = store.session(id);
    if (cur) scheduleLoginRefresh(id);
    if (removed || !cur) return;
    const cand = candidates.get(id);
    if (cand && !suppressGoogle.has(part) && sg.GOOGLE_AUTH_NAMES.test(c.name) && sg.domainMatches(c.domain, googleSuffixes)
        && scope.sameSite(cand.origin, 'https://accounts.google.com')) {
      clearTimeout(cand.timer); cand.timer = setTimeout(() => confirmLogin(id), 1500);   // Google just signed this session in
    }
    if (sg.GOOGLE_AUTH_NAMES.test(c.name) && sg.domainMatches(c.domain, googleSuffixes) && !suppressGoogle.has(part)) scheduleGoogleSync(id);
    if (cur.status !== 'pending') return;
    const base = baselines.get(id);
    if (!sg.isAuthLike(c) || !sg.siteMatches(c.domain, siteHost(cur))) return;
    if (!(base instanceof Map)) { setTimeout(() => maybeAutoAssign(id), 2500); return; }   // baseline not ready yet: the rescan will compare
    const key = c.name + '|' + c.domain, h = sg.hashValue(c.value);
    if (base.get(key) === h) return;
    base.set(key, h); authSeen.add(id);
    setTimeout(() => maybeAutoAssign(id), 1500);
  });
}
// Re-reads the cookies and compares them with the baseline. Catches a login whose cookie change was missed (it arrived before the
// baseline was ready, or the 'changed' event was coalesced), so detection never depends on one event being seen.
async function rescanPending(id) {
  const s = store.session(id), base = baselines.get(id);
  if (!s || s.status !== 'pending' || !(base instanceof Map)) return;
  const host = siteHost(s);
  for (const c of await session.fromPartition(partitionOf(s)).cookies.get({})) {
    if (!sg.isAuthLike(c) || !sg.siteMatches(c.domain, host) || (c.expirationDate && c.expirationDate < Date.now() / 1000)) continue;
    const key = c.name + '|' + c.domain, h = sg.hashValue(c.value);
    if (base.get(key) !== h) { base.set(key, h); authSeen.add(id); }
  }
}
const assignRetry = new Map();   // sessionId -> { timer, tries }
// Names a waiting session once a sign-in has been seen. If the page is still loading or is still on a sign-in-looking address
// (most sites set the cookie, THEN redirect), it tries again every 2.5 s for about 40 s instead of giving up after one look.
async function maybeAutoAssign(id) {
  const s = store.session(id);
  if (!s || s.status !== 'pending') { assignRetry.delete(id); return; }
  try { await rescanPending(id); } catch { /* try again below */ }
  if (!authSeen.has(id)) return;
  const v = views.get(id);
  if (!v || v.webContents.isDestroyed()) return;
  const wc = v.webContents;
  if (wc.isLoading() || !isHttp(wc.getURL()) || sg.isLoginLike(wc.getURL())) {
    const r = assignRetry.get(id) || { timer: null, tries: 0 };
    if (r.tries >= 16) { assignRetry.delete(id); return; }
    clearTimeout(r.timer); r.tries++; r.timer = setTimeout(() => maybeAutoAssign(id), 2500); r.timer.unref?.();
    assignRetry.set(id, r); return;
  }
  clearTimeout(assignRetry.get(id)?.timer); assignRetry.delete(id);
  const g = s.googleId && store.googleAccount(s.googleId);
  const email = (g && g.email) || sg.extractEmail(titles.get(id));
  const n = store.sessionsOf(s.workspaceId).filter(x => x.status === 'assigned').length + 1;
  const label = email || `Account ${n}`;
  actions.assignSession(id, label, g && g.email ? 'google' : email ? 'email' : 'placeholder');
  notify(email ? `Signed in as ${email}. Saved as an account.` : `Sign-in detected. Saved as “${label}”. Rename it any time.`);
}
function upgradePlaceholderName(id) {
  const s = store.session(id);
  if (!s || s.nameSource !== 'placeholder' || Date.now() - (s.assignedAt || 0) > 5 * 60 * 1000) return;
  const email = sg.extractEmail(titles.get(id)); if (!email) return;
  store.updateSession(id, { label: email.slice(0, 40), nameSource: 'email' });
  notify(`Account named ${email}.`); push();
}

// --- Google accounts. Every Google sign-in seen in any session is remembered here automatically, named by its email,
// so it can be picked again on later sign-in screens. Only Google/YouTube cookies are copied, never other site data.
const googleSes = g => { const part = 'persist:' + g.partition; hardenSession(part); return session.fromPartition(part); };
const googleName = () => `Google account ${store.data.googleAccounts.length + 1}`;
const suffixesOf = g => ((g && g.provider) || 'google') === 'google' ? googleSuffixes : providers.get(g.provider).suffixes;
async function replaceGoogleCookies(from, g) {
  const to = googleSes(g);
  await to.clearStorageData({ storages: ['cookies'] });
  await sg.copyCookies(from, to, suffixesOf(g));
  await to.cookies.flushStore();
}
async function removeGoogle(id) {
  const g = store.googleAccount(id); if (!g) return;
  googleWins.get(id)?.destroy(); googleWins.delete(id);
  await googleSes(g).clearStorageData();
  store.removeGoogle(id); push();
  fs.rm(path.join(app.getPath('userData'), 'Partitions', g.partition), { recursive: true, force: true }, () => {});
}
function scheduleGoogleSync(id, delay = 2500) {
  clearTimeout(googleTimers.get(id));
  googleTimers.set(id, setTimeout(() => { googleTimers.delete(id); syncGoogle(id).catch(() => {}); }, delay));
}
// A Google sign-in cookie appeared in this session: find out which account, remember it, and name the session after it.
async function syncGoogle(id, attempt = 0) {
  const s = store.session(id);
  if (!s || googleBusy.has(id)) return null;
  googleBusy.add(id);
  let retry = false;
  try {
    const ses = session.fromPartition(partitionOf(s));
    if (!(await sg.hasGoogleLogin(ses, googleSuffixes))) return null;
    const email = (await sg.fetchGoogleAccount(ses, googleInfoUrl))?.email || null;
    let g = email ? store.findGoogleByEmail(email) : null;
    if (!g && s.googleId) { const l = store.googleAccount(s.googleId); if (l && (!email || !l.email)) g = l; }
    if (!g && !email && attempt < 3) { retry = true; return null; }   // Google may not answer straight away
    if (!g) g = store.addGoogle(googleName(), email);
    await replaceGoogleCookies(ses, g);
    store.updateGoogle(g.id, { signedIn: true, ...(email ? { email, label: email } : {}) });
    store.updateSession(id, { googleId: g.id });
    nameFromGoogle(id, email);
    push(); log('google-saved', g.id);
    return g.id;
  } finally {
    googleBusy.delete(id);
    if (retry) setTimeout(() => syncGoogle(id, attempt + 1).catch(() => {}), 4000);
  }
}
function nameFromGoogle(id, email) {
  const s = store.session(id); if (!s || !email) return;
  const l = email.slice(0, 40);
  if (s.status === 'pending') { actions.assignSession(id, email, 'google'); notify(`Signed in as ${email}. Saved as an account.`); }
  else if ((s.nameSource === 'placeholder' || s.nameSource === 'google') && s.label !== l) {
    store.updateSession(id, { label: l, nameSource: 'google' }); notify(`Account named ${email}.`); push();
  }
}
function openGoogleWindow(g) {
  if (googleWins.has(g.id)) { googleWins.get(g.id).focus(); return; }
  const ses = googleSes(g), P = providers.get(g.provider || 'google'), isG = P.id === 'google', sfx = suffixesOf(g);
  const hasLogin = async () => providers.hasAuth(P, await ses.cookies.get({}), sfx);
  const w = new BrowserWindow({ parent: win, width: 520, height: 740, title: `Sign in to ${P.label}`, icon: winIcon(),
    webPreferences: { partition: 'persist:' + g.partition, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  googleWins.set(g.id, w); w.setMenuBarVisibility(false);
  w.webContents.setWindowOpenHandler(({ url }) => (isHttp(url) ? { action: 'allow' } : { action: 'deny' }));
  w.webContents.on('will-navigate', (e, u) => { if (!isHttp(u)) e.preventDefault(); });
  let timer;
  const onCookie = (_e, c, _cause, removed) => {
    if (removed || !P.auth.test(c.name) || !sg.domainMatches(c.domain, sfx)) return;
    clearTimeout(timer); timer = setTimeout(() => { if (!w.isDestroyed()) w.close(); }, 3000);
  };
  ses.cookies.on('changed', onCookie);
  w.on('closed', async () => {
    ses.cookies.removeListener('changed', onCookie); googleWins.delete(g.id);
    try {
      const cur = store.googleAccount(g.id); if (!cur) return;
      if (!(await hasLogin())) {
        relogin.delete(g.id);
        if (!cur.signedIn && !cur.email && !cur.named) { await removeGoogle(g.id); notify(`${P.label} sign-in was not completed.`); }
        else { store.updateGoogle(g.id, { signedIn: false }); push(); notify(`${cur.label} is not signed in yet.`); }
        return;
      }
      const email = isG ? ((await sg.fetchGoogleAccount(ses, googleInfoUrl))?.email || null) : null;
      const dup = email && store.findGoogleByEmail(email, g.id);
      if (dup) {   // already known: refresh that entry instead of keeping two
        await replaceGoogleCookies(ses, dup); store.updateGoogle(dup.id, { signedIn: true });
        await removeGoogle(g.id); notify(`${email} refreshed.`); continueRelogin(g.id, dup.id); return;
      }
      store.updateGoogle(g.id, { signedIn: true, ...(email ? { email, label: email } : {}) });
      await ses.cookies.flushStore(); push();
      notify(`${P.label} session ${email || cur.label} saved.`); continueRelogin(g.id);
    } catch { /* window already closed; nothing more to do */ }
  });
  w.webContents.on('did-finish-load', () => {
    w.webContents.executeJavaScript(`(() => {
      const attach = () => {
        document.querySelectorAll('input[type="password"]').forEach(inp => {
          if (inp.dataset.sbEye) return;
          inp.dataset.sbEye = '1';
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.textContent = 'Show';
          btn.style.cssText = 'position:absolute;right:10px;top:50%;transform:translateY(-50%);z-index:9999;background:transparent;border:0;color:#1a73e8;font:600 12px system-ui;cursor:pointer;padding:4px 6px;';
          const parent = inp.parentElement;
          if (parent && getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
          btn.onclick = e => {
            e.preventDefault(); e.stopPropagation();
            const show = inp.type === 'password';
            inp.type = show ? 'text' : 'password';
            btn.textContent = show ? 'Hide' : 'Show';
          };
          (parent || inp).appendChild(btn);
        });
      };
      attach();
      new MutationObserver(attach).observe(document.body, { childList: true, subtree: true });
    })()`).catch(() => {});
  });
  w.loadURL(P.loginUrl).catch(() => {});
}

// --- Log in / Log out helpers
const relogin = new Map();   // saved session id -> tab (session) id waiting for it to be signed in again
const suppressForSession = id => { const v = views.get(id); if (v) for (const k of [...suggested.keys()]) if (k.startsWith(v.webContents.id + '|')) suggested.delete(k); };
// Log out clears THIS SITE's login (cookies and storage of the site's own domains) and leaves everything else alone, so a
// Google/Apple/... login kept in the tab survives and "Log in" can finish with one click. On a site that belongs to a provider
// (mail.google.com, github.com) the site's cookies ARE the provider login, so all of them go.
async function clearSiteLogin(s) {
  const ses = session.fromPartition(partitionOf(s)), ws = store.workspace(s.workspaceId);
  const kinds = ['localstorage', 'indexdb', 'serviceworkers', 'cachestorage'];
  if (providers.forHost(hostOf(ws.startUrl))) { await ses.clearStorageData(); await ses.clearCache().catch(() => {}); await ses.clearAuthCache().catch(() => {}); return; }
  const key = scope.siteKey(ws.startUrl), origins = new Set();
  try { origins.add(new URL(ws.startUrl).origin); } catch {}
  for (const c of await ses.cookies.get({})) {
    const d = String(c.domain || '').replace(/^\./, '');
    if (!d || scope.siteKey('https://' + d) !== key) continue;
    origins.add('https://' + d);
    await ses.cookies.remove((c.secure ? 'https' : 'http') + '://' + d + (c.path || '/'), c.name).catch(() => {});
  }
  for (const origin of origins) await ses.clearStorageData({ origin, storages: kinds }).catch(() => {});
  await ses.clearAuthCache().catch(() => {});
}
// Take the tab to the site's own sign-in page (remembered from the last time it was seen), where saved logins are offered.
function goToLogin(id) {
  const s = store.session(id), v = views.get(id), ws = s && store.workspace(s.workspaceId);
  if (!v || v.webContents.isDestroyed() || !ws) return;
  v.webContents.loadURL(ws.loginUrl || ws.startUrl).catch(() => {});
  notify(`Sign in to ${hostOf(ws.startUrl).replace(/^www\./, '')} on the page. Saved logins are offered at the top right.`);
}
// A saved provider session was restored into the tab. On a provider's own site that is the whole login. Anywhere else the
// site still needs its own sign-in, so go to it and say what to press.
function afterRestore(id, g) {
  const s = store.session(id), ws = s && store.workspace(s.workspaceId); if (!ws) return;
  if (providers.forHost(hostOf(ws.startUrl))) return;
  const v = views.get(id); if (v && !v.webContents.isDestroyed()) v.webContents.loadURL(ws.loginUrl || ws.startUrl).catch(() => {});
  notify(`${providers.get(g.provider || 'google').label} is ready. Press Continue with ${providers.get(g.provider || 'google').label} on ${hostOf(ws.startUrl).replace(/^www\./, '')}.`);
}
function continueRelogin(gid, useGid = gid) {
  const sid = relogin.get(gid); relogin.delete(gid);
  if (!sid || !store.session(sid)) return;
  actions.useGoogle(sid, useGid, { quiet: true }).then(() => afterRestore(sid, store.googleAccount(useGid))).catch(e => notify(e.message));
}
Object.assign(actions, {
  addGoogle(providerId = 'google') {
    const P = providers.get(String(providerId)); if (!P) throw new Error('Unknown sign-in provider');
    const n = store.data.googleAccounts.filter(x => (x.provider || 'google') === P.id).length + 1;
    const g = store.addGoogle(P.id === 'google' ? 'New Google account' : `${P.label} session ${n}`, null, P.id);
    if (P.id !== 'google') store.updateGoogle(g.id, { named: true });   // keep it even if the sign-in window is closed early
    push(); openGoogleWindow(g); return g.id;
  },
  renameIdentity(id, label) { const l = String(label || '').trim().slice(0, 80); if (!l) throw new Error('Enter a name'); store.updateGoogle(id, { label: l, named: true }); push(); },
  signInGoogle(id) { const g = store.googleAccount(id); if (g) openGoogleWindow(g); },
  async useGoogle(sessionId, gid, opts = {}) {
    const s = store.session(sessionId), g = store.googleAccount(gid);
    if (!s || !g) throw new Error('Not found');
    // Same Google account already has a session on this website (open OR closed): switch to it / reopen it.
    const dup = store.sessionsOf(s.workspaceId).find(x => x.id !== s.id && x.status === 'assigned' && x.googleId === g.id);
    if (s.status === 'assigned' && s.googleId !== g.id) {
      if (dup) { actions.selectSession(dup.id); notify(`${g.label} is already open here. Switched to it.`); return; }
      // A session holds one Google login, so another account gets a session of its own.
      return actions.useGoogle(await actions.openUnassigned(s.workspaceId), gid, opts);
    }
    if (s.status === 'pending' && dup) {
      actions.selectSession(dup.id); await actions.removeSession(s.id);   // switch first so no throwaway page loads
      notify(`${g.label} is already open here. Switched to it.`); return;
    }
    const part = partitionOf(s), ses = session.fromPartition(part);
    suppressGoogle.add(part);   // our own copy must not be mistaken for a new sign-in
    let n;
    try { n = await sg.copyCookies(googleSes(g), ses, suffixesOf(g)); }
    finally { setTimeout(() => suppressGoogle.delete(part), 4000); }
    if (!n) { store.updateGoogle(g.id, { signedIn: false }); push(); const e = new Error(`That ${providers.get(g.provider || 'google').label} login has expired. Press Sign in on it under Saved sessions to refresh it.`); e.code = 'EXPIRED'; throw e; }
    // Verify the session really is that account before assigning it. A mismatch means the saved login is stale.
    const who = (g.provider || 'google') === 'google' ? ((await sg.fetchGoogleAccount(ses, googleInfoUrl))?.email || null) : null;   // only Google offers an account lookup
    if (who && g.email && who !== g.email) {
      for (const c of await ses.cookies.get({})) if (sg.domainMatches(c.domain, suffixesOf(g))) await ses.cookies.remove((c.secure ? 'https' : 'http') + '://' + String(c.domain).replace(/^\./, '') + (c.path || '/'), c.name).catch(() => {});   // only the provider's cookies, never the site's own login
      throw new Error(`Google returned ${who} instead of ${g.email}. Press Sign in on that account to refresh it.`);
    }
    store.updateSession(sessionId, { googleId: g.id });
    // The account was chosen on purpose, so the identity is known: name the session now instead of guessing from cookies.
    if (s.status === 'pending') actions.assignSession(sessionId, g.email || g.label, g.email ? 'google' : 'placeholder');
    // Leave Google's sign-in page (it would just sit on "Sign in or create an account"): continue to the website.
    const v = views.get(sessionId), ws = store.workspace(s.workspaceId), waiting = popupFor(sessionId);
    if (waiting) {   // a sign-in popup is waiting for this answer: let it continue now that the login is in place, so the site's own login completes
      waiting.webContents.reload(); waiting.show(); waiting.focus();
    } else if (v && !v.webContents.isDestroyed()) {
      const cur = v.webContents.getURL(), onGoogle = isHttp(cur) && providers.forAuthUrl(cur)?.id === (g.provider || 'google');
      const siteIsGoogle = sg.domainMatches(hostOf(ws.startUrl), suffixesOf(g));
      if (onGoogle && siteIsGoogle) v.webContents.loadURL(ws.startUrl).catch(() => {});
      else if (isHttp(cur)) v.webContents.reload();
      else v.webContents.loadURL(scope.resumeUrl(ws.startUrl, s.lastUrl)).catch(() => {});
    }
    if (!opts.quiet) notify(`Signed in as ${g.label}.`);
  },
  // Several accounts at once from "Choose an account": the first goes into this session if it is the waiting one,
  // every other gets a session of its own. Accounts already open on this website are skipped.
  async useGoogleMany(sessionId, gids) {
    const s = store.session(sessionId); if (!s) throw new Error('Not found');
    const taken = new Map(store.sessionsOf(s.workspaceId).filter(x => x.status === 'assigned' && x.googleId).map(x => [x.googleId, x.id]));
    const ids = [...new Set(gids || [])].filter(id => store.googleAccount(id));
    const todo = ids.filter(id => !taken.has(id));
    const already = ids.filter(id => taken.has(id));   // open or Closed: just switch to / reopen it
    if (already.length && !todo.length) { actions.selectSession(taken.get(already[0])); if (s.status === 'pending') await actions.removeSession(s.id).catch(() => {}); notify(`${store.googleAccount(already[0]).label} is already on this website. Switched to it.`); popupFor(sessionId)?.close(); return []; }
    if (!todo.length) return [];
    const made = []; let failed = 0;
    for (const gid of todo) {
      const target = (s.status === 'pending' && !made.length) ? s.id : await actions.openUnassigned(s.workspaceId);
      try { await actions.useGoogle(target, gid); made.push(target); } catch (e) { failed++; notify(e.message); }
    }
    if (made.length) actions.selectSession(made[0]);
    if (!made.includes(sessionId)) popupFor(sessionId)?.close();
    if (failed) notify(`${failed} account${failed > 1 ? 's' : ''} could not be signed in. Press Refresh on it under Saved sessions.`);
    return made;
  },
  removeGoogle
});


// --- Password manager. Logins are encrypted by the OS (see vault.js). A login is only ever typed into the page it was
// saved for (exact origin), when the user picks it from the key button. Passwords are never sent to the app's UI page.
let warnedNoVault = false;
function currentPage() {
  const cur = currentSession(), v = cur && views.get(cur.id);
  if (!v || v.webContents.isDestroyed()) return null;
  return { wc: v.webContents, origin: eligibleOrigin(v.webContents.getURL()) };
}
// Two-step sign-ins (Google, Microsoft, ...) ask for the username on one page and the password on the next. The username
// seen on the first step is remembered briefly, in memory, so the password page can be saved with it automatically.
ipcMain.on('pm:username', (e, p) => {
  try {
    if (!vault || !pmSenders.has(e.sender.id) || !e.senderFrame || e.senderFrame !== e.sender.mainFrame) return;
    const username = p && typeof p.username === 'string' ? p.username.trim().slice(0, 320) : '';
    if (username) pendingUser.set(e.sender.id, { host: hostOf(e.senderFrame.url || e.sender.getURL()), username, at: Date.now() });
  } catch { /* ignore */ }
});
ipcMain.on('pm:captured', (e, p) => {
  try {
    if (!vault || !pmSenders.has(e.sender.id) || !e.senderFrame || e.senderFrame !== e.sender.mainFrame) return;
    const origin = eligibleOrigin(e.senderFrame.url || e.sender.getURL());
    if (!origin || !p || typeof p.password !== 'string' || !p.password || p.password.length > 1024) return;
    let username = String(p.username || '').trim().slice(0, 320);
    if (!username) {   // not on this page: use the one given on the previous sign-in step
      const prev = pendingUser.get(e.sender.id);
      if (prev && Date.now() - prev.at < 15 * 60 * 1000 && prev.host === hostOf(e.senderFrame.url || e.sender.getURL())) username = prev.username;
    }
    pendingUser.delete(e.sender.id);
    // Even when the password will not be saved (a "Never" site, or no secure storage), the submitted login is still a sign-in signal
    // for detection, so the candidate is kept. confirmLogin() decides whether anything is offered for saving.
    if (!vault.isNever(origin) && !vault.available && !warnedNoVault) { warnedNoVault = true; notify('Passwords cannot be saved: secure storage is not available on this computer.'); }
    const sid = sessionIdOfSender(e.sender); if (!sid) return;
    // Do NOT offer yet: the password may be wrong. It is offered only once the sign-in is confirmed (confirmLogin).
    const old = candidates.get(sid); if (old) { clearTimeout(old.timer); clearTimeout(old.expire); }
    const c = { origin, username, password: p.password, timer: null, expire: null };
    c.expire = setTimeout(() => { if (candidates.get(sid) === c) candidates.delete(sid); }, 10 * 60 * 1000); c.expire.unref?.();
    candidates.set(sid, c);
  } catch { /* never let a page's report crash the app */ }
});
function sessionIdOfSender(wc) {   // the session a page (or its sign-in popup) belongs to
  for (const [id, v] of views) if (!v.webContents.isDestroyed() && v.webContents.session === wc.session) return id;
  return null;
}
// A login page that stops asking for a password (and is not another sign-in step) means the sign-in worked.
ipcMain.on('pm:page', (e, p) => {
  try {
    if (!vault || !pmSenders.has(e.sender.id) || !e.senderFrame || e.senderFrame !== e.sender.mainFrame) return;
    const sid = sessionIdOfSender(e.sender);
    if (sid && p && (p.hasPassword || p.hasUser)) maybeSuggest(e.sender, sid, p);
    if (sid && p) {
      const s0 = store.session(sid), w0 = s0 && store.workspace(s0.workspaceId), u0 = e.sender.getURL();
      if (w0 && scope.sameSite(w0.startUrl, u0)) {
        if (typeof p.storageAuth === 'boolean' && s0.status === 'pending' && !scope.isTransient(u0)) {
          // A waiting session whose page keeps a token in its storage: signed in already (restored session), or just signed in (the token appeared).
          const first = pageAuthFirst.get(sid); if (first === undefined) pageAuthFirst.set(sid, p.storageAuth);
          if (p.storageAuth && (first === false || (first === undefined && s0.createdAt < APP_START))) { authSeen.add(sid); setTimeout(() => maybeAutoAssign(sid), 1500); }
        }
        if (typeof p.storageAuth === 'boolean' && s0.status === 'assigned' && !scope.isTransient(u0) && pageAuth.get(sid) !== p.storageAuth) {
          pageAuth.set(sid, p.storageAuth);
          if (p.storageAuth && s0.authBy !== 'page') store.updateSession(sid, { authBy: 'page' });   // remembered, so the panel is right at the next start
          scheduleLoginRefresh(sid, 200);
        }
        if (p.hasPassword && scope.isTransient(u0)) { if (!formOut.has(sid)) { formOut.add(sid); scheduleLoginRefresh(sid, 200); } }
        else if (p.hasPassword === false && !scope.isTransient(u0) && formOut.delete(sid)) scheduleLoginRefresh(sid, 200);
      }
    }
    const c = sid && candidates.get(sid); if (!c) return;
    clearTimeout(c.timer);
    const url = e.sender.getURL();
    if (p && p.hasPassword === false && isHttp(url) && !scope.isTransient(url)) c.timer = setTimeout(() => confirmLogin(sid), 1500);
  } catch { /* ignore */ }
});
const warnedNoUser = new Set();
async function confirmLogin(sid) {
  const c = candidates.get(sid); if (!c) return;
  candidates.delete(sid); clearTimeout(c.timer); clearTimeout(c.expire);
  formOut.delete(sid); store.updateSession(sid, { everSignedIn: true, loggedOut: false, ...(store.session(sid)?.authBy ? {} : { authBy: 'form' }) }); loginState.set(sid, 'in'); push();   // a confirmed sign-in
  // A waiting session that just completed a sign-in form is an account, even on a site whose login cookies we cannot recognise
  // (a static site, or one that keeps its login in localStorage).
  { const w = store.session(sid);
    if (w && w.status === 'pending') {
      const em = sg.extractEmail(c.username) || sg.extractEmail(titles.get(sid)) || (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(c.username || '').trim()) ? String(c.username).trim().toLowerCase() : null);
      const label = em || String(c.username || '').trim().slice(0, 40) || `Account ${store.sessionsOf(w.workspaceId).filter(x => x.status === 'assigned').length + 1}`;
      actions.assignSession(sid, label, em ? 'email' : 'placeholder');
      notify(`Sign-in detected. Saved as “${label}”. Rename it any time.`);
    } }
  try {
    const s = store.session(sid); if (!s || !vault.available || vault.isNever(c.origin)) return;
    let username = c.username;
    if (scope.sameSite(c.origin, 'https://accounts.google.com')) {   // Google's password page never shows who: ask Google
      const email = (await sg.fetchGoogleAccount(session.fromPartition(partitionOf(s)), googleInfoUrl))?.email;
      if (email) username = email;
    }
    username = String(username || '').trim();
    if (!username) {   // never save a login we cannot tell apart from another account's
      if (!warnedNoUser.has(c.origin)) { warnedNoUser.add(c.origin); notify(`Signed in, but the username for ${hostOf(c.origin)} could not be read, so the password was not saved.`); }
      return;
    }
    const state = vault.compare(c.origin, username, c.password);
    if (state === 'same') return;
    const id = require('crypto').randomUUID();
    if (offers.size > 4) offers.delete(offers.keys().next().value);
    offers.set(id, { origin: c.origin, username, password: c.password });
    showToast({ kind: 'offer', id, ttl: 120000, title: state === 'changed' ? 'Update saved password?' : 'Save password?',
      body: `${username} on ${hostOf(c.origin).replace(/^www\./, '')}`,
      buttons: [{ id: 'save', label: state === 'changed' ? 'Update' : 'Save', primary: true }, { id: 'dismiss', label: 'Not now' }, { id: 'never', label: 'Never' }] });
  } catch { /* ignore */ }
}

// --- Is each account signed in? Judged from login cookies (names only), refreshed when cookies change.
const loginTimers = new Map();
const formOut = new Set();   // sessions whose open page is showing the site's own sign-in form
async function refreshLogin(id) {
  const s = store.session(id);
  if (!s || s.status !== 'assigned') { loginState.delete(id); return; }
  try {
    const cookies = await session.fromPartition(partitionOf(s)).cookies.get({});
    const prov = providers.forHost(siteHost(s));
    const inn = prov ? providers.hasAuth(prov, cookies, prov.id === 'google' ? googleSuffixes : prov.suffixes) : sg.hasLoginCookies(cookies, siteHost(s), googleSuffixes);
    // 'Signed out' only on evidence: a login was seen before and is now gone, the user logged out, or the page showed a sign-in
    // form. Having no recognised login cookie is NOT evidence (many sites use cookies we cannot recognise), so it stays 'unknown'.
    // Sites that keep the login outside cookies: the page's own storage (checked while the page is loaded, remembered for the next
    // start) or a sign-in the person completed in a form here. Neither can be seen in cookies, so they are trusted until the page
    // shows a sign-in form, the person logs out, or the page's storage no longer holds a token.
    const pg = pageAuth.get(id);
    let viaPage = false;
    if (!inn && !s.loggedOut && !formOut.has(id)) {
      if (pg === true) viaPage = true;
      else if (pg === undefined && (s.authBy === 'page' || s.authBy === 'form')) viaPage = true;
      else if (pg === false && s.authBy === 'form') viaPage = true;
    }
    if ((inn || viaPage) && (!s.everSignedIn || s.loggedOut)) store.updateSession(id, { everSignedIn: true, loggedOut: false });
    const next = (inn || viaPage) ? 'in' : (s.everSignedIn || s.loggedOut || formOut.has(id)) ? 'out' : 'unknown';
    const prevState = loginState.get(id);
    if (prevState === 'in' && next === 'out') noAuto.add(id);          // the site ended the login (its own Log out, or expiry)
    if (next === 'in') noAuto.delete(id);
    if (prevState !== next) { loginState.set(id, next); push(); }
  } catch { /* leave as is */ }
}
function scheduleLoginRefresh(id, delay = 800) {
  clearTimeout(loginTimers.get(id));
  loginTimers.set(id, setTimeout(() => { loginTimers.delete(id); refreshLogin(id); }, delay));
}
function refreshAllLogins() { for (const s of store.data.sessions) if (s.status === 'assigned') scheduleLoginRefresh(s.id, 200); }

// --- Windows Hello gate. When on, the saved logins can be listed, filled, auto-used or changed only after Windows has verified the user,
// and the vault locks again after the chosen time. Saving a new login never needs it (that only adds). It is a gate inside this app:
// the file itself stays protected by Windows account encryption (see SECURITY.md for what each protects against).
let unlockedUntil = 0, helloBusy = null;
const helloOn = () => !!store.data.ui.requireHello && process.platform === 'win32';
const helloLocked = () => helloOn() && Date.now() >= unlockedUntil;
async function requireUnlock(reason = 'Unlock your saved passwords') {
  if (!helloLocked()) return true;
  if (!helloBusy) helloBusy = hello.verify(reason).finally(() => { helloBusy = null; });
  const r = await helloBusy;
  if (r.ok) { unlockedUntil = Date.now() + (store.data.ui.helloMinutes || 5) * 60000; push(); return true; }
  notify(hello.describe(r.status)); return false;
}
async function fillLogin(id) {
  if (!(await requireUnlock())) return;
  const sec = vault.secret(id), page = currentPage();
  if (!sec || !page) return;
  if (page.origin !== sec.origin) { notify('That login is saved for a different website.'); return; }   // re-checked at fill time
  page.wc.send('pm:fill', { username: sec.username, password: sec.password });
  log('password-filled');
}
// --- Right-click menu for pages (and text fields in the app itself). What it shows depends on what was clicked: see contextmenu.js.
function showContextMenu(wc, params, { page = true } = {}) {
  if (wc.isDestroyed()) return;
  const h = wc.navigationHistory;
  const a = {
    canGoBack: page && h.canGoBack(), canGoForward: page && h.canGoForward(),
    back: () => h.goBack(), forward: () => h.goForward(), reload: () => wc.reload(), print: () => wc.print(),
    copyText: t => clipboard.writeText(String(t || '')), copyImage: (x, y) => wc.copyImageAt(x, y), saveUrl: u => wc.downloadURL(u),
    openTab: u => actions.addWorkspace('', u).catch(() => {}),
    search: q => actions.addWorkspace('', Engines.searchUrl(searchTemplate(), q)).catch(() => {}),
    replaceMisspelling: w => wc.replaceMisspelling(w),
    addToDictionary: w => { try { wc.session.addWordToSpellCheckerDictionary(w); } catch {} },
    edit: cmd => { const f = { undo: 'undo', redo: 'redo', cut: 'cut', copy: 'copy', paste: 'paste', pasteAsPlainText: 'pasteAndMatchStyle', selectAll: 'selectAll' }[cmd]; if (f) wc[f](); }
  };
  const tpl = ctxmenu.buildTemplate(params, a);
  if (tpl.length) Menu.buildFromTemplate(tpl).popup({ window: BrowserWindow.fromWebContents(wc) || win });
}

// --- Small popup box at the bottom left (offers to save a password, suggestions to use a saved login). It is a small window of its own that
// never takes focus, so it does not interrupt the page, and it can be dismissed. It shows only text and fixed buttons.
let toastWin = null, toastCur = null, toastTimer = null, toastParent = null;
function placeToast() {
  if (!toastWin || toastWin.isDestroyed() || !win || win.isDestroyed()) return;
  const cb = win.getContentBounds(), [, th] = toastWin.getSize();
  toastWin.setPosition(Math.round(cb.x + 16), Math.round(cb.y + cb.height - th - 16));   // bottom left
}
function closeToast() {
  clearTimeout(toastTimer); toastCur = null;
  if (toastParent) { toastParent.removeListener('move', placeToast); toastParent.removeListener('resize', placeToast); toastParent = null; }
  if (toastWin && !toastWin.isDestroyed()) toastWin.destroy();
  toastWin = null;
}
function showToast(t) {
  if (!win || win.isDestroyed()) return false;
  if (toastCur && toastCur.kind === 'offer' && t.kind !== 'offer') return false;   // a save offer is never replaced
  if (toastCur && t.kind === 'info') return false;                                 // a plain notice never replaces another box
  closeToast();
  toastCur = { ...t };
  toastWin = new BrowserWindow({ parent: win, width: 340, height: 120, frame: false, resizable: false, movable: false, minimizable: false,
    maximizable: false, fullscreenable: false, skipTaskbar: true, focusable: false, show: false, alwaysOnTop: true, hasShadow: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#171d26' : '#f5f7fa',
    webPreferences: { preload: path.join(__dirname, 'toast-preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const tw = toastWin, wc = tw.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' })); wc.on('will-navigate', e => e.preventDefault());
  toastParent = win; win.on('move', placeToast); win.on('resize', placeToast);
  wc.once('did-finish-load', () => {
    if (tw.isDestroyed()) return;
    wc.send('toast', { id: t.id, title: t.title, body: t.body, buttons: t.buttons, appearance: appearance() });
    placeToast(); tw.showInactive();
  });
  tw.loadFile(path.join(__dirname, 'ui', 'toast.html')).catch(() => {});
  toastTimer = setTimeout(() => { if (toastCur && toastCur.kind === 'offer') offers.delete(toastCur.id); closeToast(); }, t.ttl || 30000);
  return true;
}
function answerOffer(id, action) {
  const o = offers.get(id); offers.delete(id);
  if (!o) return;
  if (action === 'never') { vault.addNever(o.origin); notify('Passwords will not be offered for this site.'); }
  else if (action === 'save') { try { const r = vault.save(o.origin, o.username, o.password); notify(r.updated ? 'Password updated.' : 'Password saved.'); } catch (e) { notify(e.message); } }
}
ipcMain.on('toast:act', (e, p) => {
  try {
    if (!toastWin || toastWin.isDestroyed() || e.sender !== toastWin.webContents || !toastCur || !p || p.id !== toastCur.id) return;
    const cur = toastCur, action = String(p.action || '');
    closeToast();
    if (cur.kind === 'download') {
      if (action === 'openwhen') { const on = downloads.setOpenWhenDone(cur.dlId, true); notify(on ? 'It will open when the download finishes.' : 'That download has already finished. Use its Open button.'); }
      else if (action === 'open') downloads.open(cur.dlId).then(how => { if (how === 'revealed') notify('Programs are shown in their folder, not run.'); }).catch(e => notify(e.message));
      else if (action === 'show') downloads.show(cur.dlId);
    }
    else if (cur.kind === 'offer') answerOffer(cur.id, action);
    else if (cur.kind === 'suggest' && action === 'unlock') { requireUnlock('Unlock your saved passwords').then(ok => { if (ok && cur.retry) cur.retry(); }); }
    else if (cur.kind === 'suggest' && (action.startsWith('fill:') || action.startsWith('auto:'))) requireUnlock().then(ok => {
      if (!ok) return;
      const auto = action.startsWith('auto:'), wc = webContents.fromId(cur.wcId), sec = vault.secret(action.slice(5));
      if (wc && !wc.isDestroyed() && sec && eligibleOrigin(wc.getURL()) === sec.origin) {
        if (auto) { try { vault.setAutofill(sec.origin, true); notify(`Auto sign-in is on for ${hostOf(sec.origin).replace(/^www\./, '')}. Turn it off in the Passwords panel.`); } catch (e) { notify(e.message); } }
        wc.send('pm:fill', { username: sec.username, password: sec.password, submit: auto });
      } else notify('That login is saved for a different website.');
    });
  } catch { /* ignore */ }
});
ipcMain.on('toast:size', (e, h) => {
  if (toastWin && !toastWin.isDestroyed() && e.sender === toastWin.webContents && Number.isFinite(h)) { toastWin.setContentSize(340, Math.max(70, Math.min(260, Math.round(h)))); placeToast(); }
});
// Offer a saved login when a sign-in form appears (never fills by itself: the user presses a button).
const noAuto = new Set();      // accounts that were just logged out (by the app or by the site): auto sign-in must not log them straight back in
const autoTried = new Map();   // key -> time auto sign-in last ran for that page type
const suggested = new Map();   // key -> time last suggested (a repeat within a minute is suppressed, so it can come back after a log out)
function maybeSuggest(sender, sid, p) {
  if (!vault || !vault.available || currentSession()?.id !== sid || candidates.has(sid)) return;
  const url = sender.getURL(), origin = eligibleOrigin(url);
  if (!origin || (!p.hasPassword && !(p.hasUser && scope.isAuthFlow(url)))) return;
  const logins = vault.list(origin); if (!logins.length) return;
  const mine = String(store.session(sid)?.label || '').toLowerCase();   // an account's own login is offered first
  logins.sort((a, b) => (b.username.toLowerCase() === mine) - (a.username.toLowerCase() === mine));
  const key = `${sender.id}|${origin}|${p.hasPassword ? 'p' : 'u'}`;
  // One login clearly applies (it is the only one, or it is this account's own): auto sign-in may use it.
  const pick = logins.find(l => l.username.toLowerCase() === mine) || (logins.length === 1 ? logins[0] : null);
  // Auto sign-in: only if the user opted in for this exact site, one login clearly applies, and it has not just been tried (a wrong
  // password is never retried within 90 seconds).
  if (pick && !helloLocked() && !noAuto.has(sid) && vault.isAutofill(origin) && Date.now() - (autoTried.get(key) || 0) > 90 * 1000) {
    const sec = vault.secret(pick.id);
    if (sec && eligibleOrigin(url) === sec.origin) {
      autoTried.set(key, Date.now());
      sender.send('pm:fill', { username: sec.username, password: sec.password, submit: true });
      notify(`Signing in to ${hostOf(origin).replace(/^www\./, '')} as ${sec.username}…`); return;
    }
  }
  if (Date.now() - (suggested.get(key) || 0) < 60 * 1000) return; suggested.set(key, Date.now());
  if (helloLocked()) {   // locked: no names are shown until Windows verifies the user
    showToast({ kind: 'suggest', id: require('crypto').randomUUID(), wcId: sender.id, ttl: 45000, title: 'Saved logins are locked', body: hostOf(origin).replace(/^www\./, ''),
      buttons: [{ id: 'unlock', label: 'Unlock with Windows Hello', primary: true }, { id: 'dismiss', label: 'No thanks' }], retry: () => { suggested.delete(key); maybeSuggest(sender, sid, p); } });
    return;
  }
  showToast({ kind: 'suggest', id: require('crypto').randomUUID(), wcId: sender.id, ttl: 45000, title: 'Use a saved login?',
    body: hostOf(origin).replace(/^www\./, ''),
    buttons: [...logins.slice(0, 3).map((l, i) => ({ id: 'fill:' + l.id, label: l.username || 'Saved login', primary: i === 0 })),
      ...(pick && !vault.isAutofill(origin) ? [{ id: 'auto:' + pick.id, label: 'Always sign in here' }] : []), { id: 'dismiss', label: 'No thanks' }] });
}

function handle(ch, fn, { fromPanel = false } = {}) {
  ipcMain.handle(ch, async (e, ...args) => {
    const trusted = win && (e.sender === win.webContents || (fromPanel && panel && e.sender === panel.webContents));
    if (!trusted) return { ok: false, error: 'Untrusted sender' };
    try { return { ok: true, value: await fn(...args) }; } catch (err) { return { ok: false, error: err.message }; }
  });
}

function wireIpc() {
  const dl = { fromPanel: true };
  handle('state:get', () => snapshot(), { fromPanel: true });
  handle('ws:add', (label, url) => actions.addWorkspace(label, url));
  handle('ws:close', id => actions.closeWorkspace(id));
  handle('ws:select', id => actions.selectWorkspace(id));
  handle('sess:new', wsId => actions.openUnassigned(wsId));
  handle('sess:select', id => actions.selectSession(id));
  handle('sess:assign', (id, label) => actions.assignSession(id, label));
  handle('sess:remove', id => actions.removeSession(id));
  handle('sess:close', id => actions.closeSession(id));
  handle('sess:rename', (id, l) => actions.renameSession(id, l));
  handle('ws:move', (id, i) => actions.moveWorkspace(id, i));
  // Open a remembered page in its own account (reopening the account if it was closed). Only the site's own pages.
  // Opens a page from the history: in its own account when that account still exists on the same site, otherwise in a new tab.
  handle('sess:openPage', (id, url) => {
    url = String(url);
    const s = id && store.session(id), ws = s && store.workspace(s.workspaceId);
    if (s && s.status === 'assigned' && ws && scope.sameSite(ws.startUrl, url)) {
      actions.selectSession(id);
      const v = views.get(id); if (v && !v.webContents.isDestroyed()) v.webContents.loadURL(url).catch(() => {});
      return;
    }
    return actions.addWorkspace('', url);
  });
  handle('history:list', () => store.data.history.slice(0, 1000));
  handle('history:clear', () => { store.clearHistory(); push(); });
  handle('sess:note', (id, t) => actions.setNote(id, t));
  handle('sess:moveTo', (id, i) => actions.moveSessionTo(id, i));
  handle('sess:logout', (id, close) => actions.logoutSession(id, { close: !!close }));
  handle('sess:login', id => actions.loginSession(id));
  handle('sess:useGoogle', (id, gid) => actions.useGoogle(id, gid));
  handle('google:add', p => actions.addGoogle(p), { fromPanel: true });
  handle('google:rename', (id, l) => actions.renameIdentity(id, l), { fromPanel: true });
  handle('google:signin', gid => actions.signInGoogle(gid), { fromPanel: true });
  handle('google:remove', gid => actions.removeGoogle(gid), { fromPanel: true });
  handle('nav:go', u => actions.go(u));
  handle('nav:back', () => actions.back());
  handle('nav:forward', () => actions.forward());
  handle('nav:reload', () => actions.reload());
  handle('nav:external', () => actions.external());
  // Native web views draw above the UI, so hide them while a dialog is open.
  handle('ui:modal', open => { modalOpen = !!open; layout(); });
  // Downloads. The popup may call these too, but it can only name a download by id, never by path.
  const gate = async () => { if (!(await requireUnlock())) throw new Error('Locked. Unlock with Windows Hello first.'); };
  handle('pm:list', () => helloLocked() ? { available: vault.available, locked: true, hello: true, entries: [] }
    : { available: vault.available, locked: false, hello: helloOn(), entries: vault.all().map(e => ({ ...e, auto: vault.isAutofill(e.origin) })) }, dl);
  handle('pm:unlock', async () => ({ unlocked: await requireUnlock('Unlock your saved passwords') }), dl);
  handle('pm:lock', () => { unlockedUntil = 0; push(); }, dl);
  handle('pm:autofill', async (origin, on) => { await gate(); vault.setAutofill(String(origin), !!on); }, dl);
  handle('pm:remove', async id => { await gate(); vault.remove(String(id)); }, dl);
  handle('pm:clear', async () => { await gate(); vault.clear(); }, dl);
  // Turn the requirement on (Windows must verify you now, so a PC where it does not work can never lock you out) or off (verify first).
  handle('hello:set', async on => {
    if (process.platform !== 'win32') throw new Error(hello.describe('Unsupported'));
    const r = await hello.verify(on ? 'Turn on Windows Hello for saved passwords' : 'Turn off Windows Hello for saved passwords');
    if (!r.ok) throw new Error(hello.describe(r.status));
    store.setHello(!!on); unlockedUntil = on ? Date.now() + (store.data.ui.helloMinutes || 5) * 60000 : 0; push();
  });
  handle('side:tab', tab => { if (tab) showPanel(String(tab)); return panelTab; }, dl);
  handle('side:toggle', tab => togglePanel(String(tab)));
  handle('pm:fill', id => fillLogin(String(id)), dl);
  handle('side:hide', () => hidePanel(), dl);
  handle('menu:open', pos => openMainMenu(pos));
  handle('ctx:account', id => accountMenu(id));
  handle('sidebar:toggle', () => toggleSidebar());
  handle('settings:save', patch => {
    if (patch.homeUrl) {
      const norm = normalizeUrl(patch.homeUrl, { strict: true });
      if (!norm) throw new Error('Enter a valid home page URL (or leave blank)');
      patch.homeUrl = norm;
    }
    if (patch.searchCustom !== undefined) { const c = Engines.checkTemplate(patch.searchCustom); if (!c.ok) throw new Error(c.error); patch.searchCustom = c.url; }
    if (patch.searchEngine === 'custom' && !Engines.checkTemplate(patch.searchCustom !== undefined ? patch.searchCustom : store.data.ui.searchCustom).ok)
      throw new Error('Enter your search address first. It must contain %s where the search words go.');
    if (patch.downloadDir !== undefined) { setDownloadDir(patch.downloadDir || null); delete patch.downloadDir; }
    store.setSettings(patch);
    applyTitleBarTheme();
    push();
  });
  handle('sess:useGoogleMany', (id, gids) => actions.useGoogleMany(id, gids));
  // "Use another account": reveal the real Google sign-in (as a modal window if it was a popup, else in the page).
  handle('google:another', id => { const w = popupFor(id); if (w) { w.show(); w.focus(); } });
  handle('google:cancel', id => { popupFor(id)?.close(); });
  handle('dl:toggle', () => togglePanel());
  handle('dl:hide', () => hidePanel(), dl);
  handle('dl:list', () => { downloads.checkFiles(); return downloads.payload(); }, dl);
  handle('dl:pause', id => downloads.pause(id), dl);
  handle('dl:resume', id => downloads.resume(id), dl);
  handle('dl:cancel', id => downloads.cancel(id), dl);
  handle('dl:remove', id => downloads.remove(id), dl);
  handle('dl:clear', () => downloads.clear(), dl);
  handle('dl:open', id => downloads.open(id), dl);
  handle('dl:show', id => downloads.show(id), dl);
  handle('dl:folder', () => downloads.folder(), dl);
  // Right-click menu for a row of the Downloads panel (the panel names the row by id only).
  handle('dl:copylink', id => { const r = downloads.linkOf(String(id)); clipboard.writeText(r.url); return { partial: r.partial }; }, dl);
  handle('dl:menu', id => {
    id = String(id); const r = downloads.items.get(id); if (!r) return;
    const done = r.state === 'completed', usable = done && !r.missing, running = r.state === 'progressing';
    let hasLink = true; try { downloads.linkOf(id); } catch { hasLink = false; }
    const tell = m => { if (panel && !panel.webContents.isDestroyed()) panel.webContents.send('side-note', m); };
    const tpl = [
      { label: 'Open', enabled: usable, click: () => downloads.open(id).catch(err => tell(err.message)) },
      { label: 'Show in folder', enabled: done, click: () => downloads.show(id) },
      { type: 'separator' },
      { label: 'Copy download link', enabled: hasLink, click: () => { try { const l = downloads.linkOf(id); clipboard.writeText(l.url); tell(l.partial ? 'Copied the link without its query part. The full link is only kept until the app closes.' : 'Download link copied.'); } catch (err) { tell(err.message); } } },
      { type: 'separator' },
      ...(running ? [{ label: 'Open when complete', type: 'checkbox', checked: !!r.openWhenDone, click: () => downloads.setOpenWhenDone(id, !r.openWhenDone) }, { label: r.paused ? 'Resume' : 'Pause', click: () => (r.paused ? downloads.resume(id) : downloads.pause(id)) }, { label: 'Cancel download', click: () => downloads.cancel(id) }]
        : [{ label: 'Remove from list', click: () => downloads.remove(id) }])
    ];
    Menu.buildFromTemplate(tpl).popup({ window: win });
  }, dl);
  // Show one saved password, for a few seconds, after the system has just verified the person. It never travels in the state.
  const revealLimit = reveal.limiter();
  handle('pm:reveal', async id => {
    if (!vault.available) throw new Error('Secure storage is not available on this computer.');
    const sec = vault.secret(String(id)); if (!sec) throw new Error('That saved login is no longer there.');
    if (!revealLimit()) throw new Error('Too many passwords shown in a minute. Wait a little and try again.');
    const r = await reveal.authorize({ platform: process.platform, helloVerify: hello.verify, helloDescribe: hello.describe,
      canTouchId: () => { try { return !!systemPreferences.canPromptTouchID(); } catch { return false; } }, touchId: m => systemPreferences.promptTouchID(m) },
      `Show the saved password for ${hostOf(sec.origin).replace(/^www\./, '')}`);
    if (!r.ok) throw new Error(r.error);
    log('password-viewed');   // never the password, the site or the user name
    return { id: sec.id, password: sec.password, seconds: reveal.SHOW_SECONDS };
  }, dl);
  handle('dl:choose', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose the download folder', defaultPath: downloadDir(), properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    setDownloadDir(r.filePaths[0]); return r.filePaths[0];
  });
}

// Exactly one waiting session per website. Older versions could leave several; extra empty ones are discarded.
async function normalizePending() {
  for (const ws of store.workspaces) {
    const pend = store.sessionsOf(ws.id).filter(x => x.status === 'pending');
    const keep = pend.find(x => x.id === ws.lastSessionId) || pend[0];
    for (const x of pend) if (x !== keep) { await deleteSessionData(x); store.removeSession(x.id); }
    if (!keep) store.addSession(ws.id);
  }
}

// After a restart, sessions that were signed in to Google before the account list existed are picked up too,
// so the chooser lists every Google account known to the app.
async function reconcileGoogle() {
  for (const s of [...store.data.sessions]) {
    if (s.status !== 'assigned' || s.googleId) continue;
    try { if (await sg.hasGoogleLogin(session.fromPartition(partitionOf(s)), googleSuffixes)) await syncGoogle(s.id); } catch { /* best effort */ }
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 480, title: 'Session Browser',
    icon: winIcon(),
    // Tabs live in the title bar, like Chrome: no native title bar, the system min/max/close buttons float over the tab strip.
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 14, y: 14 } }
      : { titleBarOverlay: { color: appearance().vars['--chrome'], symbolColor: appearance().vars['--ink'], height: 42 } }),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false }
  });
  win.on('resize', layout);
  win.removeMenu();
  nativeTheme.on('updated', () => { applyTitleBarTheme(); push(); });
  win.webContents.on('context-menu', (_e, params) => { if (params.isEditable || params.selectionText) showContextMenu(win.webContents, { ...params, linkURL: '', mediaType: 'none' }, { page: false }); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.on('did-fail-load', (_e, code, desc) => bootLog(`ui load failed ${code} ${desc}`));
  win.webContents.on('preload-error', (_e, p, err) => bootLog('preload error ' + (err && err.message)));
  win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });
  win.loadFile(path.join(__dirname, 'ui', 'index.html')).catch(err => bootLog('loadFile ' + err.message));
  win.webContents.once('did-finish-load', async () => {
    await normalizePending();
    const cur = currentSession(); if (cur) ensureView(cur);
    layout(); push(); sendDownloads();
    reconcileGoogle();
    refreshAllLogins(); setInterval(refreshAllLogins, 60 * 1000).unref?.();
  });
}

if (!app.requestSingleInstanceLock()) { app.quit(); } else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    try {
      bootLog('starting');
    store = new Store(path.join(app.getPath('userData'), 'session-browser.json'));
    if (store.recovered) log('metadata-recovered');
    vault = new Vault(path.join(app.getPath('userData'), 'vault.json'), safeStorage);
    { const n = vault.purgeAnonymous(); if (n) setTimeout(() => notify(`Removed ${n} saved password${n > 1 ? 's' : ''} that had no username (they could not be told apart). Sign in again to save them.`), 3000); }
    downloads = new DownloadManager({ store, dir: downloadDir(), shell });
    downloads.on('change', sendDownloads);
    downloads.on('maxspeed', () => push());
    // Balloons for downloads. When a download starts: "Open when complete". When it finishes: "Open" and "Show in folder".
    // (If another box is busy, or no page is showing, the plain notice is used instead, without buttons.)
    const dlBalloon = (r, title, buttons, ttl, fallback) => {
      const cur = currentSession(), visible = !!cur && views.has(cur.id) && !modalOpen;
      if (visible && showToast({ kind: 'download', id: require('crypto').randomUUID(), dlId: r.id, ttl, title, body: String(r.name).slice(0, 200), buttons })) return;
      notify(fallback);
    };
    downloads.on('started', r => dlBalloon(r, 'Downloading', [{ id: 'openwhen', label: 'Open when complete', primary: true }, { id: 'dismiss', label: 'Dismiss' }], 9000, `Downloading ${r.name}`));
    downloads.on('done', r => {
      if (r.state === 'completed') {
        if (r.openWhenDone) {   // asked for when it started: open it now (programs are shown in their folder, never run)
          downloads.open(r.id).then(how => notify(how === 'revealed' ? `Downloaded ${r.name}. Programs are shown in their folder, not run.` : `Opened ${r.name}`)).catch(e => notify(e.message));
          if (toastCur && toastCur.kind === 'download') closeToast();
          return;
        }
        dlBalloon(r, 'Download complete', [{ id: 'open', label: 'Open', primary: true }, { id: 'show', label: 'Show in folder' }, { id: 'dismiss', label: 'Dismiss' }], 20000, `Downloaded ${r.name}`);
      } else if (r.state === 'interrupted') { if (toastCur && toastCur.kind === 'download') closeToast(); notify(`Download failed: ${r.name}`); }
    });
    if (process.platform === 'darwin') Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
    else Menu.setApplicationMenu(null);   // no menu bar: everything is in the three-dot menu
    if (process.env.SB_TEST === '1') {
      global.__sb = { actions, store, views, snapshot, downloads,
        setGoogleSuffixes: x => { googleSuffixes = x; }, setGoogleInfoUrl: x => { googleInfoUrl = x; }, syncGoogle: id => syncGoogle(id), baselineReady: id => baselines.get(id) instanceof Map,
        exec: (id, code) => views.get(id).webContents.executeJavaScript(code),
        go: async (id, url) => {   // retries when a concurrent load aborts this one (ERR_ABORTED)
          for (let i = 0; ; i++) {
            try { return await views.get(id).webContents.loadURL(url); }
            catch (e) { if (i >= 4 || !/ERR_ABORTED|\(-3\)/.test(e.message + e.code)) throw e; await new Promise(r => setTimeout(r, 250)); }
          }
        } };
    }
    wireIpc(); createWindow();
      bootLog('window created');
    } catch (err) {
      bootLog('startup failed ' + (err && err.stack || err));
      dialog.showErrorBox('Session Browser could not start', String(err && err.message || err));
      app.exit(1);
    }
  });
  app.on('window-all-closed', () => app.quit());
  // Make sure cookies and storage reach disk before exit so logins survive a restart.
  app.on('before-quit', e => {
    if (quitting) return;
    e.preventDefault(); quitting = true;
    const parts = store ? [...store.data.sessions.map(partitionOf), ...store.data.googleAccounts.map(g => 'persist:' + g.partition)] : [];
    const jobs = parts.map(async p => {
      const ses = session.fromPartition(p);
      await ses.cookies.flushStore(); await ses.flushStorageData();
    });
    // Never hang on exit: a lingering invisible process would hold the single-instance lock and block the next launch.
    const bail = setTimeout(() => app.exit(0), 4000);
    Promise.allSettled(jobs).then(() => { clearTimeout(bail); app.quit(); });
  });
}
