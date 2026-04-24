// Bridge layer: makes the web app work inside Electron with local thumbnail caching.
// Sets up window.__SCLOUD_CONFIG and overrides fetch/image loading for caching.

(async () => {
  if (!window.scloud) return; // Not in Electron, skip

  const config = await window.scloud.getConfig();

  // Signal to app.js that we're in desktop mode
  window.__SCLOUD_CONFIG = {
    apiBase: "", // We intercept locally, no base URL needed
    isDesktop: true,
  };

  // Override global fetch to route API calls through Electron IPC
  const originalFetch = window.fetch;
  window.fetch = async function (url, opts) {
    const urlStr = typeof url === "string" ? url : url.toString();

    // Only intercept our API calls
    if (!urlStr.startsWith("/api/")) return originalFetch(url, opts);

    const result = await window.scloud.apiFetch(urlStr);
    if (!result.ok) throw new Error(result.error || "API fetch failed");

    return new Response(result.data, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  // Convert API thumb paths to custom protocol URLs served directly by main process
  // No IPC round-trip or base64 encoding — Electron serves cached files natively
  window.__SCLOUD_THUMB_URL = function (apiPath) {
    // apiPath like /api/thumb/2026.03.x/2026.03.17/IMG_5318.JPG?w=100&q=50
    const stripped = apiPath.replace(/^\/api\/thumb\//, "");
    // Split path and query string
    const qIdx = stripped.indexOf("?");
    const pathPart = qIdx >= 0 ? stripped.substring(0, qIdx) : stripped;
    const qsPart = qIdx >= 0 ? stripped.substring(qIdx) : "";
    return `scloud-thumb://thumb/${pathPart}${qsPart}`;
  };

  // Synchronous version — used by PhotoSwipe data source (must be sync)
  const DESKTOP_TOKEN = "scloud-desktop-v1-a9f3c2e8b7d4";
  window.__SCLOUD_PHOTO_URL_SYNC = function (apiPath) {
    const sep = apiPath.includes("?") ? "&" : "?";
    return `${config.serverUrl}${apiPath}${sep}_t=${DESKTOP_TOKEN}`;
  };

  // Async version (legacy, kept for compatibility)
  window.__SCLOUD_PHOTO_URL = async function (apiPath) {
    return await window.scloud.photoUrl(apiPath);
  };
})();
