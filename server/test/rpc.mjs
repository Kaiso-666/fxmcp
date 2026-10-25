/*
 * rpc.mjs — one-shot bridge call, useful for debugging without an MCP client.
 *   node test/rpc.mjs search '{"query":"firefox"}'
 *   node test/rpc.mjs tabs '{}'
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const port = Number(process.env.FXMCP_PORT || 8787);
const token =
  process.env.FXMCP_TOKEN || fs.readFileSync(path.join(os.homedir(), ".fxmcp", "token"), "utf8").trim();
const method = process.argv[2];
if (!method) {
  console.error("usage: node test/rpc.mjs <method> ['<json params>']");
  process.exit(1);
}
let params = {};
try {
  params = JSON.parse(process.argv[3] || "{}");
} catch (e) {
  console.error("bad json params:", e.message);
  process.exit(1);
}

const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-fxmcp-token": token },
  body: JSON.stringify({ method, params, timeout: Number(process.env.FXMCP_TIMEOUT || 60000) })
});
const json = await res.json();
if (!json.ok) {
  console.error("error: " + json.error);
  process.exit(2);
}
const r = json.result;
if (r && typeof r === "object" && typeof r.text === "string") {
  const { text, ...rest } = r;
  console.log(JSON.stringify(rest, null, 2));
  console.log("--- text ---");
  console.log(text.slice(0, 4000));
} else {
  console.log(JSON.stringify(r, null, 2).slice(0, 8000));
}
