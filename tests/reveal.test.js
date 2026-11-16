'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { authorize, limiter, MAX_PER_WINDOW, SHOW_SECONDS } = require('../src/reveal');

const deps = over => ({ platform: 'win32', helloVerify: async () => ({ ok: true, status: 'Verified' }), helloDescribe: s => 'hello:' + s,
  canTouchId: () => true, touchId: async () => {}, ...over });

test('a password is shown only after the system verifies the person, with a fresh check each time', async () => {
  let asked = 0;
  const d = deps({ helloVerify: async () => { asked++; return { ok: true, status: 'Verified' }; } });
  assert.deepEqual(await authorize(d), { ok: true, method: 'hello' });
  await authorize(d); assert.equal(asked, 2);                                                       // never remembered between views
});

test('every failure refuses (fails closed) and says why', async () => {
  for (const status of ['Canceled', 'DeviceNotPresent', 'RetriesExhausted', 'Error', 'Timeout', undefined]) {
    const r = await authorize(deps({ helloVerify: async () => ({ ok: false, status }) }));
    assert.equal(r.ok, false); assert.equal(r.error, 'hello:' + status);
  }
  assert.equal((await authorize(deps({ helloVerify: async () => ({ ok: false }) }))).ok, false);
  assert.equal((await authorize(deps({ helloVerify: async () => null }))).ok, false);
});

test('macOS uses Touch ID; everything else has no system check, so it refuses', async () => {
  assert.deepEqual(await authorize(deps({ platform: 'darwin' })), { ok: true, method: 'touchid' });
  assert.equal((await authorize(deps({ platform: 'darwin', canTouchId: () => false }))).ok, false);
  assert.equal((await authorize(deps({ platform: 'darwin', touchId: async () => { throw new Error('cancelled'); } }))).ok, false);
  for (const platform of ['linux', 'freebsd', undefined]) assert.equal((await authorize(deps({ platform }))).ok, false);
});

test('views are rate limited, and the password stays on screen only briefly', () => {
  let t = 0; const ok = limiter(() => t);
  for (let i = 0; i < MAX_PER_WINDOW; i++) assert.equal(ok(), true);
  assert.equal(ok(), false); t += 61000; assert.equal(ok(), true);
  assert.ok(SHOW_SECONDS > 0 && SHOW_SECONDS <= 30);
});
