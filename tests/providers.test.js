'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const pr = require('../src/providers');

test('sign-in pages are matched to their provider', () => {
  assert.equal(pr.forAuthUrl('https://accounts.google.com/v3/signin')?.id, 'google');
  assert.equal(pr.forAuthUrl('https://login.microsoftonline.com/common/oauth2/authorize')?.id, 'microsoft');
  assert.equal(pr.forAuthUrl('https://appleid.apple.com/auth/authorize')?.id, 'apple');
  assert.equal(pr.forAuthUrl('https://www.facebook.com/login.php')?.id, 'facebook');
  assert.equal(pr.forAuthUrl('https://www.facebook.com/dialog/oauth?x=1')?.id, 'facebook');
  assert.equal(pr.forAuthUrl('https://github.com/login/oauth/authorize')?.id, 'github');
  assert.equal(pr.forAuthUrl('https://www.facebook.com/somebody'), null);     // an ordinary page is not a sign-in page
  assert.equal(pr.forAuthUrl('https://example.com/login'), null);
  assert.equal(pr.forAuthUrl('javascript:alert(1)'), null);
});

test('providers are found from a website host, and live login cookies are recognised per provider', () => {
  assert.equal(pr.forHost('mail.google.com')?.id, 'google');
  assert.equal(pr.forHost('www.icloud.com')?.id, 'apple');
  assert.equal(pr.forHost('example.com'), null);
  const now = 2_000_000_000, fb = pr.get('facebook');
  assert.equal(pr.hasAuth(fb, [{ name: 'c_user', domain: '.facebook.com', expirationDate: now + 99 }], fb.suffixes, now), true);
  assert.equal(pr.hasAuth(fb, [{ name: 'c_user', domain: '.facebook.com', expirationDate: now - 99 }], fb.suffixes, now), false);
  assert.equal(pr.hasAuth(fb, [{ name: 'c_user', domain: '.example.com' }], fb.suffixes, now), false);
  assert.deepEqual(pr.list().map(p => p.id), ['google', 'microsoft', 'apple', 'facebook', 'github']);
});
