'use strict';
const $ = s => document.querySelector(s);
let S = null;

// Icons drawn as SVG so they sit exactly in the middle of their circle (text arrows and crosses sit off-centre, and differ by font).
const ICONS = {
  back: '<path d="M10 3 5 8l5 5"/>', forward: '<path d="M6 3l5 5-5 5"/>', x: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>', plus: '<path d="M8 3.5v9M3.5 8h9"/>',
  reload: '<path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2.8v3h-3"/>'
};
function icon(name, size = 16) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('width', size); s.setAttribute('height', size); s.setAttribute('aria-hidden', 'true');
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.6'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  s.innerHTML = ICONS[name]; return s;
}

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;   // CSSOM is allowed by the CSP; style attributes are not
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k);
  return e;
}
// replaceChildren() turns a null argument into the text "null", so empty slots are dropped first.
const fill = (parent, ...kids) => parent.replaceChildren(...kids.flat().filter(k => k != null && k !== false));
let toastTimer;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 4000); }
async function call(ch, ...args) { const r = await sb.invoke(ch, ...args); if (!r.ok) toast(r.error); return r; }

// Dialog. Native web views draw above this UI, so main hides them while it is open.
function ask({ title, body, fields = [], confirm = 'OK', danger = false }) {
  return new Promise(resolve => {
    const form = $('#dialog'), scrim = $('#scrim');
    const inputs = fields.map(f => el('input', { name: f.name, value: f.value || '', placeholder: f.placeholder || '', maxlength: 200, autocomplete: 'off' }));
    const done = v => { scrim.hidden = true; form.onsubmit = null; sb.invoke('ui:modal', false); resolve(v); };
    fill(form,
      el('h3', { id: 'dlg-title' }, title), body ? el('p', {}, body) : null,
      ...fields.map((f, i) => el('label', {}, el('span', {}, f.label), inputs[i])),
      el('div', { class: 'buttons' },
        el('button', { type: 'button', class: 'btn', onclick: () => done(null) }, 'Cancel'),
        el('button', { type: 'submit', class: 'btn ' + (danger ? 'danger' : 'primary') }, confirm)));
    form.onsubmit = e => { e.preventDefault(); done(Object.fromEntries(fields.map((f, i) => [f.name, inputs[i].value]))); };
    form.onkeydown = e => { if (e.key === 'Escape') done(null); };
    sb.invoke('ui:modal', true).then(() => { scrim.hidden = false; (inputs[0] || form.querySelector('.btn.primary,.btn.danger')).focus(); });
  });
}

// Shows the build constants from build.js. Nothing here reads a clock.
const buildText = () => BUILD_STAMP !== 'unknown' ? 'Build ' + BUILD_STAMP : 'Build unknown · v' + BUILD_VERSION + ' (' + BUILD_NOTE + ')';
const buildLine = () => el('div', { class: 'buildline', title: 'Build date and time (local)' }, buildText());

const LOGIN_TEXT = { in: 'Signed in', out: 'Signed out', unknown: 'Sign-in not detected' };
const hue = id => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const siteName = ws => ws.label || 'Website';

function tabIcon(ws) {
  return ws.icon ? el('img', { class: 'ico', src: ws.icon, alt: '', draggable: 'false' })
    : el('span', { class: 'ico fallback', style: `background:hsl(${hue(ws.id)} 45% 40%)`, 'aria-hidden': 'true' }, siteName(ws).slice(0, 1).toUpperCase());
}
let dragId = null, dragSess = null;
const clearDropMarks = () => document.querySelectorAll('.tab.drop-before,.tab.drop-after').forEach(t => t.classList.remove('drop-before', 'drop-after'));
function renderTabs() {
  fill($('#tabs'),
    ...S.workspaces.map((ws, idx) => {
      const n = S.sessions.filter(s => s.workspaceId === ws.id && s.status === 'assigned').length;
      const sel = ws.id === S.activeWorkspaceId;
      return el('div', { class: 'tab', role: 'tab', 'aria-selected': String(sel), tabindex: 0, draggable: 'true', title: `${siteName(ws)}\n${ws.startUrl}`,
        onclick: () => call('ws:select', ws.id),
        ondragstart: e => { dragId = ws.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', ws.id); e.currentTarget.classList.add('dragging'); },
        ondragend: e => { dragId = null; e.currentTarget.classList.remove('dragging'); clearDropMarks(); },
        ondragover: e => {
          if (!dragId || dragId === ws.id) return;
          e.preventDefault(); e.dataTransfer.dropEffect = 'move';
          const r = e.currentTarget.getBoundingClientRect(), after = e.clientX > r.left + r.width / 2;
          clearDropMarks(); e.currentTarget.classList.add(after ? 'drop-after' : 'drop-before');
        },
        ondrop: e => {
          if (!dragId || dragId === ws.id) return;
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect(), after = e.clientX > r.left + r.width / 2;
          const from = S.workspaces.findIndex(w => w.id === dragId);
          let to = idx + (after ? 1 : 0); if (from < to) to--;
          const id = dragId; dragId = null; clearDropMarks();
          if (from >= 0 && from !== to) call('ws:move', id, to);
        },
        onauxclick: e => { if (e.button === 1) { e.preventDefault(); closeWebsite(ws); } },   // middle-click closes, like Chrome
        onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') call('ws:select', ws.id); } },
        tabIcon(ws), el('span', { class: 'name' }, siteName(ws)),
        n ? el('span', { class: 'count', title: `${n} signed-in account${n > 1 ? 's' : ''}` }, String(n)) : null,
        el('button', { class: 'x', 'aria-label': `Close ${ws.label}`, title: 'Close website', onclick: e => { e.stopPropagation(); closeWebsite(ws); } }, icon('x', 14)));
    }),
    el('button', { id: 'addtab', 'aria-label': 'Add website', title: 'Add website (Ctrl+T)', onclick: addWebsite }, icon('plus', 16)));
}

function renderSidebar() {
  const side = $('#sidebar'), ws = S.workspaces.find(w => w.id === S.activeWorkspaceId);
  if (!ws) { fill(side); return; }
  const list = S.sessions.filter(s => s.workspaceId === ws.id);
  const assigned = list.filter(s => s.status === 'assigned').sort((a, b) => a.sortOrder - b.sortOrder);
  const waiting = list.filter(s => s.status === 'pending').sort((a, b) => a.createdAt - b.createdAt)[0] || null;
  const sel = S.sessions.find(s => s.id === ws.lastSessionId);
  const lnk = (t, fn, danger) => el('button', { class: 'lnk' + (danger ? ' danger' : ''), onclick: fn }, t);

  // One fixed Unassigned session per website. Clicking it only shows the signed-out page. It never changes into
  // an account: when sign-in is detected the account appears under Accounts and a fresh one is ready here.
  const unassigned = () => {
    const isSel = !!sel && sel.status === 'pending', cur = isSel ? sel : waiting;
    return el('div', { class: 'item un' + (isSel ? ' sel' : '') },
      el('div', { class: 'line' },
        el('button', { class: 'row', 'aria-current': isSel ? 'true' : null, onclick: () => call('sess:new', ws.id) },
          el('span', { class: 'avatar pending' }, '?'),
          el('span', { class: 'text' }, el('div', { class: 'label' }, 'Unassigned session'),
            el('div', { class: 'sub' + (cur && cur.error ? ' err' : '') }, (cur && cur.error) || 'Not signed in'))),
        cur && cur.open ? el('button', { class: 'x close', 'aria-label': 'Start over with a fresh unassigned session',
          title: 'Start over with a fresh signed-out session', onclick: e => { e.stopPropagation(); call('sess:close', cur.id); } }, icon('x', 14)) : null));
  };

  // Right-click an account for Rename, Move up/down, Close and Remove.
  const clearSessMarks = () => document.querySelectorAll('.item.drop-before,.item.drop-after').forEach(t => t.classList.remove('drop-before', 'drop-after'));
  const item = (s, idx) => {
    const isSel = sel && sel.id === s.id, live = s.open;
    return el('div', { class: 'item' + (isSel ? ' sel' : '') + (live ? '' : ' closed'), draggable: 'true',
      oncontextmenu: e => { e.preventDefault(); call('ctx:account', s.id); },
      ondragstart: e => { dragSess = s.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', s.id); e.currentTarget.classList.add('dragging'); },
      ondragend: e => { dragSess = null; e.currentTarget.classList.remove('dragging'); clearSessMarks(); },
      ondragover: e => {
        if (!dragSess || dragSess === s.id) return;
        e.preventDefault(); e.dataTransfer.dropEffect = 'move';
        const r = e.currentTarget.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
        clearSessMarks(); e.currentTarget.classList.add(after ? 'drop-after' : 'drop-before');
      },
      ondrop: e => {
        if (!dragSess || dragSess === s.id) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
        const from = assigned.findIndex(x => x.id === dragSess); let to = idx + (after ? 1 : 0); if (from < to) to--;
        const id = dragSess; dragSess = null; clearSessMarks();
        if (from >= 0 && from !== to) call('sess:moveTo', id, to);
      } },
      el('div', { class: 'line' },
        el('button', { class: 'row', 'aria-current': isSel ? 'true' : null, title: [s.label, LOGIN_TEXT[s.login || 'unknown'] + (live ? '' : ' · Closed'), s.note || '', live && s.title ? s.title : ''].filter(Boolean).join('\n'), onclick: () => call('sess:select', s.id) },
          el('span', { class: 'av' },
            el('span', { class: 'avatar', style: `background:hsl(${hue(s.id)} 45% 38%)` }, s.label.slice(0, 1).toUpperCase()),
            el('span', { class: 'dot ' + (s.login || 'unknown'), title: LOGIN_TEXT[s.login || 'unknown'], role: 'img', 'aria-label': LOGIN_TEXT[s.login || 'unknown'] })),
          el('span', { class: 'text' }, el('div', { class: 'label' }, s.label),
            el('div', { class: 'sub' + (s.error ? ' err' : '') + ' ' + (s.login || '') },
              s.error || (LOGIN_TEXT[s.login || 'unknown'] + (live ? '' : ' · Closed. Click to open'))),
            s.note ? el('div', { class: 'note' }, s.note) : null)),
        // One × does both jobs: on an open account it closes it (stays signed in); on a closed one it removes it.
        el('button', { class: 'x close' + (live ? '' : ' rm'), 'aria-label': (live ? 'Log out and close ' : 'Remove ') + s.label,
          title: live ? 'Log out and close. Log in again from the account menu' : 'Remove this account and its saved login',
          onclick: e => { e.stopPropagation(); if (live) call('sess:logout', s.id, true); else removeSession(s); } }, icon('x', 14))));
  };

  fill(side,
    unassigned(),
    el('div', { class: 'group' }, 'Accounts'),
    ...(assigned.length ? assigned.map(item) : [el('div', { class: 'sub', style: 'padding:2px 8px' }, 'No accounts yet. Sign in under Unassigned session and it is named and saved here automatically.')]),
    buildLine());
}

function renderStage() {
  const ws = S.workspaces.find(w => w.id === S.activeWorkspaceId);
  const has = ws && S.sessions.some(s => s.id === ws.lastSessionId);
  if (has && S.nav && S.nav.blankLoading) { fill($('#stage'), el('div', { class: 'spinwrap', role: 'status' }, el('div', { class: 'spinner', 'aria-hidden': 'true' }), el('p', {}, 'Loading…'))); return; }
  fill($('#stage'), ...(has ? [] : !ws
    ? [el('div', {}, el('img', { class: 'applogo', src: 'logo.png', alt: '', width: '72', height: '72' }), el('h2', {}, 'Add your first website'), el('p', {}, 'Each website gets its own tab. Inside it you can stay signed in to as many accounts as you like.'), el('button', { class: 'btn primary', onclick: addWebsite }, 'Add website'))]
    : [el('div', {}, el('h2', {}, 'No session open'), el('p', {}, 'Pick an account on the left, or open the Unassigned session and sign in. It is named and saved automatically.'), el('button', { class: 'btn primary', onclick: () => call('sess:new', ws.id) }, 'Open unassigned session'))]));
}

// Same page as the tab's default address? (ignores www, query, hash and a trailing slash)
const addrKey = u => { try { const x = new URL(u); return x.host.replace(/^www\./, '').toLowerCase() + x.pathname.replace(/\/+$/, ''); } catch { return ''; } };
function renderToolbar() {
  const n = S.nav, addr = $('#address'), home = $('#home');
  $('#back').disabled = !n.canBack; $('#forward').disabled = !n.canForward;
  $('#reload').replaceChildren(icon(n.loading ? 'x' : 'reload', 16));
  $('#reload').setAttribute('aria-label', n.loading ? 'Loading' : 'Reload');
  addr.placeholder = `Search ${Engines.label(S.ui)} or enter address`;
  const hasHome = !!n.home && n.home !== 'about:blank', locked = !!n.locked;
  const onHome = hasHome && (!n.url || addrKey(n.url) === addrKey(n.home));
  // Until an account is signed in the address is free to edit. After that the tab's default address is fixed: the bar is read-only on it,
  // and elsewhere the default sits beside the real address (click it to return).
  addr.readOnly = locked && onHome;
  addr.title = addr.readOnly ? 'This tab has an account, so its default address is fixed. Use + to open another site.' : '';
  home.hidden = !(locked && hasHome && !onHome);
  if (!home.hidden) {
    let host = ''; try { host = new URL(n.home).host.replace(/^www\./, ''); } catch {}
    home.textContent = '⌂ ' + host; home.title = `Default address: ${n.home}\nClick to return to it`;
  }
  if (document.activeElement !== addr) addr.value = (locked && onHome) ? n.home : (n.url || (hasHome ? n.home : ''));
}

function renderLayout() {
  document.documentElement.dataset.platform = S.platform || '';
  applyAppearance(S.appearance);
  document.body.classList.toggle('nosb', !S.sidebarOpen);
  document.body.classList.toggle('dlopen', !!S.sidePanel);
  $('#accounts').setAttribute('aria-pressed', String(!!S.sidebarOpen));

  $('#downloads').setAttribute('aria-pressed', String(!!S.downloadsOpen));
  $('#keys').setAttribute('aria-pressed', String(S.sidePanel === 'passwords'));
  $('#sessions').setAttribute('aria-pressed', String(S.sidePanel === 'sessions'));
}
function render() {
  renderLayout(); renderTabs(); renderSidebar(); renderStage(); renderToolbar();
  if (S.recovered && !render.warned) { render.warned = true; toast('Saved website list was unreadable. A backup was kept and the list was reset.'); }
}

async function addWebsite() {
  await call('ws:add', '', (S && S.homeUrl) || '');
}

async function closeWebsite(ws) {
  // Only real accounts count (and a waiting session that looks signed in). The empty "Unassigned session" holds nothing to lose.
  const n = S.sessions.filter(s => s.workspaceId === ws.id && (s.status === 'assigned' || s.looksSignedIn)).length;
  if (!n) { await call('ws:close', ws.id); return; }   // nothing saved: close at once, like any browser tab
  const v = await ask({ title: `Close ${ws.label}?`, danger: true, confirm: 'Close and delete sessions',
    body: `This deletes ${n} saved session${n > 1 ? 's' : ''} for this website from this computer and signs you out of them here. Your online accounts are not deleted.` });
  if (v) await call('ws:close', ws.id);
}
async function noteSession(s) {
  const v = await ask({ title: s.note ? 'Edit note' : 'Add note', confirm: 'Save', fields: [{ name: 'note', label: 'Note (shown under the account, leave empty to remove)', value: s.note || '' }] });
  if (v) await call('sess:note', s.id, v.note);
}
async function renameSession(s) {
  const v = await ask({ title: 'Rename account', confirm: 'Save', fields: [{ name: 'label', label: 'Name', value: s.label }] });
  if (v) await call('sess:rename', s.id, v.label);
}
async function removeGoogle(g) {
  const v = await ask({ title: `Remove ${g.label}?`, danger: true, confirm: 'Remove',
    body: 'This forgets the saved Google account in this app. Sessions that already used it stay signed in. Your Google account is not deleted.' });
  if (v) await call('google:remove', g.id);
}
// Chrome-style "Choose an account": the saved Google accounts, shown over the window whenever the current session
// reaches a Google sign-in page. Tick one, several or all. Accounts already signed in on another session of this
// website are not listed again.
function chooseGoogle(p) {
  const sid = p.sid, prov = p.provider || 'google';
  const scrim = $('#scrim'), form = $('#dialog');
  const s = S && S.sessions.find(x => x.id === sid), ws = s && S.workspaces.find(w => w.id === s.workspaceId);
  if (!scrim.hidden || !s) { if (s) sb.invoke('google:another', sid); return; }
  // Every signed-in saved account is listed, including ones whose session is Closed. Picking one that already has a
  // session on this website switches to (reopens) it.
  const accts = S.googleAccounts.filter(g => g.signedIn && (g.provider || 'google') === prov);
  const have = g => S.sessions.find(x => x.workspaceId === s.workspaceId && x.status === 'assigned' && x.googleId === g.id);
  if (!accts.length) { sb.invoke('google:another', sid); return; }
  const boxes = accts.map(g => el('input', { type: 'checkbox', value: g.id, 'aria-label': g.label }));
  const go = el('button', { type: 'button', class: 'btn primary', disabled: true }, 'Continue');
  const all = el('button', { type: 'button', class: 'lnk' }, 'Select all');
  const picked = () => boxes.filter(b => b.checked).map(b => b.value);
  const sync = () => {
    const n = picked().length;
    go.disabled = !n; go.textContent = n > 1 ? `Sign in to ${n} accounts` : 'Continue';
    all.textContent = n === boxes.length ? 'Clear all' : 'Select all';
  };
  const done = fn => { scrim.hidden = true; form.onkeydown = null; form.onsubmit = null; sb.invoke('ui:modal', false); if (fn) fn(); };
  boxes.forEach(b => b.addEventListener('change', sync));
  all.onclick = () => { const on = picked().length !== boxes.length; boxes.forEach(b => { b.checked = on; }); sync(); };
  go.onclick = () => { const ids = picked(); if (ids.length) done(() => call('sess:useGoogleMany', sid, ids)); };
  const another = () => done(() => sb.invoke('google:another', sid));   // continue on Google's own sign-in to add a new account
  const cancel = () => done(() => sb.invoke('google:cancel', sid));
  fill(form,
    el('h3', { id: 'dlg-title' }, 'Choose an account'),
    el('p', {}, `${p.label || 'Google'} · to continue to ${ws ? ws.label : 'this site'}`),
    el('div', { class: 'gscroll' }, ...accts.map((g, i) => {
      const h = have(g);
      return el('label', { class: 'gcheck' }, boxes[i],
        el('div', { class: 'avatar sm', style: `background:hsl(${hue(g.id)} 45% 38%)` }, g.label.slice(0, 1).toUpperCase()),
        el('div', { class: 'text' }, el('div', { class: 'label', title: g.label }, g.label),
          h ? el('div', { class: 'sub' }, h.open ? 'Open on this website' : 'Closed. Will reopen') : null));
    })),
    accts.length > 1 ? el('div', { class: 'picklinks' }, all) : null,
    el('div', { class: 'buttons' }, el('button', { type: 'button', class: 'btn', onclick: cancel }, 'Cancel'),
      el('button', { type: 'button', class: 'btn', onclick: another }, 'Use another account'), go));
  form.onsubmit = e => { e.preventDefault(); go.click(); };
  form.onkeydown = e => { if (e.key === 'Escape') cancel(); };
  sb.invoke('ui:modal', true).then(() => { scrim.hidden = false; boxes[0].focus(); });
}
async function removeSession(s) {
  const pending = s.status === 'pending';
  const v = await ask({ title: pending ? 'Discard this session?' : `Remove ${s.label}?`, danger: true, confirm: pending ? 'Discard' : 'Remove account',
    body: 'This deletes the session’s saved data from this computer and signs you out of it here. The online account is not deleted.' });
  if (v) await call('sess:remove', s.id);
}

$('#home').onclick = () => { if (S && S.nav.home) call('nav:go', S.nav.home); };
$('#toolbar').addEventListener('submit', async e => { e.preventDefault(); if ($('#address').readOnly) return; const r = await call('nav:go', $('#address').value); if (r.ok) $('#address').blur(); });
$('#back').onclick = () => call('nav:back');
$('#forward').onclick = () => call('nav:forward');
$('#back').replaceChildren(icon('back')); $('#forward').replaceChildren(icon('forward')); $('#reload').replaceChildren(icon('reload'));
$('#reload').onclick = () => call('nav:reload');
$('#downloads').onclick = () => call('dl:toggle');
$('#accounts').onclick = () => call('sidebar:toggle');
// mousedown is cancelled so the menu button does not take focus: Cut/Copy/Paste then act on whatever had it.
$('#menu').addEventListener('mousedown', e => e.preventDefault());
$('#keys').addEventListener('mousedown', e => e.preventDefault());
$('#searchbtn').onclick = () => openSearch();
$('#keys').onclick = () => call('side:toggle', 'passwords');
$('#sessions').onclick = () => call('side:toggle', 'sessions');
$('#menu').onclick = () => { const r = $('#menu').getBoundingClientRect(); call('menu:open', { x: r.right - 4, y: r.bottom + 2 }); };
function renderDownloads(p) {
  const b = $('#downloads'), bar = b.querySelector('.bar');
  b.classList.toggle('busy', p.active > 0);
  bar.hidden = !p.active;
  bar.style.setProperty('--p', Math.round((p.progress || 0) * 100) + '%');
  b.title = p.active ? `Downloads: ${p.active} in progress (Ctrl+J)` : 'Downloads (Ctrl+J)';
}
$('#address').addEventListener('focus', e => e.target.select());
$('#address').addEventListener('blur', () => S && renderToolbar());
window.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.key === 'l') { e.preventDefault(); $('#address').focus(); }
  else if (e.key === 't') { e.preventDefault(); addWebsite(); }
  else if (e.key === 'r') { e.preventDefault(); call('nav:reload'); }
  else if (e.key === 'j') { e.preventDefault(); call('dl:toggle'); }
  else if (e.key === 'k') { e.preventDefault(); openSearch(); }
});
sb.on('state', s => { S = s; render(); });
sb.on('notice', toast);
sb.on('ctx', ({ action, id }) => {
  const s = S && S.sessions.find(x => x.id === id); if (!s) return;
  if (action === 'rename') renameSession(s); else if (action === 'note') noteSession(s); else if (action === 'remove') removeSession(s);
});
sb.on('downloads', renderDownloads);
sb.on('focus-address', () => $('#address').focus());
sb.on('google-chooser', p => chooseGoogle(p));
sb.on('new-website', addWebsite);
sb.on('open-settings', () => openSettings());
sb.on('open-search', () => openSearch());
sb.invoke('state:get').then(r => { if (r.ok) { S = r.value; render(); } });
sb.invoke('dl:list').then(r => { if (r.ok) renderDownloads(r.value); });
