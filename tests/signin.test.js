'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { server, launch, run, login, read, sleep, waitFor } = require('./helpers');

test('automatic sign-in detection, naming, and Google login reuse', async t => {
  const { s, base } = await server();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-test-'));
  const app = await launch(dir);
  const go = (id, p) => run(app, `await sb.go(arg.id, arg.u)`, { id, u: base + p });
  const info = id => run(app, `const s = sb.store.session(arg); return { status: s.status, label: s.label, src: s.nameSource }`, id);
  const fresh = async label => {
    const ws = await run(app, `return sb.actions.addWorkspace(arg.l, arg.b)`, { l: label, b: base });
    const id = await run(app, `return sb.store.workspace(arg).lastSessionId`, ws);
    await waitFor(() => run(app, `return sb.baselineReady(arg)`, id));
    return { ws, id };
  };

  await t.test('a non-login cookie, or a cookie set on a login page, does not convert a pending session', async () => {
    const { id } = await fresh('A');
    await go(id, '/prefs'); await sleep(2500);
    assert.equal((await info(id)).status, 'pending');
    await go(id, '/login?u=dave'); await sleep(2500);
    assert.equal((await info(id)).status, 'pending');
    await go(id, '/mail');
    await waitFor(async () => (await info(id)).status === 'assigned');
    assert.deepEqual(await info(id), { status: 'assigned', label: 'dana@example.com', src: 'email' });
  });

  await t.test('a sign-in that finishes without another page load (the address changes in place) is still detected', async () => {
    const { id } = await fresh('SPA');
    await go(id, '/login?u=ivy'); await sleep(3000);                       // the cookie is set, the page still looks like a sign-in page
    assert.equal((await info(id)).status, 'pending');
    assert.equal((await run(app, `return sb.snapshot().sessions.find(x => x.id === arg).looksSignedIn`, id)), true);   // and the close warning knows
    await run(app, `await sb.exec(arg, "history.pushState({}, '', '/home')")`, id);   // no load event: the old one-shot check never ran again
    await waitFor(async () => (await info(id)).status === 'assigned', 15000);
  });

  await t.test('without a name in the title a placeholder is used, then upgraded; manual names are never overwritten', async () => {
    const { id } = await fresh('B');
    await go(id, '/login?u=eve'); await sleep(2000);
    assert.equal((await info(id)).status, 'pending');
    await go(id, '/state');
    await waitFor(async () => (await info(id)).status === 'assigned');
    assert.deepEqual(await info(id), { status: 'assigned', label: 'Account 1', src: 'placeholder' });
    await go(id, '/mail');
    await waitFor(async () => (await info(id)).label === 'dana@example.com');

    const c = await fresh('C');
    await go(c.id, '/login?u=fay'); await go(c.id, '/state');
    await waitFor(async () => (await info(c.id)).status === 'assigned');
    await run(app, `sb.actions.renameSession(arg, 'Work')`, c.id);
    await go(c.id, '/mail'); await sleep(1500);
    assert.deepEqual(await info(c.id), { status: 'assigned', label: 'Work', src: 'manual' });
  });

  await t.test('Google sign-in is remembered automatically, names the session, and can be reused by another session', async () => {
    await run(app, `sb.setGoogleSuffixes(['127.0.0.1']); sb.setGoogleInfoUrl(arg)`, base + '/ListAccounts');   // stand-ins for google.com
    const a = await fresh('D');
    await login(app, a.id, base, 'frank');
    await waitFor(async () => (await info(a.id)).status === 'assigned');
    assert.deepEqual(await info(a.id), { status: 'assigned', label: 'f.one@example.com', src: 'google' });
    const saved = () => run(app, `return sb.store.data.googleAccounts.map(g => ({ email: g.email, label: g.label, signedIn: g.signedIn }))`);
    assert.deepEqual(await saved(), [{ email: 'f.one@example.com', label: 'f.one@example.com', signedIn: true }]);
    const gid = await run(app, `return sb.store.session(arg).googleId`, a.id);

    const d2 = await fresh('D2');                                  // another website, waiting for sign-in
    const b = d2.id;
    const other = await run(app, `return sb.actions.newSession(arg)`, d2.ws);
    await run(app, `await sb.actions.useGoogle(arg.b, arg.g)`, { b, g: gid });
    assert.deepEqual(await info(b), { status: 'assigned', label: 'f.one@example.com', src: 'google' });   // named immediately
    await sleep(1500);
    assert.deepEqual(await read(app, b, base), { cookie: 'sid=frank', ls: null, idb: null });   // cookie yes; storage no
    assert.deepEqual(await read(app, other, base), { cookie: '', ls: null, idb: null });        // other sessions untouched
    assert.equal(await run(app, `return sb.syncGoogle(arg)`, other), null);                      // no Google login there, so nothing saved
    assert.equal((await saved()).length, 1);                                                      // reusing a login does not duplicate it

    // Picking an account that is already open on the same website switches to it instead of duplicating it.
    const dupe = await run(app, `return sb.actions.newSession(arg)`, a.ws);
    await run(app, `await sb.actions.useGoogle(arg.s, arg.g)`, { s: dupe, g: gid });
    assert.equal(await run(app, `return sb.store.session(arg)`, dupe), null);
    assert.equal(await run(app, `return sb.store.workspace(arg).lastSessionId`, a.ws), a.id);

    await login(app, b, base, 'gina');                                                            // a second, different Google account
    await waitFor(async () => (await saved()).length === 2);
    assert.deepEqual((await saved()).map(g => g.email).sort(), ['f.one@example.com', 'g.two@example.com']);
    await waitFor(async () => (await info(b)).label === 'g.two@example.com');
    assert.equal((await read(app, a.id, base)).cookie, 'sid=frank');                              // still independent afterwards
    const meta = fs.readFileSync(path.join(dir, 'session-browser.json'), 'utf8');
    for (const bad of ['sid=', 'frank', 'gina']) assert.equal(meta.includes(bad), false, bad);
  });

  await t.test('Choose an account can sign in several saved accounts at once, and skips ones already open on the site', async () => {
    const m = await fresh('M');
    const ids = await run(app, `return sb.store.data.googleAccounts.filter(g => g.signedIn).map(g => g.id)`);
    assert.ok(ids.length >= 2);
    const made = await run(app, `return sb.actions.useGoogleMany(arg.s, arg.ids)`, { s: m.id, ids: ids.slice(0, 2) });
    assert.equal(made.length, 2);
    assert.equal(made[0], m.id);                                                            // the waiting session took the first one
    const assigned = () => run(app, `return sb.store.sessionsOf(arg).filter(s => s.status === 'assigned').map(s => s.googleId).sort()`, m.ws);
    assert.deepEqual(await assigned(), ids.slice(0, 2).sort());
    assert.equal(await run(app, `return sb.store.workspace(arg).lastSessionId`, m.ws), made[0]);
    const again = await run(app, `return sb.actions.useGoogleMany(arg.s, arg.ids)`, { s: made[0], ids: ids.slice(0, 2) });
    assert.deepEqual(again, []);                                                            // already open here, so nothing is added
    assert.equal((await assigned()).length, 2);
  });

  await t.test('a Closed account stays selectable: choosing it reopens its session instead of creating a duplicate', async () => {
    const m = await fresh('C');
    const ids = await run(app, `return sb.store.data.googleAccounts.filter(g => g.signedIn).map(g => g.id)`);
    const made = await run(app, `return sb.actions.useGoogleMany(arg.s, arg.ids)`, { s: m.id, ids: ids.slice(0, 1) });
    await run(app, `await sb.actions.closeSession(arg)`, made[0]);
    const before = await run(app, `return sb.store.sessionsOf(arg).length`, m.ws);
    const pend = await run(app, `return sb.actions.openUnassigned(arg)`, m.ws);
    await run(app, `return sb.actions.useGoogleMany(arg.s, arg.ids)`, { s: pend, ids: ids.slice(0, 1) });
    assert.equal(await run(app, `return sb.store.sessionsOf(arg).filter(s => s.googleId === arg2).length`.replace('arg2', JSON.stringify(ids[0])), m.ws), 1);
    assert.equal(await run(app, `return sb.views.has(arg)`, made[0]), true);               // reopened
    assert.ok((await run(app, `return sb.store.sessionsOf(arg).length`, m.ws)) <= before + 1);
  });

  await t.test('the Unassigned entry is a single session: reused when clicked, replaced after sign-in, replaced when discarded', async () => {
    const a = await fresh('U');
    const pendingIds = () => run(app, `return sb.store.sessionsOf(arg).filter(s => s.status === 'pending').map(s => s.id)`, a.ws);
    assert.deepEqual(await pendingIds(), [a.id]);
    assert.equal(await run(app, `return sb.actions.openUnassigned(arg)`, a.ws), a.id);   // clicking it again shows the same signed-out session
    assert.equal(await run(app, `return sb.actions.openUnassigned(arg)`, a.ws), a.id);
    await run(app, `sb.actions.assignSession(arg, 'Signed in')`, a.id);
    const [fresh1] = await pendingIds();
    assert.ok(fresh1 && fresh1 !== a.id);                                                // a fresh one is ready, and was not selected
    assert.equal(await run(app, `return sb.store.workspace(arg).lastSessionId`, a.ws), a.id);   // the new account stays selected
    assert.equal(await run(app, `return sb.views.has(arg)`, fresh1), false);
    assert.equal(await run(app, `return sb.actions.openUnassigned(arg)`, a.ws), fresh1);
    await run(app, `await sb.actions.closeSession(arg)`, fresh1);                         // discarding starts over with another fresh one
    const [fresh2] = await pendingIds();
    assert.ok(fresh2 && fresh2 !== fresh1);
    assert.equal(await run(app, `return sb.store.workspace(arg).lastSessionId`, a.ws), fresh2);
  });

  await t.test('closing keeps an account but unloads it; closing an unassigned session discards it', async () => {
    const a = await fresh('E');
    await run(app, `sb.actions.assignSession(arg, 'Keep me')`, a.id);
    const p = await run(app, `return sb.actions.newSession(arg)`, a.ws);
    await run(app, `await sb.actions.closeSession(arg)`, a.id);
    assert.equal(await run(app, `return sb.views.has(arg)`, a.id), false);
    assert.equal(await run(app, `return sb.store.session(arg).status`, a.id), 'assigned');
    await run(app, `sb.actions.selectSession(arg)`, a.id);                                        // reopens lazily
    assert.equal(await run(app, `return sb.views.has(arg)`, a.id), true);
    await run(app, `await sb.actions.closeSession(arg)`, a.id);                                   // closing the selected one moves to an open one
    assert.equal(await run(app, `return sb.store.workspace(arg).lastSessionId`, a.ws), p);
    await run(app, `await sb.actions.closeSession(arg)`, p);
    assert.equal(await run(app, `return sb.store.session(arg)`, p), null);
  });

  await app.close(); s.close();
});

test('a kept waiting session that is already signed in when the app starts is detected on load', async () => {
  const { s, base } = await server();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-restore-'));
  const app = await launch(dir);
  const ws = await run(app, `return sb.actions.addWorkspace('Restored', arg)`, base);
  const id = await run(app, `return sb.store.workspace(arg).lastSessionId`, ws);
  const part = await run(app, `return sb.store.session(arg).partition`, id);
  await app.evaluate(async ({ session }, { part, base }) => {   // a login left in the session by an earlier run
    const ses = session.fromPartition('persist:' + part);
    await ses.cookies.set({ url: base + '/', name: 'sid', value: 'carol', expirationDate: Date.now() / 1000 + 3600 });
    await ses.cookies.flushStore();
  }, { part, base });
  await app.close();
  await sleep(1200);                                  // the new run must start after the session was created
  const app2 = await launch(dir);
  try {
    await waitFor(() => run(app2, `const s = sb.store.session(arg); return !!s && s.status === 'assigned'`, id), 25000);
  } finally { await app2.close(); s.close(); }
});
