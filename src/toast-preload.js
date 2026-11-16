'use strict';
// Preload for the small top-right popup. It can only report a button press and its own height.
const { contextBridge, ipcRenderer } = require('electron');
let id = null;
contextBridge.exposeInMainWorld('toast', {
  onShow: cb => ipcRenderer.on('toast', (_e, p) => cb(p)),
  act: action => ipcRenderer.send('toast:act', { id, action }),
  size: h => ipcRenderer.send('toast:size', h),
  setId: v => { id = v; }
});
