// Resolve appearance before first paint. The app keeps Auto in sync afterward.
(() => {
  const shared = location.pathname.match(/^\/s\/([^/]+)\/?$/);
  if (shared) {
    window.__locdocOpen = fetch(
      `/api/open/${encodeURIComponent(shared[1])}${location.search}`,
      {
        credentials: "same-origin",
      },
    ).catch(() => null);
  }
  let preference = "auto";
  try {
    preference = localStorage.getItem("locdoc.theme") || "auto";
  } catch {}
  document.documentElement.dataset.theme =
    preference === "light" || preference === "dark"
      ? preference
      : matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
})();
