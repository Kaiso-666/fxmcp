// Template. `node server/scripts/init.mjs` copies this to config.js and fills in the token.
export const CONFIG = {
  endpoint: "ws://127.0.0.1:8787",
  token: "",
  // how many background "worker" tabs the reader may own (parallel reads)
  pool: 3,
  // page text cache lifetime (ms) for repeated `read` of the same URL
  cacheTtlMs: 120000,
  // extra settle time after load before extracting (SPAs)
  settleMs: 60,
  // "ddg" | "searxng"
  searchEngine: "ddg",
  // base URL of a SearXNG instance, e.g. "http://127.0.0.1:8888"
  searxng: "",
  verbose: false
};
