// State
let currentFiles = [];
let lightboxIndex = -1;

// DOM refs
const content = document.getElementById("content");
const breadcrumb = document.getElementById("breadcrumb");
const lightbox = document.getElementById("lightbox");
const lightboxImg = document.getElementById("lightbox-img");
const lightboxInfo = document.getElementById("lightbox-info");
const lightboxSpinner = document.getElementById("lightbox-spinner");
const filmStrip = document.getElementById("film-strip");

// Current route context for lightbox full-size URLs
let currentMonth = "";
let currentDay = "";

// Zoom/drag state
let zoomed = false;
let dragState = { dragging: false, startX: 0, startY: 0, scrollX: 0, scrollY: 0 };

// --- Routing ---

function navigate() {
  const hash = location.hash.slice(1) || "/";
  const parts = hash.split("/").filter(Boolean);

  if (parts.length === 0) {
    loadRoot();
  } else if (parts.length === 1) {
    loadMonth(parts[0]);
  } else if (parts.length === 2) {
    loadDay(parts[0], parts[1]);
  }
}

window.addEventListener("hashchange", navigate);
window.addEventListener("load", navigate);

// --- Breadcrumb ---

function setBreadcrumb(parts) {
  let html = '<a href="#/">Photos</a>';
  let hashPath = "#";
  for (const p of parts) {
    hashPath += "/" + p;
    html += '<span class="sep">/</span>';
    html += `<a href="${hashPath}">${p}</a>`;
  }
  breadcrumb.innerHTML = html;
}

// --- Helper: build thumb/photo URL ---

function thumbUrl(filename) {
  if (currentDay) return `/api/thumb/${currentMonth}/${currentDay}/${filename}`;
  return `/api/thumb/${currentMonth}/${filename}`;
}

function photoUrl(filename) {
  if (currentDay) return `/api/photo/${currentMonth}/${currentDay}/${filename}`;
  return `/api/photo/${currentMonth}/${filename}`;
}

// --- Views ---

async function loadRoot() {
  setBreadcrumb([]);
  content.innerHTML = '<div class="loading-msg">Loading folders...</div>';

  const folders = await fetch("/api/folders").then((r) => r.json());

  const grid = document.createElement("div");
  grid.className = "folder-grid";

  for (const name of folders) {
    const card = document.createElement("div");
    card.className = "folder-card";
    card.innerHTML = `
      <div class="folder-icon">📁</div>
      <div class="folder-name">${name}</div>
    `;
    card.onclick = () => (location.hash = `/${name}`);
    grid.appendChild(card);
  }

  content.innerHTML = "";
  content.appendChild(grid);
}

async function loadMonth(month) {
  setBreadcrumb([month]);
  content.innerHTML = '<div class="loading-msg">Loading...</div>';

  const data = await fetch(`/api/folders/${month}`).then((r) => r.json());

  // If this folder has photos directly (no subfolders)
  if (data.type === "photos") {
    currentMonth = month;
    currentDay = "";
    currentFiles = data.files;
    renderMasonry(data.files);
    return;
  }

  // Otherwise show subfolders
  const grid = document.createElement("div");
  grid.className = "folder-grid";

  for (const item of data.items) {
    const card = document.createElement("div");
    card.className = "folder-card";
    card.innerHTML = `
      <div class="folder-icon">📁</div>
      <div class="folder-name">${item.name}</div>
      <div class="folder-count">${item.count} photos</div>
    `;
    card.onclick = () => (location.hash = `/${month}/${item.name}`);
    grid.appendChild(card);
  }

  content.innerHTML = "";
  content.appendChild(grid);
}

async function loadDay(month, day) {
  setBreadcrumb([month, day]);
  currentMonth = month;
  currentDay = day;
  content.innerHTML = '<div class="loading-msg">Loading photos...</div>';

  const files = await fetch(`/api/folders/${month}/${day}`).then((r) =>
    r.json()
  );
  currentFiles = files;
  renderMasonry(files);
}

function renderMasonry(files) {
  if (files.length === 0) {
    content.innerHTML =
      '<div class="loading-msg">No JPEG files in this folder.</div>';
    return;
  }

  const masonry = document.createElement("div");
  masonry.className = "masonry";

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
    { rootMargin: "500px" }
  );

  for (let i = 0; i < files.length; i++) {
    const filename = files[i];
    const item = document.createElement("div");
    item.className = "masonry-item";

    const img = document.createElement("img");
    img.dataset.src = thumbUrl(filename);
    img.alt = filename;
    img.loading = "lazy";
    img.onload = () => {
      img.classList.add("loaded");
      item.style.minHeight = "";
    };

    const idx = i;
    item.onclick = () => openLightbox(idx);
    item.appendChild(img);
    masonry.appendChild(item);

    observer.observe(img);
  }

  content.innerHTML = "";
  content.appendChild(masonry);
}

// --- Lightbox ---

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

// --- Film Strip ---

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

  // Scroll active thumb into view
  const active = filmStrip.querySelector(".film-thumb.active");
  if (active) {
    active.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }
}

// --- Zoom & Drag ---

const imgContainer = document.getElementById("lightbox-img-container");

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

    // Center scroll on the double-click point
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

// Drag to pan when zoomed
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

// --- Lightbox event listeners ---

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
      if (zoomed) {
        resetZoom();
      } else {
        closeLightbox();
      }
      break;
    case "ArrowLeft":
      lightboxPrev();
      break;
    case "ArrowRight":
      lightboxNext();
      break;
  }
});
