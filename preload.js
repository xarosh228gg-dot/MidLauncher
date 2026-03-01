const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getConfig: ()       => ipcRenderer.invoke('get-config'),
  saveConfig: (data)  => ipcRenderer.invoke('save-config', data),

  launchMinecraft: (opts) => ipcRenderer.send('launch-minecraft', opts),
  cancelLaunch:    ()     => ipcRenderer.send('cancel-launch'),
  killProcess:     ()     => ipcRenderer.send('kill-process'),

  onStatus:    (cb) => ipcRenderer.on('status',    (_e, v) => cb(v)),
  onProgress:  (cb) => ipcRenderer.on('progress',  (_e, v) => cb(v)),
  onMode:      (cb) => ipcRenderer.on('mode',       (_e, v) => cb(v)),
  onCancelled: (cb) => ipcRenderer.on('cancelled',  (_e, v) => cb(v)),

  getLoaderVersions: (opts) => ipcRenderer.invoke('get-loader-versions', opts),

  elybyOAuth: () => ipcRenderer.invoke('elyby-oauth'),
  msOAuth:    () => ipcRenderer.invoke('ms-oauth'),
  fetchSkin:  (opts) => ipcRenderer.invoke('fetch-skin', opts),

  searchMods:     (opts) => ipcRenderer.invoke('search-mods', opts),
  getModVersions: (opts) => ipcRenderer.invoke('get-mod-versions', opts),
  getModDetails:  (opts) => ipcRenderer.invoke('get-mod-details', opts),
  getModpackMods: (opts) => ipcRenderer.invoke('get-modpack-mods', opts),
  downloadMod:    (opts) => ipcRenderer.invoke('download-mod', opts),

  onModDownloadProgress: (cb) => ipcRenderer.on('mod-download-progress', (_e, v) => cb(v)),
  onModDownloadDone:     (cb) => ipcRenderer.on('mod-download-done',     (_e, v) => cb(v)),

  fsList:       (dirPath)  => ipcRenderer.invoke('fs-list',        dirPath),
  fsDelete:     (filePath) => ipcRenderer.invoke('fs-delete',      filePath),
  fsOpen:       (filePath) => ipcRenderer.invoke('fs-open',        filePath),
  fsOpenFolder: (dirPath)  => ipcRenderer.invoke('fs-open-folder', dirPath),
  openMpFolder: (opts)     => ipcRenderer.invoke('open-mp-folder', opts),
  fsRename:     (opts)     => ipcRenderer.invoke('fs-rename',      opts),
  fsCopyFile:   (opts)     => ipcRenderer.invoke('fs-copy-file',   opts),

  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  selectFolder: () => ipcRenderer.invoke('select-folder'),
  selectJava:   () => ipcRenderer.invoke('select-java'),

  getManifest:      ()     => ipcRenderer.invoke('get-manifest'),
  refreshMsToken:   (opts) => ipcRenderer.invoke('refresh-ms-token', opts),

  onAccountUpdated: (cb) => ipcRenderer.on('account-updated', (_e, v) => cb(v)),
});
