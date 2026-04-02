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

ipcMain.handle("get-sync-config", () => ({
  syncSource: config.syncSource || "P:\\Photos",
  syncDest: config.syncDest || "",
}));

ipcMain.handle("set-sync-config", (_event, { syncSource, syncDest }) => {
  config.syncSource = syncSource;
  config.syncDest = syncDest;
  saveConfig(config);
  return { ok: true };
});

ipcMain.handle("pick-folder", async (_event, defaultPath) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    defaultPath: defaultPath || "P:\\Photos",
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// Walk a directory recursively, returning all files with target extensions
function walkDir(dir, exts) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(full, exts));
    } else if (exts.has(path.extname(entry.name).toLowerCase())) {
      results.push(full);
    }
  }
  return results;
}

let syncAbort = false;

ipcMain.handle("abort-sync", () => { syncAbort = true; });

ipcMain.handle("start-sync", async (event) => {
  const src = config.syncSource || "P:\\Photos";
  const dest = config.syncDest || "";

  if (!dest) return { ok: false, error: "No destination folder configured." };

  // Verify source and dest exist
  try { fs.accessSync(src); } catch { return { ok: false, error: `Source not found: ${src}` }; }
  try { fs.accessSync(dest); } catch { return { ok: false, error: `Destination not found: ${dest}` }; }

  syncAbort = false;

  const send = (msg) => {
    try { event.sender.send("sync-progress", msg); } catch {}
  };

  send({ phase: "scanning", message: "Scanning source folder..." });

  let allFiles;
  try {
    allFiles = walkDir(src, SYNC_EXTS);
  } catch (err) {
    return { ok: false, error: `Scan failed: ${err.message}` };
  }

  send({ phase: "scanning", message: `Found ${allFiles.length.toLocaleString()} files. Checking destination...` });

  let copied = 0, skipped = 0, errors = 0;
  const total = allFiles.length;

  for (let i = 0; i < allFiles.length; i++) {
    if (syncAbort) {
      send({ phase: "aborted", message: `Aborted. Copied ${copied}, skipped ${skipped}.`, copied, skipped, errors, total });
      return { ok: true, aborted: true, copied, skipped, errors };
    }

    const srcFile = allFiles[i];
    // Preserve folder structure relative to source root
    const rel = path.relative(src, srcFile);
    const destFile = path.join(dest, rel);

    // Progress update every 50 files
    if (i % 50 === 0) {
      send({ phase: "syncing", message: `Copying... ${i}/${total}`, copied, skipped, errors, total, current: rel });
    }

    // Skip if already exists with same size
    try {
      const srcStat = fs.statSync(srcFile);
      try {
        const destStat = fs.statSync(destFile);
        if (destStat.size === srcStat.size) { skipped++; continue; }
      } catch {} // dest doesn't exist, proceed to copy

      fs.mkdirSync(path.dirname(destFile), { recursive: true });
      fs.copyFileSync(srcFile, destFile);
      copied++;
    } catch (err) {
      errors++;
    }
  }

  send({ phase: "done", message: `Done! Copied ${copied}, skipped ${skipped}${errors ? `, ${errors} errors` : ""}.`, copied, skipped, errors, total });
  return { ok: true, copied, skipped, errors };
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
