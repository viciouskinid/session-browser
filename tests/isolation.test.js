'use strict';
// Runs the real app under Playwright's Electron driver against a local server.
// Test-only credentials ("alice"/"bob"); no real accounts are used.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { server, launch, run, login, read } = require('./helpers');

test('multi-session isolation, persistence and recovery', async t => {
  const { s, base } = await server();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-test-'));
  let app = await launch(dir);
  let A, B, wsId;

  await t.test('unassigned workflow: pending until named, fresh one always available', async () => {
    wsId = await run(app, `return sb.actions.addWorkspace('Test', arg)`, base);
    A = await run(app, `return sb.store.workspace(arg).lastSessionId`, wsId);
    let snap = await run(app, `return sb.snapshot()`);
    assert.equal(snap.sessions.find(x => x.id === A).status, 'pending');
    B = await run(app, `return sb.actions.newSession(arg)`, wsId);
    await run(app, `sb.actions.assignSession(arg,'Alice')`, A);
    snap = await run(app, `return sb.snapshot()`);
    assert.equal(snap.sessions.find(x => x.id === A).status, 'assigned');
    assert.equal(snap.sessions.find(x => x.id === A).label, 'Alice');
    assert.equal(snap.sessions.find(x => x.id === B).status, 'pending');
    await assert.rejects(run(app, `sb.actions.assignSession(arg,'  ')`, B));
    await run(app, `sb.actions.assignSession(arg,'Bob')`, B);
  });

  await t.test('cookies, localStorage and IndexedDB differ between sessions on the same origin', async () => {
    await login(app, A, base, 'alice'); await login(app, B, base, 'bob');
    const a = await read(app, A, base), b = await read(app, B, base);
    assert.deepEqual(a, { cookie: 'sid=alice', ls: 'alice', idb: 'alice' });
    assert.deepEqual(b, { cookie: 'sid=bob', ls: 'bob', idb: 'bob' });
  });

  await t.test('metadata file holds no cookie values, tokens or query strings', () => {
    const meta = fs.readFileSync(path.join(dir, 'session-browser.json'), 'utf8');
    for (const bad of ['sid=', 'alice', 'password', 'token', '?u=']) assert.equal(meta.includes(bad), false, bad);
  });

  await t.test('clearing one session leaves the other signed in', async () => {
    await run(app, `await sb.actions.clearSession(arg)`, A);
    const a = await read(app, A, base), b = await read(app, B, base);
    assert.deepEqual(a, { cookie: '', ls: null, idb: null });
    assert.equal(b.cookie, 'sid=bob'); assert.equal(b.ls, 'bob'); assert.equal(b.idb, 'bob');
    await login(app, A, base, 'alice');
  });

  await t.test('selection is remembered', async () => {
    await run(app, `sb.actions.selectSession(arg)`, B);
  });

  await app.close();

  await t.test('both sessions, and the selected site and account, survive a restart', async () => {
    app = await launch(dir);
    const snap = await run(app, `return sb.snapshot()`);
    assert.equal(snap.activeWorkspaceId, wsId);
    assert.equal(snap.workspaces[0].lastSessionId, B);
    assert.deepEqual(snap.sessions.filter(x => x.status === 'assigned').map(x => x.label).sort(), ['Alice', 'Bob']);
    assert.equal(snap.sessions.filter(x => x.status === 'pending').length, 1);   // one fresh Unassigned session is always ready
    await run(app, `sb.actions.selectSession(arg)`, A);   // lazily creates the view for A
    const a = await read(app, A, base), b = await run(app, `sb.actions.selectSession(arg); return 1`, B).then(() => read(app, B, base));
    assert.deepEqual(a, { cookie: 'sid=alice', ls: 'alice', idb: 'alice' });
    assert.deepEqual(b, { cookie: 'sid=bob', ls: 'bob', idb: 'bob' });
    await app.close();
  });

  await t.test('deleted profile storage is handled: metadata stays, session is simply signed out', async () => {
    fs.rmSync(path.join(dir, 'Partitions'), { recursive: true, force: true });
    app = await launch(dir);
    await run(app, `sb.actions.selectSession(arg)`, A);
    const a = await read(app, A, base);
    assert.deepEqual(a, { cookie: '', ls: null, idb: null });
    assert.equal((await run(app, `return sb.snapshot()`)).sessions.length, 3);   // Alice, Bob and the ready Unassigned session
    await app.close();
  });

  await t.test('corrupt metadata is backed up and the app starts clean', async () => {
    fs.writeFileSync(path.join(dir, 'session-browser.json'), '{ not json');
    app = await launch(dir);
    const snap = await run(app, `return sb.snapshot()`);
    assert.equal(snap.workspaces.length, 0); assert.equal(snap.recovered, true);
    assert.ok(fs.readdirSync(dir).some(f => f.includes('.corrupt-')));
    await app.close();
  });

  await t.test('removing a session deletes its data without touching others', async () => {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-test-'));
    app = await launch(d2);
    const w = await run(app, `return sb.actions.addWorkspace('T', arg)`, base);
    const X = await run(app, `return sb.store.workspace(arg).lastSessionId`, w);
    const Y = await run(app, `return sb.actions.newSession(arg)`, w);
    await login(app, X, base, 'alice'); await login(app, Y, base, 'bob');
    await run(app, `await sb.actions.removeSession(arg)`, X);
    const snap = await run(app, `return sb.snapshot()`);
    assert.deepEqual(snap.sessions.map(x => x.id), [Y]);   // Y is still the waiting session, so no extra one is made
    assert.equal((await read(app, Y, base)).cookie, 'sid=bob');
    await app.close();
  });

  s.close();
});
