'use strict';
// Keeps every session of a website on that website. A session may make TEMPORARY trips (Google/Microsoft/Apple sign-in,
// OAuth, SSO, payment redirects), but a trip never becomes the session's address, and a link or typed address that
// leads to some other site opens as its own website tab instead of moving this session to another domain.
const MULTI = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'co.nz', 'co.jp',
  'com.br', 'co.in', 'com.cn', 'co.za', 'com.mx', 'com.sg', 'com.hk', 'com.tr']);
// Sites that are one service spread over several domains.
const FAMILIES = [
  ['google.com', 'youtube.com', 'gstatic.com', 'googleusercontent.com', 'ggpht.com', 'googleapis.com', 'youtube-nocookie.com'],
  ['microsoft.com', 'live.com', 'office.com', 'office365.com', 'microsoftonline.com', 'outlook.com', 'sharepoint.com', 'msn.com', 'azure.com'],
  ['apple.com', 'icloud.com'],
  ['claude.ai', 'anthropic.com'],
  ['facebook.com', 'fb.com', 'instagram.com', 'messenger.com']
];
const AUTH_HOST = /(^|\.)(accounts\.google\.[a-z.]+|login\.microsoftonline\.com|login\.live\.com|appleid\.apple\.com|idmsa\.apple\.com|auth0\.com|okta\.com|oktapreview\.com|onelogin\.com|duosecurity\.com|id\.atlassian\.com|login\.salesforce\.com|accounts\.spotify\.com)$/i;
const AUTH_SUBDOMAIN = /^(accounts|login|auth|sso|id|idp|signin)\./i;
const AUTH_PATH_STRICT = /(^|\/)(o\/oauth2|oauth2?|authorize|authorise|saml2?|sso|consent|signin\/oauth)(\/|$|\.)/i;
const AUTH_PATH_BROAD = /(^|\/)(log-?in|sign-?in|sign-?up|register|auth|callback|challenge|verify|2fa|mfa|session\/new)(\/|$|\.)/i;

const parse = u => { try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:' ? x : null; } catch { return null; } };
const isIpOrLocal = h => h === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.startsWith('[');

function siteKey(url) {
  const u = parse(url); if (!u) return null;
  const h = u.hostname.toLowerCase().replace(/^www\./, '');
  if (isIpOrLocal(h)) return u.host.toLowerCase();                  // local apps on different ports are different sites
  if (/(^|\.)google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(h)) return 'google.com';
  const l = h.split('.');
  const reg = l.length <= 2 ? h : MULTI.has(l.slice(-2).join('.')) ? l.slice(-3).join('.') : l.slice(-2).join('.');
  const fam = FAMILIES.find(f => f.includes(reg));
  return fam ? fam[0] : reg;
}
const sameSite = (a, b) => { const x = siteKey(a), y = siteKey(b); return !!x && x === y; };

// A page that belongs to a sign-in / OAuth / SSO trip (allowed to leave the site).
function isAuthFlow(url) {
  const u = parse(url); if (!u) return false;
  return AUTH_HOST.test(u.hostname) || AUTH_SUBDOMAIN.test(u.hostname) || AUTH_PATH_STRICT.test(u.pathname);
}
// A page that must never be remembered as where the session "is" (sign-in pages, even on the site's own domain).
const isTransient = url => { const u = parse(url); return !!u && (isAuthFlow(url) || AUTH_PATH_BROAD.test(u.pathname)); };

// The site's own sign-in page (where Log in should take you). Only an on-site /login or /signin style page counts.
function isLoginPage(home, url) {
  const u = parse(url);
  return !!u && sameSite(home, url) && /(^|\/)(log-?in|sign-?in)(\/|$|\.)/i.test(u.pathname);
}

// A website with no address yet (blank tab) is unscoped.
const scoped = home => !!parse(home);

// Where a navigation the PAGE starts (link click, script, redirect target) may go.
//   'allow'  : same site, a sign-in/OAuth trip, or the session is already mid-trip (multi-hop SSO, returning home)
//   'newtab' : some other site: open it as its own website tab instead
function decide(home, target, current) {
  if (!scoped(home) || !parse(target)) return 'allow';
  if (sameSite(home, target) || isAuthFlow(target)) return 'allow';
  if (current && parse(current) && !sameSite(home, current)) return 'allow';
  return 'newtab';
}
// An address typed in the address bar is deliberate, so a mid-trip page gets no free pass.
function decideTyped(home, target) {
  if (!scoped(home) || !parse(target)) return 'allow';
  return sameSite(home, target) || isAuthFlow(target) ? 'allow' : 'newtab';
}
// Only the site's own, non-sign-in pages are remembered as the session's address.
function persistable(home, url) {
  if (!parse(url) || isTransient(url)) return false;
  return !scoped(home) || sameSite(home, url);
}
// Address to load when a session (re)opens: its remembered page if that is still on the site, else the site's own address.
function resumeUrl(home, lastUrl) {
  return lastUrl && persistable(home, lastUrl) ? lastUrl : home;
}

module.exports = { isLoginPage, siteKey, sameSite, isAuthFlow, isTransient, decide, decideTyped, persistable, resumeUrl };
