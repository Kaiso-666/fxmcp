import crypto from "node:crypto";

/**
 * Fallback transport: when another fxmcp process already owns the WebSocket port
 * (second MCP client, an opencode catalog probe, a manual `--http` instance),
 * this instance becomes a thin client of that bridge over HTTP /rpc instead of
 * dying with EADDRINUSE. Same call() surface, so tools do not care.
 */
export class HttpBridge {
  constructor(cfg) {
    this.cfg = cfg;
    this.stats = { requests: 0, errors: 0 };
    this.ok = true;
  }

  get connected() {
    return this.ok;
  }

  async call(method, params = {}, { timeout } = {}) {
    const ms = timeout ?? this.cfg.requestTimeoutMs;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms + 3000);
    const url = `http://${this.cfg.host}:${this.cfg.port}/rpc`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-fxmcp-token": this.cfg.token },
        body: JSON.stringify({ method, params, timeout: ms }),
        signal: ctl.signal
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "bridge error");
      this.stats.requests++;
      this.ok = true;
      return json.result;
    } catch (e) {
      this.stats.errors++;
      this.ok = false;
      throw new Error(`fxmcp proxy -> ${this.cfg.host}:${this.cfg.port}: ${(e && e.message) || e}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async stop() {
    /* nothing to tear down */
  }
}

export const tokenHash = (s) => crypto.createHash("sha256").update(String(s)).digest();
