/* fxmcp · web search (background module). No API keys, no tabs opened. */
import { CONFIG } from "../config.js";

const HEADERS = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9"
};

const cache = new Map(); // key -> {t, data}
const CACHE_TTL = 60_000;
const CACHE_MAX = 64;

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.t > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}

function cacheSet(key, data) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { t: Date.now(), data });
}

async function fetchDoc(url, timeoutMs = 9000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      credentials: "omit",
      cache: "no-store",
      redirect: "follow",
      headers: HEADERS
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const html = await res.text();
    if (!html) throw new Error("empty response");
    return new DOMParser().parseFromString(html, "text/html");
  } finally {
    clearTimeout(timer);
  }
}

function unwrap(href) {
  if (!href) return "";
  try {
    const u = new URL(href, "https://duckduckgo.com");
    if (/(^|\.)duckduckgo\.com$/i.test(u.hostname) && u.pathname.indexOf("/l/") === 0) {
      const t = u.searchParams.get("uddg");
      if (t) return decodeURIComponent(t);
    }
    return u.href;
  } catch (e) {
    return href;
  }
}

const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

/* ---------- engines ------------------------------------------------------- */

async function ddgHtml(query, limit) {
  const doc = await fetchDoc("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query) + "&kl=us-en");
  const out = [];
  const nodes = doc.querySelectorAll(".result");
  for (const n of nodes) {
    const a = n.querySelector("a.result__a");
    if (!a) continue;
    const url = unwrap(a.getAttribute("href"));
    if (!/^https?:/i.test(url)) continue;
    const sn = n.querySelector(".result__snippet");
    out.push({ title: clean(a.textContent), url, snippet: clean(sn && sn.textContent).slice(0, 320) });
    if (out.length >= limit) break;
  }
  if (!out.length) {
    const body = clean(doc.body && doc.body.textContent);
    if (/anomaly|unusual traffic|blocked/i.test(body)) throw new Error("ddg blocked this request");
  }
  return out;
}

async function ddgLite(query, limit) {
  const doc = await fetchDoc("https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(query) + "&kl=us-en");
  const out = [];
  const links = doc.querySelectorAll("a.result-link");
  for (const a of links) {
    const url = unwrap(a.getAttribute("href"));
    if (!/^https?:/i.test(url)) continue;
    const row = a.closest("tr");
    const next = row && row.nextElementSibling;
    const sn = next && next.querySelector(".result-snippet");
    out.push({ title: clean(a.textContent), url, snippet: clean(sn && sn.textContent).slice(0, 320) });
    if (out.length >= limit) break;
  }
  return out;
}

async function searx(query, limit) {
  const base = (CONFIG.searxng || "").replace(/\/+$/, "");
  if (!base) throw new Error("searxng base url not configured");
  const url = base + "/search?q=" + encodeURIComponent(query) + "&format=json&language=en";
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 9000);
  try {
    const res = await fetch(url, { signal: ctl.signal, credentials: "omit", headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();
    return (json.results || []).slice(0, limit).map((r) => ({
      title: clean(r.title),
      url: r.url,
      snippet: clean(r.content).slice(0, 320)
    }));
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- public ------------------------------------------------------- */

const URLISH = /^(https?:\/\/|www\.)\S+$/i;
const DOMAINISH = /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i;

export function looksLikeUrl(q) {
  return URLISH.test(q) || (DOMAINISH.test(q) && !/\s/.test(q));
}

export function normalizeTarget(q) {
  if (!looksLikeUrl(q)) return null;
  if (/^https?:\/\//i.test(q)) return q;
  return "https://" + q;
}

export async function search(query, opts = {}) {
  const q = clean(query);
  if (!q) throw new Error("empty query");
  const limit = Math.max(1, Math.min(opts.limit || 8, 30));
  const engine = opts.engine || CONFIG.searchEngine || "ddg";
  const scoped = opts.site ? (/^site:/i.test(q) ? q : "site:" + String(opts.site).replace(/^https?:\/\//, "") + " " + q) : q;

  const key = engine + "|" + limit + "|" + scoped;
  const hit = cacheGet(key);
  if (hit && !opts.fresh) return Object.assign({}, hit, { cached: true });

  const t0 = Date.now();
  const errors = [];
  let results = [];

  const chain =
    engine === "searxng"
      ? [() => searx(scoped, limit), () => ddgHtml(scoped, limit), () => ddgLite(scoped, limit)]
      : [() => ddgHtml(scoped, limit), () => ddgLite(scoped, limit), () => searx(scoped, limit)];

  for (const fn of chain) {
    try {
      const r = await fn();
      if (r && r.length) {
        results = r;
        break;
      }
    } catch (e) {
      errors.push(String((e && e.message) || e));
    }
  }

  const data = {
    query: scoped,
    engine,
    results,
    tookMs: Date.now() - t0,
    errors: errors.length ? errors : undefined
  };
  if (results.length) cacheSet(key, data);
  return data;
}
