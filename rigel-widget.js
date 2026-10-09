/**
 * Rigel — floating island chat widget for Dr3amy Pages
 * ------------------------------------------------------------
 * Drop-in: <script src="/rigel-widget.js" defer></script>
 *
 * A round button sits bottom-right. Click it and it morphs into a
 * chat "island". Everything lives in a Shadow DOM so it can't clash
 * with page styles.
 *
 * Features
 *  - Chat with Rigel (knows the site; can point you to pages)
 *  - "Export to website": publishes Rigel's HTML to the signed-in user's
 *    own dr3amy-pages repo in one click (same path the dashboard uses).
 *
 * Secrets: the GitHub token is read from this browser's localStorage and is
 * only ever sent to api.github.com. It is never sent to Rigel, and anything
 * that looks like a token is stripped from messages before they leave.
 */
(() => {
  "use strict";

  if (window.__rigelWidget) return;
  window.__rigelWidget = true;

  // ── config ──────────────────────────────────────────────
  const RIGEL_API = "https://ltnproj-rigel-api.hf.space";
  const MODEL_LABEL = "Rigel 1o-mini";
  const MAX_SENT_TURNS = 16;
  const MAX_INPUT_CHARS = 4000;
  const TIMEOUT_MS = 120000; // ZeroGPU cold starts can be slow
  const STORE_KEY = "rigel:chat:v1";
  const OPEN_KEY = "rigel:open";
  const DRAFT_KEY = "rigel:draft";

  // Same repo / branch / path scheme as dashboard.html
  const GITHUB_API = "https://api.github.com";
  const REPO_NAME = "dr3amy-pages";
  const REPO_URL = "https://github.com/ltnproject/dr3amy-pages";
  const SITE_URL = "https://dr3amy.creepers.pro";

  const SUGGESTIONS = [
    "Write HTML for a link-in-bio page",
    "Explain flexbox simply",
    "Give me a tagline idea",
  ];

  // ── tiny helpers ────────────────────────────────────────
  const store = {
    get() {
      try { return JSON.parse(sessionStorage.getItem(STORE_KEY) || "[]"); }
      catch { return []; }
    },
    set(v) {
      try { sessionStorage.setItem(STORE_KEY, JSON.stringify(v)); } catch { /* ignore */ }
    },
  };

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const TOKEN_RE = /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|hf_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g;
  const redactSecrets = (t) => t.replace(TOKEN_RE, "[removed]");

  function slugify(input) {
    return (input || "").toLowerCase().trim()
      .replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  }

  // Only allow same-site paths or the project's GitHub repo as nav targets.
  function resolveAction(a) {
    if (!a || typeof a.href !== "string" || typeof a.label !== "string") return null;
    const label = a.label.slice(0, 40);
    if (a.href.startsWith(REPO_URL)) return { label, href: a.href, external: true };
    if (/^\/(?!\/)[A-Za-z0-9\-._~\/]*(#[A-Za-z0-9\-_]*)?$/.test(a.href)) {
      return { label, href: a.href, external: false };
    }
    return null;
  }

  // Pull the last complete-looking HTML document out of a reply.
  function extractPage(text) {
    const parts = text.split("```");
    let found = null;
    for (let i = 1; i < parts.length; i += 2) {
      const body = parts[i].replace(/^[\w+#.-]*\n/, "");
      if (/<!doctype html|<html[\s>]/i.test(body)) {
        const closed = i < parts.length - 1;
        found = { html: body.trim(), complete: closed && /<\/html>/i.test(body) };
      }
    }
    return found;
  }

  // Exported pages are static: strip scripts, embeds and event handlers.
  // (Published pages share an origin with the dashboard, so this keeps a
  // generated page from ever touching the signed-in session.)
  function sanitizePage(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    let removed = 0;
    doc.querySelectorAll(
      "script,iframe,frame,frameset,object,embed,applet,base,meta[http-equiv]," +
      "link[rel~='import'],link[rel~='modulepreload']"
    ).forEach((n) => { n.remove(); removed++; });
    doc.querySelectorAll("*").forEach((n) => {
      [...n.attributes].forEach((at) => {
        const name = at.name.toLowerCase();
        const val = at.value.replace(/[\u0000-\u0020]/g, "").toLowerCase();
        const url = ["href", "src", "action", "formaction", "xlink:href"].includes(name);
        if (name.startsWith("on") || name === "srcdoc" ||
            (url && /^(javascript|vbscript):|^data:text\/html/.test(val))) {
          n.removeAttribute(at.name); removed++;
        }
      });
    });
    if (!doc.querySelector("meta[charset]")) {
      const m = doc.createElement("meta"); m.setAttribute("charset", "utf-8");
      doc.head.insertBefore(m, doc.head.firstChild);
    }
    if (!doc.querySelector("meta[name=viewport]")) {
      const m = doc.createElement("meta");
      m.name = "viewport"; m.content = "width=device-width, initial-scale=1";
      doc.head.appendChild(m);
    }
    const title = (doc.title || (doc.querySelector("h1") || {}).textContent || "").trim();
    return { html: "<!doctype html>\n" + doc.documentElement.outerHTML, removed, title };
  }

  function toBase64Unicode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  // Publish to p/<slug>/index.html in the user's repo. Never overwrites an
  // existing page: picks the next free slug (slug, slug-2, slug-3, ...).
  async function publishPage(html, wantedSlug) {
    const token = localStorage.getItem("ghToken");
    const owner = localStorage.getItem("ghOwner");
    if (!token || !owner) throw Object.assign(new Error("signin"), { code: "signin" });

    const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" };
    const base = slugify(wantedSlug) || "page-" + Date.now().toString(36);
    const api = (slug) => `${GITHUB_API}/repos/${owner}/${REPO_NAME}/contents/p/${slug}/index.html`;

    let slug = null;
    for (let n = 1; n <= 20 && !slug; n++) {
      const candidate = n === 1 ? base : `${base}-${n}`;
      const r = await fetch(api(candidate), { headers });
      if (r.status === 404) slug = candidate;
      else if (r.status === 401) throw Object.assign(new Error("auth"), { code: "auth" });
      else if (r.status !== 200) throw Object.assign(new Error("lookup"), { code: "http", status: r.status });
    }
    if (!slug) throw Object.assign(new Error("slug"), { code: "slug" });

    const res = await fetch(api(slug), {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `Publish page: ${slug} (via Rigel)`,
        content: toBase64Unicode(html),
        branch: "main",
      }),
    });
    if (res.status === 401) throw Object.assign(new Error("auth"), { code: "auth" });
    if (res.status === 404) throw Object.assign(new Error("repo"), { code: "repo" });
    if (!res.ok) throw Object.assign(new Error("put"), { code: "http", status: res.status });
    return slug;
  }

  // Safe mini-markdown: ``` blocks, `code`, **bold**. Never uses innerHTML.
  function renderRich(target, text) {
    target.textContent = "";
    text.split("```").forEach((chunk, i) => {
      if (i % 2 === 1) {
        const pre = el("pre");
        pre.appendChild(el("code", "", chunk.replace(/^[\w+#.-]*\n/, "").replace(/\n$/, "")));
        target.appendChild(pre);
      } else if (chunk) {
        inline(target, chunk);
      }
    });
  }

  function inline(target, t) {
    const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
    let last = 0, m;
    while ((m = re.exec(t))) {
      if (m.index > last) target.append(t.slice(last, m.index));
      const tok = m[0];
      if (tok[0] === "`") target.appendChild(el("code", "", tok.slice(1, -1)));
      else target.appendChild(el("strong", "", tok.slice(2, -2)));
      last = m.index + tok.length;
    }
    if (last < t.length) target.append(t.slice(last));
  }

  // ── styles ──────────────────────────────────────────────
  const CSS = `
  :host { all: initial; }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  .island {
    --ink: #1a1628;
    --muted: #6b6585;
    --accent: #7c3aed;
    --grad: linear-gradient(135deg, #7161ff, #bd75ff);
    --open-w: min(390px, calc(100vw - 24px));
    --open-h: min(590px, calc(100dvh - 40px));

    position: fixed;
    right: max(20px, env(safe-area-inset-right));
    bottom: max(20px, env(safe-area-inset-bottom));
    z-index: 990;
    width: 58px; height: 58px;
    border-radius: 29px;
    overflow: hidden;
    color: var(--ink);
    font-family: 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
    font-size: 14px; line-height: 1.55;
    background: rgba(255,255,255,0.78);
    backdrop-filter: blur(26px) saturate(1.6);
    -webkit-backdrop-filter: blur(26px) saturate(1.6);
    border: 1px solid rgba(255,255,255,0.8);
    box-shadow: 0 10px 40px rgba(113,97,255,0.30), 0 2px 8px rgba(26,22,40,0.10),
                inset 0 1px 0 rgba(255,255,255,0.9);
    transition: width .5s cubic-bezier(.2,.9,.25,1.05),
                height .5s cubic-bezier(.2,.9,.25,1.05),
                border-radius .5s cubic-bezier(.2,.9,.25,1.05),
                box-shadow .3s ease;
  }
  .island[data-open="true"] {
    width: var(--open-w); height: var(--open-h);
    border-radius: 28px;
    box-shadow: 0 24px 80px rgba(113,97,255,0.28), 0 4px 16px rgba(26,22,40,0.12),
                inset 0 1px 0 rgba(255,255,255,0.9);
  }

  /* ── launcher ── */
  .fab {
    position: absolute; inset: 0;
    display: grid; place-items: center;
    border: 0; cursor: pointer; color: #fff;
    background: var(--grad);
    font-size: 24px;
    transition: opacity .25s ease, transform .25s ease;
  }
  .fab:hover { transform: scale(1.06); }
  .fab:focus-visible, .icon-btn:focus-visible, .send:focus-visible, .chip:focus-visible {
    outline: 2px solid var(--accent); outline-offset: 2px;
  }
  .island[data-open="true"] .fab { opacity: 0; pointer-events: none; transform: scale(.6); }
  @media (prefers-reduced-motion: no-preference) {
    .island[data-open="false"]::after {
      content: ""; position: absolute; inset: -1px; border-radius: inherit;
      border: 2px solid rgba(189,117,255,.55); pointer-events: none;
      animation: ping 2.8s ease-out infinite;
    }
    @keyframes ping { 0% { transform: scale(1); opacity: .8; } 100% { transform: scale(1.5); opacity: 0; } }
  }

  /* ── panel ── */
  .panel {
    position: absolute; right: 0; bottom: 0;
    width: var(--open-w); height: var(--open-h);
    display: flex; flex-direction: column;
    opacity: 0; visibility: hidden;
    transform: translateY(10px) scale(.98);
    transition: opacity .25s ease, transform .35s ease, visibility 0s linear .3s;
  }
  .island[data-open="true"] .panel {
    opacity: 1; visibility: visible; transform: none;
    transition: opacity .3s ease .18s, transform .4s ease .15s, visibility 0s;
  }

  .head {
    display: flex; align-items: center; gap: 10px;
    padding: 14px 14px 12px 16px;
    border-bottom: 1px solid rgba(124,58,237,0.10);
  }
  .logo {
    width: 34px; height: 34px; flex: none;
    display: grid; place-items: center;
    border-radius: 11px; color: #fff; font-size: 17px;
    background: var(--grad);
    box-shadow: 0 4px 14px rgba(113,97,255,.35);
  }
  .titles { flex: 1; min-width: 0; }
  .name { font-family: 'Fraunces', Georgia, serif; font-weight: 500; font-size: 16px; letter-spacing: -.01em; }
  .sub { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--muted); }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: #a78bfa; box-shadow: 0 0 8px #a78bfa; }
  .icon-btn {
    width: 32px; height: 32px; flex: none;
    display: grid; place-items: center;
    border: 0; border-radius: 10px; cursor: pointer;
    background: transparent; color: var(--muted);
    transition: background .15s ease, color .15s ease;
  }
  .icon-btn:hover { background: rgba(124,58,237,.09); color: var(--accent); }
  .icon-btn svg { width: 17px; height: 17px; }

  /* ── messages ── */
  .log {
    flex: 1; overflow-y: auto; overscroll-behavior: contain;
    padding: 16px 14px; display: flex; flex-direction: column; gap: 10px;
    scrollbar-width: thin; scrollbar-color: rgba(124,58,237,.25) transparent;
  }
  .msg {
    max-width: 88%; padding: 9px 13px; border-radius: 17px;
    white-space: pre-wrap; overflow-wrap: anywhere;
    animation: rise .25s ease both;
  }
  @keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  .msg.user {
    align-self: flex-end; color: #fff;
    background: linear-gradient(135deg, #7161ff, #9b6bf5);
    border-bottom-right-radius: 6px;
  }
  .msg.bot {
    align-self: flex-start;
    background: rgba(255,255,255,.85);
    border: 1px solid rgba(124,58,237,.10);
    border-bottom-left-radius: 6px;
  }
  .msg.err { border-color: rgba(220,38,38,.25); color: #991b1b; }
  .msg code {
    font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 12.5px;
    background: rgba(124,58,237,.09); padding: 1px 5px; border-radius: 6px;
  }
  .msg pre {
    margin: 6px 0 2px; padding: 10px 12px; border-radius: 12px;
    background: #1a1628; color: #ece8ff; overflow-x: auto; white-space: pre;
  }
  .msg pre code { background: none; padding: 0; color: inherit; }
  .retry {
    margin-top: 6px; display: block; border: 0; cursor: pointer;
    background: rgba(124,58,237,.1); color: var(--accent);
    padding: 4px 10px; border-radius: 8px; font: inherit; font-size: 12.5px; font-weight: 500;
  }
  .msg pre { max-height: 200px; overflow: auto; }
  .msg.note { font-size: 12.5px; color: var(--muted); background: rgba(124,58,237,.06); border-color: transparent; }
  .actions { align-self: flex-start; display: flex; flex-wrap: wrap; gap: 6px; margin-top: -4px; animation: rise .25s ease both; }
  .act, .xbtn {
    border: 0; cursor: pointer; font: inherit; font-size: 12.5px; font-weight: 600;
    padding: 6px 12px; border-radius: 10px; color: #fff; background: var(--grad);
    transition: transform .15s ease, opacity .15s ease;
  }
  .act:hover, .xbtn:hover:not(:disabled) { transform: translateY(-1px); }
  .act:focus-visible, .xbtn:focus-visible, .ghost:focus-visible, .xlink:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .xbtn:disabled { opacity: .45; cursor: default; }
  .export { margin-top: 10px; padding-top: 10px; border-top: 1px dashed rgba(124,58,237,.2); white-space: normal; }
  .xrow { display: flex; flex-wrap: wrap; gap: 6px; }
  .ghost {
    border: 1px solid rgba(124,58,237,.25); background: transparent; color: var(--accent);
    font: inherit; font-size: 12.5px; font-weight: 600; padding: 5px 11px; border-radius: 10px; cursor: pointer;
  }
  .ghost:hover:not(:disabled) { background: rgba(124,58,237,.08); }
  .ghost:disabled { opacity: .45; cursor: default; }
  .xnote { margin-top: 7px; font-size: 12.5px; color: var(--muted); }
  .xnote.ok { color: #166534; }
  .xnote.bad { color: #991b1b; }
  .xlink { color: var(--accent); font-weight: 600; word-break: break-all; }
  .typing { display: inline-flex; gap: 4px; padding: 13px 14px; }
  .typing i {
    width: 6px; height: 6px; border-radius: 50%; background: #a78bfa;
    animation: bob 1s ease-in-out infinite;
  }
  .typing i:nth-child(2) { animation-delay: .15s; }
  .typing i:nth-child(3) { animation-delay: .3s; }
  @keyframes bob { 0%,60%,100% { transform: none; opacity: .5; } 30% { transform: translateY(-4px); opacity: 1; } }

  .empty { margin: auto; text-align: center; padding: 8px 6px; }
  .empty h3 { font-family: 'Fraunces', Georgia, serif; font-weight: 500; font-size: 21px; letter-spacing: -.02em; margin-bottom: 6px; }
  .empty p { color: var(--muted); font-size: 13px; margin-bottom: 16px; }
  .chips { display: flex; flex-direction: column; gap: 8px; }
  .chip {
    border: 1px solid rgba(124,58,237,.16); background: rgba(255,255,255,.7);
    color: var(--ink); font: inherit; font-size: 13px; text-align: left;
    padding: 9px 13px; border-radius: 13px; cursor: pointer;
    transition: background .15s ease, border-color .15s ease, transform .15s ease;
  }
  .chip:hover { background: rgba(124,58,237,.08); border-color: rgba(124,58,237,.35); transform: translateY(-1px); }

  /* ── composer ── */
  .composer {
    display: flex; align-items: flex-end; gap: 8px;
    margin: 0 12px; padding: 7px 7px 7px 14px;
    background: rgba(255,255,255,.9);
    border: 1px solid rgba(124,58,237,.16); border-radius: 18px;
    transition: border-color .15s ease, box-shadow .15s ease;
  }
  .composer:focus-within { border-color: rgba(124,58,237,.6); box-shadow: 0 0 0 3px rgba(124,58,237,.12); }
  textarea {
    flex: 1; resize: none; border: 0; outline: 0; background: transparent;
    font: inherit; color: var(--ink); max-height: 110px; padding: 6px 0; min-height: 28px;
  }
  textarea::placeholder { color: #9a95b3; }
  .send {
    width: 34px; height: 34px; flex: none; border: 0; border-radius: 12px; cursor: pointer;
    display: grid; place-items: center; color: #fff; background: var(--grad);
    transition: opacity .15s ease, transform .15s ease;
  }
  .send:hover:not(:disabled) { transform: scale(1.06); }
  .send:disabled { opacity: .4; cursor: default; }
  .send svg { width: 17px; height: 17px; }
  .fine { text-align: center; color: #9a95b3; font-size: 11px; padding: 8px 12px 11px; }

  @media (max-width: 480px) {
    .island { right: max(12px, env(safe-area-inset-right)); bottom: max(12px, env(safe-area-inset-bottom)); }
    .island { --open-h: min(640px, calc(100dvh - 24px)); }
  }
  @media (prefers-reduced-motion: reduce) {
    .island, .panel, .fab { transition-duration: .01ms !important; transition-delay: 0s !important; }
    .msg { animation: none; }
  }
  `;

  const ICON = {
    reset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  };

  // ── build DOM ───────────────────────────────────────────
  function mount() {
    const host = document.createElement("div");
    host.id = "rigel-host";
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = CSS;

    const island = el("div", "island");
    island.dataset.open = "false";

    const fab = el("button", "fab", "✦");
    fab.type = "button";
    fab.setAttribute("aria-label", "Open Rigel assistant");
    fab.setAttribute("aria-expanded", "false");

    const panel = el("section", "panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Rigel assistant");
    panel.inert = true;

    // header
    const head = el("header", "head");
    head.appendChild(el("div", "logo", "✦"));
    const titles = el("div", "titles");
    titles.appendChild(el("div", "name", "Rigel"));
    const sub = el("div", "sub");
    sub.appendChild(el("span", "dot"));
    sub.appendChild(el("span", "", MODEL_LABEL));
    titles.appendChild(sub);
    head.appendChild(titles);

    const resetBtn = el("button", "icon-btn");
    resetBtn.type = "button";
    resetBtn.title = "New chat";
    resetBtn.setAttribute("aria-label", "New chat");
    resetBtn.innerHTML = ICON.reset;
    const closeBtn = el("button", "icon-btn");
    closeBtn.type = "button";
    closeBtn.title = "Close";
    closeBtn.setAttribute("aria-label", "Close Rigel");
    closeBtn.innerHTML = ICON.close;
    head.append(resetBtn, closeBtn);

    // log
    const log = el("div", "log");
    log.setAttribute("role", "log");
    log.setAttribute("aria-live", "polite");

    // composer
    const form = el("form", "composer");
    const input = el("textarea");
    input.rows = 1;
    input.maxLength = MAX_INPUT_CHARS;
    input.placeholder = "Message Rigel…";
    input.setAttribute("aria-label", "Message Rigel");
    const sendBtn = el("button", "send");
    sendBtn.type = "submit";
    sendBtn.disabled = true;
    sendBtn.setAttribute("aria-label", "Send");
    sendBtn.innerHTML = ICON.send;
    form.append(input, sendBtn);

    const fine = el("p", "fine", `${MODEL_LABEL} can make mistakes. Verify important info.`);

    panel.append(head, log, form, fine);
    island.append(fab, panel);
    root.append(style, island);

    // ── state ──
    let history = store.get().filter(
      (m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string"
    );
    // The server only ever receives role + content.
    const forServer = (list) => list.map((m) => ({ role: m.role, content: m.content }));
    let busy = false;
    let controller = null;

    const scrollDown = () => { log.scrollTop = log.scrollHeight; };

    function addBubble(role, text, actions) {
      const b = el("div", `msg ${role === "user" ? "user" : "bot"}`);
      if (role === "user") {
        b.textContent = text;
      } else {
        renderRich(b, text);
        const page = extractPage(text);
        if (page) b.appendChild(buildExportBar(page));
      }
      log.appendChild(b);

      const acts = (actions || []).map(resolveAction).filter(Boolean).slice(0, 2);
      if (role !== "user" && acts.length) {
        const row = el("div", "actions");
        acts.forEach((a) => {
          const btn = el("button", "act", a.label);
          btn.type = "button";
          btn.addEventListener("click", () => go(a));
          row.appendChild(btn);
        });
        log.appendChild(row);
      }
      scrollDown();
      return b;
    }

    function addNote(text) {
      log.appendChild(el("div", "msg bot note", text));
      scrollDown();
    }

    // ── navigation ──
    function go(a) {
      if (a.external) { window.open(a.href, "_blank", "noopener,noreferrer"); return; }
      const u = new URL(a.href, location.origin);
      if (u.pathname === location.pathname) {
        if (u.hash === "#new" && typeof window.switchTab === "function") window.switchTab("new");
        else if (u.hash) location.hash = u.hash;
        setOpen(false);
        return;
      }
      try { sessionStorage.setItem(OPEN_KEY, "1"); } catch { /* ignore */ }
      location.assign(u.href);
    }

    // ── export to website ──
    function buildExportBar(page) {
      const bar = el("div", "export");
      const row = el("div", "xrow");
      const exportBtn = el("button", "xbtn", "Export to website");
      exportBtn.type = "button";
      const editBtn = el("button", "ghost", "Open in editor");
      editBtn.type = "button";
      const note = el("div", "xnote");
      row.append(exportBtn, editBtn);
      bar.append(row, note);

      const say = (text, cls) => { note.className = "xnote " + (cls || ""); note.textContent = text; };

      if (!page.complete) {
        exportBtn.disabled = true;
        editBtn.disabled = true;
        say("This page looks cut off. Ask Rigel for a shorter version, then export.", "bad");
        return bar;
      }

      const signInLink = () => {
        const b = el("button", "ghost", "Go to sign in");
        b.type = "button";
        b.style.marginTop = "6px";
        b.addEventListener("click", () => go({ href: "/dashboard.html", external: false }));
        note.appendChild(document.createElement("br"));
        note.appendChild(b);
      };

      exportBtn.addEventListener("click", async () => {
        exportBtn.disabled = true;
        editBtn.disabled = true;
        say("Publishing…");
        try {
          const clean = sanitizePage(page.html);
          const slug = await publishPage(clean.html, clean.title);
          const url = `${SITE_URL}/p/${slug}/`;
          note.className = "xnote ok";
          note.textContent = "Published. It goes live in about 30 to 60 seconds: ";
          const link = el("a", "xlink", url.replace("https://", ""));
          link.href = url; link.target = "_blank"; link.rel = "noopener noreferrer";
          note.appendChild(link);
          if (clean.removed) {
            note.appendChild(document.createElement("br"));
            note.append(`Scripts and unsafe attributes removed: ${clean.removed}.`);
          }
          exportBtn.textContent = "Published ✓";
        } catch (e) {
          exportBtn.disabled = false;
          editBtn.disabled = false;
          if (e.code === "signin") {
            say("Sign in first, then press Export again. Your chat will be waiting.", "bad");
            signInLink();
          } else if (e.code === "auth") {
            say("Your sign-in expired. Sign in again, then press Export.", "bad");
            signInLink();
          } else if (e.code === "repo") {
            say(`Couldn't find your "${REPO_NAME}" repo. Create it on GitHub (public, empty is fine) and try again.`, "bad");
          } else if (e.code === "slug") {
            say("Too many pages with that name. Rename the page title and try again.", "bad");
          } else {
            say(`GitHub said no${e.status ? ` (${e.status})` : ""}. Try again in a moment.`, "bad");
          }
        }
      });

      editBtn.addEventListener("click", () => {
        const clean = sanitizePage(page.html);
        try {
          sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ html: clean.html, slug: slugify(clean.title) }));
        } catch { /* ignore */ }
        if (location.pathname.endsWith("/dashboard.html") && typeof window.applyRigelHandoff === "function") {
          window.applyRigelHandoff();
          setOpen(false);
        } else {
          go({ href: "/dashboard.html#new", external: false });
        }
      });

      return bar;
    }

    function showEmpty() {
      log.textContent = "";
      const box = el("div", "empty");
      box.appendChild(el("h3", "", "Think beyond the ordinary."));
      box.appendChild(el("p", "", "Ask Rigel anything: ideas, code, writing, math."));
      const chips = el("div", "chips");
      SUGGESTIONS.forEach((s) => {
        const c = el("button", "chip", s);
        c.type = "button";
        c.addEventListener("click", () => ask(s));
        chips.appendChild(c);
      });
      box.appendChild(chips);
      log.appendChild(box);
    }

    function restore() {
      log.textContent = "";
      if (!history.length) return showEmpty();
      history.forEach((m) => addBubble(m.role, m.content, m.actions));
    }

    function clearEmpty() {
      const e = log.querySelector(".empty");
      if (e) e.remove();
    }

    function setBusy(v) {
      busy = v;
      sendBtn.disabled = v || !input.value.trim();
    }

    function errorMessage(status) {
      if (status === 429) return "You're sending messages too fast. Give it a moment and try again.";
      if (status === 403) return "Rigel isn't available from this page.";
      if (status === 413) return "That message was too large.";
      return "Couldn't reach Rigel. Please try again.";
    }

    async function ask(text, isRetry = false) {
      text = (text || "").trim();
      if (!text || busy) return;

      // Never let a pasted token leave the browser.
      const safe = redactSecrets(text);
      const redacted = safe !== text;
      text = safe;

      clearEmpty();
      if (!isRetry) {
        addBubble("user", text);
        if (redacted) addNote("I removed what looked like a token from your message. Never share tokens in chat; revoke it on GitHub if it was real.");
      }

      setBusy(true);
      const typing = el("div", "msg bot typing");
      typing.append(el("i"), el("i"), el("i"));
      typing.setAttribute("aria-label", "Rigel is typing");
      log.appendChild(typing);
      scrollDown();

      controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        const res = await fetch(`${RIGEL_API}/v1/chat`, {
          method: "POST",
          mode: "cors",
          credentials: "omit",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: text,
            history: forServer(history.slice(-MAX_SENT_TURNS)),
          }),
          signal: controller.signal,
        });
        if (!res.ok) throw Object.assign(new Error("http"), { status: res.status });

        const data = await res.json();
        const reply = typeof data.reply === "string" && data.reply.trim()
          ? data.reply
          : "I couldn't generate a response. Please try again.";

        const actions = Array.isArray(data.actions) ? data.actions.slice(0, 2) : [];
        typing.remove();
        addBubble("assistant", reply, actions);
        history.push({ role: "user", content: text }, { role: "assistant", content: reply, actions });
        history = history.slice(-40);
        store.set(history);
      } catch (e) {
        typing.remove();
        const b = el("div", "msg bot err");
        b.appendChild(el("div", "", e.name === "AbortError"
          ? "Rigel took too long to respond."
          : errorMessage(e.status)));
        const retry = el("button", "retry", "Retry");
        retry.type = "button";
        retry.addEventListener("click", () => { b.remove(); ask(text, true); });
        b.appendChild(retry);
        log.appendChild(b);
        scrollDown();
      } finally {
        clearTimeout(timer);
        controller = null;
        setBusy(false);
        input.focus();
      }
    }

    // ── open / close ──
    function setOpen(open, quiet) {
      island.dataset.open = String(open);
      fab.setAttribute("aria-expanded", String(open));
      panel.inert = !open;
      if (open) {
        if (!quiet) setTimeout(() => input.focus(), 320);
        scrollDown();
      } else if (!quiet) {
        fab.focus({ preventScroll: true });
      }
    }
    const isOpen = () => island.dataset.open === "true";

    fab.addEventListener("click", () => setOpen(true));
    closeBtn.addEventListener("click", () => setOpen(false));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && isOpen()) setOpen(false);
    });

    resetBtn.addEventListener("click", () => {
      if (controller) controller.abort();
      history = [];
      store.set(history);
      showEmpty();
      setBusy(false);
      input.focus();
    });

    // ── composer behaviour ──
    function autosize() {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 110) + "px";
      sendBtn.disabled = busy || !input.value.trim();
    }
    input.addEventListener("input", autosize);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = input.value;
      if (!text.trim() || busy) return;
      input.value = "";
      autosize();
      ask(text);
    });

    restore();

    // Re-open after a hop to another page (sign-in, dashboard, ...).
    try {
      if (sessionStorage.getItem(OPEN_KEY) === "1") {
        sessionStorage.removeItem(OPEN_KEY);
        setOpen(true, true);
      }
    } catch { /* ignore */ }
  }

  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
})();
