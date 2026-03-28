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

// Current route context for lightbox full-size URLs
let currentMonth = "";
let currentDay = "";

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
  content.innerHTML = '<div class="loading-msg">Loading folders...</div>';

  const folders = await fetch(`/api/folders/${month}`).then((r) => r.json());

  const grid = document.createElement("div");
  grid.className = "folder-grid";

  for (const item of folders) {
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

  if (files.length === 0) {
    content.innerHTML =
      '<div class="loading-msg">No JPEG files in this folder.</div>';
    return;
  }

  const masonry = document.createElement("div");
  masonry.className = "masonry";

  // IntersectionObserver for lazy loading
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
    img.dataset.src = `/api/thumb/${month}/${day}/${filename}`;
    img.alt = filename;
    img.loading = "lazy";
    img.onload = () => {
      img.classList.add("loaded");
      // Remove min-height once loaded so masonry reflows correctly
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
  loadLightboxImage(index);
  document.body.style.overflow = "hidden";
}

function closeLightbox() {
  lightbox.classList.add("hidden");
  lightboxImg.src = "";
  document.body.style.overflow = "";
}

function loadLightboxImage(index) {
  const filename = currentFiles[index];
  lightboxSpinner.classList.remove("hidden");
  lightboxImg.style.opacity = "0";

  lightboxImg.onload = () => {
    lightboxSpinner.classList.add("hidden");
    lightboxImg.style.opacity = "1";
  };

  lightboxImg.src = `/api/photo/${currentMonth}/${currentDay}/${filename}`;
  lightboxInfo.textContent = `${filename}  (${index + 1} / ${currentFiles.length})`;
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

// Lightbox event listeners
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
      closeLightbox();
      break;
    case "ArrowLeft":
      lightboxPrev();
      break;
    case "ArrowRight":
      lightboxNext();
      break;
  }
});
