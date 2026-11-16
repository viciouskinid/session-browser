'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { Vault, eligibleOrigin } = require('../src/vault');

// Stand-in for safeStorage: reversible but visibly different from the plaintext.
const fake = (ok = true, backend) => ({
  isEncryptionAvailable: () => ok,
  ...(backend ? { getSelectedStorageBackend: () => backend } : {}),
  encryptString: s => Buffer.from(Buffer.from(s, 'utf8').map(b => b ^ 0x5a)),
  decryptString: b => Buffer.from(Buffer.from(b).map(x => x ^ 0x5a)).toString('utf8')
});
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-vault-')), 'vault.json');

test('only https (or local http) origins are eligible', () => {
  assert.equal(eligibleOrigin('https://accounts.google.com/signin?x=1'), 'https://accounts.google.com');
  assert.equal(eligibleOrigin('http://localhost:3000/login'), 'http://localhost:3000');
  assert.equal(eligibleOrigin('http://example.com/'), null);
  assert.equal(eligibleOrigin('javascript:alert(1)'), null);
  assert.equal(eligibleOrigin('data:text/html,hi'), null);
});

test('passwords are encrypted on disk, matched by exact origin, updated, removed, and survive a restart', () => {
  const f = tmp(), v = new Vault(f, fake());
  const a = v.save('https://example.com', 'dana@example.com', 'S3cret!pass');
  const raw = fs.readFileSync(f, 'utf8');
  assert.ok(!raw.includes('S3cret!pass') && !raw.includes('dana@example.com'));   // neither password nor username in plaintext
  assert.deepEqual(v.list('https://example.com').map(x => x.username), ['dana@example.com']);
  assert.deepEqual(v.list('https://example.com.evil.test'), []);                  // no lookalike-host match
  assert.deepEqual(v.list('http://example.com'), []);                             // scheme matters
  assert.equal(v.compare('https://example.com', 'dana@example.com', 'S3cret!pass'), 'same');
  assert.equal(v.compare('https://example.com', 'dana@example.com', 'other'), 'changed');
  assert.equal(v.compare('https://example.com', 'new@example.com', 'x'), 'new');
  const b = v.save('https://example.com', 'dana@example.com', 'N3w-pass');        // same login: updated, not duplicated
  assert.equal(b.id, a.id); assert.equal(b.updated, true); assert.equal(v.all().length, 1);
  assert.equal(new Vault(f, fake()).secret(a.id).password, 'N3w-pass');
  assert.equal(process.platform === 'win32' ? true : (fs.statSync(f).mode & 0o077) === 0, true);   // owner-only file
  v.remove(a.id); assert.equal(v.all().length, 0);
});

test('nothing is saved when secure storage is unavailable or is the insecure Linux fallback', () => {
  for (const box of [fake(false), fake(true, 'basic_text')]) {
    const f = tmp(), v = new Vault(f, box);
    assert.equal(v.available, false);
    assert.throws(() => v.save('https://example.com', 'u', 'p'), /Secure storage/);
    assert.equal(fs.existsSync(f), false);
  }
});

test('rejects insecure origins and bad passwords; a corrupt file is set aside; never-save list works', () => {
  const f = tmp(), v = new Vault(f, fake());
  assert.throws(() => v.save('http://example.com', 'u', 'p'), /https/);
  assert.throws(() => v.save('https://example.com', 'u', ''), /Invalid/);
  assert.throws(() => v.save('https://example.com', 'u', 'x'.repeat(5000)), /Invalid/);
  v.addNever('https://bank.example'); assert.equal(v.isNever('https://bank.example'), true);
  fs.writeFileSync(f, '{not json');
  const r = new Vault(f, fake()); assert.equal(r.recovered, true); assert.equal(r.all().length, 0);
});

test('an entry that cannot be decrypted is ignored, never returned as garbage', () => {
  const f = tmp(), v = new Vault(f, fake());
  v.save('https://example.com', 'u', 'p');
  const d = JSON.parse(fs.readFileSync(f, 'utf8')); d.entries[0].secret = Buffer.from('garbage').toString('base64');
  fs.writeFileSync(f, JSON.stringify(d));
  assert.deepEqual(new Vault(f, fake()).all(), []);
});

test('two accounts on one site stay separate; a username is required; usernames match case-insensitively', () => {
  const f = tmp(), v = new Vault(f, fake());
  v.save('https://accounts.google.com', 'one@gmail.com', 'pw-one');
  assert.equal(v.compare('https://accounts.google.com', 'two@gmail.com', 'pw-two'), 'new');       // second user is NEW, not "update"
  v.save('https://accounts.google.com', 'two@gmail.com', 'pw-two');
  assert.equal(v.all().length, 2);
  assert.equal(v.compare('https://accounts.google.com', 'ONE@gmail.com', 'pw-one'), 'same');
  assert.equal(v.save('https://accounts.google.com', 'One@Gmail.com', 'pw-1b').updated, true);   // same user, new password
  assert.equal(v.all().length, 2);
  assert.throws(() => v.save('https://accounts.google.com', '', 'x'), /username is required/);
  assert.throws(() => v.save('https://accounts.google.com', '   ', 'x'), /username is required/);
});

test('logins saved without a username by older versions are purged', () => {
  const f = tmp(), v = new Vault(f, fake());
  v.save('https://example.com', 'keep@example.com', 'p');
  v.data.entries.push({ id: 'old', origin: 'https://accounts.google.com', secret: v._seal({ username: '', password: 'x' }), addedAt: 1, updatedAt: 1 });
  v._save();
  const r = new Vault(f, fake());
  assert.equal(r.purgeAnonymous(), 1);
  assert.deepEqual(r.all().map(x => x.username), ['keep@example.com']);
  assert.equal(new Vault(f, fake()).purgeAnonymous(), 0);
});

test('auto sign-in is opt-in per exact site, needs a saved login, and is cleared when the last login goes', () => {
  const f = tmp(), v = new Vault(f, fake());
  assert.throws(() => v.setAutofill('https://example.com', true), /Save a login/);
  assert.throws(() => v.setAutofill('http://example.com', true), /https/);
  const a = v.save('https://example.com', 'dana@example.com', 'pw1');
  assert.equal(v.isAutofill('https://example.com'), false);                         // off by default
  v.setAutofill('https://example.com', true);
  assert.equal(v.isAutofill('https://example.com'), true);
  assert.equal(v.isAutofill('https://sub.example.com'), false);                      // exact origin only
  assert.equal(new Vault(f, fake()).isAutofill('https://example.com'), true);        // survives a restart
  v.remove(a.id); assert.equal(v.isAutofill('https://example.com'), false);
  v.save('https://example.com', 'x@example.com', 'p'); v.setAutofill('https://example.com', true); v.clear();
  assert.equal(v.isAutofill('https://example.com'), false);
});
