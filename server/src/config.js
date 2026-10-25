import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export function tokenPath() {
  return path.join(os.homedir(), ".fxmcp", "token");
}

export function loadConfig(env = process.env) {
  const port = Number(env.FXMCP_PORT || 8787);
  const host = env.FXMCP_HOST || "127.0.0.1";

  let token = String(env.FXMCP_TOKEN || "").trim();
  if (!token) {
    try {
      token = fs.readFileSync(tokenPath(), "utf8").trim();
    } catch (e) {
      token = "";
    }
  }
  if (!token) {
    token = crypto.randomBytes(24).toString("base64url");
    try {
      fs.mkdirSync(path.dirname(tokenPath()), { recursive: true });
      fs.writeFileSync(tokenPath(), token + "\n", { mode: 0o600 });
      process.stderr.write(`[fxmcp] generated bridge token -> ${tokenPath()}\n`);
      process.stderr.write(`[fxmcp] put the same value in extension/config.js (CONFIG.token) or run: npm run init\n`);
    } catch (e) {
      process.stderr.write("[fxmcp] could not persist token: " + e.message + "\n");
    }
  }

  return {
    host,
    port,
    token,
    requestTimeoutMs: Number(env.FXMCP_TIMEOUT || 60000),
    connectWaitMs: Number(env.FXMCP_CONNECT_WAIT || 12000),
    quiet: env.FXMCP_QUIET === "1"
  };
}
