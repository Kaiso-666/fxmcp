# fxmcp — Firefox browser MCP

A Firefox extension + MCP server that lets an agent **search the web, read pages, and drive tabs** in
your own browser session. No Playwright, no headless Chromium, no per-call browser launch.

```
MCP client (opencode/claude/…)  ──stdio──►  server/src/index.js  ──ws://127.0.0.1:8787──►  Firefox
                                            (bridge + tools)          (token auth)          extension
                                                                                             ├─ worker tab pool
                                                                                             ├─ content scripts
                                                                                             └─ page cache
```

## Layout

```
extension/
  manifest.json          MV2, persistent background page (Firefox keeps MV2 forever)
  background.html        module host for the background page
  background.js          WS client, reconnect/backoff, request router
  config.js              endpoint + token + pool size  (generated from config.example.js)
  lib/page.js            executeScript bridge, promise-aware page calls, navigation
  lib/pool.js            worker-tab pool (lease / release / auto-discard off)
  lib/search.js          DuckDuckGo HTML + lite + SearXNG, 60s cache, fallbacks
  lib/ops.js             read/search/open/tabs/click/type/eval/screenshot handlers
  lib/extract.js         content script: readable-markdown extractor + link collector
  lib/act.js             content script: click / type / key / scroll / wait primitives
server/
  src/index.js           MCP stdio entry (or `--http` for curl-driven debugging)
  src/bridge.js          WS server + token auth + HTTP /rpc + /health
  src/mcp.js             tool definitions
  src/config.js          token/port resolution
  scripts/init.mjs       writes ~/.fxmcp/token and extension/config.js
  test/smoke.mjs         offline end-to-end test (fake extension, real MCP SDK)
```

## Setup

```powershell
cd server
npm install
npm run init                     # generates the shared token on both sides
```

Load the extension once:

1. `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…** → pick `extension/manifest.json`
3. The console should log `[fxmcp] connected to ws://127.0.0.1:8787`

Start the MCP server (your client usually does this for you):

```powershell
node server/src/index.js          # MCP over stdio
node server/src/index.js --http   # no MCP: curl http://127.0.0.1:8787/health
```

## Permanent install (release Firefox)

Temporary add-ons disappear on restart, and release Firefox only loads **signed** add-ons. Signing
through AMO's unlisted channel is free and does not publish a listing:

```powershell
cd server
npm run build                     # -> dist/fxmcp_bridge-1.1.0.zip
# one-time: https://addons.mozilla.org/developers/addon/api/key/
$env:WEB_EXT_API_KEY="user:12345:67890"
$env:WEB_EXT_API_SECRET="0123456789abcdef..."
npm run sign                      # -> dist/fxmcp_bridge-1.1.0.xpi
```

Then `about:addons` → gear icon → **Install Add-on From File…** → pick the `.xpi`. Remove the
temporary copy first if it is still loaded (`about:debugging` → Remove). Bump `version` in
`extension/manifest.json` before signing an update, otherwise Firefox refuses to replace the old one.

### Firefox Developer Edition (no account, already set up here)

Release Firefox ignores `xpinstall.signatures.required`, so unsigned builds need an aurora/nightly
channel. `tools/install-permanent.ps1` does the whole thing for a Developer Edition profile:

```powershell
powershell -ExecutionPolicy Bypass -File tools\install-permanent.ps1 -Verify
```

It builds the XPI, copies it to `<profile>\extensions\fxmcp@local.xpi`, writes a managed block into
`<profile>\user.js` (`xpinstall.signatures.required=false`, `extensions.autoDisableScopes=0`,
`extensions.startupScanScopes=15`), then launches Dev Edition headless and waits for the bridge to
report a connected extension. If Dev Edition is already running it verifies against a temporary copy
of the profile instead of failing.

Status of the current install (`3ioyvqip.dev-edition-default`):

```
id fxmcp@local  version 1.1.0  active true  userDisabled false  location app-profile
```

Re-run the script after editing the extension (bump `version` first).

Trade-offs: Developer Edition keeps its own profile, separate from release Firefox — bookmarks,
logins and other add-ons do not carry over. `user.js` re-applies those prefs on every start; delete
the `// fxmcp:start … // fxmcp:end` block to undo.

Connection settings (endpoint, token, worker-tab count) are in the add-on's **Preferences** page,
backed by `storage.local`. Rotating `~/.fxmcp/token` therefore never requires a rebuild — paste the
new value and it reconnects.
### opencode

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "firefox": {
      "type": "local",
      "command": ["node", "C:/Users/meow/firefox-mcp/server/src/index.js"],
      "enabled": true
    }
  }
}
```

### Any other MCP client

```json
{
  "mcpServers": {
    "firefox": {
      "command": "node",
      "args": ["C:/Users/meow/firefox-mcp/server/src/index.js"]
    }
  }
}
```

## Tools

| tool | what it does |
|---|---|
| `search` | DuckDuckGo HTML search, returns `{results:[{title,url,snippet}]}`. No tab opened. |
| `read` | URL or live tab → clean markdown + links. Pooled tab, cached 2 min. |
| `links` | Links only, cheapest way to enumerate a page. |
| `open` | Real user-visible tab, waits for load. |
| `tabs` / `activate` / `close` / `history` | tab management |
| `click` | by CSS selector **or** visible text; fires pointer/mouse events for framework apps |
| `type` | native value setter (React/Vue-safe) + `input`/`change`, optional `submit` |
| `press` / `scroll` / `wait` | keyboard, scroll position, selector wait |
| `eval` | run JS in the page sandbox, JSON-safe result |
| `screenshot` | JPEG of the viewport |
| `info` | url/title/readyState/scroll/focus |
| `status` | pool + cache + bridge health, `reset:true` to flush |
| `batch` | run N calls concurrently in one round trip |

Typical flow: `search` → `read` (a few results, can be one `batch`) → `open` + `click`/`type` when
interaction is needed.

## Why it's fast

Measured on a real Firefox (headless, cold extension, 2026-10):

| operation | time |
|---|---|
| `read` example.com (cold tab) | ~0.9 s total, 9 ms extraction |
| `read` HN front page (cold) | ~2.0 s total, 37–80 ms extraction |
| re-`read` same URL (no nav) | 30–300 ms |
| cached `read` | 0–1 ms |
| 3 parallel `read`s (pool of 3) | 0.4–0.9 s |
| `click` + settle | ~150 ms |

How that is achieved:

- **No browser launch per call.** One socket, one process, always warm.
- **Worker-tab pool (3).** `read` leases a background tab instead of creating one; navigation is
  skipped entirely when the tab is already on the target URL (pagination/crawl ≈ free).
- **Tabs are created straight at the target URL.** `tabs.update()` on a fresh `about:blank` tab gets
  cancelled by Gecko (NS_BINDING_ABORTED) and can hang forever — that cost 20 s per read before.
- **Pre-warmed content scripts.** Both page libs are declared in the manifest, so a read is a single
  `executeScript` round trip, and an interaction is one call (the lib is only re-injected if missing).
- **One round trip per page call.** Async page work uses a promise + side-channel, so the fast path
  never polls.
- **Compact payloads.** Extraction returns collapsed markdown + capped text (20k default) and a
  deduped link list — not serialized DOM, not a screenshot per step.
- **Caching + in-flight dedupe.** 2 min page cache (cached reads still return the parked `tabId` so
  follow-up `click`/`eval` target the right tab), 60 s search cache, identical concurrent reads share
  one navigation.
- **`batch`.** Reads fan out across the pool in parallel; per-request ok/error.
- **Self-healing loads.** If Gecko never fires `complete` but `document.readyState` says the DOM is
  ready, the read proceeds instead of failing.

## Tests

```powershell
cd server
npm test            # jsdom extractor/act tests + MCP protocol smoke test (no browser needed)
npm run test:e2e    # drives the running Firefox: search, read, pool, click, type, eval, screenshot
npm run rpc search '{"query":"firefox mcp"}'   # one-off bridge call for debugging
```

`test:e2e` needs `node src/index.js --http` running and the add-on loaded.

## Security

- Bridge binds `127.0.0.1` only and requires the token from `~/.fxmcp/token`;
  without it the upgrade is rejected with 401. Rotate with `npm run init` + reload the add-on.
- The extension has `<all_urls>` — that is what makes `read` work on arbitrary pages. Use a separate
  Firefox profile if you also browse logged-in sites you don't want an agent to touch.
- `eval` runs in the extension's content-script sandbox (page CSP does not apply).

## Troubleshooting

| symptom | cause |
|---|---|
| `Firefox bridge not connected` | add-on not loaded / Firefox closed / token mismatch (`npm run init`, then Reload in about:debugging) |
| `cannot read this page (restricted URL…)` | `about:`, `view-source:`, PDFs, AMO pages — content scripts are blocked there |
| `cannot run scripts in this tab` | the call had no `tabId` and the focused tab is `about:home`/`about:blank`/a PDF — pass the `tabId` from `read`/`tabs` |
| `navigation timed out` | site is slow or blocked; retry with a bigger `timeoutMs` |
| empty text on a JS-heavy site | retry with `settleMs: 800` or `selector` pointing at the article |
| `all worker tabs busy` | raise `pool` in the extension options |
