// Settings panel for sCloud desktop app
(async () => {
  if (!window.scloud) return; // Not in Electron

  const panel = document.getElementById("settings-panel");
  const backdrop = document.getElementById("settings-backdrop");
  const urlInput = document.getElementById("server-url-input");
  const saveBtn = document.getElementById("save-url-btn");
  const status = document.getElementById("connection-status");
  const cacheStats = document.getElementById("cache-stats");
  const clearBtn = document.getElementById("clear-cache-btn");
  const openBtn = document.getElementById("open-cache-btn");
  const closeBtn = document.getElementById("close-settings-btn");
  const settingsBtn = document.getElementById("settings-btn");

  // Load current config
  const config = await window.scloud.getConfig();
  urlInput.value = config.serverUrl;

  settingsBtn.onclick = () => {
    panel.classList.remove("hidden");
    refreshCacheStats();
  };

  backdrop.onclick = () => panel.classList.add("hidden");
  closeBtn.onclick = () => panel.classList.add("hidden");

  saveBtn.onclick = async () => {
    const url = urlInput.value.trim().replace(/\/+$/, "");
    if (!url) return;
    status.textContent = "Testing connection...";
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
    if (result.success) {
      cacheStats.textContent = "Cache cleared!";
    } else {
      cacheStats.textContent = `Error: ${result.error}`;
    }
  };

  openBtn.onclick = () => window.scloud.openCacheFolder();

  // ── Sync ────────────────────────────────────────────────
  const syncSourceInput = document.getElementById("sync-source-input");
  const syncDestInput   = document.getElementById("sync-dest-input");
  const pickSourceBtn   = document.getElementById("pick-source-btn");
  const pickDestBtn     = document.getElementById("pick-dest-btn");
  const syncSaveBtn     = document.getElementById("sync-save-btn");
  const syncStartBtn    = document.getElementById("sync-start-btn");
  const syncAbortBtn    = document.getElementById("sync-abort-btn");
  const syncStatus      = document.getElementById("sync-status");
  const syncProgressWrap = document.getElementById("sync-progress-bar-wrap");
  const syncProgressBar  = document.getElementById("sync-progress-bar");

  // Load saved sync paths
  const syncCfg = await window.scloud.getSyncConfig();
  syncSourceInput.value = syncCfg.syncSource || "P:\\Photos";
  syncDestInput.value   = syncCfg.syncDest   || "";

  pickSourceBtn.onclick = async () => {
    const folder = await window.scloud.pickFolder(syncSourceInput.value);
    if (folder) syncSourceInput.value = folder;
  };

  pickDestBtn.onclick = async () => {
    const folder = await window.scloud.pickFolder(syncDestInput.value);
    if (folder) syncDestInput.value = folder;
  };

  syncSaveBtn.onclick = async () => {
    await window.scloud.setSyncConfig({
      syncSource: syncSourceInput.value.trim(),
      syncDest:   syncDestInput.value.trim(),
    });
    syncStatus.textContent = "Paths saved.";
    setTimeout(() => { syncStatus.textContent = ""; }, 2000);
  };

  let syncing = false;

  syncStartBtn.onclick = async () => {
    if (syncing) return;
    // Auto-save paths before starting
    await window.scloud.setSyncConfig({
      syncSource: syncSourceInput.value.trim(),
      syncDest:   syncDestInput.value.trim(),
    });

    syncing = true;
    syncStartBtn.disabled = true;
    syncAbortBtn.classList.remove("hidden");
    syncProgressWrap.classList.remove("hidden");
    syncProgressBar.style.width = "0%";
    syncStatus.textContent = "Starting sync...";

    window.scloud.offSyncProgress();
    window.scloud.onSyncProgress((msg) => {
      syncStatus.textContent = msg.message;
      if (msg.total && msg.total > 0) {
        const pct = Math.round(((msg.copied + msg.skipped + msg.errors) / msg.total) * 100);
        syncProgressBar.style.width = pct + "%";
      }
      if (msg.phase === "done" || msg.phase === "aborted") {
        syncProgressBar.style.width = "100%";
        syncProgressBar.style.background = msg.phase === "done" ? "#4caf50" : "#ff9800";
        finishSync();
      }
    });

    const result = await window.scloud.startSync();
    if (!result.ok) {
      syncStatus.textContent = "Error: " + result.error;
      finishSync();
    }
  };

  syncAbortBtn.onclick = () => {
    window.scloud.abortSync();
    syncStatus.textContent = "Stopping...";
  };

  function finishSync() {
    syncing = false;
    syncStartBtn.disabled = false;
    syncAbortBtn.classList.add("hidden");
    window.scloud.offSyncProgress();
  }
})();
