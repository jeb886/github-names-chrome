const ids = ["enabled", "showLogin"];
chrome.storage.sync.get({ enabled: true, showLogin: false }).then((s) => {
  for (const id of ids) {
    const el = document.getElementById(id);
    el.checked = s[id];
    el.addEventListener("change", () => chrome.storage.sync.set({ [id]: el.checked }));
  }
});
document.getElementById("clear").addEventListener("click", async () => {
  const keys = Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith("n:"));
  await chrome.storage.local.remove(keys);
  document.getElementById("status").textContent = `Cleared ${keys.length} names. Reload GitHub tabs.`;
});
