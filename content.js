(() => {
  const KEY_PREFIX = "n:";
  const PAUSE_KEY = "pausedUntil";
  const TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const DEFAULT_PAUSE_MS = 5 * 60 * 1000;
  const MAX_CONCURRENT = 3;
  const LOGIN_RE = /^@?([a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38})$/i;
  const RESERVED = new Set([
    "about", "account", "apps", "blog", "codespaces", "collections", "contact", "copilot",
    "customer-stories", "dashboard", "discussions", "enterprise", "events", "explore",
    "features", "github", "issues", "login", "logout", "marketplace", "new", "notifications",
    "orgs", "organizations", "partners", "pricing", "pulls", "readme", "resources", "search",
    "security", "settings", "signup", "site", "solutions", "sponsors", "stars", "team",
    "topics", "trending", "users"
  ]);
  const CANDIDATES = 'a[href], [data-hovercard-url], [class*="editorLogin"]';

  let settings = { enabled: true, showLogin: false };
  const cache = new Map();
  const pending = new Map();
  const queue = [];
  let active = 0;
  let pausedUntil = 0;
  let resumeTimer = null;
  const written = new WeakMap();

  const write = (node, value) => { written.set(node, value); node.nodeValue = value; };

  const keyFor = (login) => KEY_PREFIX + login.toLowerCase();

  const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

  const getLogin = (text) => {
    const m = text.trim().match(LOGIN_RE);
    return m && !RESERVED.has(m[1].toLowerCase()) ? m[1] : null;
  };

  function parseName(html, login) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const lower = login.toLowerCase();
    const links = [...doc.querySelectorAll("a[href]")].filter(
      (a) => a.getAttribute("href").replace(/^https:\/\/github\.com/, "").toLowerCase() === "/" + lower
    );
    const named = (a) => {
      const text = a.textContent.trim();
      return text && text.toLowerCase() !== lower ? text : null;
    };
    const preferred = links.find((a) => a.classList.contains("Link--secondary") && named(a));
    if (preferred) return named(preferred);
    for (const a of links) if (named(a)) return named(a);
    return null;
  }

  class RateLimited extends Error {
    constructor(retryAfterMs) { super("rate limited"); this.retryAfterMs = retryAfterMs; }
  }

  async function fetchName(login) {
    const res = await fetch(`/users/${encodeURIComponent(login)}/hovercard`, {
      headers: { "X-Requested-With": "XMLHttpRequest", Accept: "text/html" }
    });
    if (res.status === 404) return null;
    if (res.status === 429 || res.status === 403) {
      const retry = Number(res.headers.get("Retry-After"));
      throw new RateLimited(retry > 0 ? retry * 1000 : DEFAULT_PAUSE_MS);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseName(await res.text(), login);
  }

  function pause(ms) {
    const until = Date.now() + ms;
    if (until > pausedUntil) {
      pausedUntil = until;
      chrome.storage.local.set({ [PAUSE_KEY]: until });
    }
    schedulePump();
  }

  function schedulePump() {
    clearTimeout(resumeTimer);
    const wait = pausedUntil - Date.now();
    if (wait > 0) resumeTimer = setTimeout(pump, wait + 50);
    else pump();
  }

  function pump() {
    if (Date.now() < pausedUntil) return schedulePump();
    while (active < MAX_CONCURRENT && queue.length && Date.now() >= pausedUntil) {
      const job = queue.shift();
      active++;
      fetchName(job.login)
        .then((name) => {
          const entry = { name, t: Date.now() };
          cache.set(job.login.toLowerCase(), entry);
          chrome.storage.local.set({ [keyFor(job.login)]: entry });
          job.resolve(name);
        })
        .catch((err) => {
          if (err instanceof RateLimited) {
            queue.unshift(job);
            pause(err.retryAfterMs);
          } else {
            job.resolve(null);
          }
        })
        .finally(() => { active--; pump(); });
    }
  }

  async function lookup(login) {
    const lower = login.toLowerCase();
    const fresh = (e) => e && Date.now() - e.t < TTL_MS;
    if (fresh(cache.get(lower))) return cache.get(lower).name;
    if (!pending.has(lower)) {
      const p = (async () => {
        const stored = (await chrome.storage.local.get(keyFor(login)))[keyFor(login)];
        if (fresh(stored)) { cache.set(lower, stored); return stored.name; }
        return new Promise((resolve) => { queue.push({ login, resolve }); pump(); });
      })().finally(() => pending.delete(lower));
      pending.set(lower, p);
    }
    return pending.get(lower);
  }

  function loginFor(el) {
    if (el.closest(SKIP)) return null;
    const type = el.getAttribute("data-hovercard-type");
    if (type && type !== "user") return null;
    const hc = (el.getAttribute("data-hovercard-url") || "").match(/^\/users\/([^/]+)\/hovercard/);
    if (hc) return getLogin(safeDecode(hc[1]));
    const href = el.getAttribute("href");
    if (!href) return el.matches('[class*="editorLogin"]') ? getLogin(el.textContent) : null;
    let url;
    try { url = new URL(href, location.origin); } catch { return null; }
    if (url.origin !== location.origin) return null;
    const m = url.pathname.match(/^\/([^/]+)\/?$/);
    if (m) return getLogin(safeDecode(m[1]));
    const author = url.searchParams.get("author") || (url.searchParams.get("q") || "").match(/\bauthor:(\S+)/)?.[1];
    return author ? getLogin(author) : null;
  }

  const SKIP = "pre, code, [contenteditable], textarea, input";

  function textNodesMatching(el, login) {
    const out = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const lower = login.toLowerCase();
    for (let n; (n = walker.nextNode()); ) {
      if (n.parentElement?.closest(SKIP)) continue;
      const l = getLogin(n.nodeValue);
      if (l && l.toLowerCase() === lower) out.push(n);
    }
    return out;
  }

  function apply(el, login, name) {
    if (!el.isConnected || el.dataset.ghdnLogin !== login) return;
    const nodes = textNodesMatching(el, login);
    const otherText = nodes.reduce((t, n) => t.replace(n.nodeValue, ""), el.textContent);
    if (otherText.toLowerCase().includes(name.toLowerCase())) return;
    const label = settings.showLogin ? `${name} (${login})` : name;
    for (const node of nodes) {
      const raw = node.nodeValue;
      node.__ghdnOriginal = raw;
      node.__ghdnSet = raw.match(/^\s*/)[0] + label + raw.match(/\s*$/)[0];
      write(node, node.__ghdnSet);
      el.dataset.ghdnApplied = "1";
    }
    if (el.dataset.ghdnApplied && !el.title) { el.title = `@${login}`; el.dataset.ghdnTitle = "1"; }
  }

  function processLink(el) {
    if (el.dataset.ghdnLogin || el.parentElement?.closest("[data-ghdn-login]")) return;
    const login = loginFor(el);
    if (!login || !textNodesMatching(el, login).length) return;
    el.dataset.ghdnLogin = login;
    lookup(login).then((name) => { if (name && settings.enabled) apply(el, login, name); });
  }

  function restore(el) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode()); ) {
      if (n.__ghdnOriginal === undefined) continue;
      if (n.nodeValue === n.__ghdnSet) write(n, n.__ghdnOriginal);
      delete n.__ghdnOriginal; delete n.__ghdnSet;
    }
    if (el.dataset.ghdnTitle) el.removeAttribute("title");
    delete el.dataset.ghdnLogin; delete el.dataset.ghdnApplied; delete el.dataset.ghdnTitle;
  }

  function scan(root = document) {
    if (!settings.enabled) return;
    if (root.nodeType === 1 && root.matches(CANDIDATES)) processLink(root);
    root.querySelectorAll?.(CANDIDATES).forEach(processLink);
  }

  const restoreAll = () => document.querySelectorAll("[data-ghdn-login]").forEach(restore);

  let scheduled = false;
  const dirty = new Set();
  const stale = new Set();
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "childList") {
        if (m.target.closest?.("[data-ghdn-login]")) stale.add(m.target);
        else m.addedNodes.forEach((n) => dirty.add(n.nodeType === 1 ? n : m.target));
      } else if (m.type === "attributes") {
        stale.add(m.target);
      } else if (m.type === "characterData" && m.target.nodeValue !== written.get(m.target)) {
        if (m.target.parentElement) stale.add(m.target.parentElement);
      }
    }
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      stale.forEach((n) => {
        const owner = n.closest?.("[data-ghdn-login]");
        if (owner) { restore(owner); dirty.add(owner); }
        else if (n.isConnected) dirty.add(n);
      });
      stale.clear();
      dirty.forEach((n) => n.isConnected && scan(n));
      dirty.clear();
    });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && (changes.enabled || changes.showLogin)) {
      for (const [k, v] of Object.entries(changes)) settings[k] = v.newValue;
      restoreAll();
      scan();
    }
    if (area !== "local") return;
    for (const [k, v] of Object.entries(changes)) {
      if (k === PAUSE_KEY) {
        pausedUntil = v.newValue || 0;
        schedulePump();
      } else if (k.startsWith(KEY_PREFIX)) {
        if (v.newValue) cache.set(k.slice(KEY_PREFIX.length), v.newValue);
        else cache.delete(k.slice(KEY_PREFIX.length));
      }
    }
  });

  Promise.all([
    chrome.storage.sync.get({ enabled: true, showLogin: false }),
    chrome.storage.local.get({ [PAUSE_KEY]: 0 })
  ]).then(([s, l]) => {
    settings = s;
    pausedUntil = l[PAUSE_KEY];
    scan();
    observer.observe(document.body, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ["href", "data-hovercard-url"]
    });
  });
})();
