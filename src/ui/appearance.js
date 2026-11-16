'use strict';
// Applies the app's appearance (semantic tokens computed by the main process) to this page. Used by every app page.
function applyAppearance(a) {
  if (!a) return;
  const r = document.documentElement, st = r.style;
  for (const [k, v] of Object.entries(a.vars || {})) st.setProperty(k, v);
  r.dataset.theme = a.mode === 'dark' ? 'dark' : 'light';
  r.dataset.density = a.density || 'comfortable';
  r.dataset.motion = a.motion || 'system';
  st.colorScheme = a.mode === 'dark' ? 'dark' : 'light';
  const [sm, md, lg] = a.radius || [6, 8, 12];
  st.setProperty('--r-sm', sm + 'px'); st.setProperty('--r-md', md + 'px'); st.setProperty('--r-lg', lg + 'px');
  st.setProperty('--fs', String(a.fontScale || 1));
  st.setProperty('--dens', a.density === 'compact' ? '0.7' : a.density === 'spacious' ? '1.35' : '1');
}
