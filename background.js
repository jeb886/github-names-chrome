const KEY_PREFIX = "n:";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function pruneExpired() {
  const all = await chrome.storage.local.get(null);
  const now = Date.now();
  const expired = Object.entries(all)
    .filter(([k, v]) => (k.startsWith(KEY_PREFIX) && !(now - v?.t < TTL_MS)) || k === "names")
    .map(([k]) => k);
  if (expired.length) await chrome.storage.local.remove(expired);
}

chrome.runtime.onInstalled.addListener(pruneExpired);
chrome.runtime.onStartup.addListener(pruneExpired);
