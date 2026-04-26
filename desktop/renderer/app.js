// ===========================================
// Config (for desktop app support)
// ===========================================
const API_BASE = window.__SCLOUD_CONFIG?.apiBase || '';

// ===========================================
// State
// ===========================================
let currentFiles = [];
let lightboxIndex = -1;
let currentMonth = "";
let currentDay = "";
let pswpOpen = false;
let pswpInstance = null;
let currentThumbTier = null;

// Gallery state
let treeData = null;
const fileCache = new Map(); // "month/day" -> string[]
const loadedSections = new Set(); // section keys currently with images in DOM
const sectionElements = new Map(); // section key -> { grid, month, day }

// DOM refs
const gallery = document.getElementById("gallery");
const filmStrip = document.getElementById("film-strip");
const metaPanel = document.getElementById("meta-panel");
const metaContent = document.getElementById("meta-content");
const zoomSlider = document.getElementById("zoom-slider");
const photoCount = document.getElementById("photo-count");
const scrollIndicator = document.getElementById("scroll-indicator");
const timelineNav = document.getElementById("timeline-nav");
const timelineContent = document.getElementById("timeline-content");
const timelineBackdrop = document.getElementById("timeline-backdrop");

// ===========================================
// Initialization
// ===========================================

async function init() {
  gallery.innerHTML = '<div class="loading-msg">Loading photo library...</div>';

  // Restore zoom
  const savedCols = localStorage.getItem("gridCols");
  if (savedCols) {
    const cols = parseInt(savedCols);
    zoomSlider.value = colsToSlider(cols);
    document.documentElement.style.setProperty("--grid-cols", cols);
    updateExtremeZoomClass(cols);
  }
  currentThumbTier = JSON.stringify(getThumbParams());

  try {
    const res = await fetch(API_BASE + "/api/tree");
    treeData = await res.json();
    photoCount.textContent = `Photos (${treeData.totalPhotos.toLocaleString()})`;
    buildGallery(treeData);
    buildTimelineNav(treeData);
    setupObservers();
    setupScrollIndicator();
  } catch (err) {
    gallery.innerHTML = '<div class="loading-msg">Failed to load photo library. Is the server running?</div>';
    console.error(err);
  }
}

// ===========================================
// Gallery Builder
// ===========================================

function buildGallery(tree) {
  gallery.innerHTML = "";
  let lastYear = null;

  // Timeline sections
  for (const monthGroup of tree.timeline) {
    // Year header
    if (monthGroup.year !== lastYear) {
      lastYear = monthGroup.year;
      const yearEl = document.createElement("div");
      yearEl.className = "year-header";
      yearEl.id = `year-${monthGroup.year}`;
      yearEl.textContent = monthGroup.year;
      gallery.appendChild(yearEl);
    }

    // Month header
    const monthEl = document.createElement("div");
    monthEl.className = "month-header";
    monthEl.id = `month-${monthGroup.month}`;
    const monthTotal = monthGroup.days.reduce((s, d) => s + d.count, 0);
    monthEl.textContent = `${monthGroup.monthName} · ${monthTotal.toLocaleString()}`;
    gallery.appendChild(monthEl);

    // Days
    for (const dayGroup of monthGroup.days) {
      // Day label
      if (dayGroup.day) {
        const dayLabel = document.createElement("div");
        dayLabel.className = "day-label";
        const parts = dayGroup.day.split(".");
        dayLabel.textContent = `${monthGroup.monthName} ${parseInt(parts[2])} · ${dayGroup.count}`;
        gallery.appendChild(dayLabel);
      }

      // Day grid (placeholder)
      const grid = document.createElement("div");
      grid.className = "day-grid placeholder";
      const sectionKey = dayGroup.day ? `${monthGroup.month}/${dayGroup.day}` : monthGroup.month;
      grid.dataset.month = monthGroup.month;
      grid.dataset.day = dayGroup.day || "";
      grid.dataset.count = dayGroup.count;
      grid.dataset.key = sectionKey;
      updatePlaceholderHeight(grid, dayGroup.count);
      gallery.appendChild(grid);

      sectionElements.set(sectionKey, {
        grid,
        month: monthGroup.month,
        day: dayGroup.day || ""
      });
    }
  }

  // Collections
  for (const col of tree.collections) {
    const colHeader = document.createElement("div");
    colHeader.className = "collections-header";
    colHeader.id = `col-${col.name}`;
    colHeader.textContent = col.name.replace(".x", "");
    gallery.appendChild(colHeader);

    for (const group of col.groups) {
      if (group.subfolder) {
        const label = document.createElement("div");
        label.className = "day-label";
        label.textContent = `${group.subfolder} · ${group.count}`;
        gallery.appendChild(label);
      }

      const grid = document.createElement("div");
      grid.className = "day-grid placeholder";
      const sectionKey = group.subfolder
        ? `${col.name}/${group.subfolder}`
        : col.name;
      grid.dataset.month = col.name;
      grid.dataset.day = group.subfolder || "";
      grid.dataset.count = group.count;
      grid.dataset.key = sectionKey;
      updatePlaceholderHeight(grid, group.count);
      gallery.appendChild(grid);

      sectionElements.set(sectionKey, {
        grid,
        month: col.name,
        day: group.subfolder || ""
      });
    }
  }
}

// ===========================================
// Non-linear zoom mapping (slider 0-100 → cols 2-500)
// ===========================================

function sliderToCols(val) {
  const t = val / 100;
  if (t <= 0.7) {
    // slider 0-70 → cols 2-20 (fine control)
    return Math.round(2 + 18 * (t / 0.7));
  } else {
    // slider 70-100 → cols 20-500 (quadratic)
    const t2 = (t - 0.7) / 0.3;
    return Math.round(20 + 480 * t2 * t2);
  }
}

function colsToSlider(cols) {
  if (cols <= 20) {
    return Math.round(((cols - 2) / 18) * 70);
  } else {
    const t2 = Math.sqrt((cols - 20) / 480);
    return Math.round(70 + t2 * 30);
  }
}

function getGridCols() {
  return sliderToCols(parseInt(zoomSlider.value) || 12);
}

function getCellSize() {
  const cols = getGridCols();
  const gap = cols > 50 ? 0 : 2;
  const w = window.innerWidth || 1280;
  return (w - gap * (cols - 1)) / cols;
}

// Adaptive thumbnail tier based on column count
function getThumbParams() {
  const cols = getGridCols();
  if (cols > 50) return { w: 50, q: 45 };
  if (cols > 20) return { w: 100, q: 50 };
  return null; // default server quality
}

function thumbQueryString() {
  const p = getThumbParams();
  if (!p) return '';
  return `?w=${p.w}&q=${p.q}`;
}

function updatePlaceholderHeight(grid, count) {
  const cols = getGridCols();
  const cellSize = getCellSize();
  const rows = Math.ceil(count / cols);
  grid.style.minHeight = `${rows * (cellSize + 2)}px`;
}

function updateAllPlaceholderHeights() {
  for (const [key, info] of sectionElements) {
    if (!loadedSections.has(key)) {
      updatePlaceholderHeight(info.grid, parseInt(info.grid.dataset.count));
    }
  }
}

// ===========================================
// Lazy Loading (Two-Tier)
// ===========================================

let lastScrollCheck = 0;

function setupObservers() {
  const onScroll = () => {
    const now = Date.now();
    if (now - lastScrollCheck < 100) return; // throttle to 10fps
    lastScrollCheck = now;
    checkVisibleSections();
    checkVisibleThumbs();
  };

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });

  // Initial check after layout settles
  setTimeout(onScroll, 100);
}

function checkVisibleSections() {
  const viewH = window.innerHeight;
  const grids = gallery.querySelectorAll(".day-grid");

  for (const grid of grids) {
    const rect = grid.getBoundingClientRect();
    // Load sections within 3000px of viewport
    if (rect.bottom > -3000 && rect.top < viewH + 3000) {
      if (!loadedSections.has(grid.dataset.key)) {
        loadSection(grid);
      }
    }
    // Unload sections far from viewport (>8000px away)
    if (loadedSections.has(grid.dataset.key)) {
      if (rect.bottom < -8000 || rect.top > viewH + 8000) {
        unloadSection(grid);
      }
    }
  }
}

function checkVisibleThumbs() {
  const viewH = window.innerHeight;
  // Only check loaded (non-placeholder) grids for thumbnail visibility
  for (const grid of gallery.querySelectorAll(".day-grid:not(.placeholder)")) {
    const gridRect = grid.getBoundingClientRect();
    // Skip grids far from viewport
    if (gridRect.bottom < -1500 || gridRect.top > viewH + 1500) continue;

    for (const img of grid.querySelectorAll("img[data-src]")) {
      const rect = img.getBoundingClientRect();
      if (rect.top < viewH + 1000 && rect.bottom > -1000) {
        const src = img.dataset.src;
        delete img.dataset.src;
        if (window.__SCLOUD_THUMB_URL) {
          // Desktop mode: use custom protocol for direct cached file serving
          img.src = window.__SCLOUD_THUMB_URL(src);
        } else {
          img.src = src;
        }
      } else if (rect.top > viewH + 1000) {
        break;
      }
    }
  }
}

async function loadSection(grid) {
  const key = grid.dataset.key;
  if (loadedSections.has(key)) return;
  loadedSections.add(key);

  const month = grid.dataset.month;
  const day = grid.dataset.day;

  let files = fileCache.get(key);
  if (!files) {
    try {
      if (day) {
        const res = await fetch(API_BASE + `/api/folders/${month}/${day}`);
        files = await res.json();
      } else {
        const res = await fetch(API_BASE + `/api/folders/${month}`);
        const data = await res.json();
        files = data.type === "photos" ? data.files : (Array.isArray(data) ? data : []);
      }
      fileCache.set(key, files);
    } catch {
      loadedSections.delete(key);
      return;
    }
  }

  renderSectionPhotos(grid, month, day, files);
}

function renderSectionPhotos(grid, month, day, files) {
  grid.innerHTML = "";
  grid.classList.remove("placeholder");
  grid.style.minHeight = "";

  for (let i = 0; i < files.length; i++) {
    const cell = document.createElement("div");
    cell.className = "photo-cell";

    const img = document.createElement("img");
    const qs = thumbQueryString();
    const thumbPath = day
      ? API_BASE + `/api/thumb/${month}/${day}/${files[i]}${qs}`
      : API_BASE + `/api/thumb/${month}/${files[i]}${qs}`;
    img.dataset.src = thumbPath;
    img.alt = files[i];
    img.loading = "lazy";
    img.onload = () => img.classList.add("loaded");

    const idx = i;
    cell.onclick = () => openLightboxFromGrid(month, day, files, idx);

    cell.appendChild(img);
    grid.appendChild(cell);
  }

  // Trigger a thumb visibility check for the newly rendered section
  checkVisibleThumbs();
}

function unloadSection(grid) {
  const key = grid.dataset.key;
  if (!loadedSections.has(key)) return;

  // Only unload if far from viewport
  const rect = grid.getBoundingClientRect();
  const viewH = window.innerHeight;
  if (rect.bottom > -5000 && rect.top < viewH + 5000) return;

  loadedSections.delete(key);
  const count = parseInt(grid.dataset.count);
  grid.innerHTML = "";
  grid.classList.add("placeholder");
  updatePlaceholderHeight(grid, count);
}

// ===========================================
// Zoom Control
// ===========================================

let zoomDebounceTimer = null;
zoomSlider.addEventListener("input", () => {
  const cols = sliderToCols(parseInt(zoomSlider.value));
  // Lightweight: just update CSS variable (GPU-accelerated grid reflow)
  document.documentElement.style.setProperty("--grid-cols", cols);
  localStorage.setItem("gridCols", cols);
  updateExtremeZoomClass(cols);

  // Debounce the heavy work (placeholder recalc, section reload) while dragging
  clearTimeout(zoomDebounceTimer);
  zoomDebounceTimer = setTimeout(() => {
    updateAllPlaceholderHeights();

    // If thumbnail tier changed, re-render loaded sections
    const newTier = JSON.stringify(getThumbParams());
    if (newTier !== currentThumbTier) {
      currentThumbTier = newTier;
      reloadVisibleSections();
    }
    checkVisibleSections();
    checkVisibleThumbs();
  }, 150);
});

function updateExtremeZoomClass(cols) {
  document.body.classList.toggle("extreme-zoom", cols > 50);
}

function reloadVisibleSections() {
  for (const key of [...loadedSections]) {
    const info = sectionElements.get(key);
    if (!info) continue;
    loadedSections.delete(key);
    const count = parseInt(info.grid.dataset.count);
    info.grid.innerHTML = "";
    info.grid.classList.add("placeholder");
    updatePlaceholderHeight(info.grid, count);
  }
  checkVisibleSections();
}

// Ctrl+scroll to zoom
document.addEventListener("wheel", (e) => {
  if (!e.ctrlKey) return;
  if (pswpOpen) return;
  e.preventDefault();
  const current = parseInt(zoomSlider.value);
  const step = current < 70 ? 2 : 1; // finer steps in extreme range
  const next = e.deltaY > 0 ? Math.min(100, current + step) : Math.max(0, current - step);
  if (next !== current) {
    zoomSlider.value = next;
    zoomSlider.dispatchEvent(new Event("input"));
  }
}, { passive: false });

// ===========================================
// Timeline Navigator
// ===========================================

// Jump to an element and force-load sections that become visible
function jumpToElement(el) {
  if (!el) return;
  el.scrollIntoView({ behavior: "instant" });
  setTimeout(() => {
    checkVisibleSections();
    checkVisibleThumbs();
  }, 50);
}

function buildTimelineNav(tree) {
  timelineContent.innerHTML = "";
  let lastYear = null;

  for (const mg of tree.timeline) {
    if (mg.year !== lastYear) {
      lastYear = mg.year;
      const yearEl = document.createElement("div");
      yearEl.className = "nav-year";
      yearEl.textContent = mg.year;
      yearEl.onclick = () => {
        closeTimeline();
        jumpToElement(document.getElementById(`year-${mg.year}`));
      };
      timelineContent.appendChild(yearEl);
    }

    const monthEl = document.createElement("div");
    monthEl.className = "nav-month";
    const total = mg.days.reduce((s, d) => s + d.count, 0);
    monthEl.innerHTML = `<span>${mg.monthName}</span><span class="count">${total.toLocaleString()}</span>`;
    monthEl.onclick = () => {
      closeTimeline();
      jumpToElement(document.getElementById(`month-${mg.month}`));
    };
    timelineContent.appendChild(monthEl);
  }

  // Collections
  for (const col of tree.collections) {
    const colEl = document.createElement("div");
    colEl.className = "nav-year";
    colEl.textContent = col.name.replace(".x", "");
    colEl.onclick = () => {
      closeTimeline();
      jumpToElement(document.getElementById(`col-${col.name}`));
    };
    timelineContent.appendChild(colEl);
  }
}

document.getElementById("nav-toggle").onclick = () => {
  const isOpen = timelineNav.classList.contains("open");
  if (isOpen) closeTimeline();
  else openTimeline();
};

timelineBackdrop.onclick = closeTimeline;

function openTimeline() {
  timelineNav.classList.remove("hidden");
  timelineNav.classList.add("open");
  timelineBackdrop.classList.remove("hidden");
  timelineBackdrop.classList.add("open");
}

function closeTimeline() {
  timelineNav.classList.remove("open");
  timelineBackdrop.classList.remove("open");
}

// ===========================================
// Scroll Indicator
// ===========================================

let scrollTimeout;

function setupScrollIndicator() {
  window.addEventListener("scroll", () => {
    updateScrollIndicator();
    scrollIndicator.classList.add("visible");
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
      scrollIndicator.classList.remove("visible");
    }, 1500);
  }, { passive: true });
}

function updateScrollIndicator() {
  // Find the topmost visible year/month header
  const headers = gallery.querySelectorAll(".year-header, .month-header");
  let current = "";
  const toolbarBottom = 48 + 10;

  for (const h of headers) {
    const rect = h.getBoundingClientRect();
    if (rect.top <= toolbarBottom + 50) {
      current = h.textContent;
    } else {
      break;
    }
  }

  if (current) {
    scrollIndicator.textContent = current;
  }
}

// ===========================================
// PhotoSwipe — lazy-load ESM
// ===========================================

let metaCache = new Map();

async function getPhotoSwipe() {
  if (window.__PhotoSwipeClass) return window.__PhotoSwipeClass;
  const mod = await import("./vendor/photoswipe.esm.min.js");
  window.__PhotoSwipeClass = mod.default;
  return window.__PhotoSwipeClass;
}

// ===========================================
// Lightbox URL helpers
// ===========================================

function lbThumbUrl(filename) {
  const rawUrl = currentDay
    ? API_BASE + `/api/thumb/${currentMonth}/${currentDay}/${filename}`
    : API_BASE + `/api/thumb/${currentMonth}/${filename}`;
  // In desktop mode: serve via scloud-thumb:// protocol for local caching
  if (window.__SCLOUD_THUMB_URL) return window.__SCLOUD_THUMB_URL(rawUrl);
  return rawUrl;
}

function lbPhotoUrl(filename) {
  const apiPath = currentDay
    ? `/api/photo/${currentMonth}/${currentDay}/${filename}`
    : `/api/photo/${currentMonth}/${filename}`;
  // In desktop mode: append auth token so <img src> works without cookies
  if (window.__SCLOUD_PHOTO_URL_SYNC) return window.__SCLOUD_PHOTO_URL_SYNC(apiPath);
  return API_BASE + apiPath;
}

// ===========================================
// Open with PhotoSwipe
// ===========================================

async function openLightboxFromGrid(month, day, files, index) {
  currentMonth = month;
  currentDay = day || "";
  currentFiles = files;
  lightboxIndex = index;
  await openWithPhotoSwipe(index);
}

// Cache image dimensions to avoid the lightbox stretching before loadComplete fires.
// Map<photoUrl, {width, height}>
const photoDimsCache = new Map();

function preloadPhotoDims(src) {
  if (photoDimsCache.has(src)) return Promise.resolve(photoDimsCache.get(src));
  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => resolve(null), 2000);
    img.onload = () => {
      clearTimeout(timer);
      const d = { width: img.naturalWidth, height: img.naturalHeight };
      photoDimsCache.set(src, d);
      resolve(d);
    };
    img.onerror = () => { clearTimeout(timer); resolve(null); };
    img.src = src;
  });
}

async function openWithPhotoSwipe(index) {
  if (pswpInstance) { pswpInstance.destroy(); pswpInstance = null; }

  const PhotoSwipe = await getPhotoSwipe();

  // Pre-fetch dims for the clicked image so the first slide opens at correct
  // aspect ratio without a flash. Other images will be fixed via loadComplete.
  const clickedSrc = lbPhotoUrl(currentFiles[index]);
  await preloadPhotoDims(clickedSrc);

  const items = currentFiles.map(f => {
    const src = lbPhotoUrl(f);
    const cached = photoDimsCache.get(src);
    return {
      src,
      alt: f,
      width:  cached ? cached.width  : 0,
      height: cached ? cached.height : 0,
    };
  });

  pswpInstance = new PhotoSwipe({
    dataSource: items,
    index,
    bgOpacity: 0.92,
    history: false,
    zoom: true,
    close: true,
    counter: true,
    arrowKeys: true,
    wheelToZoom: true,
    initialZoomLevel: "fit",
    secondaryZoomLevel: 1,    // 1:1 native pixels (~100%)
    maxZoomLevel: 8,
    padding: { top: 0, bottom: 90, left: 0, right: 0 },
  });

  // Add ℹ info button to PhotoSwipe toolbar
  pswpInstance.on("uiRegister", () => {
    pswpInstance.ui.registerElement({
      name: "info-button",
      title: "Photo info",
      order: 9,
      isButton: true,
      html: "&#9432;",
      appendTo: "bar",
      onClick: (e, el) => {
        const isOpen = !metaPanel.classList.contains("hidden");
        if (isOpen) closeMetaPanel(el);
        else openMetaPanel(el);
      },
    });
  });

  pswpInstance.on("change", () => {
    lightboxIndex = pswpInstance.currIndex;
    updateFilmStripHighlight();
    closeMetaPanel();
  });

  // Fix aspect ratio: without correct width/height PhotoSwipe stretches the
  // image to the viewport. When the real image loads, sync its naturalWidth/
  // Height into the Content, the data source, AND the Slide instance, then
  // recompute zoomLevels and re-render. (Updating only data.width is NOT
  // enough — Slide caches width/height in its constructor.)
  pswpInstance.on("loadComplete", (e) => {
    const content = e.content;
    const slide   = e.slide;
    const img     = content?.element;
    if (!img || !img.naturalWidth) return;

    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (content.width === w && content.height === h) return;

    // 1) Content state
    content.width  = w;
    content.height = h;
    if (content.data) {
      content.data.width  = w;
      content.data.height = h;
    }

    // 2) Slide state + recompute layout
    if (slide) {
      slide.width  = w;
      slide.height = h;
      slide.calculateSize();
      slide.updateContentSize(true);
      if (slide.isActive) {
        slide.zoomAndPanToInitial();
        slide.applyCurrentZoomPan();
      }
    }

    // 3) Cache for next open
    if (content.data?.src) {
      photoDimsCache.set(content.data.src, { width: w, height: h });
    }
  });

  pswpInstance.on("afterInit", () => {
    buildFilmStrip();
    filmStrip.classList.remove("hidden");
    pswpOpen = true;
  });

  pswpInstance.on("beforeClose", () => {
    closeMetaPanel();
    filmStrip.classList.add("hidden");
  });

  pswpInstance.on("destroy", () => {
    pswpInstance = null;
    pswpOpen = false;
  });

  pswpInstance.init();
}

// ===========================================
// Film Strip
// ===========================================

function buildFilmStrip() {
  filmStrip.innerHTML = "";
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const img = entry.target;
          img.src = img.dataset.src;
          observer.unobserve(img);
        }
      }
    },
    { root: filmStrip, rootMargin: "200px" }
  );

  for (let i = 0; i < currentFiles.length; i++) {
    const thumb = document.createElement("div");
    thumb.className = "film-thumb";

    const img = document.createElement("img");
    img.dataset.src = lbThumbUrl(currentFiles[i]);
    img.alt = currentFiles[i];

    const idx = i;
    thumb.onclick = () => {
      lightboxIndex = idx;
      if (pswpInstance) pswpInstance.goTo(idx);
    };

    thumb.appendChild(img);
    filmStrip.appendChild(thumb);
    observer.observe(img);
  }
  updateFilmStripHighlight();
}

function updateFilmStripHighlight() {
  const idx = pswpInstance ? pswpInstance.currIndex : lightboxIndex;
  const thumbs = filmStrip.querySelectorAll(".film-thumb");
  thumbs.forEach((t, i) => t.classList.toggle("active", i === idx));
  const active = filmStrip.querySelector(".film-thumb.active");
  if (active) active.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
}

// ===========================================
// Metadata Panel
// ===========================================

function closeMetaPanel(infoBtn) {
  metaPanel.classList.add("hidden");
  const btn = infoBtn || document.querySelector(".pswp__button--info-button");
  if (btn) btn.style.color = "";
}

async function openMetaPanel(infoBtn) {
  metaPanel.classList.remove("hidden");
  if (infoBtn) infoBtn.style.color = "#8ab4f8";

  const filename = currentFiles[lightboxIndex];
  const key = `${currentMonth}/${currentDay ? currentDay + "/" : ""}${filename}`;

  if (metaCache.has(key)) { renderMeta(metaCache.get(key), filename); return; }

  metaContent.innerHTML = '<span class="meta-label">Loading...</span>';
  try {
    const url = currentDay
      ? API_BASE + `/api/exif/${currentMonth}/${currentDay}/${filename}`
      : API_BASE + `/api/exif/${currentMonth}/${filename}`;
    const res = await fetch(url);
    const data = await res.json();
    metaCache.set(key, data);
    renderMeta(data, filename);
  } catch {
    metaContent.innerHTML = '<span class="meta-label">Failed to load metadata</span>';
  }
}

function renderMeta(data, filename) {
  const rows = [];
  function row(label, value) {
    if (value !== undefined && value !== null && value !== "")
      rows.push(`<span class="meta-label">${label}</span><span class="meta-value">${value}</span>`);
  }
  function divider() { rows.push('<div class="meta-divider"></div>'); }

  row("Filename", filename);
  row("Dimensions", data.width && data.height ? `${data.width} × ${data.height}` : null);
  row("Format", data.format?.toUpperCase());

  if (data.make || data.model || data.lensModel) {
    divider();
    row("Camera", [data.make, data.model].filter(Boolean).join(" "));
    row("Lens", data.lensModel || data.lensMake);
  }
  if (data.focalLength || data.fNumber || data.exposureTime || data.iso) {
    divider();
    row("Focal Length", data.focalLength);
    if (data.focalLengthIn35mm) row("35mm Equiv.", data.focalLengthIn35mm);
    row("Aperture", data.fNumber);
    row("Shutter", data.exposureTime ? `${data.exposureTime}s` : null);
    row("ISO", data.iso);
  }
  if (data.exposureProgram || data.meteringMode || data.flash || data.exposureBias) {
    divider();
    row("Mode", data.exposureProgram);
    row("Metering", data.meteringMode);
    row("Flash", data.flash);
    row("Exp. Comp.", data.exposureBias);
  }
  if (data.dateTimeOriginal) {
    divider();
    row("Date Taken", data.dateTimeOriginal);
  }

  metaContent.innerHTML = rows.join("\n");
}

// ===========================================
// Start
// ===========================================

init();
