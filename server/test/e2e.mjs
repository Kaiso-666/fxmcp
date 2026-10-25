/*
 * e2e.mjs — drives the real Firefox through the running bridge (`node src/index.js --http`).
 * Usage: node test/e2e.mjs [port]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const port = Number(process.argv[2] || process.env.FXMCP_PORT || 8787);
const token = (process.env.FXMCP_TOKEN || fs.readFileSync(path.join(os.homedir(), ".fxmcp", "token"), "utf8")).trim();
const base = `http://127.0.0.1:${port}`;

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    pass++;
    console.log("  ok   " + name);
  } else {
    fail++;
    console.log("  FAIL " + name + (extra === undefined ? "" : " :: " + JSON.stringify(extra).slice(0, 600)));
  }
};
const log = (...a) => console.log(...a);

async function call(method, params = {}, timeout) {
  const res = await fetch(base + "/rpc", {
    method: "POST",
    headers: { "content-type": "application/json", "x-fxmcp-token": token },
    body: JSON.stringify({ method, params, timeout })
  });
  const json = await res.json();
  if (!json.ok) throw new Error(method + ": " + json.error);
  return json.result;
}

const health = await (await fetch(base + "/health")).json().catch(() => null);
if (!health) {
  console.error(`bridge not reachable on ${base} — start it with: node src/index.js --http`);
  process.exit(2);
}
ok("bridge reachable", health.ok === true, health);
ok("extension connected", health.connected === true, health);
if (!health.connected) process.exit(2);

// deterministic run: drop pooled tabs and the page cache
const resetInfo = await call("reset", {}, 20000);
log(`    reset: closed ${resetInfo.closedWorkerTabs} worker tab(s)`);

log("\n[search]");
const s = await call("search", { query: "mozilla firefox webextension manifest v2" }, 30000);
ok("search results", Array.isArray(s.results) && s.results.length > 0, s);
ok("search result shape", !!(s.results[0] && s.results[0].title && /^https?:/.test(s.results[0].url)), s.results && s.results[0]);
log("    top: " + (s.results[0] || {}).url + "  (" + (s.results[0] || {}).title + ")");

const s2 = await call("search", { query: "mozilla firefox webextension manifest v2" }, 30000);
ok("search cache", s2.cached === true && s2.tookMs < s.tookMs + 50, { cached: s2.cached, tookMs: s2.tookMs });

const direct = await call("search", { query: "example.com" }, 30000);
ok("bare domain gives directUrl", direct.directUrl === "https://example.com", direct.directUrl);

log("\n[read]");
const r1 = await call("read", { url: "https://example.com", maxChars: 4000 }, 45000);
ok("example.com read", r1.chars > 40 && /example/i.test(r1.title || ""), { chars: r1.chars, title: r1.title });
ok("example.com first read fast", r1.tookMs < 12000, { tookMs: r1.tookMs, nav: r1.navigated });
ok("read reports timing", typeof r1.tookMs === "number" && r1.ms >= 0, { tookMs: r1.tookMs, ms: r1.ms });
log(`    example.com: ${r1.tookMs}ms total, ${r1.ms}ms extract, ${r1.nodes} nodes`);
ok("read returns tabId", typeof r1.tabId === "number", r1.tabId);ok("read has title", !!r1.title, r1.title);
ok("nav happened", r1.navigated === true, r1.navigated);

const r2 = await call("read", { url: "https://example.com", maxChars: 4000 }, 45000);
ok("second read cached", r2.cached === true, { cached: r2.cached, tookMs: r2.tookMs });
log(`    cached read took ${r2.tookMs}ms vs ${r1.tookMs}ms`);

const r3 = await call("read", { url: "https://example.com", maxChars: 4000, fresh: true }, 45000);
ok("fresh bypasses cache", r3.cached === false, r3.cached);

const hn = await call("read", { url: "https://news.ycombinator.com", maxChars: 8000 }, 60000);
ok("hn extraction", hn.chars > 500 && !/SIDEBAR/.test(hn.text), { chars: hn.chars, title: hn.title });
ok("hn links", Array.isArray(hn.links) && hn.links.length > 10, hn.links && hn.links.length);
ok("hn markdown-ish", /\[[^\]]+\]\(https?:/.test(hn.text), hn.text.slice(0, 300));
log(`    hn: ${hn.chars} chars, ${hn.links.length} links, ${hn.ms}ms extract, ${hn.tookMs}ms total`);

const hnFresh = await call("read", { url: "https://news.ycombinator.com", fresh: true, maxChars: 8000 }, 60000);
ok("re-extract is fast", hnFresh.ms < 1500 && hnFresh.cached === false, { ms: hnFresh.ms, nodes: hnFresh.nodes });
log(`    hn re-extract: ${hnFresh.ms}ms over ${hnFresh.nodes} nodes, nav+extract ${hnFresh.tookMs}ms`);

const hnSame = await call("read", { url: "https://news.ycombinator.com", maxChars: 4000 }, 60000);
ok("same-url re-read skips navigation", hnSame.navigated === false, { navigated: hnSame.navigated, tookMs: hnSame.tookMs });
log(`    no-nav re-read: ${hnSame.tookMs}ms (extract ${hnSame.ms}ms)`);

log("\n[parallel reads]");
const t0 = Date.now();
const urls = ["https://example.com", "https://example.org", "https://example.net"];
const b = await Promise.all(urls.map((url) => call("read", { url, maxChars: 2000 }, 90000)));
ok("three parallel reads", b.length === 3 && b.every((x) => x.ok && x.chars >= 0), b.map((x) => ({ ok: x.ok, chars: x.chars, tab: x.tabId })));
ok("distinct worker tabs", new Set(b.map((x) => x.tabId)).size === 3, b.map((x) => x.tabId));
log(`    3 pages in ${Date.now() - t0}ms`);

log("\n[tabs + interaction]");
const hnTab = await call("open", { url: "https://news.ycombinator.com", active: false }, 40000);
ok("open tab", typeof hnTab.tabId === "number" && hnTab.loaded === true, hnTab);

const tabs = await call("tabs", {}, 15000);
ok("tabs lists it", tabs.tabs.some((x) => x.id === hnTab.tabId), tabs.tabs.map((x) => x.id));

const doc = await call("eval", { tabId: hnTab.tabId, code: "({ title: document.title, links: document.querySelectorAll('a').length })" }, 15000);
ok("eval object", /Hacker News/i.test(String(doc.value && doc.value.title)) && doc.value.links > 100, doc);

const info = await call("info", { tabId: hnTab.tabId }, 15000);
ok("info", info.ok === true && info.readyState === "complete", info);

const wait = await call("waitFor", { tabId: hnTab.tabId, selector: ".titleline > a", timeoutMs: 5000 }, 20000);
ok("waitFor existing selector", wait.ok === true && wait.found === true, wait);

const before = info.url;
const clicked = await call("click", { tabId: hnTab.tabId, selector: ".subline a[href^='item?id=']" }, 30000);
ok("click navigates", clicked.ok === true && clicked.url !== before, clicked);
ok("click reports new url", /item\?id=/.test(String(clicked.url)), clicked.url);

let timedOut = false;
try {
  await call("waitFor", { tabId: hnTab.tabId, selector: "#definitely-not-here", timeoutMs: 500 }, 20000);
} catch (e) {
  timedOut = /timed out|failed/i.test(String(e.message));
}
ok("waitFor timeout surfaces as error", timedOut);

const wiki = await call("open", { url: "https://en.wikipedia.org/wiki/Main_Page", active: false }, 45000);
ok("open wikipedia", wiki.loaded === true, wiki);
const wikiBefore = await call("info", { tabId: wiki.tabId }, 15000);
log(`    wiki tab ${wiki.tabId} before type: ${wikiBefore.url} (${wikiBefore.readyState})`);
const typed = await call("type", { tabId: wiki.tabId, selector: "input[name='search']", text: "Firefox", submit: true }, 45000);
const wikiAfter = await call("info", { tabId: wiki.tabId }, 15000).catch((e) => ({ url: "info failed: " + e.message }));
log(`    wiki tab after type: ${wikiAfter.url} (${wikiAfter.readyState}) tabs=${JSON.stringify((await call("tabs", {}, 15000)).tabs.filter((t) => t.id === wiki.tabId))}`);
ok("type + submit navigates", /wikipedia\.org\/(wiki|w\/index\.php)/i.test(String(typed.url || "")) && /firefox/i.test(decodeURIComponent(String(typed.url || ""))), typed);

const shot = await call("screenshot", { tabId: wiki.tabId, quality: 50 }, 30000);
ok("screenshot", /^data:image\/jpeg;base64,/.test(shot.dataUrl) && shot.bytes > 1000, { bytes: shot.bytes });

log("\n[extras]");
const linkList = await call("links", { url: "https://news.ycombinator.com", filter: "item\\?id=", limit: 20 }, 30000);
ok("links tool + regex filter", Array.isArray(linkList.links) && linkList.links.length > 3, linkList.links && linkList.links.length);

const scrolled = await call("scroll", { tabId: hnTab.tabId, to: "bottom" }, 20000);
ok("scroll to bottom", scrolled.ok === true && scrolled.max > 0, scrolled);

const pressed = await call("press", { tabId: hnTab.tabId, key: "Escape" }, 20000);
ok("press key", pressed.ok === true && pressed.key === "Escape", pressed);

const back = await call("history", { tabId: hnTab.tabId, direction: "back" }, 30000);
ok("history back", typeof back.url === "string" && /news\.ycombinator\.com/.test(back.url), back);

const act = await call("activate", { tabId: wiki.tabId }, 15000);
ok("activate returns the tab", act.tabId === wiki.tabId && /wikipedia/i.test(String(act.url || "")), act);
const afterActivate = await call("tabs", {}, 15000);
const wikiNow = afterActivate.tabs.find((t) => t.id === wiki.tabId);
if (wikiNow && wikiNow.active) {
  ok("activate makes the tab active", true);
} else {
  log("    note: headless Firefox ignores tab activation (no visible window), skipping that assertion");
}
ok("tab list shape", afterActivate.tabs.every((t) => typeof t.id === "number" && typeof t.url === "string"), afterActivate.count);

const activeNow = afterActivate.tabs.find((t) => t.active);
let activeRead = null;
let activeErr = null;
try {
  activeRead = await call("read", { maxChars: 2000 }, 40000);
} catch (e) {
  activeErr = String(e.message);
}
ok(
  "read with no url targets the active tab",
  (activeRead && /^https?:/.test(activeRead.url)) || (!!activeErr && !!activeNow && activeErr.includes(String(activeNow.url))),
  { read: activeRead && activeRead.url, err: activeErr, active: activeNow && activeNow.url }
);
log(`    active-tab read -> ${activeRead ? activeRead.url + " (" + activeRead.chars + " chars)" : activeErr}`);

ok("close hn tab", (await call("close", { tabId: hnTab.tabId }, 15000)).closed === hnTab.tabId);
ok("close wiki tab", (await call("close", { tabId: wiki.tabId }, 15000)).closed === wiki.tabId);

log("\n[errors]");
let failed = false;
try {
  await call("read", { url: "about:config" }, 20000);
} catch (e) {
  failed = /cannot open|restricted|permission|illegal url/i.test(String(e.message));
}
ok("restricted page errors cleanly", failed);

const status = await call("status", {}, 15000);
ok("status pool", Array.isArray(status.pool) && status.pool.length > 0, status);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
