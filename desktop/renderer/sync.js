// Sync panel — P:\Photos vs Z:\Photos with expandable day breakdown
(() => {
  if (!window.scloud) return;

  const syncBtn   = document.getElementById("sync-btn");
  const panel     = document.getElementById("sync-panel");
  const backdrop  = document.getElementById("sync-backdrop");
  const closeBtn  = document.getElementById("sync-close-btn");
  const tableBody = document.getElementById("sync-table-body");
  const summaryEl = document.getElementById("sync-summary");

  // month → { monthTr, local, server, expanded, dayRows: Map<dayName, {tr, local, server}> }
  const months = new Map();

  function fmtSize(b) {
    if (!b) return "—";
    if (b >= 1e9) return (b / 1e9).toFixed(2) + " GB";
    if (b >= 1e6) return (b / 1e6).toFixed(1) + " MB";
    return Math.round(b / 1e3) + " KB";
  }
  function fmtCount(n) { return n != null ? n.toLocaleString() + " files" : "—"; }

  function isMatched(local, server) {
    if (!local || !server) return false;
    if (local.fileCount === 0) return true;
    if (local.fileCount !== server.fileCount) return false;
    return Math.abs(local.sizeBytes - server.sizeBytes) / local.sizeBytes < 0.01;
  }

  function statCell(stats, loading) {
    if (loading) return `<span class="stat-loading">${loading}</span>`;
    if (!stats) return `<span class="stat-loading">—</span>`;
    return `<span class="stat-size">${fmtSize(stats.sizeBytes)}</span><span class="stat-count">${fmtCount(stats.fileCount)}</span>`;
  }

  // ── Month rows ─────────────────────────────────────────────────────
  function getOrCreateMonthRow(name) {
    if (months.has(name)) return months.get(name);
    const tr = document.createElement("tr");
    tr.className = "month-row";
    tr.dataset.month = name;
    tr.innerHTML = `
      <td class="col-toggle"><span class="toggle-icon">▶</span></td>
      <td class="col-month">${name}</td>
      <td class="col-local"><span class="stat-loading">scanning…</span></td>
      <td class="col-server"><span class="stat-loading">loading…</span></td>
      <td class="col-action"></td>`;
    tableBody.appendChild(tr);

    const entry = { monthTr: tr, local: null, server: null, expanded: false, dayRows: new Map(), syncing: false };
    months.set(name, entry);

    tr.querySelector(".col-toggle, .col-month").addEventListener("click", () => toggleExpand(name));
    tr.querySelector(".col-toggle").style.cursor = "pointer";
    tr.querySelector(".col-month").style.cursor = "pointer";
    return entry;
  }

  function updateMonthRow(name) {
    const entry = months.get(name);
    if (!entry || entry.syncing) return;
    const { monthTr, local, server } = entry;

    // Local cell — N/A (green) if month doesn't exist on P:\
    if (local && local.notOnLocal) {
      monthTr.children[2].innerHTML = `<span class="stat-na">N/A</span>`;
    } else {
      monthTr.children[2].innerHTML = statCell(local, local ? null : "scanning…");
    }
    monthTr.children[3].innerHTML = statCell(server, server ? null : "loading…");

    // Row color
    monthTr.className = "month-row";
    if (local && local.notOnLocal) {
      monthTr.classList.add("row-na");
    } else if (local && server) {
      if (isMatched(local, server)) monthTr.classList.add("row-matched");
      else if (local.fileCount > (server.fileCount || 0)) monthTr.classList.add("row-needs-sync");
    }

    // Action button
    const actionTd = monthTr.children[4];
    if (local && local.notOnLocal) {
      actionTd.innerHTML = ""; // no sync needed
    } else if (local && local.fileCount > 0) {
      const matched = server && isMatched(local, server);
      if (matched) {
        actionTd.innerHTML = `<span class="sync-ok">✓</span>`;
      } else {
        const serverExtra = server && server.fileCount > local.fileCount;
        const missing = server ? (local.fileCount - server.fileCount) : local.fileCount;
        let html = "";
        if (missing > 0) {
          html += `<button class="sync-month-btn" data-month="${name}">↑ ${missing} files</button>`;
        } else if (!matched) {
          html += `<button class="sync-month-btn" data-month="${name}">↑ Sync</button>`;
        }
        if (serverExtra) {
          const extras = server.fileCount - local.fileCount;
          html += `<button class="sync-clean-btn" data-month="${name}" title="Delete ${extras} server-only files not on local disk">🗑 ${extras} extra</button>`;
        }
        actionTd.innerHTML = html;
        const syncBtn  = actionTd.querySelector(".sync-month-btn");
        const cleanBtn = actionTd.querySelector(".sync-clean-btn");
        if (syncBtn)  syncBtn.onclick  = (e) => { e.stopPropagation(); startMonthSync(name); };
        if (cleanBtn) cleanBtn.onclick = (e) => { e.stopPropagation(); startServerClean(name); };
      }
    }
  }

  // ── Day rows ───────────────────────────────────────────────────────
  function getOrCreateDayRow(monthName, dayName) {
    const entry = months.get(monthName);
    if (!entry) return null;
    if (entry.dayRows.has(dayName)) return entry.dayRows.get(dayName);

    const tr = document.createElement("tr");
    tr.className = "day-row";
    tr.dataset.month = monthName;
    tr.dataset.day = dayName;
    if (!entry.expanded) tr.classList.add("hidden");
    tr.innerHTML = `
      <td class="col-toggle"></td>
      <td class="col-month day-name">└ ${dayName}</td>
      <td class="col-local"><span class="stat-loading">…</span></td>
      <td class="col-server"><span class="stat-loading">…</span></td>
      <td class="col-action"></td>`;

    // Insert after last existing day row for this month, or after month row
    const siblings = [...entry.dayRows.values()];
    const insertAfter = siblings.length > 0 ? siblings[siblings.length - 1].tr : entry.monthTr;
    insertAfter.insertAdjacentElement("afterend", tr);

    const dayEntry = { tr, local: null, server: null };
    entry.dayRows.set(dayName, dayEntry);
    return dayEntry;
  }

  function updateDayRow(monthName, dayName) {
    const entry = months.get(monthName);
    if (!entry) return;
    const dayEntry = entry.dayRows.get(dayName);
    if (!dayEntry) return;
    const { tr, local, server } = dayEntry;

    tr.children[2].innerHTML = statCell(local, local ? null : "…");
    tr.children[3].innerHTML = statCell(server, server ? null : "…");

    tr.className = "day-row" + (entry.expanded ? "" : " hidden");
    if (local && server) {
      if (isMatched(local, server)) tr.classList.add("day-matched");
      else if (local.fileCount > (server.fileCount || 0)) tr.classList.add("day-needs-sync");
    }

    const actionTd = tr.children[4];
    if (local && local.fileCount > 0 && dayName !== "(root)") {
      const matched = server && isMatched(local, server);
      actionTd.innerHTML = matched
        ? `<span class="sync-ok sync-ok-sm">✓</span>`
        : `<button class="sync-day-btn">↑</button>`;
      const btn = actionTd.querySelector(".sync-day-btn");
      if (btn) btn.onclick = () => startDaySync(monthName, dayName);
    }
  }

  // ── Expand / collapse ──────────────────────────────────────────────
  function toggleExpand(name) {
    const entry = months.get(name);
    if (!entry) return;
    entry.expanded = !entry.expanded;
    const icon = entry.monthTr.querySelector(".toggle-icon");
    if (icon) icon.textContent = entry.expanded ? "▼" : "▶";

    // Show/hide existing day rows
    for (const dayEntry of entry.dayRows.values()) {
      dayEntry.tr.classList.toggle("hidden", !entry.expanded);
    }

    // If expanding for first time, load day data
    if (entry.expanded && entry.dayRows.size === 0) {
      loadDayData(name);
    }
  }

  async function loadDayData(monthName) {
    // Fetch server day stats
    try {
      const res = await fetch(`/api/sync-stats/${monthName}`);
      const data = await res.json();
      for (const d of (data.days || [])) {
        const dayEntry = getOrCreateDayRow(monthName, d.name);
        if (dayEntry) { dayEntry.server = { sizeBytes: d.sizeBytes, fileCount: d.fileCount }; updateDayRow(monthName, d.name); }
      }
    } catch {}

    // Local day scan via IPC
    window.scloud.offScanMonthProgress();
    window.scloud.onScanMonthProgress((msg) => {
      const dayEntry = getOrCreateDayRow(monthName, msg.name);
      if (dayEntry) { dayEntry.local = { sizeBytes: msg.sizeBytes, fileCount: msg.fileCount }; updateDayRow(monthName, msg.name); }
    });
    await window.scloud.scanLocalMonth(monthName);
    window.scloud.offScanMonthProgress();
  }

  // ── Month-level sync ───────────────────────────────────────────────
  function fmtBytes(b) {
    if (b == null || isNaN(b)) return "—";
    if (b >= 1e9) return (b / 1e9).toFixed(2) + " GB";
    if (b >= 1e6) return (b / 1e6).toFixed(1) + " MB";
    if (b >= 1e3) return (b / 1e3).toFixed(0) + " KB";
    return b + " B";
  }
  function fmtSpeed(bps) {
    if (!bps || bps < 0) return "";
    return fmtBytes(bps) + "/s";
  }
  function fmtEta(secs) {
    if (!isFinite(secs) || secs < 0) return "";
    if (secs < 60) return `${Math.ceil(secs)}s`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m ${Math.ceil(secs % 60)}s`;
    return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
  }

  async function startMonthSync(month) {
    const entry = months.get(month);
    if (!entry || entry.syncing) return;
    entry.syncing = true;

    const actionTd = entry.monthTr.children[4];
    entry.monthTr.className = "month-row row-syncing";

    // Insert a progress row directly below the month row
    const progRow = document.createElement("tr");
    progRow.className = "sync-progress-row";
    progRow.innerHTML = `<td colspan="5"><div class="sync-progress-panel">
      <div class="spp-bar-wrap"><div class="spp-bar" id="spp-bar-${month}"></div></div>
      <div class="spp-details">
        <span class="spp-day" id="spp-day-${month}">Connecting…</span>
        <span class="spp-files" id="spp-files-${month}"></span>
        <span class="spp-speed" id="spp-speed-${month}"></span>
        <span class="spp-eta" id="spp-eta-${month}"></span>
      </div>
      <div class="spp-file" id="spp-file-${month}"></div>
    </div></td>`;
    entry.monthTr.after(progRow);

    const barEl   = () => document.getElementById(`spp-bar-${month}`);
    const dayEl   = () => document.getElementById(`spp-day-${month}`);
    const filesEl = () => document.getElementById(`spp-files-${month}`);
    const speedEl = () => document.getElementById(`spp-speed-${month}`);
    const etaEl   = () => document.getElementById(`spp-eta-${month}`);
    const fileEl  = () => document.getElementById(`spp-file-${month}`);

    let startTime = null, totalBytesToSync = 0;

    window.scloud.offMonthProgress();
    window.scloud.onMonthProgress((msg) => {
      if (msg.month !== month) return;

      if (msg.phase === "queued") {
        dayEl() && (dayEl().textContent = "⏳ Queued — waiting for another sync to finish…");
        actionTd.innerHTML = `<span class="sync-in-progress">queued</span>`;

      } else if (msg.phase === "connecting") {
        dayEl() && (dayEl().textContent = "🔌 Connecting to server…");
        actionTd.innerHTML = `<span class="sync-in-progress">connecting…</span>`;

      } else if (msg.phase === "scanning") {
        dayEl() && (dayEl().textContent = "Scanning days…");

      } else if (msg.phase === "start") {
        startTime = Date.now();
        totalBytesToSync = msg.totalBytesToSync || 0;
        actionTd.innerHTML = `<span class="sync-in-progress">uploading…</span>`;
        dayEl() && (dayEl().textContent = `0 / ${msg.totalFilesToSync} files`);

      } else if (msg.phase === "day-start") {
        dayEl() && (dayEl().textContent = `📁 ${msg.day}  (${msg.filesNeeded} new files)`);
        fileEl() && (fileEl().textContent = "");

      } else if (msg.phase === "day-skip") {
        dayEl() && (dayEl().textContent = `✓ ${msg.day} — already synced`);

      } else if (msg.phase === "day-progress") {
        const elapsed = (Date.now() - startTime) / 1000;
        const bps     = elapsed > 0.5 ? msg.totalBytes / elapsed : 0;
        const remain  = bps > 0 ? (msg.totalBytesToSync - msg.totalBytes) / bps : 0;
        const pct     = msg.totalBytesToSync > 0
          ? Math.min(100, (msg.totalBytes / msg.totalBytesToSync) * 100) : 0;

        barEl()   && (barEl().style.width = pct.toFixed(1) + "%");
        filesEl() && (filesEl().textContent = `${msg.totalCopied} files · ${fmtBytes(msg.totalBytes)} / ${fmtBytes(msg.totalBytesToSync)}`);
        speedEl() && (speedEl().textContent = fmtSpeed(bps));
        etaEl()   && (etaEl().textContent   = remain > 0 ? `ETA ${fmtEta(remain)}` : "");
        fileEl()  && (fileEl().textContent  = msg.filename || "");
        actionTd.innerHTML = `<span class="sync-in-progress">${pct.toFixed(0)}%</span>`;

      } else if (msg.phase === "done") {
        entry.syncing = false;
        progRow.remove();
        if (msg.refreshedLocal) entry.local = msg.refreshedLocal;
        entry.server = null;
        entry.monthTr.children[3].innerHTML = `<span class="stat-loading">refreshing…</span>`;
        actionTd.innerHTML = `<span class="sync-ok">✓ +${msg.totalCopied} files</span>`;
        window.scloud.offMonthProgress();
        refreshMonthServerStats(month);
        if (entry.expanded) { entry.dayRows.clear(); loadDayData(month); }

      } else if (msg.phase === "aborted") {
        entry.syncing = false;
        progRow.remove();
        updateMonthRow(month);
        window.scloud.offMonthProgress();
      }
    });

    const result = await window.scloud.syncMonth(month);
    if (!result.ok) {
      entry.syncing = false;
      progRow.remove();
      actionTd.innerHTML = `<span class="sync-error">${result.error}</span>`;
    }
  }

  async function refreshMonthServerStats(month) {
    try {
      const res = await fetch(`/api/sync-stats/${month}?refresh=1`);
      const data = await res.json();
      // Sum day stats to get month total
      let sizeBytes = 0, fileCount = 0;
      for (const d of (data.days || [])) { sizeBytes += d.sizeBytes; fileCount += d.fileCount; }
      const entry = months.get(month);
      if (entry) { entry.server = { sizeBytes, fileCount }; updateMonthRow(month); }
    } catch {}
  }

  // ── Server cleanup (delete server-only files not on local) ─────────
  async function startServerClean(month) {
    const entry = months.get(month);
    if (!entry || entry.syncing) return;
    const actionTd = entry.monthTr.children[4];
    actionTd.innerHTML = `<span class="sync-in-progress">scanning server…</span>`;

    const result = await window.scloud.findServerExtras(month);
    if (!result.ok) {
      actionTd.innerHTML = `<span class="sync-error">${result.error}</span>`;
      setTimeout(() => updateMonthRow(month), 4000);
      return;
    }
    if (result.extras.length === 0) {
      actionTd.innerHTML = `<span class="sync-ok">✓ Nothing to clean</span>`;
      setTimeout(() => updateMonthRow(month), 3000);
      return;
    }

    // Show confirmation modal
    const totalSize = result.extras.reduce((s, f) => s + f.size, 0);
    const modal = document.createElement("div");
    modal.className = "clean-modal-overlay";
    modal.innerHTML = `
      <div class="clean-modal">
        <h3>⚠️ Delete ${result.extras.length} server-only files?</h3>
        <p>These files exist on the server for <strong>${month}</strong> but are <strong>not on your local P:\\ drive</strong>.</p>
        <p>Total: <strong>${fmtBytes(totalSize)}</strong> in ${result.extras.length} files</p>
        <div class="clean-modal-list">
          ${result.extras.slice(0, 50).map(f => `<div class="clean-modal-file">🗑 ${f.relPath} <span>${fmtBytes(f.size)}</span></div>`).join("")}
          ${result.extras.length > 50 ? `<div class="clean-modal-file" style="color:#888">… and ${result.extras.length - 50} more</div>` : ""}
        </div>
        <p style="color:#ff8a65;font-size:12px">This cannot be undone. These files will be permanently deleted from the server.</p>
        <div class="clean-modal-actions">
          <button class="clean-cancel-btn">Cancel</button>
          <button class="clean-confirm-btn">Delete ${result.extras.length} files</button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    await new Promise(resolve => {
      modal.querySelector(".clean-cancel-btn").onclick = () => { modal.remove(); updateMonthRow(month); resolve(); };
      modal.querySelector(".clean-confirm-btn").onclick = async () => {
        modal.remove();
        entry.syncing = true;
        actionTd.innerHTML = `<span class="sync-in-progress">deleting…</span>`;
        const del = await window.scloud.deleteServerExtras(result.extras.map(f => f.remotePath));
        entry.syncing = false;
        if (del.ok) {
          actionTd.innerHTML = `<span class="sync-ok">✓ Deleted ${del.deleted}</span>`;
          entry.server = null;
          entry.monthTr.children[3].innerHTML = `<span class="stat-loading">refreshing…</span>`;
          refreshMonthServerStats(month);
        } else {
          actionTd.innerHTML = `<span class="sync-error">${del.error}</span>`;
          setTimeout(() => updateMonthRow(month), 4000);
        }
        resolve();
      };
    });
  }

  // ── Day-level sync ─────────────────────────────────────────────────
  async function startDaySync(month, day) {
    const entry = months.get(month);
    const dayEntry = entry?.dayRows.get(day);
    if (!dayEntry) return;

    dayEntry.tr.children[4].innerHTML = `<span class="sync-in-progress">copying…</span>`;
    dayEntry.tr.className = "day-row day-syncing";

    window.scloud.offDayProgress();
    window.scloud.onDayProgress((msg) => {
      if (msg.month !== month || msg.day !== day) return;
      if (msg.phase === "progress") {
        dayEntry.tr.children[4].innerHTML = `<span class="sync-in-progress">+${msg.copied}</span>`;
      } else if (msg.phase === "done") {
        dayEntry.tr.children[4].innerHTML = `<span class="sync-ok sync-ok-sm">✓ +${msg.copied}</span>`;
        dayEntry.tr.className = "day-row day-matched";
        window.scloud.offDayProgress();
        // Refresh day server stats
        fetch(`/api/sync-stats/${month}?refresh=1`).then(r => r.json()).then(data => {
          const d = data.days?.find(d => d.name === day);
          if (d) { dayEntry.server = { sizeBytes: d.sizeBytes, fileCount: d.fileCount }; updateDayRow(month, day); }
          // Also update month total
          refreshMonthServerStats(month);
        }).catch(() => {});
      }
    });

    await window.scloud.syncDay(month, day);
  }

  // ── Server stats (full) ────────────────────────────────────────────
  async function fetchServerStats() {
    try {
      summaryEl.textContent = "Loading server stats… (may take a moment on first load)";
      const res = await fetch("/api/sync-stats");
      const data = await res.json();
      const age = data.generatedAt ? Math.round((Date.now() - data.generatedAt) / 60000) : 0;
      summaryEl.textContent = `Server data (${age}m old) — local scan running…`;
      for (const m of (data.months || [])) {
        const entry = getOrCreateMonthRow(m.name);
        entry.server = { sizeBytes: m.sizeBytes, fileCount: m.fileCount };
        updateMonthRow(m.name);
      }
    } catch {
      summaryEl.textContent = "Could not reach server.";
    }
  }

  // ── Local full scan ────────────────────────────────────────────────
  async function startLocalScan() {
    const scannedLocally = new Set();
    window.scloud.offScanProgress();
    window.scloud.onScanProgress((msg) => {
      scannedLocally.add(msg.name);
      const entry = getOrCreateMonthRow(msg.name);
      entry.local = { sizeBytes: msg.sizeBytes, fileCount: msg.fileCount };
      updateMonthRow(msg.name);
    });
    const result = await window.scloud.scanLocal();
    window.scloud.offScanProgress();
    if (!result.ok) { summaryEl.textContent = "Local scan error: " + result.error; return; }

    // Any month the server knows about but not on P:\ → mark N/A (green)
    for (const [name, entry] of months) {
      if (!scannedLocally.has(name) && entry.local === null) {
        entry.local = { sizeBytes: 0, fileCount: 0, notOnLocal: true };
        updateMonthRow(name);
      }
    }

    let needsSync = 0;
    for (const [, entry] of months) {
      if (entry.local && !entry.local.notOnLocal && entry.server &&
          !isMatched(entry.local, entry.server) && entry.local.fileCount > (entry.server.fileCount || 0)) needsSync++;
    }
    summaryEl.textContent = needsSync > 0
      ? `${needsSync} month${needsSync !== 1 ? "s" : ""} need syncing. Click a month row to see day breakdown.`
      : "All months synced! Click a month to inspect days.";
  }

  // ── Open / close ───────────────────────────────────────────────────
  function openPanel() {
    panel.classList.remove("hidden");
    tableBody.innerHTML = "";
    months.clear();
    summaryEl.textContent = "Loading…";
    fetchServerStats();
    startLocalScan();
  }

  function closePanel() {
    panel.classList.add("hidden");
    window.scloud.offScanProgress();
    window.scloud.offScanMonthProgress();
    window.scloud.offMonthProgress();
    window.scloud.offDayProgress();
  }

  syncBtn.onclick = openPanel;
  backdrop.onclick = closePanel;
  closeBtn.onclick = closePanel;
})();
