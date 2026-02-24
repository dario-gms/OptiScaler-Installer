const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  selectFolder:    ()            => ipcRenderer.invoke('select-folder'),
  scanDirectory:   (dir)         => ipcRenderer.invoke('scan-directory', dir),
  checkInstall:    (dir)         => ipcRenderer.invoke('check-install', dir),
  fetchRelease:    (channel)     => ipcRenderer.invoke('fetch-release', channel),
  install:         (opts, info)  => ipcRenderer.invoke('install', opts, info),
  uninstall:       (dir)         => ipcRenderer.invoke('uninstall', dir),

  onInstallLog:      (cb) => ipcRenderer.on('install-log',    (_e, d) => cb(d)),
  onInstallProgress: (cb) => ipcRenderer.on('install-progress', (_e, p) => cb(p)),
  onUninstallLog:    (cb) => ipcRenderer.on('uninstall-log',  (_e, d) => cb(d)),

  removeInstallListeners: () => {
    ipcRenderer.removeAllListeners('install-log');
    ipcRenderer.removeAllListeners('install-progress');
  },
  removeUninstallListeners: () => {
    ipcRenderer.removeAllListeners('uninstall-log');
  },
});
