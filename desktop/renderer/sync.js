// Sync panel — compares P:\Photos (local) vs Z:\Photos (server)
(() => {
  if (!window.scloud) return;

  const syncBtn  = document.getElementById("sync-btn");
  const panel    = document.getElementById("sync-panel");
  const backdrop = document.getElementById("sync-backdrop");
  const closeBtn = document.getElementById("sync-close-btn");
  const tableBody = document.getElementById("sync-table-body");
  const summaryEl = document.getElementById("sync-summary");

  // month name → { row el, local stats, server stats, syncBtn el }
  const rows = new Map();
  let serverStats = null; // { months: [{ name, sizeBytes, fileCount }] }

  function fmtSize(b) {
    if (!b) return "—";
    if (b >= 1e9) return (b / 1e9).toFixed(1) + " GB";
    if (b >= 1e6) return (b / 1e6).toFixed(1) + " MB";
    return (b / 1e3).toFixed(0) + " KB";
  }

  function fmtCount(n) { return n ? n.toLocaleString() + " files" : "—"; }

  // Return true if local and server look matched (within 1% size, equal count)
  function isMatched(local, server) {
    if (!local || !server) return false;
    if (local.fileCount === 0) return true;
    if (local.fileCount !== server.fileCount) return false;
    const diff = Math.abs(local.sizeBytes - server.sizeBytes);
    return diff / local.sizeBytes < 0.01;
  }

  function getOrCreateRow(name) {
    if (rows.has(name)) return rows.get(name);

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="col-month">${name}</td>
      <td class="col-local"><span class="stat-loading">scanning…</span></td>
      <td class="col-server"><span class="stat-loading">loading…</span></td>
      <td class="col-action"></td>`;
    tableBody.appendChild(tr);

    const entry = { tr, local: null, server: null, syncing: false };
    rows.set(name, entry);
    return entry;
  }

  function updateRow(name) {
    const entry = rows.get(name);
    if (!entry) return;
    const { tr, local, server, syncing } = entry;

    const localTd  = tr.children[1];
    const serverTd = tr.children[2];
    const actionTd = tr.children[3];

    if (local) {
      localTd.innerHTML = `<span class="stat-size">${fmtSize(local.sizeBytes)}</span><span class="stat-count">${fmtCount(local.fileCount)}</span>`;
    }
    if (server) {
      serverTd.innerHTML = `<span class="stat-size">${fmtSize(server.sizeBytes)}</span><span class="stat-count">${fmtCount(server.fileCount)}</span>`;
    }

    // Row status
    tr.className = "";
    if (local && server) {
      if (isMatched(local, server)) {
        tr.classList.add("row-matched");
      } else if (local.fileCount > (server.fileCount || 0)) {
        tr.classList.add("row-needs-sync");
      }
    }

    // Action button
    if (!syncing && local && local.fileCount > 0) {
      const matched = server && isMatched(local, server);
      actionTd.innerHTML = matched
        ? `<span class="sync-ok">✓</span>`
        : `<button class="sync-month-btn" data-month="${name}">↑ Sync</button>`;
      const btn = actionTd.querySelector(".sync-month-btn");
      if (btn) btn.onclick = () => startMonthSync(name);
    }
  }

  function setRowSyncing(name, progressText) {
    const entry = rows.get(name);
    if (!entry) return;
    entry.syncing = true;
    const actionTd = entry.tr.children[3];
    actionTd.innerHTML = `<span class="sync-in-progress">${progressText || "syncing…"}</span>`;
    entry.tr.className = "row-syncing";
  }

  function setRowDone(name, copied, errors) {
    const entry = rows.get(name);
    if (!entry) return;
    entry.syncing = false;
    // Invalidate server stats for this month so it reloads
    if (entry.server) entry.server = null;
    const actionTd = entry.tr.children[3];
    const serverTd = entry.tr.children[2];
    actionTd.innerHTML = `<span class="sync-ok">✓ +${copied}</span>`;
    serverTd.innerHTML = `<span class="stat-loading">refreshing…</span>`;
    entry.tr.className = "row-matched";
    // Re-fetch server stats to update the server column
    fetchServerStats(true);
  }

  // ── Load server stats ──────────────────────────────────────────────
  async function fetchServerStats(refresh) {
    const qs = refresh ? "?refresh=1" : "";
    try {
      summaryEl.textContent = "Loading server stats…";
      const res = await fetch(`/api/sync-stats${qs}`);
      serverStats = await res.json();

      // Note: first call may be slow (30 min cache miss = NAS walk)
      const age = serverStats.generatedAt ? Math.round((Date.now() - serverStats.generatedAt) / 60000) : null;
      summaryEl.textContent = age !== null ? `Server data (${age}m old) — local scan running…` : "Local scan running…";

      for (const m of serverStats.months) {
        const entry = getOrCreateRow(m.name);
        entry.server = { sizeBytes: m.sizeBytes, fileCount: m.fileCount };
        updateRow(m.name);
      }
    } catch (e) {
      summaryEl.textContent = "Could not load server stats — is the server reachable?";
    }
  }

  // ── Local scan via IPC ─────────────────────────────────────────────
  async function startLocalScan() {
    window.scloud.offScanProgress();
    window.scloud.onScanProgress((msg) => {
      const entry = getOrCreateRow(msg.name);
      entry.local = { sizeBytes: msg.sizeBytes, fileCount: msg.fileCount };
      updateRow(msg.name);
    });
    const result = await window.scloud.scanLocal();
    if (!result.ok) {
      summaryEl.textContent = "Local scan error: " + result.error;
      return;
    }
    // Count mismatches
    let needsSync = 0;
    for (const [name, entry] of rows) {
      if (entry.local && entry.server && !isMatched(entry.local, entry.server) && entry.local.fileCount > entry.server.fileCount) needsSync++;
    }
    summaryEl.textContent = needsSync > 0
      ? `${needsSync} month${needsSync > 1 ? "s" : ""} need syncing.`
      : "Everything looks synced!";
  }

  // ── Per-month sync ─────────────────────────────────────────────────
  async function startMonthSync(month) {
    setRowSyncing(month, "starting…");
    window.scloud.offMonthProgress();
    window.scloud.onMonthProgress((msg) => {
      if (msg.month !== month) return;
      if (msg.phase === "day-start") {
        setRowSyncing(month, `copying ${msg.day}…`);
      } else if (msg.phase === "day-progress") {
        setRowSyncing(month, `+${msg.copied} files…`);
      } else if (msg.phase === "day-skip") {
        setRowSyncing(month, `checking days…`);
      } else if (msg.phase === "done") {
        setRowDone(month, msg.totalCopied, msg.totalErrors);
        window.scloud.offMonthProgress();
        // Re-scan local for this month to update count
        window.scloud.scanLocal();
      } else if (msg.phase === "aborted") {
        const entry = rows.get(month);
        if (entry) { entry.syncing = false; updateRow(month); }
        window.scloud.offMonthProgress();
      }
    });
    const result = await window.scloud.syncMonth(month);
    if (!result.ok) {
      const entry = rows.get(month);
      if (entry) {
        entry.syncing = false;
        entry.tr.children[3].innerHTML = `<span class="sync-error">Error</span>`;
      }
    }
  }

  // ── Open / close panel ─────────────────────────────────────────────
  function openPanel() {
    panel.classList.remove("hidden");
    tableBody.innerHTML = "";
    rows.clear();
    serverStats = null;
    summaryEl.textContent = "Loading…";
    summaryEl.style.color = "";
    // Kick off both in parallel
    fetchServerStats(false);
    startLocalScan();
  }

  function closePanel() {
    panel.classList.add("hidden");
    window.scloud.offScanProgress();
    window.scloud.offMonthProgress();
  }

  syncBtn.onclick = openPanel;
  backdrop.onclick = closePanel;
  closeBtn.onclick = closePanel;
})();
