const { app, BrowserWindow, protocol, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");
const os = require("os");

// ── File logger ───────────────────────────────────────────────────────────────
const LOG_DIR  = path.join(os.homedir(), "Documents", "logs");
const LOG_FILE = path.join(LOG_DIR, `scloud-${new Date().toISOString().slice(0,10)}.log`);
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(a =>
    typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ")}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
}

// Redirect console.error / console.warn to the log too
const _origErr  = console.error.bind(console);
const _origWarn = console.warn.bind(console);
console.error = (...a) => { _origErr(...a);  log("[ERROR]", ...a); };
console.warn  = (...a) => { _origWarn(...a); log("[WARN]",  ...a); };
// ─────────────────────────────────────────────────────────────────────────────

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
// Shared secret sent with every request — server whitelists this without a login
const DESKTOP_TOKEN = "scloud-desktop-v1-a9f3c2e8b7d4";

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (url.startsWith("https") ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: "GET",
      timeout: 30000,
      headers: { "X-SCloud-Token": DESKTOP_TOKEN },
    };
    const req = mod.request(options, (res) => {
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
    req.end();
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
  // Append desktop token so the server lets the direct img src request through
  const sep = apiPath.includes("?") ? "&" : "?";
  return `${config.serverUrl}${apiPath}${sep}_t=${DESKTOP_TOKEN}`;
});

// ── Smart Sync via SFTP ─────────────────────────────────────────────────────
const SYNC_SRC = "P:\\Photos";
const fsP = require("fs").promises;
const SftpClient = require("ssh2-sftp-client");

function getSshConfig() {
  const c = config.ssh || {};
  const cfg = {
    host:     c.host || "photos.sunnygong.com",
    port:     parseInt(c.port || "22", 10),
    username: c.user || "host",
    readyTimeout:      60000,
    keepaliveInterval: 10000,
    keepaliveCountMax: 6,
  };

  // Prefer password auth if set — simpler and avoids key-negotiation timeouts
  if (c.password) {
    cfg.password = c.password;
  } else {
    // Fall back to private key
    const keyPath = c.keyPath || path.join(require("os").homedir(), ".ssh", "id_rsa");
    try {
      cfg.privateKey = fs.readFileSync(keyPath);
      if (c.passphrase) cfg.passphrase = c.passphrase;
    } catch (e) {
      console.warn("[SSH] No password set and could not read private key:", keyPath, e.message);
    }
  }
  return cfg;
}

function getRemotePath() {
  return (config.ssh && config.ssh.remotePath) || "/mnt/nas/Photos";
}

// Validate SSH config before attempting a connection — fail fast with clear message
function validateSshConfig() {
  const c = config.ssh || {};
  if (!c.host) throw new Error("No SSH host configured. Open Sync → ⚙ SSH and fill in the server details.");
  if (!c.password && !c.keyPath) throw new Error("No SSH password or key configured. Open Sync → ⚙ SSH and enter your password.");
}

// Create and connect a new SFTP client
async function connectSftp() {
  validateSshConfig();
  const cfg = getSshConfig();
  log(`[SFTP] Connecting to ${cfg.username}@${cfg.host}:${cfg.port} (auth: ${cfg.password ? "password" : "key"})`);
  const sftp = new SftpClient();
  try {
    await sftp.connect(cfg);
    log(`[SFTP] Connected successfully`);
  } catch (err) {
    log(`[SFTP] Connection failed: ${err.message}`);
    throw err;
  }
  return sftp;
}

// Async recursive size+count of SYNC_EXTS files locally — non-blocking
async function getDirStats(dir) {
  let sizeBytes = 0, fileCount = 0;
  async function walk(d) {
    let entries;
    try { entries = await fsP.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { await walk(full); }
      else if (SYNC_EXTS.has(path.extname(e.name).toLowerCase())) {
        try { sizeBytes += (await fsP.stat(full)).size; fileCount++; } catch {}
      }
    }
  }
  await walk(dir);
  return { sizeBytes, fileCount };
}

const UPLOAD_CONCURRENCY = 5; // parallel uploads per day — tune up/down if needed

// Walk srcDir recursively, create remote dirs, collect files needing upload.
async function collectUploads(sftp, srcDir, remoteDir, abortCheck) {
  const toUpload = []; // { srcFull, remoteFull, name }
  async function walk(src, remote) {
    let entries;
    try { entries = await fsP.readdir(src, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (abortCheck()) return;
      const srcFull    = path.join(src, e.name);
      const remoteFull = remote + "/" + e.name;
      if (e.isDirectory()) {
        try { await sftp.mkdir(remoteFull, true); } catch {}
        await walk(srcFull, remoteFull);
      } else if (SYNC_EXTS.has(path.extname(e.name).toLowerCase())) {
        toUpload.push({ srcFull, remoteFull, name: e.name });
      }
    }
  }
  await walk(srcDir, remoteDir);
  return toUpload;
}

// Upload files with N concurrent workers. Returns { copied, errors, bytes }.
// onProgress(filename, bytes) called after each successful upload.
async function sftpSyncDir(sftp, srcDir, remoteDir, abortCheck, onProgress) {
  let copied = 0, errors = 0, bytes = 0;

  const toUpload = await collectUploads(sftp, srcDir, remoteDir, abortCheck);
  if (!toUpload.length) return { copied, errors, bytes };

  let idx = 0;
  async function worker() {
    while (!abortCheck()) {
      const item = toUpload[idx++];
      if (!item) break;
      const { srcFull, remoteFull, name } = item;
      try {
        const localSize = (await fsP.stat(srcFull)).size;
        try { if ((await sftp.stat(remoteFull)).size === localSize) continue; } catch {}
        await sftp.put(srcFull, remoteFull);
        copied++;
        bytes += localSize;
        log(`[SFTP] ✓ uploaded ${name} (${(localSize/1e6).toFixed(1)} MB)`);
        if (onProgress) onProgress(name, localSize);
      } catch (err) { log(`[SFTP] ✗ failed ${name}: ${err.message}`); errors++; }
    }
  }

  await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, worker));
  return { copied, errors, bytes };
}

// IPC: get/set SSH config
ipcMain.handle("get-ssh-config", () => config.ssh || {});
ipcMain.handle("set-ssh-config", (_event, ssh) => {
  config.ssh = ssh;
  saveConfig(config);
  return { ok: true };
});

// IPC: test SSH connection
ipcMain.handle("test-ssh", async () => {
  try {
    const sftp = await connectSftp();
    await sftp.end();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// IPC: find files on server that don't exist locally (for a given month)
ipcMain.handle("find-server-extras", async (_event, { month }) => {
  const localMonth  = path.join(SYNC_SRC, month);
  const remoteMonth = getRemotePath() + "/" + month;

  // Collect local file names (basename only, relative to month root)
  const localFiles = new Set();
  async function walkLocal(dir, rel) {
    let entries;
    try { entries = await fsP.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const childRel = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) { await walkLocal(path.join(dir, e.name), childRel); }
      else if (SYNC_EXTS.has(path.extname(e.name).toLowerCase())) { localFiles.add(childRel); }
    }
  }
  await walkLocal(localMonth, "");

  // Collect remote files recursively via SFTP
  let sftp;
  try { sftp = await connectSftp(); }
  catch (err) { return { ok: false, error: `SSH failed: ${err.message}` }; }

  const extras = []; // { remotePath, relPath, size }
  async function walkRemote(remoteDir, rel) {
    let list;
    try { list = await sftp.list(remoteDir); } catch { return; }
    for (const item of list) {
      const childRel    = rel ? rel + "/" + item.name : item.name;
      const childRemote = remoteDir + "/" + item.name;
      if (item.type === "d") { await walkRemote(childRemote, childRel); }
      else if (SYNC_EXTS.has(path.extname(item.name).toLowerCase())) {
        if (!localFiles.has(childRel)) extras.push({ remotePath: childRemote, relPath: childRel, size: item.size });
      }
    }
  }

  try {
    await walkRemote(remoteMonth, "");
  } finally {
    try { await sftp.end(); } catch {}
  }

  return { ok: true, extras };
});

// IPC: delete specific files on server (after user confirms)
ipcMain.handle("delete-server-extras", async (_event, { remotePaths }) => {
  if (!Array.isArray(remotePaths) || remotePaths.length === 0) return { ok: true, deleted: 0 };
  let sftp;
  try { sftp = await connectSftp(); }
  catch (err) { return { ok: false, error: `SSH failed: ${err.message}` }; }

  let deleted = 0, errors = 0;
  try {
    for (const p of remotePaths) {
      try { await sftp.delete(p); deleted++; }
      catch { errors++; }
    }
  } finally {
    try { await sftp.end(); } catch {}
  }
  return { ok: true, deleted, errors };
});

// IPC: scan local P:\Photos month-by-month
ipcMain.handle("scan-local", async (event) => {
  const send = (msg) => { try { event.sender.send("scan-local-progress", msg); } catch {} };
  let months;
  try {
    const entries = await fsP.readdir(SYNC_SRC, { withFileTypes: true });
    months = entries.filter(e => e.isDirectory()).map(e => e.name).sort().reverse();
  } catch (err) { return { ok: false, error: err.message }; }
  for (const name of months) {
    const { sizeBytes, fileCount } = await getDirStats(path.join(SYNC_SRC, name));
    send({ name, sizeBytes, fileCount });
  }
  return { ok: true };
});

// IPC: scan one month's day subfolders locally
ipcMain.handle("scan-local-month", async (event, { month }) => {
  const send = (msg) => { try { event.sender.send("scan-local-month-progress", msg); } catch {} };
  const monthPath = path.join(SYNC_SRC, month);
  let entries;
  try { entries = await fsP.readdir(monthPath, { withFileTypes: true }); }
  catch (err) { return { ok: false, error: err.message }; }

  const dayDirs    = entries.filter(e => e.isDirectory()).map(e => e.name).sort().reverse();
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

// Abort flag
let syncAbort = false;
ipcMain.handle("abort-sync", () => { syncAbort = true; });

// Serialise all sync operations — only one SFTP connection at a time
let syncQueue = Promise.resolve();
let syncQueueDepth = 0;
function queueSync(fn, sendQueued) {
  syncQueueDepth++;
  if (syncQueueDepth > 1 && sendQueued) sendQueued(syncQueueDepth - 1);
  const result = syncQueue.then(() => { syncQueueDepth = Math.max(0, syncQueueDepth - 1); return fn(); });
  syncQueue = result.catch(() => {});
  return result;
}

// IPC: sync a single month via SFTP, day-by-day with size-skip
ipcMain.handle("sync-month", (event, { month }) => {
  const send = (msg) => { try { event.sender.send("sync-month-progress", { month, ...msg }); } catch {} };
  // Notify renderer it's queued before entering the queue
  send({ phase: "queued" });
  return queueSync(async () => {
  const srcMonth    = path.join(SYNC_SRC, month);
  const remoteMonth = getRemotePath() + "/" + month;

  log(`[SYNC] Starting month sync: ${month}`);
  try { await fsP.access(srcMonth); } catch { return { ok: false, error: `Not found on P:\\: ${srcMonth}` }; }

  syncAbort = false;
  let sftp;
  try {
    send({ phase: "connecting" });
    sftp = await connectSftp();
  } catch (err) {
    log(`[SYNC] Aborting ${month}: ${err.message}`);
    return { ok: false, error: err.message };
  }

  let totalCopied = 0, totalErrors = 0, totalBytes = 0;

  try {
    try { await sftp.mkdir(remoteMonth, true); } catch {}

    let dayEntries;
    try { dayEntries = await fsP.readdir(srcMonth, { withFileTypes: true }); }
    catch { return { ok: false, error: "Cannot read local month folder" }; }

    const dayDirs    = dayEntries.filter(e => e.isDirectory()).map(e => e.name).sort();
    const looseFiles = dayEntries.filter(e => e.isFile() && SYNC_EXTS.has(path.extname(e.name).toLowerCase()));

    // ── Pre-scan: compute total files+bytes to upload so renderer can show ETA ──
    send({ phase: "scanning", message: "Scanning days…" });
    const dayPlan = []; // { day, srcCount, srcBytes, remoteCount, remoteSize }
    for (const day of dayDirs) {
      const srcDay  = path.join(srcMonth, day);
      const srcStats = await getDirStats(srcDay);
      let remoteCount = 0, remoteSize = 0;
      try {
        const remoteFiles = await sftp.list(remoteMonth + "/" + day);
        for (const rf of remoteFiles) {
          if (SYNC_EXTS.has(path.extname(rf.name).toLowerCase())) {
            remoteCount++; remoteSize += rf.size;
          }
        }
      } catch {}
      dayPlan.push({ day, srcCount: srcStats.fileCount, srcBytes: srcStats.sizeBytes, remoteCount, remoteSize });
    }

    const totalFilesToSync = dayPlan.reduce((s, d) => {
      const skip = d.srcCount > 0 && d.srcCount === d.remoteCount &&
                   Math.abs(d.srcBytes - d.remoteSize) / (d.srcBytes || 1) < 0.01;
      return s + (skip ? 0 : Math.max(0, d.srcCount - d.remoteCount));
    }, 0);
    const totalBytesToSync = dayPlan.reduce((s, d) => {
      const skip = d.srcCount > 0 && d.srcCount === d.remoteCount &&
                   Math.abs(d.srcBytes - d.remoteSize) / (d.srcBytes || 1) < 0.01;
      return s + (skip ? 0 : Math.max(0, d.srcBytes - d.remoteSize));
    }, 0);

    send({ phase: "start", total: dayDirs.length, totalFilesToSync, totalBytesToSync });

    for (const { day, srcCount, srcBytes, remoteCount, remoteSize } of dayPlan) {
      if (syncAbort) { send({ phase: "aborted" }); break; }

      const srcDay    = path.join(srcMonth, day);
      const remoteDay = remoteMonth + "/" + day;

      // Skip if counts match and sizes within 1%
      if (srcCount > 0 && srcCount === remoteCount &&
          Math.abs(srcBytes - remoteSize) / (srcBytes || 1) < 0.01) {
        send({ phase: "day-skip", day, fileCount: srcCount, sizeBytes: srcBytes });
        continue;
      }

      const filesNeeded = Math.max(0, srcCount - remoteCount);
      const bytesNeeded = Math.max(0, srcBytes - remoteSize);
      send({ phase: "day-start", day, srcCount, destCount: remoteCount, filesNeeded, bytesNeeded });

      try { await sftp.mkdir(remoteDay, true); } catch {}
      const { copied, errors, bytes } = await sftpSyncDir(sftp, srcDay, remoteDay, () => syncAbort, (filename, fileBytes) => {
        totalCopied++;
        totalBytes += fileBytes || 0;
        send({ phase: "day-progress", day, totalCopied, totalBytes, totalBytesToSync, filename, fileBytes: fileBytes || 0 });
      });
      totalErrors += errors;
      send({ phase: "day-done", day, copied, errors, bytes });
    }

    // Loose files at month root
    for (const f of looseFiles) {
      if (syncAbort) break;
      const srcFile    = path.join(srcMonth, f.name);
      const remotefile = remoteMonth + "/" + f.name;
      try {
        const localSize = (await fsP.stat(srcFile)).size;
        try { if ((await sftp.stat(remotefile)).size === localSize) continue; } catch {}
        await sftp.put(srcFile, remotefile);
        totalCopied++; totalBytes += localSize;
        send({ phase: "day-progress", day: "(root)", totalCopied, totalBytes, totalBytesToSync, filename: f.name, fileBytes: localSize });
      } catch { totalErrors++; }
    }
  } finally {
    try { await sftp.end(); } catch {}
  }

  const refreshed = await getDirStats(srcMonth);
  log(`[SYNC] Done ${month}: ${totalCopied} copied, ${totalErrors} errors`);
  send({ phase: "done", totalCopied, totalErrors, refreshedLocal: refreshed });
  return { ok: true, totalCopied, totalErrors };
}); });

// IPC: sync a single day via SFTP
ipcMain.handle("sync-day", (event, { month, day }) => queueSync(async () => {
  const srcDay    = path.join(SYNC_SRC, month, day);
  const remoteDay = getRemotePath() + "/" + month + "/" + day;
  const send = (msg) => { try { event.sender.send("sync-day-progress", { month, day, ...msg }); } catch {} };

  syncAbort = false;
  let sftp;
  try {
    sftp = await connectSftp();
  } catch (err) {
    return { ok: false, error: `SSH failed: ${err.message}` };
  }

  try {
    await sftp.mkdir(remoteDay, true);
    send({ phase: "start" });
    let copied = 0;
    const { copied: c, errors } = await sftpSyncDir(sftp, srcDay, remoteDay, () => syncAbort, (filename) => {
      send({ phase: "progress", copied: ++copied, filename });
    });
    send({ phase: "done", copied: c, errors });
    return { ok: true, copied: c, errors };
  } finally {
    try { await sftp.end(); } catch {}
  }
}));

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
