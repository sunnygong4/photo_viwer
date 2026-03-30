// ===========================================
// State
// ===========================================
let currentFiles = [];
let lightboxIndex = -1;
let currentMonth = "";
let currentDay = "";
let zoomed = false;
let dragState = { dragging: false, startX: 0, startY: 0, scrollX: 0, scrollY: 0 };

// Gallery state
let treeData = null;
const fileCache = new Map(); // "month/day" -> string[]
const loadedSections = new Set(); // section keys currently with images in DOM
const sectionElements = new Map(); // section key -> { grid, month, day }

// DOM refs
const gallery = document.getElementById("gallery");
const lightbox = document.getElementById("lightbox");
const lightboxImg = document.getElementById("lightbox-img");
const lightboxInfo = document.getElementById("lightbox-info");
const lightboxSpinner = document.getElementById("lightbox-spinner");
const filmStrip = document.getElementById("film-strip");
const zoomSlider = document.getElementById("zoom-slider");
const photoCount = document.getElementById("photo-count");
const scrollIndicator = document.getElementById("scroll-indicator");
const timelineNav = document.getElementById("timeline-nav");
const timelineContent = document.getElementById("timeline-content");
const timelineBackdrop = document.getElementById("timeline-backdrop");
const imgContainer = document.getElementById("lightbox-img-container");

// ===========================================
// Initialization
// ===========================================

async function init() {
  gallery.innerHTML = '<div class="loading-msg">Loading photo library...</div>';

  // Restore zoom
  const savedZoom = localStorage.getItem("gridCols");
  if (savedZoom) {
    const cols = parseInt(savedZoom);
    zoomSlider.value = cols;
    document.documentElement.style.setProperty("--grid-cols", cols);
  }

  try {
    const res = await fetch("/api/tree");
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

function getGridCols() {
  return parseInt(zoomSlider.value) || 5;
}

function getCellSize() {
  const cols = getGridCols();
  const gap = 2;
  const w = window.innerWidth || 1280;
  return (w - gap * (cols - 1)) / cols;
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
        img.src = img.dataset.src;
        delete img.dataset.src;
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
        const res = await fetch(`/api/folders/${month}/${day}`);
        files = await res.json();
      } else {
        const res = await fetch(`/api/folders/${month}`);
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
    const thumbPath = day
      ? `/api/thumb/${month}/${day}/${files[i]}`
      : `/api/thumb/${month}/${files[i]}`;
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

zoomSlider.addEventListener("input", () => {
  const cols = parseInt(zoomSlider.value);
  document.documentElement.style.setProperty("--grid-cols", cols);
  localStorage.setItem("gridCols", cols);
  updateAllPlaceholderHeights();
});

// Ctrl+scroll to zoom
document.addEventListener("wheel", (e) => {
  if (!e.ctrlKey) return;
  if (!lightbox.classList.contains("hidden")) return;
  e.preventDefault();
  const current = parseInt(zoomSlider.value);
  const next = e.deltaY > 0 ? Math.min(12, current + 1) : Math.max(2, current - 1);
  if (next !== current) {
    zoomSlider.value = next;
    zoomSlider.dispatchEvent(new Event("input"));
  }
}, { passive: false });

// ===========================================
// Timeline Navigator
// ===========================================

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
        document.getElementById(`year-${mg.year}`)?.scrollIntoView({ behavior: "smooth" });
        closeTimeline();
      };
      timelineContent.appendChild(yearEl);
    }

    const monthEl = document.createElement("div");
    monthEl.className = "nav-month";
    const total = mg.days.reduce((s, d) => s + d.count, 0);
    monthEl.innerHTML = `<span>${mg.monthName}</span><span class="count">${total.toLocaleString()}</span>`;
    monthEl.onclick = () => {
      document.getElementById(`month-${mg.month}`)?.scrollIntoView({ behavior: "smooth" });
      closeTimeline();
    };
    timelineContent.appendChild(monthEl);
  }

  // Collections
  for (const col of tree.collections) {
    const colEl = document.createElement("div");
    colEl.className = "nav-year";
    colEl.textContent = col.name.replace(".x", "");
    colEl.onclick = () => {
      document.getElementById(`col-${col.name}`)?.scrollIntoView({ behavior: "smooth" });
      closeTimeline();
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
// URL helpers
// ===========================================

function thumbUrl(filename) {
  if (currentDay) return `/api/thumb/${currentMonth}/${currentDay}/${filename}`;
  return `/api/thumb/${currentMonth}/${filename}`;
}

function photoUrl(filename) {
  if (currentDay) return `/api/photo/${currentMonth}/${currentDay}/${filename}`;
  return `/api/photo/${currentMonth}/${filename}`;
}

// ===========================================
// Lightbox
// ===========================================

function openLightboxFromGrid(month, day, files, index) {
  currentMonth = month;
  currentDay = day || "";
  currentFiles = files;
  openLightbox(index);
}

function openLightbox(index) {
  lightboxIndex = index;
  lightbox.classList.remove("hidden");
  resetZoom();
  loadLightboxImage(index);
  buildFilmStrip();
  document.body.style.overflow = "hidden";
}

function closeLightbox() {
  lightbox.classList.add("hidden");
  lightboxImg.src = "";
  resetZoom();
  document.body.style.overflow = "";
}

function loadLightboxImage(index) {
  const filename = currentFiles[index];
  lightboxSpinner.classList.remove("hidden");
  lightboxImg.style.opacity = "0";
  resetZoom();

  lightboxImg.onload = () => {
    lightboxSpinner.classList.add("hidden");
    lightboxImg.style.opacity = "1";
  };

  lightboxImg.src = photoUrl(filename);
  lightboxInfo.textContent = `${filename}  (${index + 1} / ${currentFiles.length})`;
  updateFilmStripHighlight();
}

function lightboxPrev() {
  if (lightboxIndex > 0) {
    lightboxIndex--;
    loadLightboxImage(lightboxIndex);
  }
}

function lightboxNext() {
  if (lightboxIndex < currentFiles.length - 1) {
    lightboxIndex++;
    loadLightboxImage(lightboxIndex);
  }
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
    thumb.dataset.index = i;

    const img = document.createElement("img");
    img.dataset.src = thumbUrl(currentFiles[i]);
    img.alt = currentFiles[i];

    const idx = i;
    thumb.onclick = (e) => {
      e.stopPropagation();
      lightboxIndex = idx;
      loadLightboxImage(idx);
    };

    thumb.appendChild(img);
    filmStrip.appendChild(thumb);
    observer.observe(img);
  }

  updateFilmStripHighlight();
}

function updateFilmStripHighlight() {
  const thumbs = filmStrip.querySelectorAll(".film-thumb");
  thumbs.forEach((t, i) => {
    t.classList.toggle("active", i === lightboxIndex);
  });
  const active = filmStrip.querySelector(".film-thumb.active");
  if (active) {
    active.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }
}

// ===========================================
// Zoom & Drag (Lightbox)
// ===========================================

function resetZoom() {
  zoomed = false;
  lightboxImg.classList.remove("zoomed");
  imgContainer.scrollLeft = 0;
  imgContainer.scrollTop = 0;
  imgContainer.classList.remove("zoomed");
}

function toggleZoom(e) {
  if (zoomed) {
    resetZoom();
  } else {
    zoomed = true;
    lightboxImg.classList.add("zoomed");
    imgContainer.classList.add("zoomed");
    requestAnimationFrame(() => {
      const rect = imgContainer.getBoundingClientRect();
      const clickX = (e.clientX - rect.left) / rect.width;
      const clickY = (e.clientY - rect.top) / rect.height;
      imgContainer.scrollLeft = (imgContainer.scrollWidth - rect.width) * clickX;
      imgContainer.scrollTop = (imgContainer.scrollHeight - rect.height) * clickY;
    });
  }
}

imgContainer.addEventListener("dblclick", (e) => {
  e.preventDefault();
  e.stopPropagation();
  toggleZoom(e);
});

imgContainer.addEventListener("mousedown", (e) => {
  if (!zoomed) return;
  e.preventDefault();
  dragState.dragging = true;
  dragState.startX = e.clientX;
  dragState.startY = e.clientY;
  dragState.scrollX = imgContainer.scrollLeft;
  dragState.scrollY = imgContainer.scrollTop;
  imgContainer.style.cursor = "grabbing";
});

window.addEventListener("mousemove", (e) => {
  if (!dragState.dragging) return;
  imgContainer.scrollLeft = dragState.scrollX - (e.clientX - dragState.startX);
  imgContainer.scrollTop = dragState.scrollY - (e.clientY - dragState.startY);
});

window.addEventListener("mouseup", () => {
  if (!dragState.dragging) return;
  dragState.dragging = false;
  imgContainer.style.cursor = "";
});

// ===========================================
// Lightbox Event Listeners
// ===========================================

document.getElementById("lightbox-backdrop").onclick = closeLightbox;
document.getElementById("lightbox-close").onclick = closeLightbox;
document.getElementById("lightbox-prev").onclick = (e) => {
  e.stopPropagation();
  lightboxPrev();
};
document.getElementById("lightbox-next").onclick = (e) => {
  e.stopPropagation();
  lightboxNext();
};

document.addEventListener("keydown", (e) => {
  if (lightbox.classList.contains("hidden")) return;
  switch (e.key) {
    case "Escape":
      if (zoomed) resetZoom();
      else closeLightbox();
      break;
    case "ArrowLeft":
      lightboxPrev();
      break;
    case "ArrowRight":
      lightboxNext();
      break;
  }
});

// ===========================================
// Start
// ===========================================

init();
