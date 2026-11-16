'use strict';
// Top-right popup. Shows fixed text and buttons sent by the app, and reports which button was pressed.
const $ = s => document.querySelector(s);
toast.onShow(p => {
  applyAppearance(p.appearance);
  toast.setId(p.id);
  $('#t').textContent = p.title || (p.buttons && p.buttons.length ? '' : 'Notice');
  $('#b').textContent = p.body || '';
  $('#btns').replaceChildren(...(p.buttons || []).map(b => {
    const e = document.createElement('button');
    e.type = 'button'; e.className = 'b' + (b.primary ? ' primary' : ''); e.textContent = b.label; e.title = b.label;
    e.addEventListener('click', () => toast.act(b.id));
    return e;
  }));
  const report = () => toast.size(Math.ceil($('#box').getBoundingClientRect().height));
  requestAnimationFrame(report); setTimeout(report, 150);
});
$('#x').addEventListener('click', () => toast.act('dismiss'));
