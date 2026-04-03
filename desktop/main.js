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
const fsP = require("fs").promises; // async fs

// Async recursive size+count of SYNC_EXTS files — non-blocking
async function getDirStats(dir) {
  let sizeBytes = 0, fileCount = 0;
  async function walk(d) {
    let entries;
    try { entries = await fsP.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (SYNC_EXTS.has(path.extname(e.name).toLowerCase())) {
        try { sizeBytes += (await fsP.stat(full)).size; fileCount++; } catch {}
      }
    }
  }
  await walk(dir);
  return { sizeBytes, fileCount };
}

// Async copy of SYNC_EXTS files srcDir → destDir, skipping size-matched files
async function syncDirAsync(srcDir, destDir, abortCheck, onProgress) {
  let copied = 0, errors = 0;
  let entries;
  try { entries = await fsP.readdir(srcDir, { withFileTypes: true }); } catch { return { copied, errors: 1 }; }
  for (const e of entries) {
    if (abortCheck()) break;
    const srcFull  = path.join(srcDir,  e.name);
    const destFull = path.join(destDir, e.name);
    if (e.isDirectory()) {
      const r = await syncDirAsync(srcFull, destFull, abortCheck, onProgress);
      copied += r.copied; errors += r.errors;
    } else if (SYNC_EXTS.has(path.extname(e.name).toLowerCase())) {
      try {
        const srcSize = (await fsP.stat(srcFull)).size;
        try { if ((await fsP.stat(destFull)).size === srcSize) continue; } catch {}
        await fsP.mkdir(destDir, { recursive: true });
        await fsP.copyFile(srcFull, destFull);
        copied++;
        if (onProgress) onProgress(e.name);
      } catch { errors++; }
    }
  }
  return { copied, errors };
}

// IPC: scan one month's day subfolders locally, emitting per-day stats
ipcMain.handle("scan-local-month", async (event, { month }) => {
  const send = (msg) => { try { event.sender.send("scan-local-month-progress", msg); } catch {} };
  const monthPath = path.join(SYNC_SRC, month);
  let entries;
  try { entries = await fsP.readdir(monthPath, { withFileTypes: true }); }
  catch (err) { return { ok: false, error: err.message }; }

  const dayDirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort().reverse();
  const looseFiles = entries.filter(e => e.isFile() && SYNC_EXTS.has(path.extname(e.name).toLowerCase()));

  for (const day of dayDirs) {
    const { sizeBytes, fileCount } = await getDirStats(path.join(monthPath, day));
    send({ name: day, sizeBytes, fileCount });
  }
  if (looseFiles.length > 0) {
    let sizeBytes = 0;
    for (const f of looseFiles) {
      try { sizeBytes += (await fsP.stat(path.join(monthPath, f.name))).size; } catch {}
    }
    send({ name: "(root)", sizeBytes, fileCount: looseFiles.length });
  }
  return { ok: true };
});

// IPC: sync a single day folder
ipcMain.handle("sync-day", async (event, { month, day }) => {
  const srcDay  = path.join(SYNC_SRC,  month, day);
  const destDay = path.join(SYNC_DEST, month, day);
  const send = (msg) => { try { event.sender.send("sync-day-progress", { month, day, ...msg }); } catch {} };

  syncAbort = false;
  let copied = 0, errors = 0;

  // Check sizes first
  const [srcStats, destStats] = await Promise.all([
    getDirStats(srcDay),
    getDirStats(destDay).catch(() => ({ sizeBytes: 0, fileCount: 0 })),
  ]);

  send({ phase: "start", srcCount: srcStats.fileCount, destCount: destStats.fileCount });

  const result = await syncDirAsync(srcDay, destDay, () => syncAbort, (filename) => {
    send({ phase: "progress", copied: ++copied, filename });
  });
  copied = result.copied; errors = result.errors;

  send({ phase: "done", copied, errors });
  return { ok: true, copied, errors };
});

// IPC: scan local P:\Photos month-by-month, emitting stats per month
// Non-blocking — each month awaits async I/O
ipcMain.handle("scan-local", async (event) => {
  const send = (msg) => { try { event.sender.send("scan-local-progress", msg); } catch {} };
  let months;
  try {
    const entries = await fsP.readdir(SYNC_SRC, { withFileTypes: true });
    months = entries.filter(e => e.isDirectory()).map(e => e.name).sort().reverse();
  } catch (err) {
    return { ok: false, error: err.message };
  }
  for (const name of months) {
    const { sizeBytes, fileCount } = await getDirStats(path.join(SYNC_SRC, name));
    send({ name, sizeBytes, fileCount });
  }
  return { ok: true };
});

// IPC: sync a single month from P: → Z:, with day-level size-skip
let syncAbort = false;
ipcMain.handle("abort-sync", () => { syncAbort = true; });

ipcMain.handle("sync-month", async (event, { month }) => {
  const srcMonth  = path.join(SYNC_SRC,  month);
  const destMonth = path.join(SYNC_DEST, month);
  const send = (msg) => { try { event.sender.send("sync-month-progress", { month, ...msg }); } catch {} };

  try { await fsP.access(srcMonth); } catch { return { ok: false, error: `Not found: ${srcMonth}` }; }

  syncAbort = false;
  let totalCopied = 0, totalErrors = 0;

  // List day subfolders
  let dayEntries;
  try { dayEntries = await fsP.readdir(srcMonth, { withFileTypes: true }); } catch { return { ok: false, error: "Cannot read month folder" }; }

  const dayDirs  = dayEntries.filter(e => e.isDirectory()).map(e => e.name).sort();
  const looseFiles = dayEntries.filter(e => e.isFile() && SYNC_EXTS.has(path.extname(e.name).toLowerCase()));

  send({ phase: "start", total: dayDirs.length });

  for (const day of dayDirs) {
    if (syncAbort) { send({ phase: "aborted" }); return { ok: true, aborted: true }; }

    const srcDay  = path.join(srcMonth, day);
    const destDay = path.join(destMonth, day);

    // Compare day sizes before copying
    const [srcStats, destStats] = await Promise.all([
      getDirStats(srcDay),
      getDirStats(destDay).catch(() => ({ sizeBytes: 0, fileCount: 0 })),
    ]);

    if (srcStats.fileCount > 0 && srcStats.fileCount === destStats.fileCount &&
        Math.abs(srcStats.sizeBytes - destStats.sizeBytes) / srcStats.sizeBytes < 0.01) {
      send({ phase: "day-skip", day, fileCount: srcStats.fileCount, sizeBytes: srcStats.sizeBytes });
      continue;
    }

    send({ phase: "day-start", day, srcCount: srcStats.fileCount, srcSize: srcStats.sizeBytes, destCount: destStats.fileCount });
    const { copied, errors } = await syncDirAsync(srcDay, destDay, () => syncAbort, () => {
      send({ phase: "day-progress", day, copied: ++totalCopied });
    });
    totalErrors += errors;
    send({ phase: "day-done", day, copied, errors });
  }

  // Loose files at month root
  if (looseFiles.length > 0) {
    await fsP.mkdir(destMonth, { recursive: true });
    for (const f of looseFiles) {
      if (syncAbort) break;
      const srcFile  = path.join(srcMonth, f.name);
      const destFile = path.join(destMonth, f.name);
      try {
        const srcSize = (await fsP.stat(srcFile)).size;
        try { if ((await fsP.stat(destFile)).size === srcSize) continue; } catch {}
        await fsP.copyFile(srcFile, destFile);
        totalCopied++;
      } catch { totalErrors++; }
    }
  }

  // Re-scan local month stats after sync
  const refreshed = await getDirStats(srcMonth);
  send({ phase: "done", totalCopied, totalErrors, refreshedLocal: refreshed });
  return { ok: true, totalCopied, totalErrors };
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
