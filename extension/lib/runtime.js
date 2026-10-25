import { CONFIG } from "../config.js";

let cache = null;

/**
 * Effective runtime config: values saved from the options page (storage.local)
 * override the ones compiled into config.js, so a permanently installed, signed
 * add-on never needs a rebuild just to rotate the bridge token.
 */
export async function getConfig() {
  if (cache) return cache;
  let stored = {};
  try {
    stored = await browser.storage.local.get(["endpoint", "token", "pool"]);
  } catch (e) {
    stored = {};
  }
  const token = String(stored.token == null ? CONFIG.token || "" : stored.token).trim();
  const endpoint = String(stored.endpoint || CONFIG.endpoint || "ws://127.0.0.1:8787").trim();
  const pool = Number(stored.pool) || Number(CONFIG.pool) || 3;
  cache = Object.assign({}, CONFIG, { token, endpoint, pool });
  return cache;
}

export function invalidateConfig() {
  cache = null;
}
