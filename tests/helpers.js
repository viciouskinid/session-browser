'use strict';
// Shared test harness: local server with test-only credentials, and an Electron launcher.
const { _electron } = require('playwright-core');
const http = require('http'), path = require('path');
const APP = path.join(__dirname, '..');
const PAGE = (body, title = 't') => `<!doctype html><title>${title}</title><script>
const open=()=>new Promise(r=>{const q=indexedDB.open('t',1);q.onupgradeneeded=()=>q.result.createObjectStore('kv');q.onsuccess=()=>r(q.result)});
window.readState=async()=>{const db=await open();const idb=await new Promise(r=>{const g=db.transaction('kv').objectStore('kv').get('user');g.onsuccess=()=>r(g.result||null)});return{cookie:document.cookie,ls:localStorage.getItem('user'),idb}};
window.writeState=async u=>{localStorage.setItem('user',u);const db=await open();await new Promise(r=>{const t=db.transaction('kv','readwrite');t.objectStore('kv').put(u,'user');t.oncomplete=r})};
</script>${body}`;

const EMAILS = { frank: 'f.one@example.com', gina: 'g.two@example.com' };

function server() {
  return new Promise(res => {
    const s = http.createServer((req, rsp) => {
      const u = new URL(req.url, 'http://x');
      const h = { 'content-type': 'text/html' };
      if (u.pathname === '/login') {
        const who = u.searchParams.get('u');
        h['set-cookie'] = `sid=${who}; Max-Age=3600; Path=/`;
        rsp.writeHead(200, h);
        return rsp.end(PAGE(`<script>writeState(${JSON.stringify(who)}).then(()=>document.title='done')</script>`));
      }
      if (u.pathname === '/ListAccounts') {   // stand-in for Google's account lookup: cookie value -> email
        const m = /(?:^|;\s*)sid=([^;]*)/.exec(req.headers.cookie || ''), email = m && EMAILS[m[1]];
        rsp.writeHead(200, { 'content-type': 'application/json' });
        return rsp.end(JSON.stringify(['gaia.l.a.r', email ? [['gaia.l.a', 1, 'Test', email, '', 1, 1, 0]] : []]));
      }
      if (u.pathname === '/prefs') { h['set-cookie'] = 'theme=dark; Path=/'; rsp.writeHead(200, h); return rsp.end(PAGE('<p>prefs</p>')); }
      if (u.pathname === '/mail') { rsp.writeHead(200, h); return rsp.end(PAGE('<p>mail</p>', 'Inbox (3) - dana@example.com - Mail')); }
      rsp.writeHead(200, h); rsp.end(PAGE('<p>state</p>'));
    }).listen(0, '127.0.0.1', () => res({ s, base: `http://127.0.0.1:${s.address().port}` }));
  });
}

const launch = async dir => {
  const app = await _electron.launch({ args: ['--no-sandbox', APP], env: { ...process.env, SB_USER_DATA: dir, SB_TEST: '1' } });
  await app.firstWindow();
  return app;
};
// Run code inside the app's main process with access to the test hook `sb`.
const run = (app, src, arg) => app.evaluate(async ({}, { src, arg }) =>
  new Function('sb', 'arg', `return (async()=>{${src}})()`)(global.__sb, arg), { src, arg });
const login = (app, id, base, who) => run(app, `await sb.go(arg.id, arg.base+'/login?u='+arg.who);
  await sb.exec(arg.id, "new Promise(r=>{const t=()=>document.title==='done'?r(1):setTimeout(t,30);t()})")`, { id, base, who });
const read = async (app, id, base) => run(app, `await sb.go(arg.base+'/state' && arg.id, arg.base+'/state'); return sb.exec(arg.id,'readState()')`, { id, base });


const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('waitFor timed out'); await sleep(100); }
}
module.exports = { server, launch, run, login, read, sleep, waitFor };
