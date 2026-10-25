import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const asText = (v) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: String((e && e.message) || e) }] });

const tool = (bridge, method, map) => async (args) => {
  try {
    const params = map ? map(args || {}) : args || {};
    return asText(await bridge.call(method, params));
  } catch (e) {
    return fail(e);
  }
};

const int = (min, max) => z.number().int().min(min).max(max);

export function createMcp(bridge, cfg) {
  const mcp = new McpServer(
    { name: "fxmcp", version: "1.0.0" },
    {
      instructions:
        "Drives the user's own Firefox over a local WebSocket bridge. Prefer `search` then `read` for research, " +
        "`open`+`click`/`type` for interaction. `read` reuses background worker tabs and caches pages for 2 minutes, " +
        "so repeated reads of the same URL are nearly free; use `batch` for parallel fetches."
    }
  );

  /* ------------------------------ discovery ------------------------------ */

  mcp.registerTool(
    "search",
    {
      title: "Web search",
      description:
        "Search the web (DuckDuckGo HTML, no API key, no tab opened). Returns {results:[{title,url,snippet}], tookMs}. " +
        "If the query is a bare domain it also returns directUrl. Use `site` to scope to one host.",
      inputSchema: {
        query: z.string().describe("search terms"),
        limit: int(1, 30).optional().describe("max results (default 8)"),
        site: z.string().optional().describe("restrict to this host, e.g. github.com"),
        engine: z.enum(["ddg", "searxng"]).optional(),
        fresh: z.boolean().optional().describe("bypass the 60s result cache")
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    tool(bridge, "search")
  );

  mcp.registerTool(
    "read",
    {
      title: "Read page as markdown",
      description:
        "Fetch a URL (or a live tab) and return clean markdown plus deduped links. Uses a pooled background tab: " +
        "no tab spam, navigation skipped when the pooled tab is already there, 2-minute page cache. " +
        "Returns {url,title,text,links,tabId,chars,truncated,tookMs}.",
      inputSchema: {
        url: z.string().optional().describe("page to load; omit to read the active tab"),
        tabId: z.number().int().optional().describe("read this tab instead of the pool"),
        format: z.enum(["markdown", "text"]).optional().describe("markdown (default) or plain text"),
        maxChars: int(500, 400000).optional().describe("text cap, default 20000"),
        selector: z.string().optional().describe("CSS selector to restrict the extracted region"),
        links: z.boolean().optional().describe("include link list (default true)"),
        limit: int(1, 1000).optional().describe("max links, default 120"),
        filter: z.string().optional().describe("regex filter for links"),
        fresh: z.boolean().optional().describe("skip cache and reload"),
        settleMs: int(0, 10000).optional().describe("wait after load for SPAs"),
        timeoutMs: int(1000, 120000).optional().describe("navigation budget, default 30000")
      },
      annotations: { readOnlyHint: true }
    },
    tool(bridge, "read")
  );

  mcp.registerTool(
    "links",
    {
      title: "List page links",
      description: "Links only (no body text) from a URL or live tab. Cheap way to enumerate a page before choosing targets.",
      inputSchema: {
        url: z.string().optional(),
        tabId: z.number().int().optional(),
        filter: z.string().optional().describe("regex on href or anchor text"),
        limit: int(1, 1000).optional()
      },
      annotations: { readOnlyHint: true }
    },
    tool(bridge, "links")
  );

  /* -------------------------------- tabs --------------------------------- */

  mcp.registerTool(
    "open",
    {
      title: "Open URL in tab",
      description: "Open a URL in a real (user-visible) tab. Waits for load by default and returns {tabId,url,title,loaded}.",
      inputSchema: {
        url: z.string(),
        active: z.boolean().optional().describe("focus the tab (default false)"),
        wait: z.boolean().optional().describe("wait for load (default true)")
      },
      annotations: { openWorldHint: true }
    },
    tool(bridge, "open")
  );

  mcp.registerTool(
    "tabs",
    {
      title: "List tabs",
      description: "All open tabs with id, url, title, active/discarded flags. Use the id with read/click/close/etc.",
      inputSchema: {
        currentWindow: z.boolean().optional(),
        limit: int(1, 1000).optional()
      },
      annotations: { readOnlyHint: true }
    },
    tool(bridge, "tabs")
  );

  mcp.registerTool(
    "activate",
    { title: "Focus tab", description: "Switch Firefox to the given tab and focus its window.", inputSchema: { tabId: z.number().int() } },
    tool(bridge, "activate")
  );

  mcp.registerTool(
    "close",
    { title: "Close tab", description: "Close a tab by id.", inputSchema: { tabId: z.number().int() }, annotations: { destructiveHint: true } },
    tool(bridge, "close")
  );

  mcp.registerTool(
    "history",
    { title: "Back / forward", description: "Navigate the tab history.", inputSchema: { tabId: z.number().int().optional(), direction: z.enum(["back", "forward"]).optional() } },
    tool(bridge, "history")
  );

  /* ----------------------------- interaction ----------------------------- */

  mcp.registerTool(
    "click",
    {
      title: "Click element",
      description:
        "Click by CSS selector or by visible text (whichever given). Fires pointer/mouse events for framework apps, " +
        "scrolls into view, and reports the resulting URL/title if it navigated.",
      inputSchema: {
        selector: z.string().optional(),
        text: z.string().optional().describe("visible text to match"),
        index: z.number().int().min(0).optional().describe("nth match"),
        tabId: z.number().int().optional(),
        settleMs: int(0, 20000).optional(),
        timeoutMs: int(1000, 120000).optional().describe("how long to wait for the resulting load")
      },
      annotations: { destructiveHint: false }
    },
    tool(bridge, "click")
  );

  mcp.registerTool(
    "type",
    {
      title: "Type into field",
      description:
        "Focus a field and set its value through the native value setter (works with React/Vue), firing input+change. " +
        "`submit: true` submits the form (or presses Enter when there is none).",
      inputSchema: {
        selector: z.string(),
        text: z.string(),
        clear: z.boolean().optional().describe("replace existing value (default true)"),
        submit: z.boolean().optional(),
        tabId: z.number().int().optional(),
        settleMs: int(0, 20000).optional()
      }
    },
    tool(bridge, "type")
  );

  mcp.registerTool(
    "press",
    {
      title: "Press key",
      description: "Dispatch a key (Enter, Escape, ArrowDown, ...) to the focused element or a selector, then submit the surrounding form on Enter.",
      inputSchema: {
        key: z.string().optional().describe("default Enter"),
        selector: z.string().optional(),
        tabId: z.number().int().optional()
      }
    },
    tool(bridge, "press")
  );

  mcp.registerTool(
    "scroll",
    {
      title: "Scroll page",
      description: "Scroll to top/bottom or an explicit pixel offset. Reports max scroll so you know when you hit the end.",
      inputSchema: {
        to: z.union([z.enum(["top", "bottom"]), z.number()]).optional().describe("default bottom"),
        smooth: z.boolean().optional(),
        tabId: z.number().int().optional()
      }
    },
    tool(bridge, "scroll")
  );

  mcp.registerTool(
    "wait",
    {
      title: "Wait for selector",
      description: "Block until a selector exists (optionally visible). Returns {found,elapsedMs} — use before clicking on SPA content.",
      inputSchema: {
        selector: z.string(),
        visible: z.boolean().optional(),
        timeoutMs: int(50, 60000).optional(),
        tabId: z.number().int().optional()
      },
      annotations: { readOnlyHint: true }
    },
    tool(bridge, "waitFor")
  );

  /* -------------------------------- misc --------------------------------- */

  mcp.registerTool(
    "eval",
    {
      title: "Run JS in page",
      description:
        "Execute JavaScript in the page's extension sandbox and return the JSON-safe result. " +
        "mode=auto accepts an expression or statements; mode=body only statements with explicit return.",
      inputSchema: {
        code: z.string(),
        mode: z.enum(["auto", "expr", "body"]).optional(),
        timeoutMs: int(500, 60000).optional(),
        tabId: z.number().int().optional()
      }
    },
    tool(bridge, "eval")
  );

  mcp.registerTool(
    "info",
    {
      title: "Page state",
      description: "URL, title, readyState, scroll position and focused element of a tab. Cheap health check.",
      inputSchema: { tabId: z.number().int().optional() },
      annotations: { readOnlyHint: true }
    },
    tool(bridge, "info")
  );

  mcp.registerTool(
    "screenshot",
    {
      title: "Screenshot tab",
      description: "Focus the tab and capture a JPEG of the viewport (returns an image).",
      inputSchema: {
        tabId: z.number().int().optional(),
        quality: int(10, 95).optional(),
        settleMs: int(0, 10000).optional()
      },
      annotations: { readOnlyHint: true }
    },
    async (args) => {
      try {
        const r = await bridge.call("screenshot", args || {});
        const b64 = String(r.dataUrl).split(",")[1] || "";
        return {
          content: [
            { type: "image", data: b64, mimeType: "image/jpeg" },
            { type: "text", text: JSON.stringify({ tabId: r.tabId, bytes: r.bytes }) }
          ]
        };
      } catch (e) {
        return fail(e);
      }
    }
  );

  mcp.registerTool(
    "status",
    {
      title: "Bridge status",
      description: "Worker tab pool, cache size and engine. reset:true closes pooled tabs and clears the page cache.",
      inputSchema: { reset: z.boolean().optional() },
      annotations: { readOnlyHint: true }
    },
    async (args) => {
      try {
        const a = args || {};
        if (a.reset) return asText(await bridge.call("reset", {}));
        return asText({
          bridge: { connected: bridge.connected, stats: bridge.stats },
          extension: await bridge.call("status", {})
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  /* -------------------------------- batch -------------------------------- */

  const BATCHABLE = new Set([
    "search", "read", "links", "open", "tabs", "activate", "close", "history",
    "click", "type", "press", "scroll", "waitFor", "info", "eval", "screenshot"
  ]);

  mcp.registerTool(
    "batch",
    {
      title: "Parallel calls",
      description:
        "Run several bridge calls concurrently in one tool round trip (reads fan out over the worker-tab pool). " +
        "Returns {results:[{ok,result|error}]} in request order. Use this instead of many sequential calls.",
      inputSchema: {
        requests: z.array(z.object({ method: z.string(), params: z.record(z.any()).optional() })),
        concurrency: int(1, 8).optional().describe("default 3")
      }
    },
    async (args) => {
      const reqs = (args && args.requests) || [];
      const limit = Math.max(1, Math.min((args && args.concurrency) || 3, 8));
      const results = new Array(reqs.length);
      let cursor = 0;
      const worker = async () => {
        for (;;) {
          const i = cursor++;
          if (i >= reqs.length) return;
          const r = reqs[i] || {};
          try {
            if (!BATCHABLE.has(r.method)) throw new Error("not batchable: " + r.method);
            results[i] = { ok: true, result: await bridge.call(r.method, r.params || {}, { timeout: 120000 }) };
          } catch (e) {
            results[i] = { ok: false, error: String((e && e.message) || e) };
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(limit, reqs.length || 1) }, worker));
      return asText({ results });
    }
  );

  return mcp;
}
