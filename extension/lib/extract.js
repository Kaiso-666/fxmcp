/*
 * fxmcp · page reader (declared content script, classic script, isolated world)
 * Turns the current document into compact markdown/text + link list.
 * No page mutation, no layout thrash (innerText is only used when explicitly asked for).
 */
(() => {
  "use strict";
  if (globalThis.FXExtract) return;

  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "IFRAME", "OBJECT", "EMBED",
    "VIDEO", "AUDIO", "SOURCE", "TRACK", "MAP", "AREA", "LINK", "META", "HEAD", "BASE",
    "NAV", "ASIDE", "FOOTER", "DIALOG", "FORM", "INPUT", "SELECT", "TEXTAREA", "BUTTON"
  ]);
  const SKIP_ROLES = new Set([
    "navigation", "banner", "complementary", "contentinfo", "search", "dialog",
    "menu", "menubar", "toolbar", "tablist"
  ]);
  const SKIP_CLASS = /(^|[\s_-])(ads?|advert|advertisement|sponsor|promo|sidebar|comments?|share|social|related|newsletter|subscribe|cookie|popup|modal|overlay|paywall|breadcrumbs?)([\s_-]|$)/i;

  const MAX_NODES = 30000;

  function collapse(s) {
    return s
      .replace(/[ \t\u00a0]+/g, " ")
      .replace(/ ?\n ?/g, "\n")
      .replace(/[ \t]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function isHidden(el) {
    if (el.hidden === true) return true;
    const a = el.getAttribute("aria-hidden");
    if (a === "true" || a === "1") return true;
    const st = el.getAttribute("style");
    if (st) {
      if (st.indexOf("display:none") >= 0 || st.indexOf("display: none") >= 0) return true;
      if (st.indexOf("visibility:hidden") >= 0 || st.indexOf("visibility: hidden") >= 0) return true;
    }
    return false;
  }

  /* ---------- main-content heuristic -------------------------------------- */

  function scoreRoot(doc) {
    const scores = new Map();
    const nodes = doc.querySelectorAll("p,pre,li,h2,h3,blockquote,td");
    const n = Math.min(nodes.length, 5000);
    for (let i = 0; i < n; i++) {
      const el = nodes[i];
      const len = el.textContent.length;
      if (len < 30) continue;
      let p = el.parentElement;
      let d = 0;
      while (p && d < 3) {
        const w = d === 0 ? 1 : d === 1 ? 0.6 : 0.3;
        scores.set(p, (scores.get(p) || 0) + len * w);
        p = p.parentElement;
        d++;
      }
    }
    let best = null;
    let bestScore = 0;
    for (const [el, s] of scores) {
      if (s > bestScore) {
        bestScore = s;
        best = el;
      }
    }
    return bestScore >= 250 ? best : null;
  }

  /* ---------- markdown serialiser ----------------------------------------- */

  function serialize(root, maxChars) {
    const parts = [];
    let len = 0;
    let nodes = 0;
    let truncated = false;

    function push(s) {
      if (!s) return true;
      if (len >= maxChars) {
        truncated = true;
        return false;
      }
      if (len + s.length > maxChars) {
        parts.push(s.slice(0, maxChars - len));
        len = maxChars;
        truncated = true;
        return false;
      }
      parts.push(s);
      len += s.length;
      return true;
    }

    const flat = (el) => (el.textContent || "").replace(/\s+/g, " ");

    // inline renderer for table cells: keeps anchors and images as markdown
    function inlineMd(el) {
      let out = "";
      const rec = (n) => {
        if (n.nodeType === 3) {
          out += n.nodeValue.replace(/\s+/g, " ");
          return;
        }
        if (n.nodeType !== 1) return;
        const tag = n.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return;
        if (tag === "BR") {
          out += " ";
          return;
        }
        if (tag === "IMG") {
          const alt = (n.getAttribute("alt") || "").trim();
          if (alt) out += "![" + alt + "]";
          return;
        }
        if (tag === "A") {
          const href = n.getAttribute("href");
          const t = (n.textContent || "").replace(/\s+/g, " ").trim();
          let abs = "";
          try {
            abs = new URL(href, document.baseURI || location.href).href;
          } catch (e) {
            abs = "";
          }
          if (t && /^https?:/i.test(abs)) out += "[" + t + "](" + abs + ")";
          else out += t;
          return;
        }
        for (let c = n.firstChild; c; c = c.nextSibling) rec(c);
      };
      rec(el);
      return out.replace(/\s+/g, " ").trim();
    }

    function walk(node, depth) {
      if (truncated) return;
      if (depth > 160 || nodes > MAX_NODES) {
        truncated = true;
        return;
      }
      if (node.nodeType === 3) {
        nodes++;
        push(node.nodeValue.replace(/\s+/g, " "));
        return;
      }
      if (node.nodeType !== 1) return;
      nodes++;

      const tag = node.tagName;
      if (SKIP_TAGS.has(tag)) return;
      if (node.namespaceURI && node.namespaceURI !== "http://www.w3.org/1999/xhtml") return;

      const role = node.getAttribute("role");
      if (role && SKIP_ROLES.has(role.toLowerCase())) return;

      const cls = node.className;
      if (typeof cls === "string" && cls.length && cls.length < 240 && SKIP_CLASS.test(cls)) return;

      const id = node.id;
      if (id && SKIP_CLASS.test(id)) return;

      if (isHidden(node)) return;

      switch (tag) {
        case "H1": case "H2": case "H3": case "H4": case "H5": case "H6": {
          const lvl = +tag.charAt(1);
          if (!push("\n\n" + "#".repeat(lvl) + " ")) return;
          for (let c = node.firstChild; c && !truncated; c = c.nextSibling) walk(c, depth + 1);
          push("\n\n");
          return;
        }
        case "P": case "DIV": case "SECTION": case "ARTICLE": case "MAIN": case "BODY": {
          const block = tag !== "DIV" && tag !== "SECTION" && tag !== "ARTICLE" && tag !== "MAIN" && tag !== "BODY";
          if (block && !push("\n\n")) return;
          for (let c = node.firstChild; c && !truncated; c = c.nextSibling) walk(c, depth + 1);
          if (block) push("\n\n");
          return;
        }
        case "BR":
          push("\n");
          return;
        case "HR":
          push("\n\n---\n\n");
          return;
        case "PRE": {
          const t = (node.textContent || "").replace(/^\n+|\n+$/g, "");
          if (!t.trim()) return;
          push("\n\n```\n" + t.slice(0, 8000) + "\n```\n\n");
          return;
        }
        case "CODE": {
          if (node.closest("pre")) {
            push(node.textContent || "");
            return;
          }
          const t = flat(node).slice(0, 400);
          if (t) push("`" + t + "`");
          return;
        }
        case "UL": case "OL": {
          push("\n");
          let i = 0;
          for (let li = node.firstElementChild; li && !truncated; li = li.nextElementSibling) {
            if (li.tagName !== "LI") continue;
            i++;
            if (tag === "OL") {
              const start = parseInt(node.getAttribute("start") || "1", 10) || 1;
              push("\n" + (start + i - 1) + ". ");
            } else {
              push("\n- ");
            }
            for (let c = li.firstChild; c && !truncated; c = c.nextSibling) walk(c, depth + 1);
          }
          push("\n");
          return;
        }
        case "LI": {
          push("\n- ");
          for (let c = node.firstChild; c && !truncated; c = c.nextSibling) walk(c, depth + 1);
          push("\n");
          return;
        }
        case "BLOCKQUOTE": {
          const t = collapse(flat(node)).slice(0, Math.min(6000, maxChars));
          if (!t) return;
          push("\n\n" + t.split("\n").map((l) => "> " + l).join("\n") + "\n\n");
          return;
        }
        case "A": {
          const href = node.getAttribute("href");
          const t = flat(node).trim();
          if (!href || href.charAt(0) === "#" || /^javascript:/i.test(href)) {
            if (t) push(t);
            return;
          }
          if (!t) return;
          let abs;
          try {
            abs = new URL(href, document.baseURI || location.href).href;
          } catch (e) {
            push(t);
            return;
          }
          if (!/^https?:/i.test(abs)) {
            push(t);
            return;
          }
          push("[" + t.slice(0, 300) + "](" + abs + ")");
          return;
        }
        case "IMG": {
          const alt = (node.getAttribute("alt") || "").replace(/\s+/g, " ").trim();
          if (alt.length > 2 && alt.length < 300) push("![" + alt + "]");
          return;
        }
        case "TABLE": {
          const rows = node.querySelectorAll("tr");
          if (!rows.length || rows.length > 400) return;
          push("\n");
          for (let i = 0; i < rows.length && !truncated; i++) {
            const cells = rows[i].querySelectorAll("th,td");
            if (!cells.length) continue;
            const line = [];
            for (let j = 0; j < cells.length; j++) line.push(inlineMd(cells[j]).slice(0, 300));
            if (line.join("").trim()) push("\n" + line.join(" | "));
          }
          push("\n");
          return;
        }
        case "STRONG": case "B": {
          push("**");
          for (let c = node.firstChild; c && !truncated; c = c.nextSibling) walk(c, depth + 1);
          push("**");
          return;
        }
        case "EM": case "I": {
          push("_");
          for (let c = node.firstChild; c && !truncated; c = c.nextSibling) walk(c, depth + 1);
          push("_");
          return;
        }
        default: {
          for (let c = node.firstChild; c && !truncated; c = c.nextSibling) walk(c, depth + 1);
        }
      }
    }

    walk(root, 0);
    return { text: parts.join(""), truncated, nodes };
  }

  /* ---------- links / meta ------------------------------------------------ */

  function collectLinks(doc, filter, limit) {
    const out = [];
    const seen = new Set();
    const base = doc.baseURI || location.href;
    let re = null;
    if (filter) {
      try {
        re = new RegExp(filter, "i");
      } catch (e) {
        re = null;
      }
    }
    const anchors = doc.querySelectorAll("a[href]");
    for (let i = 0; i < anchors.length; i++) {
      if (out.length >= limit) break;
      const a = anchors[i];
      const href = a.getAttribute("href");
      if (!href || href.charAt(0) === "#") continue;
      if (/^(javascript|mailto|tel|data|blob):/i.test(href)) continue;
      let url;
      try {
        url = new URL(href, base).href;
      } catch (e) {
        continue;
      }
      if (!/^https?:/i.test(url)) continue;
      if (seen.has(url)) continue;
      let text = (a.textContent || "").replace(/\s+/g, " ").trim();
      if (!text) text = a.getAttribute("aria-label") || a.getAttribute("title") || "";
      text = text.slice(0, 160);
      if (re && !re.test(url) && !re.test(text)) continue;
      seen.add(url);
      out.push(text ? { text, url } : { url });
    }
    return out;
  }

  function meta(doc, name) {
    const el =
      doc.querySelector('meta[name="' + name + '"]') ||
      doc.querySelector('meta[property="' + name + '"]') ||
      doc.querySelector('meta[itemprop="' + name + '"]');
    const c = el && el.getAttribute("content");
    return c ? c.trim().slice(0, 500) : "";
  }

  /* ---------- entry point ------------------------------------------------- */

  function run(opts) {
    opts = opts || {};
    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
    const maxChars = Math.max(500, Math.min(opts.maxChars || 20000, 400000));
    const format = opts.format === "text" ? "text" : "markdown";

    let root = null;
    if (opts.selector) {
      try {
        root = document.querySelector(opts.selector);
      } catch (e) {
        root = null;
      }
    }
    if (!root) root = scoreRoot(document) || document.body || document.documentElement;
    if (!root) return { ok: false, error: "empty document" };

    let text = "";
    let truncated = false;
    let nodes = 0;

    if (format === "text") {
      const raw = (root.innerText || root.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
      text = raw.slice(0, maxChars);
      truncated = raw.length > text.length;
    } else if (opts.linksOnly) {
      text = "";
    } else {
      const r = serialize(root, maxChars);
      text = collapse(r.text);
      truncated = r.truncated;
      nodes = r.nodes;
      if (text.length > maxChars) {
        text = text.slice(0, maxChars);
        truncated = true;
      }
    }

    const links = opts.links
      ? collectLinks(document, opts.filter, Math.max(1, Math.min(opts.limit || 120, 1000)))
      : undefined;

    const ms = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;

    return {
      ok: true,
      url: location.href,
      title: (document.title || "").trim().slice(0, 300),
      site: location.hostname,
      lang: document.documentElement.getAttribute("lang") || "",
      description: meta(document, "description") || meta(document, "og:description"),
      text,
      links,
      chars: text.length,
      truncated,
      nodes,
      ms: Math.round(ms * 10) / 10
    };
  }

  globalThis.FXExtract = {
    run,
    links: (filter, limit) => collectLinks(document, filter, limit || 200),
    meta: (n) => meta(document, n),
    version: 1
  };
})();
