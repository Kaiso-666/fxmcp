/*
 * fxmcp · page actors (declared content script, classic script, isolated world)
 * Click / type / key / scroll / wait primitives. Every function returns a plain
 * JSON-safe object so it can cross the executeScript boundary.
 */
(() => {
  "use strict";
  if (globalThis.FXAct) return;

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
  }

  function pick(selector, index) {
    if (!selector) return null;
    let list;
    try {
      list = document.querySelectorAll(selector);
    } catch (e) {
      throw new Error("invalid selector: " + selector);
    }
    if (!list.length) return null;
    return list[index || 0] || null;
  }

  function findByText(text, index) {
    const want = text.trim().toLowerCase();
    if (!want) return null;
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const v = n.nodeValue;
        if (!v || v.length < 2) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        const t = p.tagName;
        if (t === "SCRIPT" || t === "STYLE" || t === "NOSCRIPT" || t === "TEMPLATE") return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const hits = [];
    let n;
    while ((n = walker.nextNode())) {
      const v = n.nodeValue.toLowerCase();
      if (v.indexOf(want) < 0) continue;
      const p = n.parentElement;
      const el = p.closest('a,button,[role="button"],[role="link"],input,summary,label,li,tr,td,div,span') || p;
      hits.push({ el, exact: v.trim() === want ? 1 : 0, len: n.nodeValue.length });
      if (hits.length > 80) break;
    }
    if (!hits.length) return null;
    hits.sort((a, b) => b.exact - a.exact || a.len - b.len);
    return (hits[index || 0] || hits[0]).el;
  }

  function fire(el, type) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 }));
  }

  function label(el) {
    const t = (el.innerText || el.value || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
    return t.slice(0, 120);
  }

  /* ---------- click ------------------------------------------------------- */

  function click(opts) {
    opts = opts || {};
    let el = pick(opts.selector, opts.index);
    if (!el && opts.text) el = findByText(opts.text, opts.index);
    if (!el) return { ok: false, error: "target not found" };
    if (el.disabled === true) return { ok: false, error: "element is disabled" };

    const before = location.href;
    try {
      el.scrollIntoView({ block: "center", inline: "nearest" });
    } catch (e) {
      /* noop */
    }
    try {
      if (typeof el.focus === "function") el.focus({ preventScroll: true });
      fire(el, "pointerdown");
      fire(el, "mousedown");
      fire(el, "mouseup");
      if (typeof el.click === "function") el.click();
      else fire(el, "click");
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }

    const out = {
      ok: true,
      tag: el.tagName.toLowerCase(),
      text: label(el),
      href: el.href || null
    };
    if (location.href !== before) out.navigated = location.href;
    return out;
  }

  /* ---------- type / keys -------------------------------------------------- */

  function setValue(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : null;
    if (proto) {
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(el, value);
      else el.value = value;
      return true;
    }
    if (el.isContentEditable) {
      el.textContent = value;
      return true;
    }
    return false;
  }

  function key(el, name, extra) {
    const base = {
      key: name,
      code: (extra && extra.code) || name,
      bubbles: true,
      cancelable: true,
      composed: true,
      keyCode: name === "Enter" ? 13 : undefined,
      which: name === "Enter" ? 13 : undefined
    };
    const target = el || document.activeElement || document.body;
    for (const type of ["keydown", "keypress", "keyup"]) {
      target.dispatchEvent(new KeyboardEvent(type, base));
    }
  }

  function type(opts) {
    opts = opts || {};
    let el = pick(opts.selector, opts.index);
    if (!el && opts.text !== undefined && opts.locateByText) el = findByText(opts.locateByText, opts.index);
    if (!el) return { ok: false, error: "input not found" };
    if (el.disabled === true || el.readOnly === true) return { ok: false, error: "element is read-only" };

    try {
      if (typeof el.focus === "function") el.focus({ preventScroll: true });
    } catch (e) {
      /* noop */
    }

    const clear = opts.clear !== false;
    const current = el.isContentEditable ? el.textContent || "" : el.value || "";
    if (!setValue(el, (clear ? "" : current) + (opts.text || ""))) {
      return { ok: false, error: "element does not accept text" };
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));

    if (opts.submit) {
      const form = el.form || el.closest("form");
      if (form) {
        if (typeof form.requestSubmit === "function") {
          try {
            form.requestSubmit();
          } catch (e) {
            form.submit();
          }
        } else {
          form.submit();
        }
      } else {
        key(el, "Enter");
      }
    }

    const value = el.isContentEditable ? el.textContent || "" : el.value || "";
    return { ok: true, tag: el.tagName.toLowerCase(), value: value.slice(0, 300) };
  }

  function press(opts) {
    opts = opts || {};
    const el = pick(opts.selector, 0) || document.activeElement || document.body;
    const name = opts.key || "Enter";
    key(el, name);
    if (name === "Enter") {
      const form = el.form || (el.closest && el.closest("form"));
      if (form) {
        if (typeof form.requestSubmit === "function") {
          try {
            form.requestSubmit();
          } catch (e) {
            /* noop */
          }
        } else {
          form.submit();
        }
      }
    }
    return { ok: true, target: el.tagName ? el.tagName.toLowerCase() : "body", key: name };
  }

  function scroll(opts) {
    opts = opts || {};
    const doc = document.documentElement;
    const max = Math.max(0, (doc.scrollHeight || 0) - window.innerHeight);
    const from = window.scrollY;
    let top;
    const to = opts.to;
    if (to === "bottom" || to === -1) top = max;
    else if (to === "top" || to === undefined || to === null) top = 0;
    else if (typeof to === "number") top = to;
    else if (/^\d+$/.test(String(to))) top = Number(to);
    else top = 0;
    top = Math.max(0, Math.min(top, max));
    window.scrollTo({ top, behavior: opts.smooth ? "smooth" : "instant" });
    return { ok: true, from: Math.round(from), to: Math.round(top), max: Math.round(max) };
  }

  /* ---------- wait -------------------------------------------------------- */

  function waitFor(opts) {
    opts = opts || {};
    const selector = opts.selector;
    const timeoutMs = Math.max(50, Math.min(opts.timeoutMs || 5000, 60000));
    const t0 = Date.now();
    if (!selector) return Promise.resolve({ ok: false, error: "selector required" });

    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      let poll = null;

      const done = (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(poll);
        resolve(v);
      };

      const check = () => {
        let el = null;
        try {
          el = document.querySelector(selector);
        } catch (e) {
          done({ ok: false, error: "invalid selector" });
          return;
        }
        if (el && (!opts.visible || isVisible(el))) {
          done({ ok: true, found: true, elapsedMs: Date.now() - t0 });
        }
      };

      check();
      if (settled) return;
      poll = setInterval(check, 60);
      timer = setTimeout(() => done({ ok: false, found: false, timeout: true, elapsedMs: Date.now() - t0 }), timeoutMs);
    });
  }

  function info() {
    return {
      ok: true,
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      scrollY: Math.round(window.scrollY),
      scrollMax: Math.round(Math.max(0, (document.documentElement.scrollHeight || 0) - window.innerHeight)),
      focused: document.activeElement ? document.activeElement.tagName.toLowerCase() : null
    };
  }

  globalThis.FXAct = { click, type, press, scroll, waitFor, info, isVisible, version: 1 };
})();
