/* fxmcp · tab/page plumbing (background module) */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LIB_FILE = { FXExtract: "/lib/extract.js", FXAct: "/lib/act.js" };

/* ---------- low level executeScript -------------------------------------- */

export async function execRaw(tabId, opts) {
  const res = await browser.tabs.executeScript(tabId, Object.assign({ runAt: "document_idle" }, opts));
  return Array.isArray(res) && res.length ? res[0] : null;
}

async function tryExec(tabId, opts) {
  try {
    return await execRaw(tabId, opts);
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/missing host permission|cannot access|does not have permission/i.test(msg)) return null;
    if (/No tab with id|Invalid tab/i.test(msg)) return null;
    return null;
  }
}

/* ---------- content-script library bootstrap ----------------------------- */

export async function ensureLib(tabId, name) {
  const probe = await tryExec(tabId, { code: `!!globalThis.${name}` });
  if (probe === true) return true;
  const file = LIB_FILE[name];
  if (!file) return false;
  try {
    await browser.tabs.executeScript(tabId, { file });
  } catch (e) {
    return false;
  }
  return (await tryExec(tabId, { code: `!!globalThis.${name}` })) === true;
}

/* ---------- promise-aware page call -------------------------------------- */

export async function canScript(tabId) {
  try {
    await browser.tabs.executeScript(tabId, { code: "1" });
    return true;
  } catch (e) {
    return false;
  }
}

/*
 * Runs `expr` inside the page, awaits it, returns {ok, value|error}.
 * Firefox may or may not await a promise returned by executeScript, so the
 * result is also written to a side channel we can poll. Whichever lands first
 * wins; the fast path costs exactly one round trip.
 */
let callSeq = 0;

export async function callPage(tabId, expr, { timeout = 10000, lib = null } = {}) {
  const tok = "fx" + ++callSeq + "_" + Date.now().toString(36);
  const slot = JSON.stringify(tok);
  const code =
    `(async () => { let r; try { r = { ok: true, value: await (${expr}) }; }` +
    ` catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }` +
    ` try { (globalThis.__fxr = globalThis.__fxr || {})[${slot}] = r; } catch (e) {} return r; })()`;

  const once = async () => {
    const first = await tryExec(tabId, { code });
    if (first && typeof first === "object" && "ok" in first) return first;
    if (first === null && !(await canScript(tabId))) {
      throw new Error("cannot run scripts in this tab (about:, view-source:, PDF viewer, add-on store or another protected page)");
    }
    // executeScript did not await the promise: poll the side channel
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      await sleep(35);
      const v = await tryExec(tabId, { code: `(globalThis.__fxr && globalThis.__fxr[${slot}]) || null` });
      if (v && typeof v === "object" && "ok" in v) {
        tryExec(tabId, { code: `try{delete globalThis.__fxr[${slot}]}catch(e){}` });
        return v;
      }
    }
    throw new Error(`page call timed out after ${timeout}ms`);
  };

  // fast path: declared content scripts are already there, so a call is one round trip
  const r = await once();
  if (r.ok || !lib || !/is not defined/i.test(r.error || "")) return r;

  if (!(await ensureLib(tabId, lib))) {
    throw new Error(`content script ${lib} unavailable on this page`);
  }
  return once();
}

/* ---------- extraction ---------------------------------------------------- */

export async function extractPage(tabId, opts) {
  const json = JSON.stringify(opts || {});
  let out = await tryExec(tabId, { code: `(globalThis.FXExtract && FXExtract.run(${json})) || null` });
  if (!out) {
    if (!(await ensureLib(tabId, "FXExtract"))) {
      throw new Error("cannot read this page (restricted URL, PDF, or non-HTML document)");
    }
    out = await tryExec(tabId, { code: `FXExtract.run(${json})` });
  }
  if (!out) throw new Error("extraction returned nothing");
  if (out.ok === false) throw new Error(out.error || "extraction failed");
  return out;
}

/* ---------- navigation ---------------------------------------------------- */

export const navLog = { last: null };

export function waitForLoad(tabId, timeout = 30000, opts = {}) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    // NS_BINDING_ABORTED (0x804B0002): a superseded/cancelled load, not a real failure
    const ABORT = /NS_BINDING_ABORTED|Error code 2152398850|804B0002/i;
    const blank = (u) => /^about:blank/i.test(String(u || ""));
    const events = [];
    const rec = (type, url, status, extra) => {
      if (events.length >= 24) return;
      events.push({ type, url: url || null, status: status || null, ...(extra || {}) });
    };
    const done = (v) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ...(v || {}), elapsedMs: Date.now() - t0, events });
    };
    const onNav = (d) => {
      if (d.tabId !== tabId) return;
      rec("completed", d.url, null, { frameId: d.frameId });
      if (d.frameId !== 0) return;
      if (opts.notBlank && blank(d.url)) return;
      done({ url: d.url, via: "webNavigation", events });
    };
    const onErr = (d) => {
      if (d.tabId !== tabId) return;
      rec("error", d.url, null, { frameId: d.frameId, error: String(d.error || "") });
      if (d.frameId !== 0 || !d.error) return;
      const e = String(d.error);
      if (ABORT.test(e)) return;
      done({ url: d.url, error: e, via: "webNavigation", events });
    };
    const onUpd = (id, info) => {
      if (id !== tabId) return;
      rec("updated", info.url, info.status, {});
      if (info.status !== "complete") return;
      if (opts.notBlank && blank(info.url)) return;
      done({ url: info.url, via: "tabs", events });
    };
    const timer = setTimeout(async () => {
      let state = null;
      try {
        const t = await browser.tabs.get(tabId);
        state = { url: t.url, status: t.status };
      } catch (e) {
        state = { error: String((e && e.message) || e) };
      }
      done({ url: state && state.url, timeout: true, events, state });
    }, timeout);
    function cleanup() {
      clearTimeout(timer);
      try {
        browser.webNavigation.onCompleted.removeListener(onNav);
        browser.webNavigation.onErrorOccurred.removeListener(onErr);
        browser.tabs.onUpdated.removeListener(onUpd);
      } catch (e) {
        /* noop */
      }
    }
    browser.webNavigation.onCompleted.addListener(onNav);
    browser.webNavigation.onErrorOccurred.addListener(onErr);
    browser.tabs.onUpdated.addListener(onUpd);

    // listeners are attached first, so this check can only catch events that
    // already fired — no window where a completion is missed or misread.
    if (opts.checkNow) {
      browser.tabs
        .get(tabId)
        .then((t) => {
          if (t && t.status === "complete" && (!opts.notBlank || !blank(t.url))) {
            done({ url: t.url, via: "checkNow", events });
          }
        })
        .catch(() => {});
    }
  });
}

export async function navigate(tabId, url, timeout = 30000) {
  const loaded = waitForLoad(tabId, timeout, { notBlank: true });
  await browser.tabs.update(tabId, { url });
  const r = await loaded;
  let out = r || { url, timeout: true };

  // Gecko sometimes never fires "complete" (aborted document load) while the DOM
  // is perfectly usable. Recover instead of failing the whole read.
  if (out.timeout) {
    const ready = await tryExec(tabId, { code: "document.readyState" });
    if (ready === "complete" || ready === "interactive") {
      let t = null;
      try {
        t = await browser.tabs.get(tabId);
      } catch (e) {
        t = null;
      }
      out = { url: (t && t.url) || url, via: "recovered", events: out.events };
    }
  }

  navLog.last = { tabId, url, result: out, at: Date.now() };
  return out;
}

/* ---------- misc ---------------------------------------------------------- */

export function normUrl(u) {
  try {
    const x = new URL(u);
    x.hash = "";
    if (x.pathname === "/" && !x.search) return x.origin;
    return x.href.replace(/\/$/, "");
  } catch (e) {
    return String(u || "");
  }
}

export async function activeTabId() {
  let tabs = [];
  try {
    tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  } catch (e) {
    tabs = [];
  }
  if (!tabs.length) tabs = await browser.tabs.query({ active: true });
  const scriptable = tabs.filter((t) => /^(https?|file):/i.test(t.url || ""));
  const pick = scriptable[0] || tabs[0];
  if (!pick) throw new Error("no active tab");
  return pick.id;
}

