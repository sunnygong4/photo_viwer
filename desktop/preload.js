const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("scloud", {
  getConfig: () => ipcRenderer.invoke("get-config"),
  setServerUrl: (url) => ipcRenderer.invoke("set-server-url", url),
  getCacheStats: () => ipcRenderer.invoke("get-cache-stats"),
  clearCache: () => ipcRenderer.invoke("clear-cache"),
  openCacheFolder: () => ipcRenderer.invoke("open-cache-folder"),
  apiFetch: (path) => ipcRenderer.invoke("api-fetch", path),
  thumbFetch: (path) => ipcRenderer.invoke("thumb-fetch", path),
  photoUrl: (path) => ipcRenderer.invoke("photo-url", path),
  // Sync
  getSyncConfig: () => ipcRenderer.invoke("get-sync-config"),
  setSyncConfig: (cfg) => ipcRenderer.invoke("set-sync-config", cfg),
  pickFolder: (defaultPath) => ipcRenderer.invoke("pick-folder", defaultPath),
  startSync: () => ipcRenderer.invoke("start-sync"),
  abortSync: () => ipcRenderer.invoke("abort-sync"),
  onSyncProgress: (cb) => ipcRenderer.on("sync-progress", (_e, msg) => cb(msg)),
  offSyncProgress: () => ipcRenderer.removeAllListeners("sync-progress"),
});
