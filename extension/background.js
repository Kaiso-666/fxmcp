/* fxmcp · background bridge (MV2 persistent background page, ES module) */
import { CONFIG } from "./config.js";
import { getConfig, invalidateConfig } from "./lib/runtime.js";
import { configurePool, dropTab } from "./lib/pool.js";
import * as ops from "./lib/ops.js";

const VERSION = "1.1.1";

let cfg = Object.assign({}, CONFIG);

const log = (...a) => {
  if (cfg.verbose) console.log("[fxmcp]", ...a);
};

configurePool(CONFIG.pool);

/* ---------- handler table ------------------------------------------------- */

const HANDLERS = {
  ping: async () => ({ pong: true, version: VERSION, ts: Date.now() }),
  status: () => ops.opStatus(),
  reset: () => ops.opReset(),

  search: (p) => ops.opSearch(p),
  read: (p) => ops.opRead(p),
  links: (p) => ops.opRead(Object.assign({}, p, { linksOnly: true, links: true })),

  open: (p) => ops.opOpen(p),
  tabs: (p) => ops.opTabs(p),
  activate: (p) => ops.opActivate(p),
  close: (p) => ops.opClose(p),
  history: (p) => ops.opHistory(p),

  click: (p) => ops.opClick(p),
  type: (p) => ops.opType(p),
  press: (p) => ops.opPress(p),
  scroll: (p) => ops.opScroll(p),
  waitFor: (p) => ops.opWaitFor(p),
  info: (p) => ops.opInfo(p),
  eval: (p) => ops.opEval(p),
  screenshot: (p) => ops.opScreenshot(p)
};

/* ---------- socket -------------------------------------------------------- */

let ws = null;
let backoff = 400;
let connecting = false;
let stats = { connects: 0, requests: 0, errors: 0 };

function url() {
  const base = String(cfg.endpoint || "ws://127.0.0.1:8787").replace(/\/+$/, "");
  const tok = cfg.token ? "?token=" + encodeURIComponent(cfg.token) : "";
  return base + "/" + tok;
}

function send(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch (e) {
    return false;
  }
}

function connect() {
  if (connecting) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  connecting = true;
  let sock;
  try {
    sock = new WebSocket(url());
  } catch (e) {
    connecting = false;
    scheduleReconnect();
    return;
  }
  ws = sock;

  sock.onopen = () => {
    connecting = false;
    backoff = 400;
    stats.connects++;
    send({ t: "hello", version: VERSION, token: cfg.token, ua: navigator.userAgent, pool: cfg.pool });
    console.log("[fxmcp] connected to", cfg.endpoint);
  };

  sock.onmessage = (ev) => {
    if (typeof ev.data !== "string") return;
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (e) {
      return;
    }
    if (msg && msg.t === "req") dispatch(msg);
  };

  sock.onclose = () => {
    connecting = false;
    ws = null;
    scheduleReconnect();
  };

  sock.onerror = () => {
    try {
      sock.close();
    } catch (e) {
      /* noop */
    }
  };
}

function scheduleReconnect() {
  const wait = Math.min(backoff, 15000) * (1 + Math.random() * 0.25);
  backoff = Math.min(backoff * 2, 15000);
  setTimeout(connect, wait);
}

async function dispatch(msg) {
  const id = msg.id;
  const method = msg.method;
  const params = msg.params || {};
  const fn = HANDLERS[method];
  stats.requests++;

  if (!fn) {
    send({ t: "res", id, ok: false, error: { message: "unknown method: " + method, code: "E_METHOD" } });
    return;
  }

  try {
    const result = await fn(params);
    send({ t: "res", id, ok: true, result });
  } catch (e) {
    stats.errors++;
    const message = String((e && e.message) || e);
    log("error", method, message);
    send({ t: "res", id, ok: false, error: { message, code: (e && e.code) || "E_OP" } });
  }
}

/* ---------- lifecycle ----------------------------------------------------- */

browser.tabs.onRemoved.addListener((tabId) => dropTab(tabId));

function forceReconnect() {
  try {
    if (ws) ws.close();
  } catch (e) {
    /* noop */
  }
  ws = null;
  connecting = false;
  backoff = 400;
  connect();
}

async function boot(reconnect) {
  cfg = await getConfig();
  configurePool(cfg.pool);
  if (reconnect) forceReconnect();
  else connect();
}

browser.runtime.onStartup.addListener(() => boot(false));
browser.runtime.onInstalled.addListener(() => boot(false));

// options page writes endpoint/token/pool here — apply without a reinstall
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  invalidateConfig();
  boot(true);
});

browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "fxmcp.reconnect") {
    invalidateConfig();
    boot(true);
    return Promise.resolve({ ok: true });
  }
  return undefined;
});

boot(false);

// keepalive: the background page is persistent, but a dead socket is not always
// reported by the browser, so probe cheaply and reconnect if needed.
setInterval(() => {
  if (!ws || ws.readyState === WebSocket.CLOSED) connect();
}, 5000);

globalThis.__fxmcp = { stats, connect, HANDLERS, VERSION };
