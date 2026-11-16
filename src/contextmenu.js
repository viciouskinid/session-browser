'use strict';
// What the right-click menu shows, by what was clicked (like a mainstream browser). Pure: it turns the click's parameters and a
// set of actions into a menu template, so every case can be tested without a window.
//   misspelled word in a text field -> Spelling (one submenu of suggestions), Add to dictionary
//   link            -> Open link in new tab, Copy link address (or Copy email address)
//   image / media   -> Open in new tab, Copy image, Copy address, Save as
//   text field      -> Undo, Redo, Cut, Copy, Paste, Paste as plain text, Select all (no Cut/Copy in a password field)
//   selected text   -> Copy, Search the web for it
//   plain page      -> Back, Forward, Reload, Copy page address, Print
const isHttp = u => /^https?:\/\//i.test(String(u || ''));
const trunc = (t, n) => { t = String(t).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

function buildTemplate(p, a) {
  const t = [];
  const sep = () => { if (t.length && t[t.length - 1].type !== 'separator') t.push({ type: 'separator' }); };
  const ef = p.editFlags || {};
  const secret = p.isEditable && p.inputFieldType === 'password';

  if (p.isEditable && p.misspelledWord) {
    // All the suggested spellings live in one submenu, so the menu stays short however many there are.
    const sug = (p.dictionarySuggestions || []).slice(0, 12);
    if (sug.length) t.push({ label: 'Spelling', submenu: sug.map(s => ({ label: s, click: () => a.replaceMisspelling(s) })) });
    else t.push({ label: 'No spelling suggestions', enabled: false });
    t.push({ label: 'Add to dictionary', click: () => a.addToDictionary(p.misspelledWord) });
    sep();
  }
  if (p.linkURL) {
    if (/^mailto:/i.test(p.linkURL)) t.push({ label: 'Copy email address', click: () => a.copyText(p.linkURL.replace(/^mailto:/i, '').split('?')[0]) });
    else {
      if (isHttp(p.linkURL)) t.push({ label: 'Open link in new tab', click: () => a.openTab(p.linkURL) });
      t.push({ label: 'Copy link address', click: () => a.copyText(p.linkURL) });
    }
    sep();
  }
  if (p.mediaType === 'image' && p.srcURL) {
    if (isHttp(p.srcURL)) t.push({ label: 'Open image in new tab', click: () => a.openTab(p.srcURL) });
    t.push({ label: 'Copy image', click: () => a.copyImage(p.x, p.y) });
    if (isHttp(p.srcURL)) { t.push({ label: 'Copy image address', click: () => a.copyText(p.srcURL) }); t.push({ label: 'Save image as…', click: () => a.saveUrl(p.srcURL) }); }
    sep();
  } else if ((p.mediaType === 'video' || p.mediaType === 'audio') && isHttp(p.srcURL)) {
    t.push({ label: `Copy ${p.mediaType} address`, click: () => a.copyText(p.srcURL) });
    t.push({ label: `Save ${p.mediaType} as…`, click: () => a.saveUrl(p.srcURL) });
    sep();
  }
  if (p.isEditable) {
    t.push({ label: 'Undo', enabled: !!ef.canUndo, click: () => a.edit('undo') }, { label: 'Redo', enabled: !!ef.canRedo, click: () => a.edit('redo') }, { type: 'separator' });
    if (!secret) t.push({ label: 'Cut', enabled: !!ef.canCut, click: () => a.edit('cut') }, { label: 'Copy', enabled: !!ef.canCopy, click: () => a.edit('copy') });
    t.push({ label: 'Paste', enabled: !!ef.canPaste, click: () => a.edit('paste') });
    if (!secret) t.push({ label: 'Paste as plain text', enabled: !!ef.canPaste, click: () => a.edit('pasteAsPlainText') });
    t.push({ type: 'separator' }, { label: 'Select all', enabled: !!ef.canSelectAll, click: () => a.edit('selectAll') });
  } else if (p.selectionText && p.selectionText.trim()) {
    t.push({ label: 'Copy', click: () => a.edit('copy') });
    t.push({ label: `Search the web for “${trunc(p.selectionText, 28)}”`, click: () => a.search(p.selectionText.trim()) });
  } else if (!p.linkURL && !(p.mediaType && p.mediaType !== 'none')) {
    t.push({ label: 'Back', enabled: !!a.canGoBack, click: () => a.back() }, { label: 'Forward', enabled: !!a.canGoForward, click: () => a.forward() }, { label: 'Reload', click: () => a.reload() },
      { type: 'separator' }, { label: 'Copy page address', click: () => a.copyText(p.pageURL) }, { label: 'Print…', click: () => a.print() }, { type: 'separator' }, { label: 'Select all', click: () => a.edit('selectAll') });
  }
  while (t.length && t[t.length - 1].type === 'separator') t.pop();
  return t;
}
module.exports = { buildTemplate };
