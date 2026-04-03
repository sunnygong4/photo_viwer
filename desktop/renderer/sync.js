// Sync panel for sCloud — P:\Photos → Z:\Photos
(() => {
  if (!window.scloud) return;

  const syncBtn      = document.getElementById("sync-btn");
  const panel        = document.getElementById("sync-panel");
  const backdrop     = document.getElementById("sync-backdrop");
  const startBtn     = document.getElementById("sync-start-btn");
  const abortBtn     = document.getElementById("sync-abort-btn");
  const closeBtn     = document.getElementById("sync-close-btn");
  const summaryEl    = document.getElementById("sync-summary");
  const logEl        = document.getElementById("sync-log");
  const overallBar   = document.getElementById("sync-overall-bar");
  const overallWrap  = document.getElementById("sync-overall-bar-wrap");

  let syncing = false;
  // Track month rows by name so we can update them in-place
  const monthRows = new Map();

  function openPanel() {
    panel.classList.remove("hidden");
  }

  function closePanel() {
    if (syncing) return; // don't close while running
    panel.classList.add("hidden");
  }

  syncBtn.onclick = openPanel;
  backdrop.onclick = closePanel;
  closeBtn.onclick = closePanel;

  function fmtSize(bytes) {
    if (!bytes) return "—";
    if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + " GB";
    if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + " MB";
    return (bytes / 1e3).toFixed(0) + " KB";
  }

  // Add or update a month row in the log
  function setMonthRow(month, icon, detail, cls) {
    let row = monthRows.get(month);
    if (!row) {
      row = document.createElement("div");
      row.className = "sync-row";
      logEl.appendChild(row);
      monthRows.set(month, row);
    }
    row.className = "sync-row" + (cls ? " " + cls : "");
    row.innerHTML = `<span class="sync-row-icon">${icon}</span><span class="sync-row-name">${month}</span><span class="sync-row-detail">${detail}</span>`;
    // Auto-scroll to latest
    row.scrollIntoView({ block: "nearest" });
  }

  startBtn.onclick = async () => {
    if (syncing) return;
    syncing = true;
    startBtn.disabled = true;
    abortBtn.classList.remove("hidden");
    closeBtn.disabled = true;
    logEl.innerHTML = "";
    monthRows.clear();
    overallWrap.classList.remove("hidden");
    overallBar.style.width = "0%";
    overallBar.style.background = "#4caf50";
    summaryEl.textContent = "Starting…";

    window.scloud.offSyncProgress();
    window.scloud.onSyncProgress((msg) => {
      const { phase, month, message } = msg;

      if (phase === "checking") {
        setMonthRow(month, "⏳", "checking…", "row-checking");
        summaryEl.textContent = message;

      } else if (phase === "month-skip") {
        setMonthRow(month, "✓", fmtSize(msg.srcSize) + " — matched", "row-skip");

      } else if (phase === "month-diff") {
        setMonthRow(month, "↑", `${fmtSize(msg.srcSize)} src / ${fmtSize(msg.destSize)} dest`, "row-diff");

      } else if (phase === "day-skip") {
        // Update month row to show day activity
        const row = monthRows.get(month);
        if (row) {
          const detail = row.querySelector(".sync-row-detail");
          if (detail) detail.textContent = `↑ checking days… ${msg.day} ✓`;
        }

      } else if (phase === "day-sync") {
        const row = monthRows.get(month);
        if (row) {
          const detail = row.querySelector(".sync-row-detail");
          if (detail) detail.textContent = `↑ copying ${msg.day}…`;
        }

      } else if (phase === "day-done") {
        const row = monthRows.get(month);
        if (row) {
          const detail = row.querySelector(".sync-row-detail");
          if (detail) detail.textContent = `↑ ${msg.day} +${msg.copied} files`;
        }

      } else if (phase === "done") {
        overallBar.style.width = "100%";
        summaryEl.textContent = message;
        summaryEl.style.color = "#4caf50";
        finishSync(false);

      } else if (phase === "aborted") {
        overallBar.style.width = "100%";
        overallBar.style.background = "#ff9800";
        summaryEl.textContent = message;
        summaryEl.style.color = "#ff9800";
        finishSync(false);
      }

      // Pulse the bar while running
      if (!["done","aborted"].includes(phase)) {
        overallBar.classList.add("pulse");
      }
    });

    const result = await window.scloud.startSync();
    if (!result.ok) {
      summaryEl.textContent = "Error: " + result.error;
      summaryEl.style.color = "#f44336";
      finishSync(false);
    }
  };

  abortBtn.onclick = () => {
    window.scloud.abortSync();
    summaryEl.textContent = "Stopping…";
  };

  function finishSync() {
    syncing = false;
    startBtn.disabled = false;
    abortBtn.classList.add("hidden");
    closeBtn.disabled = false;
    overallBar.classList.remove("pulse");
    window.scloud.offSyncProgress();
  }
})();
