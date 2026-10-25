import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";

const MAX_BODY = 1 << 20;
const WS_MAX_PAYLOAD = 32 << 20;

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();

/**
 * Bridge = WebSocket server the extension dials into + a tiny HTTP RPC surface
 * for debugging without an MCP client.
 */
export class Bridge {
  constructor(cfg, { log } = {}) {
    this.cfg = cfg;
    this.log = log || (() => {});
    this.pending = new Map();
    this.seq = 0;
    this.active = null;
    this.waiters = [];
    this.stats = { connects: 0, requests: 0, errors: 0 };
    this.server = null;
    this.wss = null;
    this.tokenHash = sha(cfg.token);
  }

  get connected() {
    return !!(this.active && this.active.readyState === 1);
  }

  tokenOk(candidate) {
    if (!candidate) return false;
    const a = sha(candidate);
    return a.length === this.tokenHash.length && crypto.timingSafeEqual(a, this.tokenHash);
  }

  /* ---------- lifecycle -------------------------------------------------- */

  async start() {
    const { host, port } = this.cfg;
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: WS_MAX_PAYLOAD,
      perMessageDeflate: false,
      clientTracking: true
    });
    this.wss.on("connection", (ws, req) => this.onConnection(ws, req));

    const server = http.createServer((req, res) => this.onRequest(req, res));
    server.on("upgrade", (req, socket, head) => this.onUpgrade(req, socket, head));
    server.on("clientError", (err, socket) => {
      try {
        socket.destroy();
      } catch (e) {
        /* noop */
      }
    });

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });

    this.server = server;
    this.log(`listening on http://${host}:${port} (ws + /rpc)`);
    return this;
  }

  async stop() {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("bridge shutting down"));
    }
    this.pending.clear();
    try {
      this.wss && this.wss.close();
    } catch (e) {
      /* noop */
    }
    if (this.server) {
      await new Promise((resolve) => this.server.close(() => resolve()));
    }
  }

  /* ---------- connections ------------------------------------------------ */

  onUpgrade(req, socket, head) {
    let url;
    try {
      url = new URL(req.url, "http://127.0.0.1");
    } catch (e) {
      socket.destroy();
      return;
    }
    const token = url.searchParams.get("token") || req.headers["x-fxmcp-token"] || "";
    if (!this.tokenOk(token)) {
      this.log("rejected websocket: bad token");
      try {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      } catch (e) {
        /* noop */
      }
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit("connection", ws, req));
  }

  onConnection(ws, req) {
    this.stats.connects++;
    this.active = ws;
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });
    ws.on("message", (data) => this.onMessage(ws, data));
    ws.on("close", () => {
      if (this.active === ws) this.active = null;
      for (const [id, p] of this.pending) {
        if (p.socket === ws) {
          clearTimeout(p.timer);
          this.pending.delete(id);
          p.reject(new Error("extension disconnected"));
        }
      }
      this.log("extension disconnected");
    });
    ws.on("error", () => {
      /* close follows */
    });

    const hb = setInterval(() => {
      if (ws.readyState !== 1) return clearInterval(hb);
      if (!ws.isAlive) {
        try {
          ws.terminate();
        } catch (e) {
          /* noop */
        }
        return clearInterval(hb);
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch (e) {
        /* noop */
      }
    }, 20000);
    ws.on("close", () => clearInterval(hb));

    this.log("extension connected");
    const w = this.waiters.shift();
    if (w) w(ws);
  }

  onMessage(ws, data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    if (msg.t === "hello") {
      this.log(`hello from extension v${msg.version || "?"}`);
      return;
    }
    if (msg.t === "res") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else {
        this.stats.errors++;
        const err = new Error((msg.error && msg.error.message) || "extension error");
        err.code = (msg.error && msg.error.code) || "E_OP";
        p.reject(err);
      }
    }
  }

  waitForClient(ms = this.cfg.connectWaitMs) {
    if (this.connected) return Promise.resolve(this.active);
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        resolve(v);
      };
      const w = (ws) => finish(ws);
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        finish(this.connected ? this.active : null);
      }, Math.max(0, ms));
    });
  }

  /* ---------- rpc -------------------------------------------------------- */

  async call(method, params = {}, { timeout } = {}) {
    const client = await this.waitForClient();
    if (!client) {
      throw new Error(
        "Firefox bridge not connected. Load the extension (about:debugging -> Load Temporary Add-on -> extension/manifest.json), " +
          "keep Firefox running, and make sure extension/config.js CONFIG.token equals " +
          "~/.fxmcp/token."
      );
    }
    const id = ++this.seq;
    const ms = timeout ?? this.cfg.requestTimeoutMs;
    const payload = JSON.stringify({ t: "req", id, method, params });
    this.stats.requests++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`fxmcp: ${method} timed out after ${ms}ms`));
      }, ms);
      this.pending.set(id, { resolve, reject, timer, socket: client, method });
      try {
        client.send(payload);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  onRequest(req, res) {
    const send = (code, body) => {
      const text = JSON.stringify(body);
      res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      res.end(text);
    };
    const url = new URL(req.url, "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/health") {
      return send(200, {
        ok: true,
        connected: this.connected,
        pending: this.pending.size,
        stats: this.stats
      });
    }

    if (req.method === "POST" && url.pathname === "/rpc") {
      const token = url.searchParams.get("token") || req.headers["x-fxmcp-token"] || "";
      if (!this.tokenOk(token)) return send(401, { ok: false, error: "bad token" });
      let size = 0;
      const chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", async () => {
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch (e) {
          return send(400, { ok: false, error: "invalid json" });
        }
        try {
          const result = await this.call(body.method, body.params || {}, { timeout: body.timeout });
          send(200, { ok: true, result });
        } catch (e) {
          send(200, { ok: false, error: String((e && e.message) || e) });
        }
      });
      return;
    }

    send(404, { ok: false, error: "not found" });
  }
}
