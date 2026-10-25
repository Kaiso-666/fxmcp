#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Bridge } from "./bridge.js";
import { createMcp } from "./mcp.js";
import { loadConfig } from "./config.js";

const cfg = loadConfig();
const log = (m) => {
  if (!cfg.quiet) process.stderr.write("[fxmcp] " + m + "\n");
};

process.on("unhandledRejection", (e) => {
  process.stderr.write("[fxmcp] unhandled rejection: " + ((e && e.stack) || e) + "\n");
});

const bridge = new Bridge(cfg, { log });
let active = bridge;

// A second fxmcp process (extra MCP client, opencode catalog probe, manual
// `--http`) must not fight over the port: if a bridge already answers /health,
// attach to it as a client instead of binding.
async function bridgeAlive() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 700);
  try {
    const res = await fetch(`http://${cfg.host}:${cfg.port}/health`, { signal: ctl.signal });
    const json = await res.json();
    return !!(json && json.ok === true && typeof json.connected === "boolean");
  } catch (e) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

if (!process.argv.includes("--http") && (await bridgeAlive())) {
  const { HttpBridge } = await import("./remote.js");
  active = new HttpBridge(cfg);
  log(`port ${cfg.port} is already served by another fxmcp process — attached as a client`);
} else {
  try {
    await bridge.start();
  } catch (e) {
    const code = e && e.code;
    if (code === "EADDRINUSE" && !process.argv.includes("--http")) {
      const { HttpBridge } = await import("./remote.js");
      active = new HttpBridge(cfg);
      log(`port ${cfg.port} taken — attached to the existing bridge as a client`);
    } else {
      process.stderr.write(`[fxmcp] cannot bind ${cfg.host}:${cfg.port}: ${(e && e.message) || e}\n`);
      process.exit(1);
    }
  }
}

if (process.argv.includes("--http")) {
  log(`http mode on http://${cfg.host}:${cfg.port}`);
  log(`  GET  /health`);
  log(`  POST /rpc  {"method":"search","params":{"query":"..."}}  (header x-fxmcp-token)`);
} else {
  const mcp = createMcp(active, cfg);
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  log(`mcp ready (bridge ws://${cfg.host}:${cfg.port}${active === bridge ? "" : ", proxying"})`);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await active.stop();
    } catch (e) {
      /* noop */
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);
  process.stdin.on("end", shutdown);
}
