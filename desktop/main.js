const { app, BrowserWindow, protocol, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");

// Default server URL — can be changed in settings
const CONFIG_PATH = path.join(app.getPath("userData"), "config.json");
const CACHE_DIR = path.join(app.getPath("userData"), "thumbcache");

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return { serverUrl: "https://photos.sunnygong.com" };
  }
}

function saveConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

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

app.whenReady().then(() => {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
