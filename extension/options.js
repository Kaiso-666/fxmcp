import { CONFIG } from "./config.js";

const $ = (id) => document.getElementById(id);

const stored = await browser.storage.local.get(["endpoint", "token", "pool"]);
$("endpoint").value = stored.endpoint || CONFIG.endpoint || "ws://127.0.0.1:8787";
$("token").value = stored.token == null ? CONFIG.token || "" : stored.token;
$("pool").value = stored.pool || CONFIG.pool || 3;

$("save").addEventListener("click", async () => {
  const endpoint = $("endpoint").value.trim() || CONFIG.endpoint || "ws://127.0.0.1:8787";
  const token = $("token").value.trim();
  const pool = Math.max(1, Math.min(Number($("pool").value) || 3, 8));

  await browser.storage.local.set({ endpoint, token, pool });
  try {
    await browser.runtime.sendMessage({ type: "fxmcp.reconnect" });
    $("msg").textContent = "saved — reconnecting";
  } catch (e) {
    // background page may be starting up; storage change already triggers a reconnect
    $("msg").textContent = "saved";
  }
  setTimeout(() => {
    $("msg").textContent = "";
  }, 2500);
});
