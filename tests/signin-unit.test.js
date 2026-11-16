'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sg = require('../src/signin');

test('isAuthLike', () => {
  assert.ok(sg.isAuthLike({ name: '__Secure-1PSID', httpOnly: true, secure: true }));
  assert.ok(sg.isAuthLike({ name: 'auth_token', httpOnly: false, secure: false }));
  assert.ok(sg.isAuthLike({ name: 'my_session_key', httpOnly: true, secure: false }));
  assert.ok(!sg.isAuthLike({ name: 'my_session_key', httpOnly: false, secure: false }));
  for (const n of ['_ga', 'csrftoken', 'theme', 'cookie_consent', 'locale']) assert.ok(!sg.isAuthLike({ name: n, httpOnly: true, secure: true }), n);
});
test('siteMatches', () => {
  assert.ok(sg.siteMatches('.google.com', 'mail.google.com'));
  assert.ok(sg.siteMatches('accounts.example.com', 'example.com'));
  assert.ok(!sg.siteMatches('.google.com', 'example.com'));
});
test('isLoginLike', () => {
  assert.ok(sg.isLoginLike('https://example.com/login'));
  assert.ok(sg.isLoginLike('https://example.com/users/sign_in'.replace('sign_in', 'sign-in')));
  assert.ok(sg.isLoginLike('https://accounts.google.com/v3/signin'));
  assert.ok(!sg.isLoginLike('https://example.com/dashboard'));
});
test('extractEmail takes the last address in a title', () => {
  assert.equal(sg.extractEmail('Inbox (3) - Dana@Example.com - Mail'), 'dana@example.com');
  assert.equal(sg.extractEmail('Re: bob@x.com - me@y.com - Mail'), 'me@y.com');
  assert.equal(sg.extractEmail('Dashboard'), null);
});
test('parseListAccounts reads the default account email and nothing else', () => {
  const two = `)]}'\n["gaia.l.a.r",[["gaia.l.a",1,"A","a@x.com","",0,1,0],["gaia.l.a",1,"B","B@X.com","",1,1,0]]]`;
  assert.deepEqual(sg.parseListAccounts(two), { email: 'b@x.com' });
  assert.deepEqual(sg.parseListAccounts('["gaia.l.a.r",[["gaia.l.a",1,"A","a@x.com"]]]'), { email: 'a@x.com' });
  assert.equal(sg.parseListAccounts('["gaia.l.a.r",[]]'), null);
  assert.equal(sg.parseListAccounts(''), null);
  assert.deepEqual(sg.parseListAccounts('not json c@x.com'), { email: 'c@x.com' });
});
test('isGoogleAuthPage', () => {
  assert.ok(sg.isGoogleAuthPage('https://accounts.google.com/v3/signin/identifier'));
  assert.ok(!sg.isGoogleAuthPage('https://mail.google.com/'));
  assert.ok(!sg.isGoogleAuthPage('nonsense'));
});

test('hasLoginCookies: live login cookies mean signed in; expired or absent ones mean signed out', () => {
  const sg = require('../src/signin');
  const now = 2_000_000_000, suffixes = ['google.com', 'youtube.com'];
  const g = (name, exp) => ({ name, domain: '.google.com', value: 'x', ...(exp ? { expirationDate: exp } : {}) });
  assert.equal(sg.hasLoginCookies([g('SID', now + 1000)], 'mail.google.com', suffixes, now), true);
  assert.equal(sg.hasLoginCookies([g('SID', now - 1000)], 'mail.google.com', suffixes, now), false);   // expired
  assert.equal(sg.hasLoginCookies([g('NID', now + 1000)], 'mail.google.com', suffixes, now), false);   // not a sign-in cookie
  assert.equal(sg.hasLoginCookies([], 'example.com', suffixes, now), false);
  const site = { name: 'sessionid', domain: 'app.example.com', value: 'x', httpOnly: true, secure: true };
  assert.equal(sg.hasLoginCookies([site], 'app.example.com', suffixes, now), true);
  assert.equal(sg.hasLoginCookies([{ ...site, domain: 'other.test' }], 'app.example.com', suffixes, now), false);
});
