'use strict';
// Download manager, in the spirit of Chrome's: files save straight to the Downloads folder (never overwriting),
// progress is tracked, and finished downloads are remembered. Only name, path, source host, size and state are kept.
// Never the full URL, which can carry tokens.
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { EventEmitter } = require('events');

const RISKY = /\.(exe|msi|bat|cmd|com|scr|ps1|vbs|vbe|js|jse|wsf|hta|jar|lnk|reg|dll|cpl|app|command|sh|pkg|dmg|appimage)$/i;
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
// The address as it is kept on disk: http(s) only, no credentials, no query, no fragment (those can carry tokens).
const keptLink = u => { try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:' ? x.origin + x.pathname : null; } catch { return null; } };

function safeName(n) {
  const base = path.basename(String(n || '')).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim().slice(0, 150);
  return base || 'download';
}
function uniquePath(dir, name, taken) {
  const ext = path.extname(name), stem = path.basename(name, ext);
  let p = path.join(dir, name);
  for (let i = 1; taken(p); i++) p = path.join(dir, `${stem} (${i})${ext}`);
  return p;
}
const plain = r => ({ id: r.id, name: r.name, path: r.path, host: r.host, link: r.link || null, total: r.total, received: r.received,
  state: r.state, startedAt: r.startedAt, endedAt: r.endedAt });

class DownloadManager extends EventEmitter {
  constructor({ store, dir, shell }) {
    super();
    this.store = store; this.dir = dir; this.shell = shell;
    this.items = new Map(); this.live = new Map(); this.reserved = new Set(); this.timer = null;
    this.maxDirty = false; this.maxTimer = null;
    for (const d of [...store.data.downloads].reverse())   // anything unfinished when the app last closed did not finish
      this.items.set(d.id, { ...d, state: d.state === 'progressing' ? 'interrupted' : d.state, paused: false, canResume: false, speed: 0, missing: false });
  }

  attach(ses) { ses.on('will-download', (_e, item) => this.add(item)); }

  add(item) {
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch {}
    const savePath = uniquePath(this.dir, safeName(item.getFilename()), p => this.reserved.has(p) || fs.existsSync(p));
    this.reserved.add(savePath);
    item.setSavePath(savePath);   // no save dialog, like Chrome
    const rec = { id: randomUUID(), name: path.basename(savePath), path: savePath, host: hostOf(item.getURL()),
      url: String(item.getURL() || ''), link: keptLink(item.getURL()),   // url (the full address) stays in memory only, never saved
      samples: 0,
      total: Math.max(0, item.getTotalBytes()), received: 0, state: 'progressing', paused: false, canResume: false,
      speed: 0, startedAt: Date.now(), endedAt: null, missing: false };
    this.items.set(rec.id, rec); this.live.set(rec.id, item);
    let lastT = Date.now(), lastB = 0;
    item.on('updated', (_e, state) => {
      const now = Date.now(), b = item.getReceivedBytes();
      if (now - lastT >= 500) {
        const inst = (b - lastB) / ((now - lastT) / 1000);
        rec.speed = rec.speed ? rec.speed * 0.6 + inst * 0.4 : inst; lastT = now; lastB = b; rec.samples++;
        this._noteSpeed(rec);
      }
      rec.received = b; rec.total = Math.max(0, item.getTotalBytes());
      rec.paused = item.isPaused(); rec.canResume = item.canResume();
      rec.state = state === 'interrupted' ? 'interrupted' : 'progressing';
      if (rec.paused || rec.state === 'interrupted') rec.speed = 0;
      this._changed();
    });
    item.once('done', (_e, state) => {
      rec.received = item.getReceivedBytes(); rec.total = Math.max(rec.total, item.getTotalBytes());
      rec.state = state; rec.endedAt = Date.now(); rec.speed = 0; rec.paused = false; rec.canResume = false;
      this.live.delete(rec.id); this.reserved.delete(savePath);
      this.store.upsertDownload(plain(rec));   // saves the whole file, including a pending peak-speed record
      this.maxDirty = false; clearTimeout(this.maxTimer); this.maxTimer = null;
      this._changed(true); this.emit('done', rec);
    });
    this._changed(true); this.emit('started', rec);
    return rec;
  }

  // The peak speed record. The smoothed speed is used (one lucky half second is not a record), and only after a few samples.
  // The record lives in memory at once and is written to disk at most every 5 seconds (and when a download ends).
  _noteSpeed(rec) {
    if (rec.samples < 3 || rec.paused || !(rec.speed > 0)) return;
    if (!this.store.noteMaxSpeed(rec.speed, rec.name, Date.now(), { save: false })) return;
    this.maxDirty = true; this.emit('maxspeed');
    if (!this.maxTimer) { this.maxTimer = setTimeout(() => { this.maxTimer = null; if (this.maxDirty) { this.maxDirty = false; try { this.store.flush(); } catch {} } }, 5000); this.maxTimer.unref?.(); }
  }
  // What "Copy download link" copies: the full address while this run still has it, otherwise the saved one without its query part.
  linkOf(id) {
    const r = this.items.get(id); if (!r) throw new Error('That download is no longer in the list.');
    if (r.url) return { url: r.url, partial: false };
    if (r.link) return { url: r.link, partial: true };
    throw new Error('The link for this download was not kept.');
  }
  // The row changes at once (Electron may send no further update while a download is paused).
  pause(id) { const it = this.live.get(id), r = this.items.get(id); if (it && r && !it.isPaused()) { it.pause(); r.paused = true; r.speed = 0; this._changed(true); } }
  resume(id) { const it = this.live.get(id), r = this.items.get(id); if (it && r && it.canResume()) { it.resume(); r.paused = false; this._changed(true); } }
  cancel(id) { this.live.get(id)?.cancel(); }
  remove(id) {   // forgets the entry only. The file itself is left alone
    this.live.get(id)?.cancel(); this.live.delete(id);
    this.items.delete(id); this.store.removeDownload(id); this._changed(true);
  }
  clear() {
    for (const id of [...this.items.keys()]) if (!this.live.has(id)) this.items.delete(id);
    this.store.clearDownloads(id => this.live.has(id)); this._changed(true);
  }
  checkFiles() { for (const r of this.items.values()) if (r.state === 'completed') r.missing = !fs.existsSync(r.path); }

  async open(id) {
    const r = this.items.get(id);
    if (!r || r.state !== 'completed') throw new Error('That download is not finished.');
    if (!fs.existsSync(r.path)) { r.missing = true; this._changed(true); throw new Error('The file was moved or deleted.'); }
    // Programs and scripts are shown in their folder rather than run straight from the browser.
    if (RISKY.test(r.path)) { this.shell.showItemInFolder(r.path); return 'revealed'; }
    const err = await this.shell.openPath(r.path);
    if (err) throw new Error(err);
    return 'opened';
  }
  // "Open when complete": remembered for this run only (the app opens the file itself when the download ends).
  setOpenWhenDone(id, on) { const r = this.items.get(id); if (r && r.state === 'progressing') { r.openWhenDone = !!on; this._changed(true); } return !!(r && r.state === 'progressing' && r.openWhenDone); }
  show(id) {
    const r = this.items.get(id); if (!r) return;
    if (fs.existsSync(r.path)) this.shell.showItemInFolder(r.path); else this.shell.openPath(this.dir);
  }
  folder() { fs.mkdirSync(this.dir, { recursive: true }); return this.shell.openPath(this.dir); }

  payload() {
    const items = [...this.items.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 100)
      .map(r => ({ id: r.id, name: r.name, host: r.host, total: r.total, received: r.received, state: r.state, paused: r.paused,
        canResume: r.canResume, speed: r.speed, startedAt: r.startedAt, endedAt: r.endedAt, missing: !!r.missing, openWhenDone: !!r.openWhenDone }));
    const live = [...this.live.keys()].map(id => this.items.get(id)).filter(Boolean);
    const total = live.reduce((n, r) => n + r.total, 0), got = live.reduce((n, r) => n + r.received, 0);
    return { items, active: live.length, progress: live.length && total ? Math.min(1, got / total) : null };
  }
  _changed(now) {
    if (now) { clearTimeout(this.timer); this.timer = null; this.emit('change'); }
    else if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.emit('change'); }, 250);
  }
}

module.exports = { DownloadManager, safeName, uniquePath, RISKY, keptLink };
