// Settings panel for sCloud desktop app
(async () => {
  if (!window.scloud) return; // Not in Electron

  const panel      = document.getElementById("settings-panel");
  const backdrop   = document.getElementById("settings-backdrop");
  const urlInput   = document.getElementById("server-url-input");
  const saveBtn    = document.getElementById("save-url-btn");
  const status     = document.getElementById("connection-status");
  const cacheStats = document.getElementById("cache-stats");
  const clearBtn   = document.getElementById("clear-cache-btn");
  const openBtn    = document.getElementById("open-cache-btn");
  const closeBtn   = document.getElementById("close-settings-btn");
  const settingsBtn = document.getElementById("settings-btn");

  const config = await window.scloud.getConfig();
  urlInput.value = config.serverUrl;

  settingsBtn.onclick = () => { panel.classList.remove("hidden"); refreshCacheStats(); };
  backdrop.onclick    = () => panel.classList.add("hidden");
  closeBtn.onclick    = () => panel.classList.add("hidden");

  saveBtn.onclick = async () => {
    const url = urlInput.value.trim().replace(/\/+$/, "");
    if (!url) return;
    status.textContent = "Testing connection…";
    status.className = "";
    try {
      const result = await window.scloud.apiFetch("/api/folders");
      if (result.ok) {
        await window.scloud.setServerUrl(url);
        status.textContent = "Connected! Reload to apply.";
        status.className = "status-ok";
      } else {
        status.textContent = `Failed: ${result.error}`;
        status.className = "status-err";
      }
    } catch (err) {
      status.textContent = `Error: ${err.message}`;
      status.className = "status-err";
    }
  };

  async function refreshCacheStats() {
    const stats = await window.scloud.getCacheStats();
    const mb = (stats.totalSize / 1024 / 1024).toFixed(1);
    cacheStats.textContent = `${stats.fileCount.toLocaleString()} files, ${mb} MB`;
  }

  clearBtn.onclick = async () => {
    const result = await window.scloud.clearCache();
    cacheStats.textContent = result.success ? "Cache cleared!" : `Error: ${result.error}`;
  };

  openBtn.onclick = () => window.scloud.openCacheFolder();
})();
