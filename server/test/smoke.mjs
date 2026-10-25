/*
 * smoke.mjs — no Firefox required.
 * 1. boots the Bridge, attaches a fake extension over WS, exercises /health + /rpc
 * 2. boots the real MCP server over stdio, attaches a fake extension, drives
 *    initialize / tools/list / tools/call through the actual SDK
 */
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { Bridge } from "../src/bridge.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, "..", "src", "index.js");
const TOKEN = "smoke-" + Math.random().toString(36).slice(2);

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    pass++;
    console.log("  ok   " + name);
  } else {
    fail++;
    console.log("  FAIL " + name + (extra === undefined ? "" : " :: " + JSON.stringify(extra).slice(0, 400)));
  }
};

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

const HANDLERS = {
  ping: () => ({ pong: true, version: "smoke" }),
  status: () => ({ pool: [{ tabId: 7, busy: false, url: "" }], cache: 0 }),
  reset: () => ({ closedWorkerTabs: 1 }),
  search: (p) => ({
    query: p.query,
    engine: "ddg",
    tookMs: 3,
    results: [{ title: "Example", url: "https://example.com/", snippet: "canned" }]
  }),
  read: (p) => ({
    ok: true,
    url: p.url || "https://example.com/",
    title: "Example Domain",
    text: "# Example Domain\n\ncanned body",
    links: [{ text: "more", url: "https://example.com/more" }],
    chars: 30,
    truncated: false,
    tabId: 7,
    tookMs: 5
  }),
  links: (p) => ({ ok: true, url: p.url, text: "", links: [{ url: "https://example.com/a" }] }),
  tabs: () => ({ count: 1, tabs: [{ id: 1, index: 0, active: true, url: "about:blank", title: "" }] })
};

function fakeExtension(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(TOKEN)}`);
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }
    if (!msg || msg.t !== "req") return;
    const send = (payload, isErr) => {
      if (ws.readyState !== 1) return;
      ws.send(JSON.stringify({ t: "res", id: msg.id, ok: !isErr, ...(isErr ? { error: { message: String(payload) } } : { result: payload }) }));
    };
    const fn = HANDLERS[msg.method];
    if (!fn) return send("unknown method " + msg.method, true);
    Promise.resolve()
      .then(() => fn(msg.params || {}))
      .then((r) => send(r), (e) => send((e && e.message) || e, true));
  });
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

async function connectWithRetry(port, tries = 40) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fakeExtension(port);
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw last;
}

/* ------------------------------------------------------------------ part 1 */

console.log("\n[1] bridge + http rpc");
const port1 = await freePort();
const bridge = new Bridge(
  { host: "127.0.0.1", port: port1, token: TOKEN, requestTimeoutMs: 5000, connectWaitMs: 3000 },
  { log: () => {} }
);
await bridge.start();
const ext1 = await connectWithRetry(port1);

const base = `http://127.0.0.1:${port1}`;
const health = await (await fetch(base + "/health")).json();
ok("health.connected", health.connected === true, health);

const rpc = await (
  await fetch(base + "/rpc", {
    method: "POST",
    headers: { "content-type": "application/json", "x-fxmcp-token": TOKEN },
    body: JSON.stringify({ method: "search", params: { query: "test" } })
  })
).json();
ok("rpc search", rpc.ok === true && rpc.result.results[0].url === "https://example.com/", rpc);

const unauth = await fetch(base + "/rpc", { method: "POST", body: "{}" });
ok("rpc rejects bad token", unauth.status === 401, unauth.status);

const ping = await bridge.call("ping", {});
ok("bridge.call", ping.pong === true, ping);

/* ------------------------------------------------------------------ part 2 */

console.log("\n[2] mcp stdio server");
const port2 = await freePort();
const child = spawn(process.execPath, [serverEntry], {
  env: Object.assign({}, process.env, { FXMCP_PORT: String(port2), FXMCP_TOKEN: TOKEN, FXMCP_QUIET: "1" }),
  stdio: ["pipe", "pipe", "pipe"]
});
let childErr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (d) => {
  childErr += d;
});

let seq = 0;
const waiting = new Map();
let buf = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      continue;
    }
    if (msg.id != null && waiting.has(msg.id)) {
      const w = waiting.get(msg.id);
      waiting.delete(msg.id);
      w(msg);
    }
  }
});

function rpcCall(method, params) {
  const msg = { jsonrpc: "2.0", id: ++seq, method };
  if (params !== undefined) msg.params = params;
  child.stdin.write(JSON.stringify(msg) + "\n");
  return new Promise((resolve, reject) => {
    waiting.set(msg.id, resolve);
    setTimeout(() => {
      if (waiting.delete(msg.id)) reject(new Error("rpc timeout: " + method));
    }, 10000);
  });
}
const notify = (method, params) => {
  const msg = { jsonrpc: "2.0", method };
  if (params !== undefined) msg.params = params;
  child.stdin.write(JSON.stringify(msg) + "\n");
};

const ext2 = await connectWithRetry(port2);

const init = await rpcCall("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "smoke", version: "1" }
});
ok("initialize", init.result && init.result.serverInfo && init.result.serverInfo.name === "fxmcp", init);
notify("notifications/initialized");

const list = await rpcCall("tools/list", {});
const names = ((list.result && list.result.tools) || []).map((t) => t.name);
ok("tools/list >= 15", names.length >= 15, names);
for (const want of ["search", "read", "links", "open", "tabs", "click", "type", "eval", "batch", "screenshot"]) {
  ok("tool " + want, names.includes(want));
}

const call = await rpcCall("tools/call", { name: "search", arguments: { query: "hello" } });
const callText = call.result && call.result.content && call.result.content[0] && call.result.content[0].text;
ok("tools/call search", !!callText && callText.includes("example.com"), call.result);

const readCall = await rpcCall("tools/call", { name: "read", arguments: { url: "https://example.com" } });
const readText = readCall.result && readCall.result.content && readCall.result.content[0] && readCall.result.content[0].text;
ok("tools/call read", !!readText && readText.includes("canned body"), readCall.result);

const batchCall = await rpcCall("tools/call", {
  name: "batch",
  arguments: { requests: [{ method: "search", params: { query: "a" } }, { method: "read", params: { url: "https://example.com" } }] }
});
const batchText = batchCall.result && batchCall.result.content && batchCall.result.content[0].text;
const batchJson = batchText ? JSON.parse(batchText) : { results: [] };
ok("tools/call batch", batchJson.results.length === 2 && batchJson.results.every((r) => r.ok), batchJson);

/* ---------------------------------------------------------------- cleanup */

ext1.close();
ext2.close();
child.kill();
await bridge.stop();
await new Promise((r) => setTimeout(r, 200));

if (childErr && !/mcp ready|listening/.test(childErr)) {
  console.log("\nchild stderr:\n" + childErr.trim());
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
