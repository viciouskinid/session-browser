'use strict';
// Settings dialog: a category rail (General, Appearance, About) and a scrollable panel. Appearance changes apply and are
// saved immediately; there is no Save button to forget. Uses el/fill/call/S/buildText from ui.js and Themes from themes.js.
let settingsCat = 'appearance';

function openSettings(cat) {
  const scrim = $('#sscrim'), box = $('#settings');
  if (!scrim.hidden || !$('#scrim').hidden || !$('#qscrim').hidden) return;
  settingsCat = cat || settingsCat;
  const view = { q: '', fam: 'all', note: '' };
  const ui = () => S.ui || {};
  const customs = () => ui().customThemes || [];
  const current = () => S.appearance || { themeId: 'light', mode: 'light' };
  const save = patch => sb.invoke('settings:save', patch);
  const close = () => { scrim.hidden = true; box.onkeydown = null; sb.invoke('ui:modal', false); const m = $('#menu'); if (m) m.focus(); };
  let content, nav, redraw = () => {};

  const radio = (name, label, hint, options, value, onPick) => el('fieldset', { class: 'sfield' },
    el('legend', {}, label), hint ? el('div', { class: 'shint' }, hint) : null,
    el('div', { class: 'sradios', role: 'radiogroup', 'aria-label': label },
      ...options.map(([v, t]) => el('label', { class: 'sradio' + (v === value ? ' on' : '') },
        el('input', { type: 'radio', name, value: v, checked: v === value, onchange: () => onPick(v) }), el('span', {}, t)))));

  // ---------- General
  function drawGeneral() {
    const err = el('div', { class: 'serr', role: 'alert' });
    const home = el('input', { type: 'text', value: ui().homeUrl || '', placeholder: 'Leave blank for an empty tab (for example https://example.com)', 'aria-label': 'Default home page', autocomplete: 'off', spellcheck: 'false' });
    const commit = async () => {
      if (home.value.trim() === (ui().homeUrl || '')) return;
      const r = await save({ homeUrl: home.value }); err.textContent = r.ok ? '' : r.error;
      if (r.ok) view.note = 'Saved.';
    };
    home.onchange = commit; home.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } };
    const isDefault = !ui().downloadDir;
    const dirNote = el('div', { class: 'serr', role: 'alert' }), helloNote = el('div', { class: 'serr', role: 'alert' });
    // Search engine: what the address bar uses when you type words instead of an address. Pick one, or type your own address.
    const engNote = el('div', { class: 'serr', role: 'alert' });
    const engSel = el('select', { 'aria-label': 'Default search engine' },
      ...Engines.ENGINES.map(e => el('option', { value: e.id, selected: (ui().searchEngine || Engines.DEFAULT_ID) === e.id }, e.name)),
      el('option', { value: 'custom', selected: ui().searchEngine === 'custom' }, 'Other (type the address)…'));
    const customIn = el('input', { type: 'text', value: ui().searchCustom || '', placeholder: 'https://example.com/search?q=%s', 'aria-label': 'Custom search address', autocomplete: 'off', spellcheck: 'false' });
    const customRow = el('label', { class: 'sfield', hidden: ui().searchEngine !== 'custom' }, el('span', { class: 'shint' }, 'Use %s where the search words go.'), customIn);
    engSel.onchange = async () => {
      customRow.hidden = engSel.value !== 'custom';
      if (engSel.value === 'custom') { customIn.focus(); if (!Engines.checkTemplate(customIn.value).ok) return; }   // saved once a valid address is typed
      const r = await save({ searchEngine: engSel.value, ...(engSel.value === 'custom' ? { searchCustom: customIn.value } : {}) });
      engNote.textContent = r.ok ? '' : r.error; if (r.ok) redraw();
    };
    const commitCustom = async () => {
      const r = await save({ searchCustom: customIn.value, searchEngine: 'custom' });
      engNote.textContent = r.ok ? '' : r.error; if (r.ok) redraw();
    };
    customIn.onchange = commitCustom; customIn.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); commitCustom(); } };
    // Peak download speed (fastest the app has seen, smoothed over a few seconds).
    const peak = ui().maxDownloadSpeed;
    const speedText = p => { const mb = p.bps / 1048576; return `${mb >= 10 ? mb.toFixed(1) : mb.toFixed(2)} MB/s (${(p.bps * 8 / 1e6).toFixed(p.bps * 8 / 1e6 >= 100 ? 0 : 1)} Mbit/s)`; };
    fill(content, el('h4', {}, 'General'), el('p', { class: 'shint' }, 'How new tabs start, how the address bar searches, and where downloads go. Each tab keeps its own default address once it exists.'),
      el('label', { class: 'sfield' }, el('span', { class: 'slabel' }, 'Default home page for new tabs (+)'), home, el('div', { class: 'shint' }, 'Changes apply to tabs you create next.'), err),
      el('div', { class: 'sfield' }, el('label', { class: 'slabel' }, 'Search engine'),
        el('div', { class: 'shint' }, 'Used when you type words instead of an address in the address bar, and for “Search the web for…” in the right-click menu.'),
        engSel, customRow, engNote),
      radio('saveHistory', 'Recent pages', 'Remembers the pages you open in each account (address and title, never the part after ? or #) so you can find them in Search. They are removed with the account.',
        [['on', 'Remember'], ['off', 'Don’t remember']], ui().saveHistory === false ? 'off' : 'on', async v => { await save({ saveHistory: v === 'on' }); redraw(); }),
      el('div', { class: 'sfield' }, el('button', { type: 'button', class: 'btn danger', disabled: !S.historyCount, onclick: async () => { await sb.invoke('history:clear'); redraw(); } }, 'Clear recent pages')),
      el('div', { class: 'sfield' }, el('div', { class: 'slabel' }, 'Saved passwords and Windows Hello'),
        S.helloSupported
          ? el('div', {}, el('div', { class: 'shint' }, 'Ask Windows (PIN, fingerprint or face) before saved logins can be shown, filled or changed. Saving a new login never asks.'),
              el('div', { class: 'sradios', role: 'radiogroup', 'aria-label': 'Windows Hello' },
                ...[['off', 'Off'], ['on', 'Require Windows Hello']].map(([v, t]) => el('label', { class: 'sradio' + ((S.helloOn ? 'on' : 'off') === v ? ' on' : '') },
                  el('input', { type: 'radio', name: 'hello', value: v, checked: (S.helloOn ? 'on' : 'off') === v, onchange: async () => { const r = await sb.invoke('hello:set', v === 'on'); helloNote.textContent = r.ok ? '' : r.error; redraw(); } }), el('span', {}, t)))),
              S.helloOn ? el('div', { class: 'sradios', style: 'margin-top:8px', role: 'radiogroup', 'aria-label': 'Lock after' },
                ...[[1, '1 min'], [5, '5 min'], [15, '15 min'], [60, '1 hour']].map(([m, t]) => el('label', { class: 'sradio' + ((ui().helloMinutes || 5) === m ? ' on' : '') },
                  el('input', { type: 'radio', name: 'hellomin', value: String(m), checked: (ui().helloMinutes || 5) === m, onchange: async () => { await save({ helloMinutes: m }); redraw(); } }), el('span', {}, 'Lock after ' + t)))) : null)
          : el('div', { class: 'shint' }, 'Windows Hello is only available on Windows.'), helloNote),
      el('div', { class: 'sfield' }, el('div', { class: 'slabel' }, 'Fastest download speed recorded'),
        peak ? el('div', {}, el('div', { class: 'sdir' }, speedText(peak)),
            el('div', { class: 'shint' }, `Reached ${new Date(peak.at).toLocaleString()}${peak.name ? ' while downloading ' + peak.name : ''}. It is the speed averaged over a few seconds, not a single burst.`),
            el('div', { class: 'srow' }, el('button', { type: 'button', class: 'btn', onclick: async () => { await save({ maxDownloadSpeed: null }); redraw(); } }, 'Reset record')))
          : el('div', { class: 'shint' }, 'Nothing recorded yet. The fastest speed of any download is kept here, with its date and time.')),
      el('div', { class: 'sfield' }, el('div', { class: 'slabel' }, 'Download folder'),
        el('div', { class: 'sdir', title: S.downloadDir || '' }, S.downloadDir || ''),
        el('div', { class: 'shint' }, isDefault ? 'The default: a folder named after the application inside your Downloads folder. It is created when the first file arrives.' : 'A folder you chose.'),
        el('div', { class: 'srow' },
          el('button', { type: 'button', class: 'btn', onclick: async () => { const r = await sb.invoke('dl:choose'); dirNote.textContent = r.ok ? '' : r.error; redraw(); } }, 'Change…'),
          el('button', { type: 'button', class: 'btn', onclick: () => sb.invoke('dl:folder') }, 'Open folder'),
          el('button', { type: 'button', class: 'btn', disabled: isDefault, onclick: async () => { const r = await save({ downloadDir: null }); dirNote.textContent = r.ok ? '' : r.error; redraw(); } }, 'Reset to default')), dirNote));
  }

  // ---------- Appearance
  const all = () => Themes.all(customs());
  const shown = () => {
    const q = view.q.trim().toLowerCase();
    return all().filter(t => (view.fam === 'all' || (view.fam === 'light' || view.fam === 'dark' ? t.mode === view.fam : t.family === view.fam)) && (!q || t.name.toLowerCase().includes(q) || t.id.includes(q)));
  };
  async function pickTheme(t) {
    const u = ui(), patch = { theme: t.id, recentThemes: [t.id, ...(u.recentThemes || []).filter(x => x !== t.id)].slice(0, 6) };
    patch[t.mode === 'dark' ? 'themeDark' : 'themeLight'] = t.id;   // remembered, so switching mode never discards it
    await save(patch); redraw();
  }
  const preview = (t, accent) => {
    const k = Themes.tokens(t, accent);
    return el('span', { class: 'tprev', style: `background:${k['--bg']};border-color:${k['--line']}` },
      el('span', { class: 'tbar', style: `background:${k['--chrome']}` }),
      el('span', { class: 'tmini', style: `background:${k['--panel']};border-color:${k['--line']}` },
        el('i', { style: `background:${k['--ink']}` }), el('i', { class: 'short', style: `background:${k['--muted']}` }),
        el('b', { style: `background:${k['--accent']};color:${k['--on-accent']}` }, 'Aa')));
  };
  const card = t => {
    const sel = t.id === current().themeId;
    return el('button', { type: 'button', class: 'tcard' + (sel ? ' sel' : ''), 'aria-pressed': String(sel), title: t.name, onclick: () => pickTheme(t) },
      preview(t), el('span', { class: 'tname' }, t.name), el('span', { class: 'tmeta' }, (t.mode === 'dark' ? 'Dark' : 'Light') + (sel ? ' · ✓ Selected' : '')));
  };

  function drawAppearance() {
    const u = ui(), a = current(), mode = (u.theme || 'system') === 'system' ? 'system' : a.mode;
    const gallery = el('div', { class: 'tgrid', role: 'group', 'aria-label': 'Themes' });
    const count = el('div', { class: 'shint', 'aria-live': 'polite' });
    const recent = el('div', { class: 'trecent' });
    const search = el('input', { type: 'search', class: 'tsearch', placeholder: 'Search themes', 'aria-label': 'Search themes', value: view.q, autocomplete: 'off', spellcheck: 'false' });
    const chips = el('div', { class: 'tchips', role: 'group', 'aria-label': 'Theme categories' });
    const drawGallery = () => {
      const list = shown();
      gallery.replaceChildren(...(list.length ? list.map(card) : [el('div', { class: 'sempty' }, view.fam === 'custom' ? 'No custom themes yet. Create one below.' : 'No theme matches. Try another name or category.')]));
      count.textContent = `${list.length} of ${all().length} themes`;
      const rec = (u.recentThemes || []).map(id => Themes.find(id, customs())).filter(Boolean);
      recent.replaceChildren(...(rec.length && !view.q && view.fam === 'all' ? [el('span', { class: 'slabel' }, 'Recently used'), ...rec.map(t => el('button', { type: 'button', class: 'chip' + (t.id === a.themeId ? ' on' : ''), onclick: () => pickTheme(t) }, t.name))] : []));
      chips.replaceChildren(...Themes.FAMILIES.map(([id, name]) => el('button', { type: 'button', class: 'chip' + (view.fam === id ? ' on' : ''), 'aria-pressed': String(view.fam === id), onclick: () => { view.fam = id; drawGallery(); } }, name)));
    };
    search.oninput = () => { view.q = search.value; drawGallery(); };
    drawGallery();

    // accent
    const accents = el('div', { class: 'swatches', role: 'group', 'aria-label': 'Accent colour' },
      ...Themes.ACCENTS.map(([name, hex]) => el('button', { type: 'button', class: 'sw' + (u.accent === hex ? ' on' : ''), style: `background:${hex}`, title: name, 'aria-label': name, 'aria-pressed': String(u.accent === hex),
        onclick: async () => { await save({ accent: hex }); redraw(); } }, u.accent === hex ? '✓' : '')));
    const picker = el('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(u.accent || '') ? u.accent : (a.vars && a.vars['--accent']) || '#2563eb', 'aria-label': 'Custom accent colour' });
    picker.onchange = async () => { await save({ accent: picker.value }); redraw(); };

    fill(content, el('h4', {}, 'Appearance'),
      el('p', { class: 'shint' }, 'Themes, accent colour and interface style. Websites that follow the system appearance (auto) follow this theme too.'),
      radio('mode', 'Mode', 'System follows your computer’s light/dark setting and uses your chosen light and dark themes.',
        [['light', 'Light'], ['dark', 'Dark'], ['system', 'System']], mode, async v => {
          const slot = v === 'light' ? (Themes.find(u.themeLight || '', customs())?.mode === 'light' ? u.themeLight : 'light') : v === 'dark' ? (Themes.find(u.themeDark || '', customs())?.mode === 'dark' ? u.themeDark : 'dark') : 'system';
          await save({ theme: slot }); redraw();
        }),
      el('div', { class: 'sfield' }, el('div', { class: 'slabel' }, 'Theme'), search, chips, recent, count, gallery),
      el('div', { class: 'sfield' }, el('div', { class: 'slabel' }, 'Accent colour'),
        el('div', { class: 'shint' }, 'Overrides the theme’s accent for buttons, links, focus rings and selection. The theme underneath is unchanged.'), accents,
        el('div', { class: 'srow' }, el('label', { class: 'sinline' }, el('span', {}, 'Custom'), picker),
          el('button', { type: 'button', class: 'btn', disabled: !u.accent, onclick: async () => { await save({ accent: null }); redraw(); } }, 'Use the theme’s accent'))),
      radio('density', 'Density', 'Spacing in lists.', [['compact', 'Compact'], ['comfortable', 'Comfortable'], ['spacious', 'Spacious']], u.density || 'comfortable', async v => { await save({ density: v }); redraw(); }),
      radio('radius', 'Corners', null, [['sharp', 'Sharp'], ['subtle', 'Subtle'], ['rounded', 'Rounded']], u.radius || 'subtle', async v => { await save({ radius: v }); redraw(); }),
      radio('fontScale', 'Text size', null, [['small', 'Small'], ['default', 'Default'], ['large', 'Large'], ['xl', 'Extra large']], u.fontScale || 'default', async v => { await save({ fontScale: v }); redraw(); }),
      radio('motion', 'Motion', 'System follows your computer’s reduce-motion setting.', [['system', 'System'], ['reduced', 'Reduced'], ['off', 'Off']], u.motion || 'system', async v => { await save({ motion: v }); redraw(); }),
      drawBuilder(),
      el('div', { class: 'sfield' }, el('button', { type: 'button', class: 'btn', onclick: async () => {
        await save({ theme: 'system', themeLight: 'light', themeDark: 'dark', accent: null, density: 'comfortable', radius: 'subtle', fontScale: 'default', motion: 'system' }); redraw();
      } }, 'Reset appearance to defaults'), el('div', { class: 'shint' }, 'Your custom themes are kept.')));
  }

  // ---------- Custom theme builder
  const ed = { id: null, name: 'My theme', mode: 'light', bg: '#f4f6fa', panel: '#ffffff', ink: '#1b2430', accent: '#2563eb' };
  const loadFrom = (t, asNew) => { Object.assign(ed, { id: asNew ? null : (t.builtin ? null : t.id), name: asNew ? t.name + ' copy' : t.name, mode: t.mode, bg: t.bg, panel: t.panel, ink: t.ink, accent: t.accent }); };
  function drawBuilder() {
    const status = el('div', { class: 'shint', role: 'status', 'aria-live': 'polite' });
    const prevBox = el('div', { class: 'bprev' });
    const report = el('ul', { class: 'breport' });
    const row = (label, key) => {
      const inp = el('input', { type: 'color', value: ed[key], 'aria-label': label });
      inp.oninput = () => { ed[key] = inp.value; update(); };
      return el('label', { class: 'sinline' }, el('span', {}, label), inp);
    };
    const nameIn = el('input', { type: 'text', value: ed.name, maxlength: 40, 'aria-label': 'Theme name' });
    nameIn.oninput = () => { ed.name = nameIn.value; };
    const modeSel = el('select', { 'aria-label': 'Base mode' }, el('option', { value: 'light', selected: ed.mode === 'light' }, 'Light'), el('option', { value: 'dark', selected: ed.mode === 'dark' }, 'Dark'));
    modeSel.onchange = () => { ed.mode = modeSel.value; update(); };
    const line = (label, a, b, min) => { const r = Themes.contrast(a, b); return el('li', {}, `${r >= min ? '✓' : '⚠'} ${label}: ${r.toFixed(1)} : 1${r >= min ? '' : ` (below ${min}). The app will adjust it so it stays readable.`}`); };
    function update() {
      prevBox.replaceChildren(preview({ ...ed }));
      report.replaceChildren(line('Text on background', ed.ink, ed.bg, 4.5), line('Text on surface', ed.ink, ed.panel, 4.5), line('Accent on background', ed.accent, ed.bg, 3));
    }
    update();
    const mine = customs().find(t => t.id === ed.id);
    const mk = id => ({ id, name: ed.name.trim() || 'My theme', mode: ed.mode, bg: ed.bg, panel: ed.panel, ink: ed.ink, accent: ed.accent });
    const delBtn = el('button', { type: 'button', class: 'btn danger', disabled: !mine }, 'Delete');
    let armed = false;
    delBtn.onclick = async () => {
      if (!armed) { armed = true; delBtn.textContent = 'Click again to delete'; setTimeout(() => { armed = false; delBtn.textContent = 'Delete'; }, 4000); return; }
      const wasSelected = current().themeId === ed.id;
      await save({ customThemes: customs().filter(t => t.id !== ed.id), ...(wasSelected ? { theme: 'system' } : {}) });
      ed.id = null; redraw();
    };
    return el('details', { class: 'sfield builder', open: !!ed.id || view.builderOpen, ontoggle: e => { view.builderOpen = e.target.open; } },
      el('summary', {}, 'Custom themes'),
      el('p', { class: 'shint' }, 'Make your own theme from four colours. Everything else is derived and checked for contrast.'),
      el('div', { class: 'bgrid' },
        el('div', {}, el('label', { class: 'sinline' }, el('span', {}, 'Name'), nameIn), el('label', { class: 'sinline' }, el('span', {}, 'Base mode'), modeSel),
          row('Background', 'bg'), row('Surface', 'panel'), row('Text', 'ink'), row('Accent', 'accent'), report),
        prevBox),
      el('div', { class: 'srow' },
        el('button', { type: 'button', class: 'btn primary', onclick: async () => {
          const t = mk('custom-' + Math.random().toString(36).slice(2, 8));
          if (customs().length >= 30) { status.textContent = 'You can keep up to 30 custom themes.'; return; }
          await save({ customThemes: [...customs(), t], theme: t.id }); ed.id = t.id; view.fam = 'custom'; redraw();
        } }, 'Save as new theme'),
        el('button', { type: 'button', class: 'btn', disabled: !mine, onclick: async () => { await save({ customThemes: customs().map(t => t.id === ed.id ? mk(ed.id) : t) }); status.textContent = 'Updated.'; redraw(); } }, 'Update this theme'),
        el('button', { type: 'button', class: 'btn', onclick: () => { loadFrom(Themes.find(current().themeId, customs()), true); redraw(); } }, 'Duplicate current theme'),
        delBtn), status);
  }

  // ---------- About
  function drawAbout() {
    fill(content, el('h4', {}, 'About'), el('img', { class: 'applogo', src: 'logo.png', alt: 'Session Browser logo', width: '72', height: '72', style: 'margin:0 0 12px' }),
      el('p', {}, 'Session Browser keeps each account of a website in its own isolated session.'),
      el('dl', { class: 'sabout' }, el('dt', {}, 'Version'), el('dd', {}, S.appVersion || ''), el('dt', {}, 'Build'), el('dd', {}, buildText().replace(/^Build /, '')),
        el('dt', {}, 'Themes'), el('dd', {}, `${Themes.BUILTIN.length} built in, ${customs().length} custom`)));
  }

  const CATS = [['general', 'General', drawGeneral], ['appearance', 'Appearance', drawAppearance], ['about', 'About', drawAbout]];
  const drawNav = () => nav.replaceChildren(...CATS.map(([id, name]) => el('button', { type: 'button', class: 'snavitem' + (id === settingsCat ? ' on' : ''), 'aria-current': id === settingsCat ? 'page' : null,
    onclick: () => { settingsCat = id; redraw(); } }, name)));
  redraw = () => { const keep = content && content.scrollTop; drawNav(); (CATS.find(c => c[0] === settingsCat) || CATS[1])[2](); if (keep) content.scrollTop = keep; };

  nav = el('nav', { class: 'snav', 'aria-label': 'Settings categories' });
  content = el('div', { class: 'scontent' });
  fill(box, el('div', { class: 'shead' }, el('h3', { id: 'set-title' }, 'Settings'),
    el('button', { type: 'button', class: 'x', 'aria-label': 'Close settings', title: 'Close (Esc)', onclick: close }, '×')),
    el('div', { class: 'sbody' }, nav, content));
  box.onkeydown = e => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); close(); } };
  scrim.onmousedown = e => { if (e.target === scrim) close(); };
  redraw();
  sb.invoke('ui:modal', true).then(() => { scrim.hidden = false; (nav.querySelector('.on') || nav.firstChild).focus(); });
}
