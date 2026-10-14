const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getUser: () => ipcRenderer.invoke('get-user'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  systemControl: (id, action) => ipcRenderer.invoke('system-control', id, action),
  onSystemSessions: (cb) => {
    const handler = (_e, sessions) => cb(sessions);
    ipcRenderer.on('system-sessions', handler);
    return () => ipcRenderer.removeListener('system-sessions', handler);
  },
  onTracksMeta: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on('tracks-meta', handler);
    return () => ipcRenderer.removeListener('tracks-meta', handler);
  },
  toMediaUrl: (p) => `media://local/?p=${encodeURIComponent(p)}`,
  toCoverUrl: (p) => `media://cover/?p=${encodeURIComponent(p)}`,
});
