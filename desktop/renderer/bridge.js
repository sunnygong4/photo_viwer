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

  // Provide a function to load thumbnails via IPC with local caching
  // This returns a blob URL from the cached/fetched data
  window.__SCLOUD_THUMB = async function (apiPath) {
    const result = await window.scloud.thumbFetch(apiPath);
    if (!result.ok) return null;
    // Convert base64 to blob URL
    const binary = atob(result.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: "image/jpeg" });
    return URL.createObjectURL(blob);
  };

  // Provide a function to get full photo URL from server
  window.__SCLOUD_PHOTO_URL = async function (apiPath) {
    return await window.scloud.photoUrl(apiPath);
  };
})();
