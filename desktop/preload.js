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
  scanLocalMonth: (month) => ipcRenderer.invoke("scan-local-month", { month }),
  syncMonth: (month) => ipcRenderer.invoke("sync-month", { month }),
  syncDay: (month, day) => ipcRenderer.invoke("sync-day", { month, day }),
  abortSync: () => ipcRenderer.invoke("abort-sync"),
  onScanProgress: (cb) => ipcRenderer.on("scan-local-progress", (_e, msg) => cb(msg)),
  offScanProgress: () => ipcRenderer.removeAllListeners("scan-local-progress"),
  onScanMonthProgress: (cb) => ipcRenderer.on("scan-local-month-progress", (_e, msg) => cb(msg)),
  offScanMonthProgress: () => ipcRenderer.removeAllListeners("scan-local-month-progress"),
  onMonthProgress: (cb) => ipcRenderer.on("sync-month-progress", (_e, msg) => cb(msg)),
  offMonthProgress: () => ipcRenderer.removeAllListeners("sync-month-progress"),
  onDayProgress: (cb) => ipcRenderer.on("sync-day-progress", (_e, msg) => cb(msg)),
  offDayProgress: () => ipcRenderer.removeAllListeners("sync-day-progress"),
});
