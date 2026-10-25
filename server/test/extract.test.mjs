/*
 * extract.test.mjs — runs the real content scripts inside jsdom (no Firefox needed).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.resolve(here, "..", "..", "extension", "lib");
const extractSrc = fs.readFileSync(path.join(ext, "extract.js"), "utf8");
const actSrc = fs.readFileSync(path.join(ext, "act.js"), "utf8");

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    pass++;
    console.log("  ok   " + name);
  } else {
    fail++;
    console.log("  FAIL " + name + (extra === undefined ? "" : " :: " + JSON.stringify(extra).slice(0, 500)));
  }
};

const FILLER = Array.from({ length: 30 }, (_, i) => `Filler sentence number ${i} keeps the article long enough to be scored as the content root.`).join(" ");

const HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>Test Article — Site</title>
<meta name="description" content="A test article about extraction">
<style>.x{color:red}</style>
<script>window.evil = "SCRIPT_TEXT_SHOULD_NOT_APPEAR";</script>
</head>
<body>
<header><h1>The Real Title</h1></header>
<nav><a href="/home">Home</a><a href="/about">About</a><a href="/home">Home dup</a></nav>
<main>
  <article>
    <h2>Section one</h2>
    <p>First paragraph with <strong>bold</strong> and <a href="/link-1">a link</a>.</p>
    <p>Second paragraph is reasonably long so the scorer picks this article as the content root.</p>
    <p>${FILLER}</p>
    <ul><li>alpha</li><li>beta</li></ul>
    <pre><code>const x = 1;</code></pre>
    <blockquote>Quoted line</blockquote>
    <table><tr><th>k</th><th>v</th></tr><tr><td><a href="/cell-link">cell link</a></td><td>1</td></tr></table>
    <p><img alt="diagram" src="/d.png"></p>
    <div class="cookie-banner"><p>COOKIE_JUNK_TEXT</p></div>
    <div style="display:none"><p>HIDDEN_JUNK_TEXT</p></div>
  </article>
</main>
<aside><p>SIDEBAR_JUNK_TEXT that must not appear in the output body.</p></aside>
<footer><p>FOOTER_JUNK_TEXT must not appear.</p></footer>
</body></html>`;

function boot(html, url = "http://example.com/a/page") {
  // jsdom does not implement scrollTo/requestSubmit; those are expected here
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e) => {
    if (!/Not implemented/i.test(e.message)) console.error("[jsdom] " + e.message);
  });
  const dom = new JSDOM(html, { url, runScripts: "outside-only", pretendToBeVisual: true, virtualConsole });
  dom.window.eval(extractSrc);
  dom.window.eval(actSrc);
  return dom;
}

console.log("\n[extract.js]");
{
  const dom = boot(HTML);
  const r = dom.window.FXExtract.run({ links: true });
  ok("ok flag", r.ok === true, r);
  ok("title", r.title === "Test Article — Site", r.title);
  ok("lang", r.lang === "en", r.lang);
  ok("description", r.description === "A test article about extraction", r.description);
  ok("site", r.site === "example.com", r.site);
  ok("heading markdown", r.text.includes("## Section one"), r.text.slice(0, 200));
  ok("bold markdown", r.text.includes("**bold**"));
  ok("inline link markdown", r.text.includes("[a link](http://example.com/link-1)"), r.text.match(/\[a link\][^)]*\)/));
  ok("list markdown", r.text.includes("- alpha") && r.text.includes("- beta"));
  ok("code fence", r.text.includes("```") && r.text.includes("const x = 1;"));
  ok("blockquote", r.text.includes("> Quoted line"));
  ok("table", r.text.includes("k | v") && r.text.includes("[cell link](http://example.com/cell-link) | 1"), r.text.match(/k \| v[\s\S]{0,120}/));
  ok("img alt", r.text.includes("![diagram]"), r.text.slice(-400));
  ok("no script text", !r.text.includes("SCRIPT_TEXT_SHOULD_NOT_APPEAR"));
  ok("no sidebar", !r.text.includes("SIDEBAR_JUNK_TEXT"));
  ok("no footer", !r.text.includes("FOOTER_JUNK_TEXT"));
  ok("no cookie class junk", !r.text.includes("COOKIE_JUNK_TEXT"));
  ok("no inline-hidden junk", !r.text.includes("HIDDEN_JUNK_TEXT"));
  ok("links collected", Array.isArray(r.links) && r.links.length >= 3, r.links && r.links.length);
  ok("links absolute", r.links.every((l) => /^https?:\/\//.test(l.url)), r.links);
  ok("links deduped", new Set(r.links.map((l) => l.url)).size === r.links.length, r.links.map((l) => l.url));
  ok("junk anchors skipped", !r.links.some((l) => l.url.includes("#")), r.links.map((l) => l.url));
  ok("nodes counted", r.nodes > 10, r.nodes);
  ok("timing reported", typeof r.ms === "number");
}

console.log("\n[extract.js · caps and formats]");
{
  const dom = boot(HTML);
  const r = dom.window.FXExtract.run({ maxChars: 500 });
  ok("cap enforced", r.chars <= 500 && r.text.length <= 500, r.chars);
  ok("truncated flagged", r.truncated === true, r.truncated);

  const txt = dom.window.FXExtract.run({ format: "text", maxChars: 500 });
  ok("text format", !txt.text.includes("## ") && txt.chars <= 500, txt.text.slice(0, 120));

  const scoped = dom.window.FXExtract.run({ selector: "blockquote" });
  ok("selector scoping", scoped.text.includes("Quoted line") && !scoped.text.includes("Filler sentence"), scoped.text);

  const noLinks = dom.window.FXExtract.run({ links: false });
  ok("links opt-out", noLinks.links === undefined);
}

console.log("\n[extract.js · pages without article/main]");
{
  const dom = boot(`<!doctype html><html><body><div><div><p>${FILLER}</p><p>${FILLER}</p></div></div><div><p>short</p></div></body></html>`);
  const r = dom.window.FXExtract.run({});
  ok("fallback root picks prose", r.text.includes("Filler sentence number 0"), r.text.slice(0, 120));
  ok("returned content", r.chars > 500, r.chars);
}

console.log("\n[act.js · click / type / press]");
{
  const dom = boot(`<!doctype html><html><body>
    <a id="go" href="/next">Go next</a>
    <button id="btn">Press me</button>
    <form id="f" onsubmit="this.dataset.sent='1'; return false;">
      <input id="q" name="q" value="old">
      <input id="sub" type="submit" value="Search">
    </form>
    <div id="late"></div>
  </body></html>`);

  const { FXAct } = dom.window;

  const byText = FXAct.click({ text: "Go next" });
  ok("click by text", byText.ok === true && byText.href === "http://example.com/next", byText);

  const btn = dom.window.document.getElementById("btn");
  btn.addEventListener("click", () => {
    btn.textContent = "clicked!";
  });
  const bySel = FXAct.click({ selector: "#btn" });
  ok("click by selector", bySel.ok === true && dom.window.document.getElementById("btn").textContent === "clicked!", bySel);

  const missing = FXAct.click({ selector: "#nope" });
  ok("click missing reports error", missing.ok === false, missing);

  const typed = FXAct.type({ selector: "#q", text: "hello world" });
  ok("type sets value", typed.ok === true && dom.window.document.getElementById("q").value === "hello world", typed);

  const appended = FXAct.type({ selector: "#q", text: "!", clear: false });
  ok("type appends", appended.value === "hello world!", appended);

  let submitted = false;
  dom.window.document.getElementById("f").addEventListener("submit", () => {
    submitted = true;
  });
  const sub = FXAct.type({ selector: "#q", text: "x", submit: true });
  ok("type submit fires form", sub.ok === true && submitted === true, sub);

  const pressed = FXAct.press({ key: "Escape" });
  ok("press key", pressed.ok === true && pressed.key === "Escape", pressed);

  const scrolled = FXAct.scroll({ to: "top" });
  ok("scroll reports bounds", scrolled.ok === true && scrolled.to === 0, scrolled);

  const info = FXAct.info();
  ok("info", info.ok === true && info.url === "http://example.com/a/page", info);
}

const dom2 = boot(HTML);
dom2.window.FXAct.waitFor({ selector: "h2", timeoutMs: 500 }).then((v) => {
  ok("waitFor finds existing", v.ok === true && v.found === true, v);
  ok("waitFor reports elapsed", typeof v.elapsedMs === "number", v);
  finish();
});

function finish() {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
