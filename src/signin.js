'use strict';
// Pure helpers for sign-in detection and Google-login reuse. Cookie values are only
// hashed in memory for change detection; they are never logged or stored by this app.
const crypto = require('crypto');

const GOOGLE_SUFFIXES = ['google.com', 'youtube.com'];
const GOOGLE_AUTH_NAMES = /^(sid|__secure-1psid|__secure-3psid)$/i;

const STRONG = /^(sid|ssid|hsid|apisid|sapisid|__secure-[13]psid|c_user|xs|li_at|auth_token|sessionid|session_id|sess|connect\.sid|phpsessid|jsessionid|asp\.net_sessionid|_session_id|__session|laravel_session)$/i;
const GENERIC = /(sess|auth|token|jwt|login|logged|sso|identity|access|refresh|remember)/i;
const NOISE = /(csrf|xsrf|consent|^_ga|^_gid|^_fbp|^_gcl|analytics|locale|lang|theme|tracking|optanon|cookielaw)/i;
const LOGIN_PATH = /(^|\/)(log-?in|sign-?in|sign-?up|register|auth|oauth2?|sso|authorize|callback|consent|challenge|verify|2fa|mfa|session\/new)(\/|$|\.)/i;

const bare = d => String(d || '').replace(/^\./, '').toLowerCase();
const domainMatches = (domain, suffixes) => { const d = bare(domain); return suffixes.some(s => d === s || d.endsWith('.' + s)); };

// Looks like a login cookie by NAME and flags only.
function isAuthLike(c) {
  if (NOISE.test(c.name)) return false;
  return STRONG.test(c.name) || ((c.httpOnly || c.secure) && GENERIC.test(c.name));
}
function siteMatches(cookieDomain, siteHost) {
  const d = bare(cookieDomain), h = bare(siteHost);
  return !!d && !!h && (h === d || h.endsWith('.' + d) || d.endsWith('.' + h));
}
function isLoginLike(url) {
  try { const u = new URL(url); return /^(accounts|login|auth|sso)\./i.test(u.hostname) || LOGIN_PATH.test(u.pathname); }
  catch { return true; }
}
function extractEmail(title) {
  const m = String(title || '').match(/[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi);
  return m ? m[m.length - 1].toLowerCase() : null;
}
const hashValue = v => crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 12);

// Copies only cookies whose domain matches `suffixes`. No site data (localStorage, IndexedDB, cache) is copied.
async function copyCookies(from, to, suffixes) {
  let n = 0;
  for (const c of await from.cookies.get({})) {
    if (!domainMatches(c.domain, suffixes)) continue;
    const host = bare(c.domain), p = c.path || '/';
    const d = { url: `${c.secure ? 'https' : 'http'}://${host}${p}`, name: c.name, value: c.value, path: p,
      secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite };
    if (!c.hostOnly) d.domain = c.domain;
    if (!c.session && c.expirationDate) d.expirationDate = c.expirationDate;
    try { await to.cookies.set(d); n++; } catch { /* skip cookies the target rejects */ }
  }
  return n;
}
// Is a session signed in? Judged by live (unexpired) login cookies for the site, by NAME only. Values are never read.
// Google-family sites look for Google's own sign-in cookies. Returns true/false.
function hasLoginCookies(cookies, host, suffixes, nowSec = Date.now() / 1000) {
  const live = c => !c.expirationDate || c.expirationDate > nowSec;
  if (domainMatches(host, suffixes)) return cookies.some(c => GOOGLE_AUTH_NAMES.test(c.name) && domainMatches(c.domain, suffixes) && live(c));
  return cookies.some(c => isAuthLike(c) && siteMatches(c.domain, host) && live(c));
}
async function hasGoogleLogin(ses, suffixes) {
  return (await ses.cookies.get({})).some(c => GOOGLE_AUTH_NAMES.test(c.name) && domainMatches(c.domain, suffixes));
}

// --- Google account identification -------------------------------------------------------------
// Asks Google which account(s) the session's own cookies are signed in as (the same ListAccounts call
// Chromium makes). Only the email address is kept. The request carries that session's cookies to
// Google, which is where they already belong.
const LIST_ACCOUNTS_URL = 'https://accounts.google.com/ListAccounts?gpsia=1&source=ChromiumBrowser&json=standard';
const isGoogleAuthPage = url => {
  try {
    const u = new URL(url);
    if (/^accounts\.google\./i.test(u.hostname)) {
      // Trigger on account chooser, sign-in identifier, or OAuth endpoints, excluding passive background/ListAccounts calls
      return !/^\/(ListAccounts|CheckCookie|RotateCookies|Logout)/i.test(u.pathname);
    }
    return /google\.com$/i.test(u.hostname) && /\/(o\/oauth2|signin|ServiceLogin)/i.test(u.pathname);
  } catch { return false; }
};

function parseListAccounts(text) {
  const t = String(text || '').replace(/^\)\]\}'\s*/, '').trim();
  const valid = e => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  let root;
  try { root = JSON.parse(t); } catch {
    const m = t.match(/[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/i);
    return m ? { email: m[0].toLowerCase() } : null;
  }
  const rows = (Array.isArray(root) && Array.isArray(root[1]) ? root[1] : []).filter(r => Array.isArray(r) && valid(r[3]));
  const row = rows.find(r => r[5] === 1) || rows[0];   // index 5 flags the default account
  return row ? { email: row[3].toLowerCase() } : null;
}

async function fetchGoogleAccount(ses, url = LIST_ACCOUNTS_URL) {
  try {
    const r = await ses.fetch(url, { method: 'POST', credentials: 'include', body: '',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://accounts.google.com' } });
    return r.ok ? parseListAccounts(await r.text()) : null;
  } catch { return null; }
}

module.exports = { hasLoginCookies, LIST_ACCOUNTS_URL, isGoogleAuthPage, parseListAccounts, fetchGoogleAccount, GOOGLE_SUFFIXES, GOOGLE_AUTH_NAMES, isAuthLike, siteMatches, isLoginLike, extractEmail, hashValue, copyCookies, hasGoogleLogin, domainMatches };
