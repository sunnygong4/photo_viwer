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

// GET /api/exif/:month/:filename - EXIF metadata for photos in month folder
app.get("/api/exif/:month/:filename", async (req, res) => {
  const { month, filename } = req.params;
  if (!safePath(month) || !safePath(filename))
    return res.status(400).json({ error: "Invalid path" });
  const filePath = path.join(PHOTOS_ROOT, month, filename);
  try {
    const meta = await sharp(filePath).metadata();
    res.json(formatExif(meta));
  } catch {
    res.status(404).json({ error: "Could not read metadata" });
  }
});

// GET /api/exif/:month/:day/:filename - EXIF metadata for photos in day folder
app.get("/api/exif/:month/:day/:filename", async (req, res) => {
  const { month, day, filename } = req.params;
  if (!safePath(month) || !safePath(day) || !safePath(filename))
    return res.status(400).json({ error: "Invalid path" });
  const filePath = path.join(PHOTOS_ROOT, month, day, filename);
  try {
    const meta = await sharp(filePath).metadata();
    res.json(formatExif(meta));
  } catch {
    res.status(404).json({ error: "Could not read metadata" });
  }
});

function formatExif(meta: any) {
  const exif = meta.exif ? parseExifBuffer(meta.exif) : {};
  return {
    width: meta.width,
    height: meta.height,
    format: meta.format,
    space: meta.space,
    density: meta.density,
    ...exif,
  };
}

function parseExifBuffer(buf: Buffer) {
  // Sharp gives raw EXIF buffer; use a lightweight parser
  // We'll extract common tags from the IFD0 and EXIF sub-IFD
  try {
    const result: Record<string, any> = {};
    // Check for EXIF header
    if (buf.length < 10) return result;

    let offset = 0;
    // Skip "Exif\0\0" header if present
    if (buf[0] === 0x45 && buf[1] === 0x78) offset = 6;

    const tiffStart = offset;
    const isLE = buf.readUInt16BE(offset) === 0x4949;
    const read16 = isLE ? (o: number) => buf.readUInt16LE(o) : (o: number) => buf.readUInt16BE(o);
    const read32 = isLE ? (o: number) => buf.readUInt32LE(o) : (o: number) => buf.readUInt32BE(o);
    const readS32 = isLE ? (o: number) => buf.readInt32LE(o) : (o: number) => buf.readInt32BE(o);

    function readRational(o: number) {
      const num = read32(o);
      const den = read32(o + 4);
      return den ? num / den : 0;
    }
    function readSRational(o: number) {
      const num = readS32(o);
      const den = readS32(o + 4);
      return den ? num / den : 0;
    }
    function readString(o: number, len: number) {
      return buf.subarray(o, o + len).toString("ascii").replace(/\0+$/, "").trim();
    }

    function readValue(tag: number, type: number, count: number, valueOffset: number) {
      const totalBytes = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8][type] * count;
      const dataOff = totalBytes <= 4 ? valueOffset : tiffStart + read32(valueOffset);
      if (dataOff + totalBytes > buf.length) return null;

      if (type === 2) return readString(dataOff, count); // ASCII
      if (type === 5) return readRational(dataOff); // RATIONAL
      if (type === 10) return readSRational(dataOff); // SRATIONAL
      if (type === 3 && count === 1) return read16(dataOff); // SHORT
      if (type === 4 && count === 1) return read32(dataOff); // LONG
      return null;
    }

    const TAGS: Record<number, string> = {
      0x010f: "make", 0x0110: "model",
      0x8769: "_exifIFD", 0xa005: "_interopIFD",
      0x829a: "exposureTime", 0x829d: "fNumber",
      0x8827: "iso", 0x9003: "dateTimeOriginal",
      0x920a: "focalLength", 0xa405: "focalLengthIn35mm",
      0xa434: "lensModel", 0xa433: "lensMake",
      0x0112: "orientation", 0xa002: "pixelXDimension", 0xa003: "pixelYDimension",
      0x9204: "exposureBias", 0x9207: "meteringMode",
      0x8822: "exposureProgram", 0xa406: "sceneCaptureType",
      0x9209: "flash",
    };

    const METERING: Record<number, string> = {
      0: "Unknown", 1: "Average", 2: "Center-weighted", 3: "Spot",
      4: "Multi-spot", 5: "Multi-segment", 6: "Partial",
    };
    const EXPOSURE_PROG: Record<number, string> = {
      0: "Unknown", 1: "Manual", 2: "Program AE", 3: "Aperture Priority",
      4: "Shutter Priority", 5: "Creative", 6: "Action", 7: "Portrait",
    };

    function parseIFD(ifdOffset: number) {
      if (ifdOffset + 2 > buf.length) return;
      const entries = read16(ifdOffset);
      for (let i = 0; i < entries; i++) {
        const entryOff = ifdOffset + 2 + i * 12;
        if (entryOff + 12 > buf.length) break;
        const tag = read16(entryOff);
        const type = read16(entryOff + 2);
        const count = read32(entryOff + 4);
        const valueOff = entryOff + 8;

        const name = TAGS[tag];
        if (!name) continue;

        if (name === "_exifIFD") {
          const subOffset = tiffStart + read32(valueOff);
          parseIFD(subOffset);
          continue;
        }
        if (name === "_interopIFD") continue;

        const val = readValue(tag, type, count, valueOff);
        if (val === null || val === undefined) continue;

        if (name === "exposureTime") {
          result[name] = val < 1 ? `1/${Math.round(1 / val)}` : `${val}`;
          result.exposureTimeValue = val;
        } else if (name === "fNumber") {
          result[name] = `f/${val.toFixed(1)}`;
        } else if (name === "focalLength") {
          result[name] = `${val.toFixed(1)}mm`;
        } else if (name === "focalLengthIn35mm") {
          result[name] = `${val}mm`;
        } else if (name === "exposureBias") {
          result[name] = `${val >= 0 ? "+" : ""}${val.toFixed(1)} EV`;
        } else if (name === "meteringMode") {
          result[name] = METERING[val as number] || `${val}`;
        } else if (name === "exposureProgram") {
          result[name] = EXPOSURE_PROG[val as number] || `${val}`;
        } else if (name === "flash") {
          result[name] = (val as number) & 1 ? "Fired" : "No flash";
        } else {
          result[name] = val;
        }
      }
    }

    // Parse IFD0
    const ifd0Offset = tiffStart + read32(tiffStart + 4);
    parseIFD(ifd0Offset);
    return result;
  } catch {
    return {};
  }
}

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
