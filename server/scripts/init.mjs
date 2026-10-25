#!/usr/bin/env node
/*
 * Generates the shared bridge token and writes it to both sides:
 *   ~/.fxmcp/token           (server reads this)
 *   extension/config.js      (extension sends this)
 * Re-run whenever you want to rotate the token.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const extConfig = path.join(root, "extension", "config.js");
const extExample = path.join(root, "extension", "config.example.js");
const tokenFile = path.join(os.homedir(), ".fxmcp", "token");

const token = crypto.randomBytes(24).toString("base64url");

fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
fs.writeFileSync(tokenFile, token + "\n", { mode: 0o600 });

if (!fs.existsSync(extConfig)) {
  if (!fs.existsSync(extExample)) {
    console.error("missing " + extExample);
    process.exit(1);
  }
  fs.copyFileSync(extExample, extConfig);
  console.log("created extension/config.js from config.example.js");
}
const src = fs.readFileSync(extConfig, "utf8");
if (!/token:\s*"[^"]*"/.test(src)) {
  console.error("could not find `token: \"...\"` in extension/config.js");
  process.exit(1);
}
fs.writeFileSync(extConfig, src.replace(/token:\s*"[^"]*"/, `token: "${token}"`));

console.log("token written:");
console.log("  " + tokenFile);
console.log("  " + extConfig);
console.log("");
console.log("next: reload the add-on in about:debugging (Reload) so the extension picks up the token.");
