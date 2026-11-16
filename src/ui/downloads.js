'use strict';
// The Downloads panel, docked to the right of the page. It names downloads by id only. Paths never reach this page.
const $ = s => document.querySelector(s);
let P = { items: [], active: 0, progress: null }, query = '', tick;

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k);
  return e;
}
const hue = t => { let h = 0; for (const c of t) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const bytes = n => { if (!n || n < 0) return '0 B'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return (i && n < 10 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i]; };
function left(sec) {
  if (!isFinite(sec) || sec < 0) return '';
  if (sec < 60) return `${Math.max(1, Math.round(sec))} sec left`;
  if (sec < 3600) return `${Math.round(sec / 60)} min left`;
  return `${Math.floor(sec / 3600)} hr ${Math.round((sec % 3600) / 60)} min left`;
}
function dayLabel(t) {
  const d = new Date(t), now = new Date(), start = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(now) - start(d)) / 864e5);
  return diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}
// Date and time of a download: when it finished, or when it started if it is still going (or never finished).
const stamp = d => {
  const t = d.state === 'completed' && d.endedAt ? d.endedAt : d.startedAt; if (!t) return null;
  const x = new Date(t);
  return { text: x.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }),
    title: `Started ${new Date(d.startedAt).toLocaleString()}` + (d.endedAt ? `\nEnded ${new Date(d.endedAt).toLocaleString()}` : ''),
    iso: x.toISOString() };
};
const ext = n => { const m = /\.([A-Za-z0-9]{1,4})$/.exec(n); return m ? m[1].toUpperCase() : 'FILE'; };
let msgTimer;
function say(t) { $('#msg').textContent = t || ''; clearTimeout(msgTimer); if (t) msgTimer = setTimeout(() => say(''), 5000); }
async function act(ch, id) { const r = await sb.invoke(ch, id); if (!r.ok) say(r.error); else say(''); return r; }

function status(d) {
  const t = d.total > 0;
  if (d.state === 'progressing') {
    const pct = t ? Math.min(100, Math.round(d.received / d.total * 100)) + '% · ' : '';
    const parts = [pct + (t ? `${bytes(d.received)} of ${bytes(d.total)}` : bytes(d.received))];
    if (d.paused) return { text: 'Paused · ' + parts[0] };
    if (d.speed > 0) { parts.push(bytes(d.speed) + '/s'); if (t) parts.push(left((d.total - d.received) / d.speed)); }
    return { text: parts.filter(Boolean).join(' · ') };
  }
  if (d.state === 'completed') return d.missing ? { text: 'File was moved or deleted', err: true }
    : { text: [bytes(d.total || d.received), d.host].filter(Boolean).join(' · ') };
  if (d.state === 'cancelled') return { text: 'Cancelled' };
  return { text: d.canResume ? 'Interrupted. You can resume it' : 'Failed', err: true };
}

function row(d) {
  const st = status(d), running = d.state === 'progressing', done = d.state === 'completed', usable = done && !d.missing;
  const pct = d.total > 0 ? Math.min(100, Math.round(d.received / d.total * 100)) : null;
  const when = stamp(d);
  return el('div', { class: 'dl' + (done && d.missing ? ' gone' : ''), role: 'listitem', oncontextmenu: e => { e.preventDefault(); sb.invoke('dl:menu', d.id); } },
    el('div', { class: 'tile', style: `background:hsl(${hue(ext(d.name))} 40% 40%)`, 'aria-hidden': 'true' }, ext(d.name)),
    el('div', { class: 'body' },
      el('button', { class: 'name', title: d.name, disabled: !usable, onclick: () => act('dl:open', d.id) }, d.name),
      el('div', { class: 'stat' + (st.err ? ' err' : '') }, st.text),
      when ? el('time', { class: 'when', datetime: when.iso, title: when.title }, (d.state === 'completed' ? '' : d.state === 'progressing' ? 'Started ' : '') + when.text) : null,
      running ? el('div', { class: 'bar' + (pct == null ? ' unknown' : '') + (d.paused ? ' paused' : ''), role: 'progressbar', 'aria-label': 'Download progress', 'aria-valuemin': '0', 'aria-valuemax': '100', ...(pct == null ? {} : { 'aria-valuenow': String(pct) }), style: pct == null ? '' : `--p:${pct}%` }, el('i')) : null,
      el('div', { class: 'acts' },
        running ? el('button', { class: 'lnk strong', onclick: () => act(d.paused ? 'dl:resume' : 'dl:pause', d.id) }, d.paused ? '▶ Resume' : '❚❚ Pause') : null,
        running ? el('button', { class: 'lnk danger', onclick: () => act('dl:cancel', d.id) }, 'Cancel') : null,
        !running && d.state === 'interrupted' && d.canResume ? el('button', { class: 'lnk', onclick: () => act('dl:resume', d.id) }, 'Resume') : null,
        usable ? el('button', { class: 'lnk', onclick: () => act('dl:open', d.id) }, 'Open') : null,
        done ? el('button', { class: 'lnk', onclick: () => act('dl:show', d.id) }, 'Show in folder') : null,
        !running ? el('button', { class: 'lnk', title: 'Remove from this list. The file is kept.', onclick: () => act('dl:remove', d.id) }, 'Remove from list') : null)));
}

// Footer: the combined speed of everything that is downloading right now.
function renderFoot() {
  const foot = $('#dlfoot'), active = P.items.filter(d => d.state === 'progressing'), moving = active.filter(d => !d.paused);
  if (!active.length) { foot.hidden = true; foot.textContent = ''; return; }
  const speed = moving.reduce((n, d) => n + (d.speed || 0), 0);
  foot.hidden = false;
  foot.textContent = moving.length
    ? `Downloading ${moving.length} file${moving.length > 1 ? 's' : ''} · ${speed > 0 ? bytes(speed) + '/s' : 'starting…'}`
    : `${active.length} download${active.length > 1 ? 's' : ''} paused`;
}
function render() {
  renderFoot();
  const q = query.trim().toLowerCase();
  const items = P.items.filter(d => !q || d.name.toLowerCase().includes(q) || (d.host || '').toLowerCase().includes(q));
  const kids = []; let last = '';
  for (const d of items) {
    const day = dayLabel(d.startedAt);
    if (day !== last) { kids.push(el('div', { class: 'day' }, day)); last = day; }
    kids.push(row(d));
  }
  $('#list').replaceChildren(...(kids.length ? kids : [el('div', { class: 'empty' }, P.items.length ? 'No downloads match your search.' : 'No downloads yet. Files you download appear here.')]));
  $('#clear').disabled = !P.items.some(d => d.state !== 'progressing');
}

$('#q').addEventListener('input', e => { query = e.target.value; render(); });
$('#folder').onclick = () => act('dl:folder');
$('#clear').onclick = () => act('dl:clear');
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j')) { e.preventDefault(); sb.invoke('dl:hide'); }
});
$('#close').onclick = () => sb.invoke('dl:hide');
sb.on('downloads', p => { P = p; render(); });
sb.on('side-note', say);   // messages from the row menu (for example after Copy download link)
sb.invoke('dl:list').then(r => { if (r.ok) { P = r.value; render(); } });
