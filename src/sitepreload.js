'use strict';
// Password-manager helper loaded into website pages (main frame only, sandboxed, context-isolated).
// It exposes NOTHING to the page: the page's own scripts cannot call it or read from it.
//  - When you submit a login (a trusted click/Enter, never a script-made event) it tells the app the username and
//    password so the app can offer to save them. The page's address is taken by the app itself, not from here.
//  - When you choose a saved login from the key button, the app sends it here and it is typed into the visible fields.
const { ipcRenderer } = require('electron');

const visible = el => {
  const r = el.getBoundingClientRect(), s = getComputedStyle(el);
  return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
};
const passwordFields = root => [...root.querySelectorAll('input[type=password]')].filter(visible);
const TEXTLIKE = /^(text|email|tel)$/i;

function usernameFieldFor(pw) {
  const scope = pw.form || document;
  const cands = [...scope.querySelectorAll('input')].filter(i => i !== pw && visible(i) && TEXTLIKE.test(i.type || 'text'));
  const before = cands.filter(i => i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING);   // fields that come before the password
  const list = before.length ? before : cands;
  return list.find(i => /user|email|login/i.test((i.autocomplete || '') + (i.name || '') + (i.id || ''))) || list[list.length - 1] || null;
}

// Two-step sign-ins (username page, then password page) only show one field at a time: remember the last username typed.
let lastUsername = '';
document.addEventListener('input', e => {
  const t = e.target;
  if (t instanceof HTMLInputElement && TEXTLIKE.test(t.type || 'text') && !passwordFields(document).length && t.value) lastUsername = t.value.slice(0, 320);
}, true);

// First step of a two-step sign-in: tell the app which username was entered, so the password page can be saved with it.
function noteUsername() {
  if (lastUsername && !passwordFields(document).length) ipcRenderer.send('pm:username', { username: lastUsername });
}
function capture(pw) {
  const password = pw.value;
  if (!password) return;
  const u = usernameFieldFor(pw);
  ipcRenderer.send('pm:captured', { username: ((u && u.value) || lastUsername || '').slice(0, 320), password: password.slice(0, 1024) });
}
document.addEventListener('submit', e => {
  const pw = e.target instanceof HTMLFormElement ? passwordFields(e.target)[0] : null;
  if (pw) capture(pw); else noteUsername();
}, true);
document.addEventListener('keydown', e => {
  if (!e.isTrusted || e.key !== 'Enter' || !(e.target instanceof HTMLInputElement)) return;
  if (e.target.type === 'password') capture(e.target); else noteUsername();
}, true);
document.addEventListener('click', e => {
  if (!e.isTrusted || !(e.target instanceof Element)) return;
  const b = e.target.closest('button,input[type=submit],[role=button]');
  if (!b) return;
  const pw = passwordFields(b.form || document)[0];
  if (pw) capture(pw); else noteUsername();
}, true);

// Tell the app whether this page shows a password field. After a login is submitted, a page that no longer asks for one
// (and a server-side sign-in) is how the app knows the login worked, so a password is only offered for saving then.
let lastKey = null, reportTimer = null;
// Some sites keep the login in the page's own storage, not in cookies (single-page apps, static sites with a token). A stored value
// under a name like token / jwt / auth / session is evidence that this account is signed in. Only the YES/NO leaves the page.
const AUTHKEY = /(^|[._:\/-])(access[_-]?token|id[_-]?token|refresh[_-]?token|auth[_-]?token|token|jwt|bearer|session([_-]?(id|token))?|auth|credentials?)($|[._:\/-])/i;
function storageAuth() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i); if (!AUTHKEY.test(k)) continue;
      const v = localStorage.getItem(k); if (v && v.length >= 16 && !/^(null|undefined|false|true)$/i.test(v)) return true;
    }
  } catch { /* storage blocked: no evidence */ }
  return false;
}
function reportPage() {
  const hasPassword = passwordFields(document).length > 0;
  const hasUser = !hasPassword && [...document.querySelectorAll('input')].some(i => visible(i) && TEXTLIKE.test(i.type || 'text') && /user|email|login|identifier/i.test((i.autocomplete || '') + (i.type || '') + (i.name || '') + (i.id || '')));
  const sa = storageAuth();
  const key = hasPassword + '|' + hasUser + '|' + sa;
  if (key !== lastKey) { lastKey = key; ipcRenderer.send('pm:page', { hasPassword, hasUser, storageAuth: sa }); }
}
const schedule = () => { clearTimeout(reportTimer); reportTimer = setTimeout(reportPage, 400); };
window.addEventListener('DOMContentLoaded', schedule);
window.addEventListener('load', schedule);
window.addEventListener('storage', schedule);
setInterval(() => { if (!document.hidden) reportPage(); }, 5000);   // a token written without any page change
new MutationObserver(schedule).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['type', 'style', 'class', 'hidden'] });

// Set a value the way a person typing would, so frameworks such as React notice it.
function setValue(el, v) {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
// Submit the login the app just filled (auto sign-in only). A form that would post to a different site is never submitted.
function trySubmit(field) {
  if (!field || !field.isConnected) return;
  const form = field.form;
  if (form) {
    try { if (new URL(form.action || location.href, location.href).origin !== location.origin) return; } catch { return; }
    if (form.requestSubmit) { form.requestSubmit(); return; }
  }
  const word = e => String(e.getAttribute('aria-label') || e.value || e.textContent || '').replace(/\s+/g, ' ').trim();
  const b = [...(form || document).querySelectorAll('button,input[type=submit],[role=button]')].find(e => visible(e) && /^(next|continue|log\s?in|sign\s?in|submit)$/i.test(word(e)));
  if (b) b.click();
}
ipcRenderer.on('pm:fill', (_e, { username, password, submit }) => {
  const pw = passwordFields(document)[0];
  const user = pw ? usernameFieldFor(pw) : [...document.querySelectorAll('input')].find(i => visible(i) && TEXTLIKE.test(i.type || 'text'));
  if (user && username) setValue(user, String(username));
  if (pw && password) setValue(pw, String(password));
  if (submit === true) setTimeout(() => trySubmit(pw || user), 300);
});

// A spinner while a web page has loaded but shows nothing yet (slow site, or a script-built page that has not drawn). It disappears the
// moment the page has any content, and after 15 seconds at most. It is drawn with element styles and the Web Animations API, so a
// page's own Content-Security-Policy cannot block it, and it never takes clicks.
(function () {
  if (!/^https?:$/.test(location.protocol)) return;
  const t0 = Date.now();
  let box = null, anim = null;
  const empty = () => {
    const b = document.body; if (!b) return true;
    if ((b.innerText || '').trim().length) return false;
    return !b.querySelector('img,canvas,video,svg,iframe,input,button,textarea,select') && b.children.length < 3;
  };
  const show = () => {
    if (box || !document.documentElement) return;
    box = document.createElement('div'); box.setAttribute('aria-hidden', 'true');
    Object.assign(box.style, { position: 'fixed', inset: '0', display: 'grid', placeItems: 'center', zIndex: '2147483647', pointerEvents: 'none' });
    const ring = document.createElement('div');
    Object.assign(ring.style, { width: '36px', height: '36px', borderRadius: '50%', boxSizing: 'border-box', border: '4px solid rgba(128,128,128,.3)', borderTopColor: '#6b7a90' });
    box.appendChild(ring); document.documentElement.appendChild(box);
    try { anim = ring.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: 900, iterations: Infinity }); } catch {}
  };
  const hide = () => { if (!box) return; try { if (anim) anim.cancel(); } catch {} box.remove(); box = null; anim = null; };
  const timer = setInterval(() => {
    const age = Date.now() - t0;
    if (age > 15000) { hide(); clearInterval(timer); return; }
    if (empty()) { if (age > 350) show(); } else { hide(); if (document.readyState === 'complete') clearInterval(timer); }
  }, 250);
})();
