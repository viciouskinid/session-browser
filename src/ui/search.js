'use strict';
// Global search (Ctrl+K or the toolbar icon): accounts, websites, saved sessions, saved passwords (site and username only) and
// commands. Ranked: exact title, title starts with, title contains, secondary text contains. Keyboard first.
function searchRank(item, tokens) {
  const title = item.title.toLowerCase(), sub = (item.sub || '').toLowerCase();
  let total = 0;
  for (const t of tokens) {
    let s = 0;
    if (title === t) s = 100; else if (title.startsWith(t)) s = 80; else if (title.split(/[\s.@/-]+/).some(w => w.startsWith(t))) s = 70; else if (title.includes(t)) s = 60;
    else if (sub.includes(t)) s = 30; else if ((item.keys || '').includes(t)) s = 20;
    if (!s) return 0;      // every word must match something
    total += s;
  }
  return total / tokens.length;
}

function magnifier() {   // a real SVG (el() makes HTML elements only)
  const w = document.createElement('span'); w.style.display = 'contents';
  w.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';
  return w;
}

const dayLabel = t => {
  const d = new Date(t), today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((today - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
};

// Search is first a HISTORY search: with nothing typed it lists the pages you visited (newest first, by day), and typing filters them.
// The "Everything" scope adds accounts, websites, saved sessions, saved passwords (site and username only) and commands.
async function openSearch() {
  const scrim = $('#qscrim'), box = $('#search');
  if (!scrim.hidden) { const i = box.querySelector('input'); if (i) { i.focus(); i.select(); } return; }
  if (!$('#scrim').hidden || !$('#sscrim').hidden) return;                       // never over another dialog
  const trigger = document.activeElement;
  let others = [], hist = [], results = [], sel = 0, query = '', state = 'idle', scope = openSearch.scope || 'history', stateErr = '';
  const ws = id => S.workspaces.find(w => w.id === id);
  const close = () => { scrim.hidden = true; box.onkeydown = null; sb.invoke('ui:modal', false); if (trigger && trigger.focus && document.contains(trigger)) trigger.focus(); };
  const run = it => { close(); setTimeout(() => it.run(), 0); };

  const curWs = S.workspaces.find(w => w.id === S.activeWorkspaceId), cur = (curWs && S.sessions.find(x => x.id === curWs.lastSessionId)) || null;
  const stampOf = t => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  // Every page opened in any tab: with an account (its name is the tag), or without one.
  const histItems = () => hist.map(h => {
    const s = h.sessionId ? S.sessions.find(x => x.id === h.sessionId) : null, acct = s && s.status === 'assigned' ? s.label : '';
    let host = '', path = ''; try { const u = new URL(h.url); host = u.host.replace(/^www\./, ''); path = u.pathname; } catch {}
    const when = stampOf(h.at);
    return { kind: 'Recent pages', day: dayLabel(h.at), tag: acct, icon: '↺', title: h.title || host + path, sub: `${host}${path === '/' ? '' : path} · ${when}`,
      keys: `${acct} ${h.url} ${when} ${dayLabel(h.at)}`.toLowerCase(), run: () => call('sess:openPage', s ? s.id : '', h.url) };
  });
  const buildOthers = (pw, pwError) => {
    const out = [];
    for (const s of S.sessions) if (s.status === 'assigned') out.push({ kind: 'Accounts', tag: 'Account', icon: (s.label || '?').slice(0, 1).toUpperCase(), title: s.label, sub: `${(ws(s.workspaceId) || {}).label || ''} · ${LOGIN_TEXT[s.login || 'unknown']}${s.open ? '' : ' · Closed'}`, keys: (s.note || '').toLowerCase(), run: () => call('sess:select', s.id) });
    for (const w of S.workspaces) out.push({ kind: 'Websites', tag: 'Website', icon: '◫', title: siteName(w), sub: w.startUrl === 'about:blank' ? 'New tab' : w.startUrl.replace(/^https?:\/\//, ''), run: () => call('ws:select', w.id) });
    for (const g of S.googleAccounts) out.push({ kind: 'Saved sessions', tag: ((S.providers || []).find(p => p.id === (g.provider || 'google')) || { label: 'Google' }).label, icon: '☺', title: g.label, sub: g.signedIn ? 'Ready to use' : 'Needs sign-in', run: () => call('side:tab', 'sessions') });
    for (const e of pw || []) out.push({ kind: 'Passwords', tag: 'Password', icon: '⚿', title: e.origin.replace(/^https?:\/\//, ''), sub: e.username, run: () => call('side:tab', 'passwords') });
    const cmd = (title, keys, fn, sub = '') => out.push({ kind: 'Commands', tag: 'Command', icon: '›', title, sub, keys, run: fn });
    cmd('Open settings', 'preferences options', () => openSettings());
    cmd('Appearance and themes', 'theme dark light colour accent', () => openSettings('appearance'));
    cmd('Show downloads', 'downloads files', () => call('side:toggle', 'downloads'));
    cmd('Show saved passwords', 'passwords logins', () => call('side:toggle', 'passwords'));
    cmd('Show saved sessions', 'google apple facebook microsoft github sign-in', () => call('side:toggle', 'sessions'));
    cmd('New website tab', 'add tab open site', () => addWebsite());
    cmd('Reload the page', 'refresh', () => call('nav:reload'));
    cmd('Show or hide the accounts panel', 'sidebar', () => call('sidebar:toggle'));
    if (cur && cur.status === 'assigned') {
      cmd(`Log in: ${cur.label}`, 'sign in', () => call('sess:login', cur.id), 'Current account');
      cmd(`Log out: ${cur.label}`, 'sign out', () => call('sess:logout', cur.id, false), 'Current account');
    }
    others = out; stateErr = pwError;
  };

  const input = el('input', { type: 'text', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'qlist', 'aria-autocomplete': 'list', placeholder: 'Search pages you visited…', 'aria-label': 'Search history', autocomplete: 'off', spellcheck: 'false' });
  const clear = el('button', { type: 'button', class: 'qclear off', tabindex: '-1', 'aria-label': 'Clear search', title: 'Clear', onclick: () => { input.value = ''; query = ''; compute(); input.focus(); } }, '×');
  const chips = el('div', { class: 'qchips', role: 'group', 'aria-label': 'Search scope' });
  const list = el('div', { class: 'qlist', id: 'qlist', role: 'listbox', 'aria-label': 'Results' });
  const live = el('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite', style: 'position:absolute;left:-9999px' });
  const drawChips = () => chips.replaceChildren(...[['history', 'History'], ['everything', 'Everything']].map(([id, name]) =>
    el('button', { type: 'button', class: 'chip' + (scope === id ? ' on' : ''), 'aria-pressed': String(scope === id), onclick: () => { scope = openSearch.scope = id; input.placeholder = id === 'history' ? 'Search pages you visited…' : 'Search pages, accounts, websites, passwords and commands…'; drawChips(); compute(); input.focus(); } }, name)));

  const looksLikeAddress = q => /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i.test(q.trim());
  function compute() {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean), H = histItems();
    let rs;
    if (!tokens.length) {
      rs = scope === 'history' ? H.slice(0, 100).map(it => ({ ...it, kind: it.day }))
        : H.slice(0, 5).map(it => ({ ...it, kind: it.day })).concat(others.filter(i => i.kind === 'Commands').slice(0, 4), others.filter(i => i.kind === 'Accounts').slice(0, 4));
      state = rs.length ? 'idle' : 'empty';
    } else {
      const pool = scope === 'history' ? H : H.concat(others);
      rs = pool.map((it, idx) => ({ it, idx, s: searchRank(it, tokens) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s || a.idx - b.idx).map(x => x.it).slice(0, 60);
      if (scope === 'everything' && looksLikeAddress(query)) rs.push({ kind: 'Commands', tag: 'Open', icon: '↗', title: `Open ${query.trim()} in a new tab`, sub: 'New website tab', run: () => call('ws:add', '', query.trim()) });
      state = rs.length ? 'results' : 'none';
    }
    results = rs; sel = 0; clear.classList.toggle('off', !query); clear.tabIndex = query ? 0 : -1; draw();
  }
  function draw() {
    const nodes = []; let last = null;
    if (!results.length) nodes.push(el('div', { class: 'qstate' }, state === 'none' ? `Nothing matched “${query}”${scope === 'history' ? ' in your history. Try the Everything scope.' : '. Try a different word.'}`
      : S.ui && S.ui.saveHistory === false ? 'Recent pages are turned off in Settings, so there is no history to show.' : 'No history yet. Pages you open in an account appear here.'));
    const groups = new Set(results.map(r => r.kind)).size > 1 || state === 'idle';
    results.forEach((it, i) => {
      if (groups && it.kind !== last) nodes.push(el('div', { class: 'qgroup', role: 'presentation' }, it.kind));
      last = it.kind;
      nodes.push(el('div', { class: 'qitem', role: 'option', id: 'qopt' + i, 'aria-selected': String(i === sel), onmousemove: () => { if (sel !== i) { sel = i; mark(); } }, onclick: () => run(it) },
        el('span', { class: 'qicon', 'aria-hidden': 'true' }, it.icon), el('span', { class: 'qtext' }, el('div', { class: 'qtitle' }, it.title), it.sub ? el('div', { class: 'qsub' }, it.sub) : null),
        el('span', { class: 'qtag', title: it.tag }, it.tag)));
    });
    if (stateErr) nodes.push(el('div', { class: 'qstate' }, stateErr));
    list.replaceChildren(...nodes); mark();
    live.textContent = !query ? '' : results.length ? `${results.length} result${results.length > 1 ? 's' : ''}` : 'No results';
  }
  function mark() {
    list.querySelectorAll('.qitem').forEach((n, i) => n.setAttribute('aria-selected', String(i === sel)));
    const n = list.querySelector('#qopt' + sel); input.setAttribute('aria-activedescendant', n ? n.id : ''); if (n) n.scrollIntoView({ block: 'nearest' });
  }
  input.oninput = () => { query = input.value; compute(); };
  box.onkeydown = e => {
    if (e.key === 'Escape') { e.preventDefault(); if (query) { input.value = ''; query = ''; compute(); } else close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); if (results.length) { sel = (sel + 1) % results.length; mark(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (results.length) { sel = (sel - 1 + results.length) % results.length; mark(); } }
    else if (e.key === 'Enter' && e.target === input) { e.preventDefault(); if (results[sel]) run(results[sel]); }
  };
  scrim.onmousedown = e => { if (e.target === scrim) close(); };       // backdrop closes; clicks inside do not
  fill(box,
    el('div', { class: 'qrow' }, magnifier(), input, clear), chips, list, live,
    el('div', { class: 'qfoot' }, el('span', {}, el('kbd', {}, '↑'), ' ', el('kbd', {}, '↓'), ' move'), el('span', {}, el('kbd', {}, 'Enter'), ' open'), el('span', {}, el('kbd', {}, 'Esc'), ' close')));
  if (scope === 'everything') input.placeholder = 'Search pages, accounts, websites, passwords and commands…';
  buildOthers([], ''); drawChips(); compute();
  await sb.invoke('ui:modal', true); scrim.hidden = false; input.focus();
  // history and saved passwords (site and username only) load after opening; failures are explained, never a blank panel
  const [h, p] = await Promise.all([sb.invoke('history:list'), sb.invoke('pm:list')]);
  if (scrim.hidden) return;
  hist = h.ok ? h.value : [];
  buildOthers(p.ok && !p.value.locked ? p.value.entries : [], p.ok ? '' : 'Saved passwords could not be searched.'); compute();
}
