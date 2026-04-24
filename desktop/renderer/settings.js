// Settings panels for sCloud desktop app
(async () => {
  if (!window.scloud) return; // Not in Electron

  // ── sCloud Settings (gear button) ─────────────────────────────────
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

  // ── Sync / SSH Settings (opened from sync panel ⚙ SSH button) ─────
  const sshPanel      = document.getElementById("ssh-settings-panel");
  const sshBackdrop   = document.getElementById("ssh-settings-backdrop");
  const sshCloseBtn   = document.getElementById("close-ssh-settings-btn");
  const syncSshBtn    = document.getElementById("sync-ssh-settings-btn");

  const sshHost     = document.getElementById("ssh-host");
  const sshPort     = document.getElementById("ssh-port");
  const sshUser     = document.getElementById("ssh-user");
  const sshPassword = document.getElementById("ssh-password");
  const sshKey      = document.getElementById("ssh-key");
  const sshRemote   = document.getElementById("ssh-remote-path");
  const sshSaveBtn  = document.getElementById("ssh-save-btn");
  const sshTestBtn  = document.getElementById("ssh-test-btn");
  const sshStatus   = document.getElementById("ssh-status");

  async function openSshSettings() {
    const sshCfg = await window.scloud.getSshConfig();
    sshHost.value     = sshCfg.host       || "";
    sshPort.value     = sshCfg.port       || "22";
    sshUser.value     = sshCfg.user       || "";
    sshPassword.value = sshCfg.password   || "";
    sshKey.value      = sshCfg.keyPath    || "";
    sshRemote.value   = sshCfg.remotePath || "/mnt/nas/Photos";
    sshStatus.textContent = "";
    sshStatus.className = "";
    sshPanel.classList.remove("hidden");
  }

  function collectSshCfg() {
    return {
      host:       sshHost.value.trim(),
      port:       sshPort.value.trim() || "22",
      user:       sshUser.value.trim(),
      password:   sshPassword.value,
      keyPath:    sshKey.value.trim(),
      remotePath: sshRemote.value.trim() || "/mnt/nas/Photos",
    };
  }

  if (syncSshBtn) syncSshBtn.onclick = openSshSettings;
  if (sshBackdrop) sshBackdrop.onclick = () => sshPanel.classList.add("hidden");
  if (sshCloseBtn) sshCloseBtn.onclick = () => sshPanel.classList.add("hidden");

  sshSaveBtn.onclick = async () => {
    await window.scloud.setSshConfig(collectSshCfg());
    sshStatus.textContent = "✓ Saved!";
    sshStatus.className = "status-ok";
    setTimeout(() => { sshStatus.textContent = ""; sshStatus.className = ""; }, 2000);
  };

  sshTestBtn.onclick = async () => {
    sshStatus.textContent = "Connecting…";
    sshStatus.className = "";
    await window.scloud.setSshConfig(collectSshCfg());
    const result = await window.scloud.testSsh();
    if (result.ok) {
      sshStatus.textContent = "✓ Connected successfully!";
      sshStatus.className = "status-ok";
    } else {
      sshStatus.textContent = "✗ " + result.error;
      sshStatus.className = "status-err";
    }
  };
})();
