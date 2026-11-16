'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sc = require('../src/sitescope');

test('site identity: subdomains, multi-part suffixes, families and local ports', () => {
  assert.equal(sc.siteKey('https://www.example.com/x'), 'example.com');
  assert.equal(sc.siteKey('https://shop.example.co.uk/'), 'example.co.uk');
  assert.equal(sc.siteKey('https://mail.google.com/'), sc.siteKey('https://www.youtube.com/'));   // one Google family
  assert.equal(sc.siteKey('https://www.google.com.au/'), 'google.com');
  assert.notEqual(sc.siteKey('http://localhost:3000/'), sc.siteKey('http://localhost:4000/'));
  assert.notEqual(sc.siteKey('https://example.com.evil.test/'), sc.siteKey('https://example.com/'));   // lookalike host
  assert.equal(sc.siteKey('javascript:alert(1)'), null);
});

test('sign-in trips are recognised; ordinary external sites are not', () => {
  assert.equal(sc.isAuthFlow('https://accounts.google.com/v3/signin/identifier'), true);
  assert.equal(sc.isAuthFlow('https://login.microsoftonline.com/common/oauth2/authorize'), true);
  assert.equal(sc.isAuthFlow('https://company.okta.com/app/x/sso/saml'), true);
  assert.equal(sc.isAuthFlow('https://thirdparty.example/oauth2/authorize?x=1'), true);
  assert.equal(sc.isAuthFlow('https://news.example.org/story'), false);
  assert.equal(sc.isAuthFlow('https://thirdparty.example/login'), false);   // a bare /login elsewhere is not a free pass
});

test('a page-started navigation to another site opens its own tab, but sign-in trips and returns are allowed', () => {
  const home = 'https://claude.ai/';
  assert.equal(sc.decide(home, 'https://claude.ai/chats', home), 'allow');
  assert.equal(sc.decide(home, 'https://accounts.google.com/o/oauth2/auth', home), 'allow');
  assert.equal(sc.decide(home, 'https://news.example.org/', home), 'newtab');
  // mid-trip (already on the identity provider): multi-hop SSO and the return to the site are allowed
  assert.equal(sc.decide(home, 'https://sso.unknown-idp.test/step2', 'https://accounts.google.com/x'), 'allow');
  assert.equal(sc.decide(home, 'https://claude.ai/callback?code=1', 'https://accounts.google.com/x'), 'allow');
});

test('a typed address on another site never moves the session, even from a sign-in page', () => {
  const home = 'https://mail.google.com/';
  assert.equal(sc.decideTyped(home, 'https://github.com/'), 'newtab');
  assert.equal(sc.decideTyped(home, 'https://www.youtube.com/'), 'allow');
  assert.equal(sc.decideTyped('about:blank', 'https://github.com/'), 'allow');   // a blank tab is unscoped
});

test('the site\'s own sign-in page is recognised (for Log in), other pages and other sites are not', () => {
  const home = 'https://claude.ai/';
  assert.equal(sc.isLoginPage(home, 'https://claude.ai/login'), true);
  assert.equal(sc.isLoginPage(home, 'https://claude.ai/signin/'), true);
  assert.equal(sc.isLoginPage(home, 'https://claude.ai/chat/abc'), false);
  assert.equal(sc.isLoginPage(home, 'https://other.example/login'), false);
});

test('only the site\'s own non-sign-in pages are remembered; stale remembered pages fall back to the site', () => {
  const home = 'https://claude.ai/';
  assert.equal(sc.persistable(home, 'https://claude.ai/chat/abc'), true);
  assert.equal(sc.persistable(home, 'https://accounts.google.com/v3/signin'), false);
  assert.equal(sc.persistable(home, 'https://claude.ai/login'), false);
  assert.equal(sc.persistable(home, 'https://news.example.org/'), false);
  assert.equal(sc.resumeUrl(home, 'https://accounts.google.com/v3/signin'), home);
  assert.equal(sc.resumeUrl(home, 'https://news.example.org/'), home);
  assert.equal(sc.resumeUrl(home, 'https://claude.ai/chat/abc'), 'https://claude.ai/chat/abc');
  assert.equal(sc.resumeUrl(home, null), home);
});
