import express from "express";
import path from "path";
import fs from "fs/promises";
import { createReadStream } from "fs";
import sharp from "sharp";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PHOTOS_ROOT = process.env.PHOTOS_ROOT || "Z:/Photos";
const CACHE_DIR = path.join(__dirname, ".thumbcache");
const THUMB_WIDTH = 400;
const THUMB_QUALITY = 75;
const PORT = parseInt(process.env.PORT || "3333");
const MAX_CONCURRENT = 4;

// Semaphore for limiting concurrent sharp operations
let activeCount = 0;
const queue: Array<() => void> = [];

function acquireSemaphore(): Promise<void> {
  return new Promise((resolve) => {
    if (activeCount < MAX_CONCURRENT) {
      activeCount++;
      resolve();
    } else {
      queue.push(resolve);
    }
  });
}

function releaseSemaphore() {
  activeCount--;
  if (queue.length > 0) {
    activeCount++;
    queue.shift()!();
  }
}

// Path safety: reject traversal attempts
function safePath(segment: string): boolean {
  return !segment.includes("..") && !segment.includes("/") && !segment.includes("\\");
}

const JPEG_EXTS = new Set([".jpg", ".jpeg"]);

function isJpeg(filename: string): boolean {
  return JPEG_EXTS.has(path.extname(filename).toLowerCase());
}

const app = express();

// Basic auth middleware
app.use((req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Photos"');
    return res.status(401).send("Authentication required");
  }
  const [user, pass] = Buffer.from(auth.slice(6), "base64").toString().split(":");
  if (user === "guest" && pass === "abc123") return next();
  res.setHeader("WWW-Authenticate", 'Basic realm="Photos"');
  res.status(401).send("Invalid credentials");
});

// --- /api/tree endpoint with caching ---
const MONTH_PATTERN = /^\d{4}\.\d{2}\.x$/;
const MONTH_NAMES = ["", "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

let treeCache: { data: any; timestamp: number } | null = null;
const TREE_TTL = 3600_000; // 1 hour (NAS scan takes ~4 min, cache aggressively)

app.get("/api/tree", async (req, res) => {
  if (req.query.refresh) treeCache = null;
  if (treeCache && Date.now() - treeCache.timestamp < TREE_TTL) {
    return res.json(treeCache.data);
  }

  try {
    const topEntries = await fs.readdir(PHOTOS_ROOT, { withFileTypes: true });
    const topDirs = topEntries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();

    const timeline: any[] = [];
    const collections: any[] = [];
    let totalPhotos = 0;

    for (const dir of topDirs) {
      const isDateFolder = MONTH_PATTERN.test(dir);
      const fullPath = path.join(PHOTOS_ROOT, dir);
      const entries = await fs.readdir(fullPath, { withFileTypes: true });
      const subDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();
      const directJpegs = entries.filter((e) => e.isFile() && isJpeg(e.name));

      if (isDateFolder) {
        const year = parseInt(dir.slice(0, 4));
        const monthNum = parseInt(dir.slice(5, 7));
        const days: any[] = [];

        if (subDirs.length > 0) {
          // Has day subfolders
          for (const sub of subDirs) {
            const dayFiles = await fs.readdir(path.join(fullPath, sub));
            const count = dayFiles.filter(isJpeg).length;
            if (count > 0) {
              days.push({ day: sub, count });
              totalPhotos += count;
            }
          }
        } else if (directJpegs.length > 0) {
          // Flat folder with photos directly
          days.push({ day: null, count: directJpegs.length });
          totalPhotos += directJpegs.length;
        }

        if (days.length > 0) {
          timeline.push({ month: dir, year, monthNum, monthName: MONTH_NAMES[monthNum], days });
        }
      } else {
        // Collection folder (e.g., Film.x)
        const groups: any[] = [];
        if (subDirs.length > 0) {
          for (const sub of subDirs) {
            const subFiles = await fs.readdir(path.join(fullPath, sub));
            const count = subFiles.filter(isJpeg).length;
            if (count > 0) {
              groups.push({ subfolder: sub, count });
              totalPhotos += count;
            }
          }
        }
        if (directJpegs.length > 0) {
          groups.push({ subfolder: null, count: directJpegs.length });
          totalPhotos += directJpegs.length;
        }
        if (groups.length > 0) {
          collections.push({ name: dir, groups });
        }
      }
    }

    const result = { timeline, collections, totalPhotos };
    treeCache = { data: result, timestamp: Date.now() };
    res.json(result);
  } catch (err) {
    console.error("Tree scan error:", err);
    res.status(500).json({ error: "Failed to scan photo tree" });
  }
});

// GET /api/folders - list top-level folders (months + Film.x)
app.get("/api/folders", async (_req, res) => {
  try {
    const entries = await fs.readdir(PHOTOS_ROOT, { withFileTypes: true });
    const folders = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse();
    res.json(folders);
  } catch (err) {
    res.status(500).json({ error: "Failed to read photos root" });
  }
});

// GET /api/folders/:month - list subfolders within a month
// If the folder has no subfolders (e.g. 2023.10.x), return JPEGs directly
app.get("/api/folders/:month", async (req, res) => {
  const { month } = req.params;
  if (!safePath(month)) return res.status(400).json({ error: "Invalid path" });

  try {
    const dir = path.join(PHOTOS_ROOT, month);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const folders = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse();

    // If no subfolders, return photos directly in this folder
    const jpegs = entries.filter((e) => e.isFile() && isJpeg(e.name)).map((e) => e.name).sort();
    if (folders.length === 0 && jpegs.length > 0) {
      return res.json({ type: "photos", files: jpegs });
    }

    // Also count JPEGs in each subfolder for display
    const result = await Promise.all(
      folders.map(async (f) => {
        try {
          const files = await fs.readdir(path.join(dir, f));
          const jpegCount = files.filter(isJpeg).length;
          return { name: f, count: jpegCount };
        } catch {
          return { name: f, count: 0 };
        }
      })
    );

    res.json({ type: "folders", items: result });
  } catch (err) {
    res.status(500).json({ error: "Failed to read folder" });
  }
});

// GET /api/folders/:month/:day - list JPEGs in a day folder
app.get("/api/folders/:month/:day", async (req, res) => {
  const { month, day } = req.params;
  if (!safePath(month) || !safePath(day))
    return res.status(400).json({ error: "Invalid path" });

  try {
    const dir = path.join(PHOTOS_ROOT, month, day);
    const entries = await fs.readdir(dir);
    const jpegs = entries.filter(isJpeg).sort();
    res.json(jpegs);
  } catch (err) {
    res.status(500).json({ error: "Failed to read day folder" });
  }
});

// GET /api/thumb/:month/:filename - serve thumbnail for photos directly in month folder
app.get("/api/thumb/:month/:filename", async (req, res) => {
  const { month, filename } = req.params;
  if (!safePath(month) || !safePath(filename))
    return res.status(400).json({ error: "Invalid path" });

  if (!isJpeg(filename)) return res.status(400).json({ error: "Not a JPEG" });

  const srcPath = path.join(PHOTOS_ROOT, month, filename);
  const cacheDir = path.join(CACHE_DIR, month);
  const cachePath = path.join(cacheDir, filename);

  const sendJpeg = (filePath: string) => {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("Content-Type", "image/jpeg");
    createReadStream(filePath).pipe(res);
  };

  try {
    await fs.access(cachePath);
    return sendJpeg(cachePath);
  } catch {}

  try {
    await fs.access(srcPath);
  } catch {
    return res.status(404).json({ error: "Source file not found" });
  }

  try {
    await acquireSemaphore();
    try {
      try {
        await fs.access(cachePath);
        return sendJpeg(cachePath);
      } catch {}

      await fs.mkdir(cacheDir, { recursive: true });
      await sharp(srcPath)
        .rotate()
        .resize(THUMB_WIDTH, null, { withoutEnlargement: true })
        .jpeg({ quality: THUMB_QUALITY })
        .toFile(cachePath);

      sendJpeg(cachePath);
    } finally {
      releaseSemaphore();
    }
  } catch (err) {
    console.error(`Thumbnail error for ${srcPath}:`, err);
    res.status(500).json({ error: "Failed to generate thumbnail" });
  }
});

// GET /api/photo/:month/:filename - serve full-size photo from month folder
app.get("/api/photo/:month/:filename", async (req, res) => {
  const { month, filename } = req.params;
  if (!safePath(month) || !safePath(filename))
    return res.status(400).json({ error: "Invalid path" });

  const filePath = path.join(PHOTOS_ROOT, month, filename);

  try {
    await fs.access(filePath);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Content-Type", "image/jpeg");
    createReadStream(filePath).pipe(res);
  } catch {
    res.status(404).json({ error: "File not found" });
  }
});

// GET /api/thumb/:month/:day/:filename - serve cached thumbnail or generate
app.get("/api/thumb/:month/:day/:filename", async (req, res) => {
  const { month, day, filename } = req.params;
  if (!safePath(month) || !safePath(day) || !safePath(filename))
    return res.status(400).json({ error: "Invalid path" });

  if (!isJpeg(filename)) return res.status(400).json({ error: "Not a JPEG" });

  const srcPath = path.join(PHOTOS_ROOT, month, day, filename);
  const cacheDir = path.join(CACHE_DIR, month, day);
  const cachePath = path.join(cacheDir, filename);

  const sendJpeg = (filePath: string) => {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("Content-Type", "image/jpeg");
    createReadStream(filePath).pipe(res);
  };

  // Try serving from cache first
  try {
    await fs.access(cachePath);
    return sendJpeg(cachePath);
  } catch {
    // Cache miss - generate thumbnail
  }

  try {
    await fs.access(srcPath);
  } catch {
    return res.status(404).json({ error: "Source file not found" });
  }

  try {
    await acquireSemaphore();
    try {
      // Double-check cache (another request may have generated it)
      try {
        await fs.access(cachePath);
        return sendJpeg(cachePath);
      } catch {
        // Still a cache miss, proceed
      }

      await fs.mkdir(cacheDir, { recursive: true });
      await sharp(srcPath)
        .rotate() // Auto-orient from EXIF
        .resize(THUMB_WIDTH, null, { withoutEnlargement: true })
        .jpeg({ quality: THUMB_QUALITY })
        .toFile(cachePath);

      sendJpeg(cachePath);
    } finally {
      releaseSemaphore();
    }
  } catch (err) {
    console.error(`Thumbnail error for ${srcPath}:`, err);
    res.status(500).json({ error: "Failed to generate thumbnail" });
  }
});

// GET /api/photo/:month/:day/:filename - serve full-size JPEG
app.get("/api/photo/:month/:day/:filename", async (req, res) => {
  const { month, day, filename } = req.params;
  if (!safePath(month) || !safePath(day) || !safePath(filename))
    return res.status(400).json({ error: "Invalid path" });

  const filePath = path.join(PHOTOS_ROOT, month, day, filename);

  try {
    await fs.access(filePath);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Content-Type", "image/jpeg");
    createReadStream(filePath).pipe(res);
  } catch {
    res.status(404).json({ error: "File not found" });
  }
});

// Serve static frontend (after API routes to avoid intercepting .JPG URLs)
app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Photo browser running at http://localhost:${PORT}`);
  console.log(`Serving photos from: ${PHOTOS_ROOT}`);
  console.log(`Thumbnail cache: ${CACHE_DIR}`);

  // Pre-warm the tree cache in the background
  console.log("Pre-scanning photo tree in background...");
  fetch(`http://localhost:${PORT}/api/tree`).then(() => {
    console.log("Tree cache warmed successfully.");
  }).catch(() => {
    console.log("Background tree scan failed (will retry on first request).");
  });
});
