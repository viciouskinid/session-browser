'use strict';
// Sign-in providers whose logged-in session can be saved once and reused on other websites ("Saved sessions").
// Google is the original; the others follow the same model: sign in once in a window of its own, keep that login's
// cookies, and hand them to a tab when a site asks to "Continue with <provider>".
const sg = require('./signin');

const PROVIDERS = [
  { id: 'google', label: 'Google', loginUrl: 'https://accounts.google.com/', suffixes: sg.GOOGLE_SUFFIXES, auth: sg.GOOGLE_AUTH_NAMES,
    authPage: u => sg.isGoogleAuthPage(u) },
  { id: 'microsoft', label: 'Microsoft', loginUrl: 'https://login.live.com/', suffixes: ['live.com', 'microsoftonline.com', 'microsoft.com', 'office.com', 'outlook.com'],
    auth: /^(estsauth|estsauthpersistent|estsauthlight|mspauth|mspprof|wlssc|rpssecauth)$/i,
    authPage: (_u, h) => /^(login\.microsoftonline\.com|login\.live\.com|login\.microsoft\.com)$/i.test(h) },
  { id: 'apple', label: 'Apple', loginUrl: 'https://appleid.apple.com/sign-in', suffixes: ['apple.com', 'icloud.com'],
    auth: /^(myacinfo|dsid|acn01|aasp)$/i,
    authPage: (_u, h) => /^(appleid\.apple\.com|idmsa\.apple\.com)$/i.test(h) },
  { id: 'facebook', label: 'Facebook', loginUrl: 'https://www.facebook.com/login', suffixes: ['facebook.com'],
    auth: /^(c_user|xs)$/i,
    authPage: (_u, h, p) => /(^|\.)facebook\.com$/i.test(h) && /^\/(login|v[\d.]+\/dialog\/oauth|dialog\/oauth|checkpoint)/i.test(p) },
  { id: 'github', label: 'GitHub', loginUrl: 'https://github.com/login', suffixes: ['github.com'],
    auth: /^(user_session|__host-user_session_same_site)$/i,
    authPage: (_u, h, p) => /^github\.com$/i.test(h) && /^\/(login|session)/i.test(p) }
];

const get = id => PROVIDERS.find(p => p.id === id) || null;
const list = () => PROVIDERS.map(({ id, label }) => ({ id, label }));

// Which provider's sign-in page is this? (null when it is not one)
function forAuthUrl(url) {
  let u; try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const h = u.hostname.toLowerCase();
  return PROVIDERS.find(p => p.authPage(url, h, u.pathname)) || null;
}
// Is this website run by a provider (for example mail.google.com, github.com)?
function forHost(host) { return PROVIDERS.find(p => sg.domainMatches(String(host || ''), p.suffixes)) || null; }

// Live (unexpired) sign-in cookies of this provider, judged by name only. Values are never read.
function hasAuth(p, cookies, suffixes = p.suffixes, nowSec = Date.now() / 1000) {
  return cookies.some(c => p.auth.test(c.name) && sg.domainMatches(c.domain, suffixes) && (!c.expirationDate || c.expirationDate > nowSec));
}

module.exports = { PROVIDERS, get, list, forAuthUrl, forHost, hasAuth };
