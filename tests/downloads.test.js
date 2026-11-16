'use strict';
// Pure Node: the manager is driven with a stand-in for Electron's DownloadItem, so no window is needed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { EventEmitter } = require('events');
const { Store } = require('../src/store');
const { DownloadManager, safeName, uniquePath } = require('../src/downloads');

function fakeItem(name, url = 'https://files.example.com/a/b?token=SECRET', total = 1000) {
  const it = new EventEmitter();
  let got = 0, paused = false, saved = null;
  Object.assign(it, {
    getFilename: () => name, getURL: () => url, getTotalBytes: () => total, getReceivedBytes: () => got,
    setSavePath: p => { saved = p; }, savedPath: () => saved,
    pause: () => { paused = true; it.emit('updated', {}, 'progressing'); }, resume: () => { paused = false; },
    isPaused: () => paused, canResume: () => true,
    cancel: () => it.emit('done', {}, 'cancelled'),
    progress: n => { got = n; it.emit('updated', {}, 'progressing'); },
    finish: () => { got = total; if (saved) fs.writeFileSync(saved, 'x'); it.emit('done', {}, 'completed'); }
  });
  return it;
}
const setup = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-dl-'));
  const store = new Store(path.join(dir, 'meta.json'));
  const shell = { opened: [], shown: [], openPath: async p => { shell.opened.push(p); return ''; }, showItemInFolder: p => shell.shown.push(p) };
  return { dir, store, shell, mgr: new DownloadManager({ store, dir: path.join(dir, 'Downloads'), shell }) };
};

test('file names are made safe and never overwrite', () => {
  assert.equal(safeName('../../etc/passwd'), 'passwd');
  assert.equal(safeName('a<b>:c.txt'), 'a_b__c.txt');
  assert.equal(safeName(''), 'download');
  const taken = new Set([path.join('d', 'r.pdf')]);
  assert.equal(uniquePath('d', 'r.pdf', p => taken.has(p)), path.join('d', 'r (1).pdf'));
});

test('progress, completion, history and no URL stored', async () => {
  const { mgr, store, dir } = setup();
  const a = fakeItem('report.pdf'), b = fakeItem('report.pdf');
  const ra = mgr.add(a), rb = mgr.add(b);
  assert.notEqual(a.savedPath(), b.savedPath());                       // two at once do not collide
  assert.equal(path.basename(b.savedPath()), 'report (1).pdf');
  a.progress(250);
  assert.equal(mgr.payload().active, 2);
  assert.equal(mgr.payload().items.find(i => i.id === ra.id).received, 250);
  a.finish(); b.finish();
  const p = mgr.payload();
  assert.equal(p.active, 0);
  assert.deepEqual(p.items.map(i => i.state), ['completed', 'completed']);
  assert.equal(p.items[0].host, 'files.example.com');
  assert.equal(JSON.stringify(p).includes('SECRET'), false);
  const meta = fs.readFileSync(path.join(dir, 'meta.json'), 'utf8');
  assert.equal(meta.includes('SECRET'), false); assert.equal(meta.includes('token'), false);
  assert.equal(store.data.downloads.length, 2);
});

test('pause, resume, cancel, remove and clear', () => {
  const { mgr, store } = setup();
  const a = fakeItem('a.zip'), b = fakeItem('b.zip'), c = fakeItem('c.zip');
  const [ra, rb, rc] = [a, b, c].map(i => mgr.add(i));
  mgr.pause(ra.id); assert.equal(mgr.items.get(ra.id).paused, true);
  mgr.resume(ra.id); assert.equal(a.isPaused(), false);
  mgr.cancel(rb.id); assert.equal(mgr.items.get(rb.id).state, 'cancelled');
  c.finish();
  mgr.remove(rc.id); assert.equal(mgr.items.has(rc.id), false);
  mgr.clear();                                                          // clears finished, keeps the one still running
  assert.deepEqual([...mgr.items.keys()], [ra.id]);
  assert.equal(store.data.downloads.length, 0);
});

test('open: reports missing files, and shows programs in their folder instead of running them', async () => {
  const { mgr, shell } = setup();
  const doc = fakeItem('notes.txt'), exe = fakeItem('setup.exe');
  const rd = mgr.add(doc), re = mgr.add(exe);
  doc.finish(); exe.finish();
  assert.equal(await mgr.open(rd.id), 'opened');
  assert.deepEqual(shell.opened, [doc.savedPath()]);
  assert.equal(await mgr.open(re.id), 'revealed');
  assert.deepEqual(shell.shown, [exe.savedPath()]);
  fs.rmSync(doc.savedPath());
  await assert.rejects(mgr.open(rd.id), /moved or deleted/);
  mgr.checkFiles();
  assert.equal(mgr.payload().items.find(i => i.id === rd.id).missing, true);
});

test('history survives a restart, and unfinished downloads show as interrupted', () => {
  const { mgr, store, dir } = setup();
  const done = fakeItem('done.bin'), mid = fakeItem('mid.bin');
  mgr.add(done); done.finish();
  const rm = mgr.add(mid); mid.progress(10);
  store.upsertDownload({ id: rm.id, name: rm.name, path: rm.path, host: rm.host, total: 1000, received: 10, state: 'progressing', startedAt: rm.startedAt, endedAt: null });
  const again = new DownloadManager({ store: new Store(path.join(dir, 'meta.json')), dir: path.join(dir, 'Downloads'), shell: {} });
  const states = Object.fromEntries(again.payload().items.map(i => [i.name, i.state]));
  assert.deepEqual(states, { 'done.bin': 'completed', 'mid.bin': 'interrupted' });
});

test('copy download link: the full address this run, only the part without ? or # after a restart', () => {
  const { mgr, store, dir, shell } = setup();
  const a = fakeItem('f.zip', 'https://user:pw@files.example.com/a/b.zip?token=SECRET#frag');
  const r = mgr.add(a); a.finish();
  assert.deepEqual(mgr.linkOf(r.id), { url: 'https://user:pw@files.example.com/a/b.zip?token=SECRET#frag', partial: false });
  const meta = fs.readFileSync(path.join(dir, 'meta.json'), 'utf8');
  assert.equal(meta.includes('SECRET'), false); assert.equal(meta.includes('frag'), false); assert.equal(meta.includes('pw@'), false);
  assert.ok(meta.includes('https://files.example.com/a/b.zip'));
  const again = new DownloadManager({ store: new Store(path.join(dir, 'meta.json')), dir: path.join(dir, 'Downloads'), shell });
  assert.deepEqual(again.linkOf(r.id), { url: 'https://files.example.com/a/b.zip', partial: true });
  assert.equal(JSON.stringify(again.payload()).includes('files.example.com/a/b.zip'), false);                   // the panel never gets addresses
  assert.throws(() => again.linkOf('nope'), /no longer in the list/);
  const blob = fakeItem('x.bin', 'blob:https://files.example.com/1234'), rb = again.add(blob); blob.finish();
  assert.equal(again.linkOf(rb.id).partial, false);                                                             // in memory this run
  assert.equal(new Store(path.join(dir, 'meta.json')).data.downloads.find(d => d.id === rb.id).link, null);     // but never saved
});

test('the fastest speed is recorded in settings with its file and time, from smoothed samples only', async () => {
  const { mgr, store } = setup();
  let t = 1000; const realNow = Date.now; Date.now = () => t;
  try {
    const a = fakeItem('big.iso', 'https://h.example/big.iso', 1e9); mgr.add(a);
    let got = 0; const step = bytes => { t += 600; got += bytes; a.progress(got); };
    let fired = 0; mgr.on('maxspeed', () => fired++);
    step(600000); step(600000); assert.equal(store.data.ui.maxDownloadSpeed, undefined);                          // too few samples: no record yet
    step(600000); step(600000);
    const rec1 = store.data.ui.maxDownloadSpeed; assert.ok(rec1 && rec1.bps > 900000 && rec1.bps < 1100000 && rec1.name === 'big.iso'); assert.ok(fired >= 1);
    step(60000); assert.equal(store.data.ui.maxDownloadSpeed.bps, rec1.bps);                                      // slower: record stays
    for (let i = 0; i < 6; i++) step(6000000); assert.ok(store.data.ui.maxDownloadSpeed.bps > rec1.bps);         // faster: record rises
    a.pause(); a.progress(got); const keep = store.data.ui.maxDownloadSpeed.bps; a.finish();
    assert.equal(new Store(store.file).data.ui.maxDownloadSpeed.bps, keep);                                       // written to disk when the download ends
  } finally { Date.now = realNow; }
});

test('open when complete is remembered for a running download only, and shows in the panel payload', () => {
  const { mgr } = setup();
  const a = fakeItem('doc.pdf', 'https://h.example/doc.pdf', 1000), r = mgr.add(a);
  assert.equal(mgr.setOpenWhenDone(r.id, true), true);
  assert.equal(mgr.payload().items.find(i => i.id === r.id).openWhenDone, true);
  assert.equal(mgr.setOpenWhenDone(r.id, false), false);
  mgr.setOpenWhenDone(r.id, true); let seen = null; mgr.on('done', x => { seen = x.openWhenDone; }); a.finish();
  assert.equal(seen, true);                                                                                    // the app reads it when the download ends
  assert.equal(mgr.setOpenWhenDone(r.id, true), false);                                                        // finished: cannot be set any more
});
