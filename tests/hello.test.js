'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const hello = require('../src/hello');

function fakeSpawn(output, { code = 0, never = false } = {}) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const c = new EventEmitter(); c.stdout = new EventEmitter(); c.kill = () => { c.killed = true; };
    if (!never) setImmediate(() => { if (output !== null) c.stdout.emit('data', output); c.emit('close', code); });
    return c;
  };
  spawn.calls = calls; return spawn;
}

test('only a Verified answer unlocks; every other answer, error or silence fails closed', async () => {
  for (const [out, ok, status] of [['SB_RESULT:Verified\r\n', true, 'Verified'], ['SB_RESULT:Canceled', false, 'Canceled'], ['SB_RESULT:NotConfiguredForUser', false, 'NotConfiguredForUser'],
    ['SB_RESULT:RetriesExhausted', false, 'RetriesExhausted'], ['garbage', false, 'Error'], [null, false, 'Error']]) {
    const r = await hello.verify('Unlock', { platform: 'win32', spawn: fakeSpawn(out) });
    assert.deepEqual([r.ok, r.status], [ok, status], String(out));
  }
  assert.deepEqual(await hello.verify('x', { platform: 'win32', spawn: () => { throw new Error('no powershell'); } }), { ok: false, status: 'Error' });
});

test('it never runs off Windows, times out cleanly, and runs PowerShell hidden with an encoded command', async () => {
  assert.deepEqual(await hello.verify('x', { platform: 'linux', spawn: () => { throw new Error('must not run'); } }), { ok: false, status: 'Unsupported' });
  const r = await hello.verify('x', { platform: 'win32', spawn: fakeSpawn('', { never: true }), timeoutMs: 30 });
  assert.deepEqual([r.ok, r.status], [false, 'Timeout']);
  const sp = fakeSpawn('SB_RESULT:Verified'); await hello.verify('x', { platform: 'win32', spawn: sp });
  assert.equal(sp.calls[0].cmd, 'powershell.exe'); assert.equal(sp.calls[0].opts.windowsHide, true);
  assert.ok(sp.calls[0].args.includes('-EncodedCommand') && sp.calls[0].args.includes('-NoProfile'));
});

test('the prompt message cannot change the script, and the script asks Windows for verification', () => {
  const evil = "x'); Remove-Item C:\\ -Recurse; ('";
  const clean = hello.cleanMessage(evil);
  assert.equal(/['"`$\\]/.test(clean), false);                          // no quote, backtick, dollar or backslash can get through
  const script = hello.buildScript(evil);
  const m = /RequestVerificationAsync\('([^']*)'\)/.exec(script);       // the message stays inside ONE quoted string
  assert.ok(m, 'message is a single quoted literal'); assert.equal(m[1], clean);
  assert.equal((script.match(/RequestVerificationAsync/g) || []).length, 1);
  assert.match(script, /CheckAvailabilityAsync/);
  assert.equal(hello.cleanMessage(''), 'Unlock your saved passwords');
  assert.equal(hello.parseResult('noise\nSB_RESULT:Verified\n'), 'Verified');
  for (const st of ['Verified', 'Canceled', 'NotConfiguredForUser', 'DisabledByPolicy', 'Unsupported', 'Timeout', 'whatever']) assert.ok(hello.describe(st).length > 5);
});
