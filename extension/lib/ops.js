/* fxmcp · operation handlers (background module) */
import { CONFIG } from "../config.js";
import { acquire, release, closeAll, poolStats } from "./pool.js";
import {
  extractPage,
  callPage,
  navigate,
  waitForLoad,
  normUrl,
  activeTabId,
  navLog,
  sleep
} from "./page.js";
import { search as doSearch, normalizeTarget } from "./search.js";

const pageCache = new Map();
const inflight = new Map();
const locks = new Map();
const CACHE_MAX = 48;

function withLock(tabId, fn) {
  const prev = locks.get(tabId) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(tabId, next.then(() => {}, () => {}));
  return next;
}

function cacheGet(key) {
  const hit = pageCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.t > (CONFIG.cacheTtlMs || 120000)) {
    pageCache.delete(key);
    return null;
  }
  return hit.data;
}

function cacheSet(key, data) {
  if (pageCache.size >= CACHE_MAX) pageCache.delete(pageCache.keys().next().value);
  pageCache.set(key, { t: Date.now(), data });
}

const clip = (s, n) => String(s == null ? "" : s).slice(0, n);

async function afterAction(tabId, settleMs, expectNav) {
  await sleep(settleMs == null ? 100 : settleMs);
  let tab;
  try {
    tab = await browser.tabs.get(tabId);
  } catch (e) {
    return { gone: true };
  }

  // a submitted form can start navigating a moment later: watch for it briefly
  if (expectNav && tab.status !== "loading") {
    const firstUrl = tab.url;
    for (let i = 0; i < 8; i++) {
      await sleep(60);
      let next;
      try {
        next = await browser.tabs.get(tabId);
      } catch (e) {
        return { gone: true };
      }
      tab = next;
      if (next.status === "loading" || next.url !== firstUrl) break;
    }
  }

  const out = { url: tab.url, title: tab.title, status: tab.status };
  if (tab.status === "loading") {
    const r = await waitForLoad(tabId, 20000);
    if (r && r.url) {
      out.url = r.url;
      out.status = "complete";
    }
  }
  return out;
}

/* ---------- read ---------------------------------------------------------- */

export async function opRead(p = {}) {
  const started = Date.now();
  const maxChars = Math.max(500, Math.min(Number(p.maxChars) || 20000, 400000));
  const want = {
    format: p.format === "text" ? "text" : "markdown",
    maxChars,
    links: p.links !== false,
    linksOnly: !!p.linksOnly,
    selector: p.selector || "",
    filter: p.filter || "",
    limit: Math.max(1, Math.min(Number(p.limit) || 120, 1000))
  };

  const cacheKey = p.url
    ? [normUrl(p.url), want.format, want.maxChars, want.selector, want.filter, want.limit, want.linksOnly ? 1 : 0, want.links ? 1 : 0].join("|")
    : null;

  if (cacheKey && !p.fresh) {
    const hit = cacheGet(cacheKey);
    if (hit) {
      // hand back a tab that is still parked on this URL so follow-up clicks/evals
      // have a real target instead of falling back to "the active tab"
      const norm = normUrl(p.url);
      const parked = poolStats().find((s) => s.url === norm);
      return Object.assign({}, hit, { tabId: parked ? parked.tabId : undefined, cached: true, tookMs: Date.now() - started });
    }
  }
  if (cacheKey && inflight.has(cacheKey)) return inflight.get(cacheKey);

  const run = async () => {
    let tabId = p.tabId || null;
    let slot = null;
    let navigated = false;
    let activeUrl = null;
    try {
      if (p.url) {
        if (!tabId) {
          slot = await acquire(p.url);
          tabId = slot.id;
        }
        const target = normUrl(p.url);
        const settleMs = p.settleMs == null ? CONFIG.settleMs || 60 : Number(p.settleMs);
        const pending = slot && slot.load;
        if (pending) {
          // the tab was created directly at the target URL, just wait for it
          delete slot.load;
          navigated = true;
          const r = await pending;
          navLog.last = { tabId, url: p.url, via: "create", result: r, at: Date.now() };
          if (r && r.error) throw new Error("cannot open " + p.url + ": " + r.error);
          if (r && r.timeout) throw new Error("navigation timed out after " + (Number(p.timeoutMs) || 30000) + "ms");
          await sleep(settleMs);
        } else if (p.fresh || !slot || slot.url !== target) {
          let r;
          try {
            r = await navigate(tabId, p.url, Number(p.timeoutMs) || 30000);
          } catch (e) {
            throw new Error("cannot open " + p.url + ": " + String((e && e.message) || e));
          }
          navigated = true;
          if (r && r.error) throw new Error("cannot open " + p.url + ": " + r.error);
          if (r && r.timeout) throw new Error("navigation timed out after " + (Number(p.timeoutMs) || 30000) + "ms");
          await sleep(settleMs);
        }
      } else if (!tabId) {
        tabId = await activeTabId();
        try {
          const t = await browser.tabs.get(tabId);
          activeUrl = t.url;
        } catch (e) {
          activeUrl = null;
        }
      }

      let data;
      try {
        data = await extractPage(tabId, want);
      } catch (e) {
        const msg = String((e && e.message) || e);
        throw new Error(activeUrl ? msg + " [active tab: " + activeUrl + "]" : msg);
      }
      if (slot) slot.url = normUrl(data.url || p.url);
      const out = Object.assign({}, data, {
        tabId,
        navigated,
        cached: false,
        tookMs: Date.now() - started
      });
      if (cacheKey) cacheSet(cacheKey, out);
      return out;
    } finally {
      if (slot) release(slot);
    }
  };

  const job = p.tabId ? withLock(p.tabId, run) : run();
  if (cacheKey) {
    inflight.set(cacheKey, job);
    job.then(
      () => inflight.delete(cacheKey),
      () => inflight.delete(cacheKey)
    );
  }
  return job;
}

/* ---------- search -------------------------------------------------------- */

export async function opSearch(p = {}) {
  const q = String(p.query || "").trim();
  if (!q) throw new Error("query required");
  const res = await doSearch(q, {
    limit: p.limit,
    engine: p.engine,
    site: p.site,
    fresh: p.fresh
  });
  const direct = normalizeTarget(q);
  if (direct) res.directUrl = direct;
  return res;
}

/* ---------- tabs ---------------------------------------------------------- */

export async function opOpen(p = {}) {
  let url = String(p.url || "").trim();
  if (!url) throw new Error("url required");
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = "https://" + url;
  const tab = await browser.tabs.create({ url, active: !!p.active });
  const out = { tabId: tab.id, url, active: !!p.active };
  const pos = await afterAction(tab.id, p.wait === false ? 0 : 40);
  out.url = pos.url || url;
  out.title = pos.title;
  out.loaded = pos.status === "complete";
  return out;
}

export async function opTabs(p = {}) {
  const tabs = await browser.tabs.query({});
  const out = [];
  for (const t of tabs) {
    if (p.currentWindow) {
      const win = await browser.windows.getLastFocused();
      if (t.windowId !== win.id) continue;
    }
    out.push({
      id: t.id,
      index: t.index,
      windowId: t.windowId,
      active: !!t.active,
      pinned: !!t.pinned,
      discarded: !!t.discarded,
      status: t.status,
      url: clip(t.url, 300),
      title: clip(t.title, 200)
    });
  }
  out.sort((a, b) => a.windowId - b.windowId || a.index - b.index);
  const limit = Math.max(1, Math.min(Number(p.limit) || 200, 1000));
  return { count: out.length, tabs: out.slice(0, limit) };
}

export async function opActivate(p = {}) {
  const tabId = Number(p.tabId);
  if (!tabId) throw new Error("tabId required");
  const tab = await browser.tabs.update(tabId, { active: true });
  try {
    await browser.windows.update(tab.windowId, { focused: true });
  } catch (e) {
    /* noop */
  }
  return { tabId, url: tab.url, title: tab.title };
}

export async function opClose(p = {}) {
  const id = Number(p.tabId);
  if (!id) throw new Error("tabId required");
  await browser.tabs.remove(id);
  return { closed: id };
}

export async function opHistory(p = {}) {
  const tabId = p.tabId || (await activeTabId());
  const r = await withLock(tabId, async () => {
    const wait = waitForLoad(tabId, 15000);
    if (p.direction === "forward") await browser.tabs.goForward(tabId);
    else await browser.tabs.goBack(tabId);
    return wait;
  });
  return { tabId, url: (r && r.url) || null, navigated: true };
}

/* ---------- interaction --------------------------------------------------- */

export async function opClick(p = {}) {
  const tabId = p.tabId || (await activeTabId());
  const arg = JSON.stringify({ selector: p.selector, text: p.text, index: p.index });
  return withLock(tabId, async () => {
    const r = await callPage(tabId, `FXAct.click(${arg})`, { lib: "FXAct" });
    const v = r.value || {};
    if (!r.ok || v.ok === false) throw new Error(v.error || r.error || "click failed");
    const pos = await afterAction(tabId, p.settleMs);
    return Object.assign({ tabId }, v, pos);
  });
}

export async function opType(p = {}) {
  const tabId = p.tabId || (await activeTabId());
  const arg = JSON.stringify({
    selector: p.selector,
    text: p.text == null ? "" : String(p.text),
    index: p.index,
    clear: p.clear !== false,
    submit: !!p.submit
  });
  return withLock(tabId, async () => {
    const r = await callPage(tabId, `FXAct.type(${arg})`, { lib: "FXAct" });
    const v = r.value || {};
    if (!r.ok || v.ok === false) throw new Error(v.error || r.error || "type failed");
    const pos = await afterAction(tabId, p.settleMs, !!p.submit);
    return Object.assign({ tabId }, v, pos);
  });
}

export async function opPress(p = {}) {
  const tabId = p.tabId || (await activeTabId());
  const arg = JSON.stringify({ selector: p.selector, key: p.key || "Enter" });
  return withLock(tabId, async () => {
    const r = await callPage(tabId, `FXAct.press(${arg})`, { lib: "FXAct" });
    const v = r.value || {};
    if (!r.ok || v.ok === false) throw new Error(v.error || r.error || "press failed");
    const pos = await afterAction(tabId, p.settleMs, (p.key || "Enter") === "Enter");
    return Object.assign({ tabId }, v, pos);
  });
}

export async function opScroll(p = {}) {
  const tabId = p.tabId || (await activeTabId());
  const arg = JSON.stringify({ to: p.to == null ? "bottom" : p.to, smooth: !!p.smooth });
  const r = await callPage(tabId, `FXAct.scroll(${arg})`, { lib: "FXAct" });
  const v = r.value || {};
  if (!r.ok || v.ok === false) throw new Error(v.error || r.error || "scroll failed");
  return Object.assign({ tabId }, v);
}

export async function opWaitFor(p = {}) {
  const tabId = p.tabId || (await activeTabId());
  if (!p.selector) throw new Error("selector required");
  const timeout = Math.max(50, Math.min(Number(p.timeoutMs) || 5000, 60000));
  const arg = JSON.stringify({ selector: p.selector, visible: !!p.visible, timeoutMs: timeout });
  const r = await callPage(tabId, `FXAct.waitFor(${arg})`, { lib: "FXAct", timeout: timeout + 5000 });
  const v = r.value || {};
  if (!r.ok || v.ok === false) {
    if (v.timeout) throw new Error(`waitFor timed out after ${timeout}ms: ${p.selector} did not appear`);
    throw new Error(v.error || r.error || "waitFor failed");
  }
  return Object.assign({ tabId }, v);
}

export async function opInfo(p = {}) {
  const tabId = p.tabId || (await activeTabId());
  const r = await callPage(tabId, `FXAct.info()`, { lib: "FXAct" });
  const v = r.value || {};
  if (!r.ok || v.ok === false) throw new Error(v.error || r.error || "info failed");
  return Object.assign({ tabId }, v);
}

/* ---------- eval ---------------------------------------------------------- */

const SAFE = `(function s(v,d){if(v===null||v===undefined)return v;var t=typeof v;if(t==="function")return "[function]";if(t==="symbol")return String(v);if(t==="bigint")return String(v);if(t!=="object")return v;if(d>6)return "[depth]";if(Array.isArray(v))return v.slice(0,200).map(function(x){return s(x,d+1)});if(typeof Node!=="undefined"&&v instanceof Node)return "[node "+(v.nodeName||"")+"]";if(v instanceof Date)return v.toISOString();if(t==="object"&&typeof v.then==="function")return "[promise]";var o={},n=0;for(var k in v){if(!Object.prototype.hasOwnProperty.call(v,k))continue;if(n++>200)break;try{o[k]=s(v[k],d+1)}catch(e){o[k]="[unreadable]"}}return o})(VALUE,0)`;

export async function opEval(p = {}) {
  const tabId = p.tabId || (await activeTabId());
  const code = String(p.code || "").trim();
  if (!code) throw new Error("code required");
  const timeout = Math.max(500, Math.min(Number(p.timeoutMs) || 15000, 60000));
  const mode = p.mode || "auto";
  const shape = (expr) => `(async () => ${SAFE.replace("VALUE", "(" + expr + ")")})()`;

  let r = null;
  if (mode !== "body") {
    r = await callPage(tabId, shape(code), { timeout });
    if (mode === "auto" && !r.ok && /SyntaxError|Unexpected (token|identifier)|Invalid or unexpected/i.test(r.error || "")) {
      r = await callPage(tabId, shape("(function(){" + code + "\n})()"), { timeout });
    }
  } else {
    r = await callPage(tabId, shape("(function(){" + code + "\n})()"), { timeout });
  }
  if (!r.ok) throw new Error(r.error || "eval failed");
  return { tabId, value: r.value };
}

/* ---------- screenshot ---------------------------------------------------- */

export async function opScreenshot(p = {}) {
  const tabId = p.tabId || (await activeTabId());
  await browser.tabs.update(tabId, { active: true });
  await sleep(p.settleMs == null ? 120 : Number(p.settleMs));
  const quality = Math.max(10, Math.min(Number(p.quality) || 60, 95));
  const dataUrl = await browser.tabs.captureTab(tabId, { format: "jpeg", quality });
  return {
    tabId,
    mime: "image/jpeg",
    dataUrl,
    bytes: Math.round(((dataUrl.length - 23) * 3) / 4)
  };
}

/* ---------- meta ---------------------------------------------------------- */

export async function opStatus() {
  return {
    ok: true,
    version: (globalThis.__fxmcp && globalThis.__fxmcp.VERSION) || null,
    pool: poolStats(),
    cache: pageCache.size,
    inflight: inflight.size,
    engine: CONFIG.searchEngine,
    lastNav: navLog.last
  };
}

export async function opReset() {
  const n = await closeAll();
  pageCache.clear();
  return { closedWorkerTabs: n };
}
