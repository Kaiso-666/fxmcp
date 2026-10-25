/*
 * fxmcp · worker-tab pool
 * Reads never open a fresh tab per call: up to CONFIG.pool background tabs are
 * reused and leased out. Navigation is skipped when the tab already sits on the
 * requested URL, which is the single biggest win for crawl-style workloads.
 */
import { CONFIG } from "../config.js";
import { waitForLoad, normUrl } from "./page.js";

const slots = [];
const waiters = [];
let maxSlots = 3;

export function configurePool(n) {
  const v = Number(n) || Number(CONFIG.pool) || 3;
  maxSlots = Math.max(1, Math.min(v, 8));
}

async function spawn() {
  const tab = await browser.tabs.create({ url: "about:blank", active: false });
  try {
    await browser.tabs.update(tab.id, { autoDiscardable: false });
  } catch (e) {
    /* older gecko: ignore */
  }
  // A navigation issued while the initial about:blank document is still loading
  // gets cancelled by Gecko (NS_BINDING_ABORTED) and the tab can stick in
  // "loading" forever, so let it settle first (usually 1-2 polls).
  const deadline = Date.now() + 4000;
  for (;;) {
    let t;
    try {
      t = await browser.tabs.get(tab.id);
    } catch (e) {
      break;
    }
    if (t.status === "complete") break;
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  return tab.id;
}

export function poolStats() {
  return slots.map((s) => ({ tabId: s.id, busy: s.busy, url: s.url, used: s.used }));
}

export async function acquire(url = null, timeoutMs = 45000) {
  for (const s of slots) {
    if (!s.busy) {
      s.busy = true;
      s.used = Date.now();
      return s;
    }
  }
  if (slots.length < maxSlots) {
    if (url) {
      // create straight at the target: a tabs.update() issued on a brand-new
      // about:blank tab gets cancelled by Gecko and can hang the load forever
      const tab = await browser.tabs.create({ url, active: false });
      const load = waitForLoad(tab.id, 30000, { notBlank: true, checkNow: true });
      try {
        await browser.tabs.update(tab.id, { autoDiscardable: false });
      } catch (e) {
        /* older gecko: ignore */
      }
      const s = { id: tab.id, busy: true, url: normUrl(url), used: Date.now(), load };
      slots.push(s);
      return s;
    }
    const id = await spawn();
    const s = { id, busy: true, url: "about:blank", used: Date.now() };
    slots.push(s);
    return s;
  }
  return new Promise((resolve, reject) => {
    const w = { resolve, dead: false };
    waiters.push(w);
    setTimeout(() => {
      w.dead = true;
      const i = waiters.indexOf(w);
      if (i >= 0) waiters.splice(i, 1);
      reject(new Error("all worker tabs busy"));
    }, timeoutMs);
  });
}

export function release(slot) {
  if (!slot) return;
  slot.used = Date.now();
  while (waiters.length) {
    const w = waiters.shift();
    if (w.dead) continue;
    slot.busy = true;
    w.resolve(slot);
    return;
  }
  slot.busy = false;
}

export function invalidate(slot) {
  slot.url = "";
}

export function dropTab(tabId) {
  const i = slots.findIndex((s) => s.id === tabId);
  if (i >= 0) slots.splice(i, 1);
  const w = waiters.shift();
  if (w && !w.dead) {
    // hand the waiter a replacement tab so a closed worker does not stall the queue
    w.dead = true;
    spawn()
      .then((id) => {
        const s = { id, busy: true, url: "about:blank", used: Date.now() };
        slots.push(s);
        w.resolve(s);
      })
      .catch(() => w.reject(new Error("worker tab vanished")));
  }
}

export async function closeAll() {
  const ids = slots.map((s) => s.id);
  slots.length = 0;
  for (const id of ids) {
    try {
      await browser.tabs.remove(id);
    } catch (e) {
      /* already gone */
    }
  }
  return ids.length;
}
