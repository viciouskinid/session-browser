'use strict';
// The only privileged surface. Loaded into the app's own UI, never into websites.
const { contextBridge, ipcRenderer } = require('electron');
const CH = ['state:get','ws:add','ws:close','ws:select','sess:new','sess:select','sess:assign','sess:remove','sess:close',
  'sess:rename','sess:moveTo','sess:logout','sess:login','google:rename','side:tab','side:hide','sess:useGoogle','ws:move','pm:fill','pm:autofill','pm:unlock','pm:lock','hello:set','sess:note','side:toggle','sess:openPage','history:clear','history:list','dl:choose','dl:folder','pm:list','pm:remove','pm:clear','pm:answer','theme:preview','google:another','google:cancel','google:add','google:signin','google:remove',
  'menu:open','ctx:account','sidebar:toggle','settings:save','sess:useGoogleMany','nav:go','nav:back','nav:forward','nav:reload','nav:external','ui:modal',
  'dl:toggle','dl:hide','dl:menu','dl:copylink','pm:reveal','dl:list','dl:pause','dl:resume','dl:cancel','dl:remove','dl:clear','dl:open','dl:show','dl:folder'];
contextBridge.exposeInMainWorld('sb', {
  invoke: (ch, ...args) => CH.includes(ch) ? ipcRenderer.invoke(ch, ...args) : Promise.reject(new Error('bad channel')),
  on: (ev, cb) => { if (['state','notice','focus-address','new-website','google-chooser','downloads','ctx','open-settings','pm-offer','pm-manage','side-tab','open-search','side-note'].includes(ev)) ipcRenderer.on(ev, (_e, p) => cb(p)); }
});
