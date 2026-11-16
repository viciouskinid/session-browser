'use strict';
// Passwords and Saved sessions tabs of the side panel (the Downloads tab lives in downloads.js, which also defines $, el, hue, say).
let S = null, tab = 'downloads', pwTimer;

// ---- Viewing a saved password. The main process asks the operating system to verify the person first (a fresh check each time),
// then returns the one password. It is kept here only while it is shown: it is wiped after a few seconds, when the panel switches
// tab or loses focus, and when the vault locks.
let shown = null;   // { id, password, until, timer }
function clearShown() { if (shown) { clearInterval(shown.timer); shown.password = ''; shown = null; } }
function hideShown() { const was = !!shown; clearShown(); if (was && tab === 'passwords') loadPasswords(); }
async function viewPassword(id) {
  if (shown && shown.id === id) return hideShown();
  clearShown();
  say('Verify yourself when your computer asks…');
  const r = await sb.invoke('pm:reveal', id);
  if (!r.ok) return say(r.error);
  say('');
  shown = { id, password: r.value.password, until: Date.now() + (r.value.seconds || 15) * 1000, timer: null };
  shown.timer = setInterval(() => {
    if (!shown) return;
    if (Date.now() >= shown.until) return hideShown();
    const n = document.querySelector('.pwshow .left'); if (n) n.textContent = Math.ceil((shown.until - Date.now()) / 1000) + ' s';
  }, 500);
  loadPasswords();
}
window.addEventListener('blur', hideShown);
document.addEventListener('visibilitychange', () => { if (document.hidden) hideShown(); });

function showTab(t) {
  tab = ['downloads', 'passwords', 'sessions'].includes(t) ? t : 'downloads';
  document.title = { downloads: 'Downloads', passwords: 'Saved passwords', sessions: 'Saved sessions' }[tab];
  for (const id of ['downloads', 'passwords', 'sessions']) $('#tab-' + id).hidden = id !== tab;
  if (tab !== 'passwords') clearShown();
  if (tab === 'passwords') loadPasswords();
  if (tab === 'sessions') renderSessions();
  say('');
}

// ---- Passwords: site + username only. The passwords themselves never reach this page.
async function loadPasswords() {
  const r = await sb.invoke('pm:list'); if (!r.ok) return say(r.error);
  const { available, entries } = r.value;
  if (r.value.locked) {
    clearShown();
    $('#pwnote').textContent = 'Your saved passwords are locked. Windows Hello (PIN, fingerprint or face) unlocks them for a while.';
    $('#pwclear').hidden = true;
    $('#pwlist').replaceChildren(el('div', { class: 'empty' }, el('button', { class: 'btn primary', onclick: async () => { const u = await sb.invoke('pm:unlock'); if (!u.ok) say(u.error); loadPasswords(); } }, 'Unlock with Windows Hello')));
    return;
  }
  let here = ''; try { here = new URL(S && S.nav && S.nav.url).origin; } catch {}   // the open page: its logins get a Fill button
  $('#pwnote').textContent = available
    ? 'Encrypted with your computer’s secure storage. A saved login is offered at the top right when a sign-in form appears. It is filled only on the exact site it was saved for, when you choose it.'
    : 'Secure storage is not available on this computer, so passwords cannot be saved.';
  if (available) $('#pwnote').append(' Press View to see a password for a few seconds: your computer verifies you first, every time.');
  $('#pwclear').hidden = !entries.length;
  if (r.value.hello) $('#pwnote').append(' ', el('button', { class: 'lnk', onclick: async () => { await sb.invoke('pm:lock'); loadPasswords(); } }, 'Lock now'));
  $('#pwlist').replaceChildren(...(entries.length ? entries.map(e => el('div', { class: 'row2', role: 'listitem' },
    el('div', { class: 'text' }, el('div', { class: 'l', title: e.origin }, e.origin.replace(/^https?:\/\//, '')), el('div', { class: 's' }, e.username),
      shown && shown.id === e.id ? el('div', { class: 'pwshow', role: 'group', 'aria-label': 'Password' }, el('code', {}, shown.password), el('span', { class: 'left' }, Math.max(1, Math.ceil((shown.until - Date.now()) / 1000)) + ' s')) : null),
    el('div', { class: 'acts', style: 'flex-direction:column;align-items:flex-end;margin:0' },
      el('button', { class: 'lnk' + (e.auto ? ' strong' : ''), 'aria-pressed': String(!!e.auto), title: 'Fill and submit this site’s login by itself when its sign-in page opens. Only for this exact site, and only when one login clearly applies.',
        onclick: async () => { const x = await sb.invoke('pm:autofill', e.origin, !e.auto); if (!x.ok) say(x.error); loadPasswords(); } }, 'Auto sign-in: ' + (e.auto ? 'On' : 'Off')),
      el('button', { class: 'lnk', 'aria-pressed': String(!!(shown && shown.id === e.id)), title: 'Show this password for a few seconds. Your computer verifies you first.', onclick: () => viewPassword(e.id) }, shown && shown.id === e.id ? 'Hide' : 'View'),
      here === e.origin ? el('button', { class: 'lnk', title: 'Type this login into the open page', onclick: async () => { const x = await sb.invoke('pm:fill', e.id); if (!x.ok) say(x.error); } }, 'Fill') : null,
      el('button', { class: 'lnk danger', onclick: async () => { if (shown && shown.id === e.id) clearShown(); const x = await sb.invoke('pm:remove', e.id); if (!x.ok) say(x.error); loadPasswords(); } }, 'Remove'))))
    : [el('div', { class: 'empty' }, 'No saved passwords yet. Sign in to a site and choose Save when asked.')]));
}
let clearArmed = false;
$('#pwclear').onclick = async () => {
  if (!clearArmed) { clearArmed = true; $('#pwclear').textContent = 'Click again to remove all'; setTimeout(() => { clearArmed = false; $('#pwclear').textContent = 'Remove all'; }, 4000); return; }
  clearArmed = false; $('#pwclear').textContent = 'Remove all'; clearShown();
  const x = await sb.invoke('pm:clear'); if (!x.ok) say(x.error); loadPasswords();
};

// ---- Saved sessions (any sign-in provider)
function renderSessions() {
  if (!S) return;
  const sel = $('#prov');
  if (!sel.options.length) for (const p of S.providers || []) sel.append(el('option', { value: p.id }, p.label));
  const label = id => ((S.providers || []).find(p => p.id === id) || { label: 'Google' }).label;
  const armed = renderSessions.armed || (renderSessions.armed = new Set());
  $('#sesslist').replaceChildren(...(S.googleAccounts.length ? S.googleAccounts.map(g => {
    const used = S.sessions.filter(x => x.googleId === g.id && x.status === 'assigned').length;
    const nameEl = el('div', { class: 'l', title: g.label }, g.label);
    return el('div', { class: 'row2', role: 'listitem' },
      el('div', { class: 'av2', style: `background:hsl(${hue(g.provider || 'google')} 45% 38%)`, 'aria-hidden': 'true' }, label(g.provider || 'google').slice(0, 1)),
      el('div', { class: 'text' }, nameEl,
        el('div', { class: 's' + (g.signedIn ? '' : ' err') }, `${label(g.provider || 'google')} · ${g.signedIn ? 'Ready to use' : 'Needs sign-in'}${used ? ` · used by ${used} account${used > 1 ? 's' : ''}` : ''}`)),
      el('div', { class: 'acts', style: 'flex-direction:column;align-items:flex-end;margin:0' },
        el('button', { class: 'lnk', onclick: () => sb.invoke('google:signin', g.id) }, g.signedIn ? 'Refresh' : 'Sign in'),
        el('button', { class: 'lnk', onclick: () => {
          const inp = el('input', { class: 'rn', value: g.label, maxlength: 80, 'aria-label': 'Name' });
          nameEl.replaceWith(inp); inp.focus(); inp.select();
          const done = async ok => { if (ok && inp.value.trim() && inp.value.trim() !== g.label) { const x = await sb.invoke('google:rename', g.id, inp.value); if (!x.ok) say(x.error); } renderSessions(); };
          inp.onkeydown = e => { if (e.key === 'Enter') done(true); else if (e.key === 'Escape') { e.stopPropagation(); done(false); } };
          inp.onblur = () => done(true);
        } }, 'Rename'),
        el('button', { class: 'lnk danger', onclick: async () => {
          if (!armed.has(g.id)) { armed.add(g.id); renderSessions(); setTimeout(() => { armed.delete(g.id); renderSessions(); }, 4000); return; }
          armed.delete(g.id); const x = await sb.invoke('google:remove', g.id); if (!x.ok) say(x.error);
        } }, armed.has(g.id) ? 'Click to confirm' : 'Remove')));
  }) : [el('div', { class: 'empty' }, 'No saved sessions yet. Google sign-ins are saved automatically when you sign in to a Google site. Use Add session for the others.')]));
}
$('#addsess').onclick = async () => { const r = await sb.invoke('google:add', $('#prov').value); if (!r.ok) say(r.error); };

sb.on('state', st => {
  S = st; applyAppearance(st.appearance);
  if (tab === 'sessions') renderSessions();
  if (tab === 'passwords') { clearTimeout(pwTimer); pwTimer = setTimeout(loadPasswords, 600); }
});
sb.on('side-tab', showTab);
sb.invoke('state:get').then(r => { if (r.ok) { S = r.value; applyAppearance(S.appearance); if (tab === 'sessions') renderSessions(); } });
sb.invoke('side:tab').then(r => showTab(r.ok ? r.value : 'downloads'));
