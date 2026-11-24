'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tt', {
  loadData: () => ipcRenderer.invoke('store:load'),
  saveData: (state) => ipcRenderer.invoke('store:save', state),
  exportTxt: (content, suggestedName) => ipcRenderer.invoke('export:txt', content, suggestedName),
  notifyTimer: (state) => ipcRenderer.send('timer:state', state),
  getAutostart: () => ipcRenderer.invoke('autostart:get'),
  setAutostart: (enabled) => ipcRenderer.invoke('autostart:set', enabled),
  getVersion: () => ipcRenderer.invoke('app:version'),
  onTimerCommand: (callback) => {
    ipcRenderer.on('timer:command', (_event, cmd) => callback(cmd));
  },
});
