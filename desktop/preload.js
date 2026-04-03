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
  scanLocal: () => ipcRenderer.invoke("scan-local"),
  syncMonth: (month) => ipcRenderer.invoke("sync-month", { month }),
  abortSync: () => ipcRenderer.invoke("abort-sync"),
  onScanProgress: (cb) => ipcRenderer.on("scan-local-progress", (_e, msg) => cb(msg)),
  offScanProgress: () => ipcRenderer.removeAllListeners("scan-local-progress"),
  onMonthProgress: (cb) => ipcRenderer.on("sync-month-progress", (_e, msg) => cb(msg)),
  offMonthProgress: () => ipcRenderer.removeAllListeners("sync-month-progress"),
});
