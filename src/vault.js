'use strict';
// Password vault. Each login (username + password) is encrypted with the operating system's secure storage
// (Electron safeStorage: Windows DPAPI, macOS Keychain, Linux libsecret/kwallet) before it touches the disk.
// If secure storage is unavailable, or on Linux it would fall back to a hard-coded key ("basic_text"), nothing is saved.
// Logins are matched to the exact origin (scheme + host + port). Passwords never leave the main process
// except into the page they were saved for, on the user's click.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const MAX_PASSWORD = 1024, MAX_USERNAME = 320;

// Only https pages (or http on this computer, for local development) may hold or receive saved passwords.
function eligibleOrigin(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return u.origin;
    if (u.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) return u.origin;
  } catch { /* not a URL */ }
  return null;
}

const sameUser = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

class Vault {
  // box: { isEncryptionAvailable(), encryptString(s) -> Buffer, decryptString(Buffer) -> s, getSelectedStorageBackend?() }
  constructor(file, box) { this.file = file; this.box = box; this.recovered = false; this.data = this._load(); }
  get available() {
    try {
      if (!this.box.isEncryptionAvailable()) return false;
      if (typeof this.box.getSelectedStorageBackend === 'function' && this.box.getSelectedStorageBackend() === 'basic_text') return false;
      return true;
    } catch { return false; }
  }
  _empty() { return { version: 1, entries: [], never: [], autofill: [] }; }
  _load() {
    let raw;
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return this._empty(); raw = null; }
    try {
      const d = JSON.parse(raw);
      if (!d || !Array.isArray(d.entries)) throw new Error('shape');
      d.never = Array.isArray(d.never) ? d.never : [];
      d.autofill = Array.isArray(d.autofill) ? d.autofill : [];
      return d;
    } catch {
      try { fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch {}
      this.recovered = true;
      return this._empty();
    }
  }
  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  _seal(obj) { return this.box.encryptString(JSON.stringify(obj)).toString('base64'); }
  _open(b64) { try { return JSON.parse(this.box.decryptString(Buffer.from(b64, 'base64'))); } catch { return null; } }
  _read(e) { const x = this._open(e.secret); return x && typeof x.password === 'string' ? { id: e.id, origin: e.origin, username: String(x.username || ''), password: x.password } : null; }

  // Metadata only (no passwords): used for menus and the manager.
  list(origin) { return this.data.entries.filter(e => e.origin === origin).map(e => this._read(e)).filter(Boolean).map(({ id, origin: o, username }) => ({ id, origin: o, username })); }
  all() {
    return this.data.entries.map(e => this._read(e)).filter(Boolean).map(({ id, origin, username }) => ({ id, origin, username }))
      .sort((a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username));
  }
  secret(id) { const e = this.data.entries.find(x => x.id === id); return e ? this._read(e) : null; }
  // 'new' | 'changed' | 'same' for a login seen on a page. A login is identified by site + username (case-insensitive).
  compare(origin, username, password) {
    const hit = this.data.entries.map(e => e.origin === origin ? this._read(e) : null).filter(Boolean).find(x => sameUser(x.username, username));
    return !hit ? 'new' : hit.password === password ? 'same' : 'changed';
  }
  save(origin, username, password) {
    if (!this.available) throw new Error('Secure storage is not available on this computer, so passwords cannot be saved.');
    if (eligibleOrigin(origin) !== origin) throw new Error('Passwords can only be saved for https sites.');
    username = String(username || '').trim().slice(0, MAX_USERNAME);
    if (!username) throw new Error('A username is required, so two accounts are never mixed up.');
    if (typeof password !== 'string' || !password || password.length > MAX_PASSWORD) throw new Error('Invalid password.');
    const secret = this._seal({ username, password });
    const hit = this.data.entries.find(e => e.origin === origin && sameUser(this._read(e)?.username, username));
    if (hit) { hit.secret = secret; hit.updatedAt = Date.now(); this._save(); return { id: hit.id, updated: true }; }
    const e = { id: randomUUID(), origin, secret, addedAt: Date.now(), updatedAt: Date.now() };
    this.data.entries.push(e); this._save(); return { id: e.id, updated: false };
  }
  remove(id) {
    const n = this.data.entries.length; this.data.entries = this.data.entries.filter(e => e.id !== id);
    this.data.autofill = this.data.autofill.filter(o => this.data.entries.some(e => e.origin === o));   // no logins left for a site: auto sign-in is off
    if (this.data.entries.length !== n) this._save();
  }
  clear() { this.data = this._empty(); this._save(); }
  // Older versions could save a login without a username, which made different accounts overwrite each other.
  // They cannot be told apart, so they are removed. Returns how many.
  purgeAnonymous() {
    const before = this.data.entries.length;
    this.data.entries = this.data.entries.filter(e => { const x = this._read(e); return !x || x.username; });
    const n = before - this.data.entries.length; if (n) this._save(); return n;
  }
  // Auto sign-in is opt-in PER SITE: only for these exact origins.
  isAutofill(origin) { return this.data.autofill.includes(origin); }
  setAutofill(origin, on) {
    if (eligibleOrigin(origin) !== origin) throw new Error('Auto sign-in works on https sites only.');
    if (on && !this.data.entries.some(e => e.origin === origin)) throw new Error('Save a login for this site first.');
    const has = this.isAutofill(origin);
    if (on && !has) this.data.autofill.push(origin); else if (!on && has) this.data.autofill = this.data.autofill.filter(o => o !== origin); else return;
    this._save();
  }
  isNever(origin) { return this.data.never.includes(origin); }
  addNever(origin) { if (eligibleOrigin(origin) === origin && !this.isNever(origin)) { this.data.never.push(origin); this._save(); } }
}

module.exports = { Vault, eligibleOrigin, MAX_PASSWORD, MAX_USERNAME };
