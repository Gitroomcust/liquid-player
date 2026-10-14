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
  toMediaUrl: (p) => 'media://local/' + encodeURIComponent(p.split(String.fromCharCode(92)).join('/').replace(/^([a-zA-Z]):\//, '$1/')).replace(/%2F/g, '/'),
});
