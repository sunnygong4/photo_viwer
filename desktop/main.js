const { app, BrowserWindow, protocol, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");

// Default server URL — can be changed in settings
const CONFIG_PATH = path.join(app.getPath("userData"), "config.json");
const CACHE_DIR = path.join(app.getPath("userData"), "thumbcache");

const SYNC_EXTS = new Set([
  ".jpg", ".jpeg", ".heic", ".heif",
  ".cr2", ".cr3", ".nef", ".arw", ".raw", ".dng",
  ".rw2", ".orf", ".raf", ".rwl", ".pef", ".srw"
]);

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {
      serverUrl: "https://photos.sunnygong.com",
      syncSource: "P:\\Photos",
      syncDest: "",
    };
  }
}

function saveConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// Force dedicated GPU (NVIDIA/AMD) instead of integrated graphics
app.commandLine.appendSwitch("force_high_performance_gpu");

let config = loadConfig();
let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: "sCloud",
    backgroundColor: "#1a1a1a",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  // Open devtools in dev mode
  if (process.argv.includes("--dev")) {
    mainWindow.webContents.openDevTools();
  }
}

// Fetch a URL and return the buffer
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { timeout: 30000 }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

// IPC handlers
ipcMain.handle("get-config", () => config);

ipcMain.handle("set-server-url", (_event, url) => {
  config.serverUrl = url.replace(/\/+$/, "");
  saveConfig(config);
  return config;
});

ipcMain.handle("get-cache-stats", async () => {
  try {
    let totalSize = 0;
    let fileCount = 0;
    const walk = (dir) => {
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else { totalSize += fs.statSync(full).size; fileCount++; }
        }
      } catch {}
    };
    walk(CACHE_DIR);
    return { totalSize, fileCount, path: CACHE_DIR };
  } catch {
    return { totalSize: 0, fileCount: 0, path: CACHE_DIR };
  }
});

ipcMain.handle("clear-cache", async () => {
  try {
    fs.rmSync(CACHE_DIR, { recursive: true, force: true });
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("open-cache-folder", () => {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  shell.openPath(CACHE_DIR);
});

// Proxy API requests with thumbnail caching
ipcMain.handle("api-fetch", async (_event, apiPath) => {
  const url = `${config.serverUrl}${apiPath}`;
  try {
    const data = await fetchUrl(url);
    return { ok: true, data: data.toString("utf-8") };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("thumb-fetch", async (_event, apiPath) => {
  // apiPath like /api/thumb/2026.03.x/2026.03.17/IMG_5318.JPG?w=400&q=60
  // Cache key: strip query params for the file path, but include them in dir
  const urlObj = new URL(apiPath, "http://localhost");
  const cleanPath = urlObj.pathname; // /api/thumb/month/day/file.jpg
  const qsKey = urlObj.search || "_default";
  const cacheKey = cleanPath.replace(/^\/api\/thumb\//, "") + "/" + qsKey.replace(/[?&=]/g, "_");
  const cachePath = path.join(CACHE_DIR, cacheKey);

  // Check local cache
  try {
    fs.accessSync(cachePath);
    const data = fs.readFileSync(cachePath);
    return { ok: true, data: data.toString("base64"), cached: true };
  } catch {}

  // Fetch from server
  const url = `${config.serverUrl}${apiPath}`;
  try {
    const data = await fetchUrl(url);
    // Save to cache
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, data);
    return { ok: true, data: data.toString("base64"), cached: false };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("photo-url", (_event, apiPath) => {
  // Return the full URL for the photo (opened in lightbox)
  return `${config.serverUrl}${apiPath}`;
});

// ── Smart Sync ──────────────────────────────────────────────────────────────
const SYNC_SRC  = "P:\\Photos";
const SYNC_DEST = "Z:\\Photos";
// Tolerance: dest folder is considered "matched" if its size is within 1% of source
const SIZE_TOLERANCE = 0.01;

// Sum file sizes recursively (only SYNC_EXTS files)
function getDirSize(dir) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        total += getDirSize(full);
      } else if (SYNC_EXTS.has(path.extname(entry.name).toLowerCase())) {
        try { total += fs.statSync(full).size; } catch {}
      }
    }
  } catch {}
  return total;
}

function sizesMatch(srcSize, destSize) {
  if (srcSize === 0) return true;
  return Math.abs(srcSize - destSize) / srcSize <= SIZE_TOLERANCE;
}

function fmtSize(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + " GB";
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + " MB";
  return (bytes / 1e3).toFixed(0) + " KB";
}

// Copy all SYNC_EXTS files from srcDir → destDir, returns { copied, errors }
function syncDayDir(srcDir, destDir, abortCheck) {
  let copied = 0, errors = 0;
  let entries;
  try { entries = fs.readdirSync(srcDir, { withFileTypes: true }); } catch { return { copied, errors: 1 }; }

  for (const entry of entries) {
    if (abortCheck()) break;
    if (entry.isDirectory()) {
      const r = syncDayDir(path.join(srcDir, entry.name), path.join(destDir, entry.name), abortCheck);
      copied += r.copied; errors += r.errors;
      continue;
    }
    if (!SYNC_EXTS.has(path.extname(entry.name).toLowerCase())) continue;
    const srcFile  = path.join(srcDir,  entry.name);
    const destFile = path.join(destDir, entry.name);
    try {
      const srcSize = fs.statSync(srcFile).size;
      try {
        if (fs.statSync(destFile).size === srcSize) continue; // already there
      } catch {}
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(srcFile, destFile);
      copied++;
    } catch { errors++; }
  }
  return { copied, errors };
}

let syncAbort = false;
ipcMain.handle("abort-sync", () => { syncAbort = true; });

ipcMain.handle("start-sync", async (event) => {
  const src  = SYNC_SRC;
  const dest = SYNC_DEST;

  try { fs.accessSync(src);  } catch { return { ok: false, error: `Source not found: ${src}` }; }
  try { fs.accessSync(dest); } catch { return { ok: false, error: `Destination not found: ${dest}` }; }

  syncAbort = false;
  const send = (msg) => { try { event.sender.send("sync-progress", msg); } catch {} };

  // List top-level month folders in source (e.g. 2026.02.x)
  let monthFolders;
  try {
    monthFolders = fs.readdirSync(src, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort();
  } catch (err) {
    return { ok: false, error: `Cannot read source: ${err.message}` };
  }

  let totalCopied = 0, totalErrors = 0, monthsSkipped = 0, daysSkipped = 0;

  for (const month of monthFolders) {
    if (syncAbort) {
      send({ phase: "aborted", message: `Stopped. Copied ${totalCopied} files.`, totalCopied, totalErrors });
      return { ok: true, aborted: true };
    }

    const srcMonth  = path.join(src,  month);
    const destMonth = path.join(dest, month);

    send({ phase: "checking", message: `Checking ${month}...`, month });

    // Compare month-level sizes first
    const srcMonthSize  = getDirSize(srcMonth);
    const destMonthSize = getDirSize(destMonth);

    if (sizesMatch(srcMonthSize, destMonthSize)) {
      monthsSkipped++;
      send({ phase: "month-skip", message: `${month}  ✓  ${fmtSize(srcMonthSize)} — matched, skipped`, month, srcSize: srcMonthSize, destSize: destMonthSize });
      continue;
    }

    send({ phase: "month-diff", message: `${month}  ↑  src ${fmtSize(srcMonthSize)} / dest ${fmtSize(destMonthSize)} — checking days...`, month });

    // Drill into day subfolders
    let dayFolders;
    try {
      dayFolders = fs.readdirSync(srcMonth, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort();
    } catch { dayFolders = []; }

    // Also handle loose files at month root (non-day-organized)
    const looseSrcFiles = fs.readdirSync(srcMonth, { withFileTypes: true })
      .filter(e => e.isFile() && SYNC_EXTS.has(path.extname(e.name).toLowerCase()));

    for (const day of dayFolders) {
      if (syncAbort) break;

      const srcDay  = path.join(srcMonth,  day);
      const destDay = path.join(destMonth, day);

      const srcDaySize  = getDirSize(srcDay);
      const destDaySize = getDirSize(destDay);

      if (sizesMatch(srcDaySize, destDaySize)) {
        daysSkipped++;
        send({ phase: "day-skip", message: `  ${day}  ✓  ${fmtSize(srcDaySize)}`, month, day });
        continue;
      }

      send({ phase: "day-sync", message: `  ${day}  ↑  ${fmtSize(srcDaySize)} — copying...`, month, day });

      const { copied, errors } = syncDayDir(srcDay, destDay, () => syncAbort);
      totalCopied += copied;
      totalErrors += errors;

      send({ phase: "day-done", message: `  ${day}  ✓  copied ${copied} files`, month, day, copied, errors });
    }

    // Handle loose files at month root
    if (looseSrcFiles.length > 0) {
      fs.mkdirSync(destMonth, { recursive: true });
      for (const f of looseSrcFiles) {
        if (syncAbort) break;
        const srcFile  = path.join(srcMonth, f.name);
        const destFile = path.join(destMonth, f.name);
        try {
          if (fs.statSync(destFile).size === fs.statSync(srcFile).size) continue;
        } catch {}
        try { fs.copyFileSync(srcFile, destFile); totalCopied++; } catch { totalErrors++; }
      }
    }
  }

  if (syncAbort) {
    send({ phase: "aborted", message: `Stopped. Copied ${totalCopied} files.`, totalCopied, totalErrors });
  } else {
    send({ phase: "done", message: `Done! Copied ${totalCopied} files. ${monthsSkipped} months already matched.${totalErrors ? ` ${totalErrors} errors.` : ""}`, totalCopied, totalErrors, monthsSkipped });
  }
  return { ok: true, totalCopied, totalErrors, monthsSkipped };
});

// Register custom protocol for serving cached thumbnails directly (no base64 IPC overhead)
protocol.registerSchemesAsPrivileged([
  { scheme: "scloud-thumb", privileges: { bypassCSP: true, supportFetchAPI: true, stream: true } },
]);

app.whenReady().then(() => {
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  // Handle scloud-thumb:// URLs — serves cached thumbnails as direct file responses
  // URL format: scloud-thumb://thumb/month/day/file.jpg?w=100&q=50
  protocol.handle("scloud-thumb", async (request) => {
    const url = new URL(request.url);
    // pathname: /month/day/file.jpg  (host is "thumb")
    const thumbPath = url.pathname.replace(/^\//, ""); // month/day/file.jpg
    const qs = url.search || "";
    const qsKey = qs ? qs.replace(/[?&=]/g, "_") : "_default";
    const cachePath = path.join(CACHE_DIR, thumbPath, qsKey);

    // Try serving from cache first
    try {
      fs.accessSync(cachePath);
      const data = fs.readFileSync(cachePath);
      return new Response(data, {
        headers: { "Content-Type": "image/jpeg", "Cache-Control": "max-age=31536000" },
      });
    } catch {}

    // Cache miss — fetch from server, save, then serve
    const apiPath = `/api/thumb/${thumbPath}${qs}`;
    const serverUrl = `${config.serverUrl}${apiPath}`;
    try {
      const data = await fetchUrl(serverUrl);
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, data);
      return new Response(data, {
        headers: { "Content-Type": "image/jpeg", "Cache-Control": "max-age=31536000" },
      });
    } catch (err) {
      return new Response(`Fetch error: ${err.message}`, { status: 502 });
    }
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
