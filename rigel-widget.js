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
 *  - Two tabs: Chat (site-aware assistant) and Code (coding model)
 *  - Instant actions (no API call): "send me to the dashboard" redirects;
 *    "create code" checks sign-in and sends signed-out users to GitHub sign-in;
 *    "show my pages" lists your published sites so you can pick one to open;
 *    "make a QR code" builds a scannable code for one of your pages or a link
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
  const RIGEL_CODE_API = "https://ltnproj-rigel-code-api.hf.space";
  const MODEL_LABEL = "Rigel 1o-mini";
  const CODE_MODEL_LABEL = "Rigel 1 RC";
  // GitHub OAuth entry point (same link the dashboard's sign-in button uses).
  const AUTH_URL = "https://dr3amy-pages.rachatapanapitakkun-mail2.workers.dev/auth/github";
  const PENDING_KEY = "rigel:pending";
  const MAX_SENT_TURNS = 16;
  const MAX_INPUT_CHARS = 4000;
  const TIMEOUT_MS = 120000; // ZeroGPU cold starts can be slow
  const STORE_KEY = "rigel:chat:v1";
  const CODE_STORE_KEY = "rigel:code:v1";
  const TAB_KEY = "rigel:tab";
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
    "Show my pages",
    "Make a QR code",
  ];

  const CODE_SUGGESTIONS = [
    "Write a Python function to debounce calls",
    "Explain this error: TypeError: undefined is not a function",
    "Refactor a nested loop into something cleaner",
  ];

  // One entry per tab. Each tab has its own endpoint and its own history.
  const MODES = {
    chat: {
      label: "Chat", api: RIGEL_API, model: MODEL_LABEL, storeKey: STORE_KEY,
      turns: MAX_SENT_TURNS, maxChars: MAX_INPUT_CHARS, timeout: TIMEOUT_MS,
      placeholder: "Message Rigel…",
      title: "Think beyond the ordinary.",
      blurb: "Ask Rigel anything: ideas, writing, math, or building a page.",
      suggestions: SUGGESTIONS, newTokens: null, exportable: true,
    },
    code: {
      label: "Code", api: RIGEL_CODE_API, model: CODE_MODEL_LABEL, storeKey: CODE_STORE_KEY,
      turns: 8, maxChars: 8000, timeout: 180000, // bigger model, slower cold start
      placeholder: "Ask for code, a bug fix, or a refactor…",
      title: "Code with Rigel.",
      blurb: "Write, debug and explain code. Replies can take a little longer.",
      suggestions: CODE_SUGGESTIONS, newTokens: 2048, exportable: false,
    },
  };

  // ── tiny helpers ────────────────────────────────────────
  const store = {
    get(key) {
      try { return JSON.parse(sessionStorage.getItem(key) || "[]"); }
      catch { return []; }
    },
    set(key, v) {
      try { sessionStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ }
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

  // Same sign-in state the dashboard uses.
  const isSignedIn = () => {
    try { return !!(localStorage.getItem("ghToken") && localStorage.getItem("ghOwner")); }
    catch { return false; }
  };

  // Short, clear commands only, so normal questions still go to the model.
  const LEAD = "^\\s*(please\\s+|pls\\s+|just\\s+|can\\s+you\\s+|could\\s+you\\s+)?";
  const DASHBOARD_INTENT = new RegExp(
    LEAD + "(send|take|bring|redirect|navigate|go|open)\\b[^.?!\\n]{0,20}\\bdashboard\\b[^.?!\\n]{0,15}[.!?]*\\s*$", "i");
  const CODE_INTENT = new RegExp(
    LEAD + "(create|write|make|generate|build)\\s+(me\\s+)?(some\\s+|a\\s+|the\\s+|new\\s+)?code[.!?]*\\s*$", "i");
  const URL_RE = /https?:\/\/[^\s<>"'`]+/i;
  const QR_WORD = /\bqr(\s*-?\s*codes?)?\b/i;
  // "write a python script that makes a qr code" is a coding question, not this.
  const NOT_A_COMMAND =
    /\b(python|javascript|typescript|js|java|script|function|api|react|node|php|golang|rust|c\+\+|library|npm|pip|program|app|how)\b/i;
  const PAGES_INTENT = [
    new RegExp(LEAD + "(open|show|list|visit|launch|view)\\b[^.?!\\n]{0,15}\\b(websites?|web\\s*sites?|sites?|pages?)\\b[^.?!\\n]{0,15}[.!?]*\\s*$", "i"),
    /^\s*my\s+(websites?|web\s*sites?|sites?|pages?)[.!?]*\s*$/i,
    /^\s*(what|which)\b[^.?!\n]{0,20}\b(websites?|sites?|pages?)\b[^.?!\n]{0,25}\b(do\s+i\s+have|have\s+i|published|i\s+(made|created|have))\b/i,
  ];
  const NOT_PAGES = /\b(home|landing|main|new|publish|sign|dashboard)\b/i;
  function detectIntent(text) {
    const bare = text.replace(URL_RE, " ");
    if (QR_WORD.test(bare) && text.length <= 200 && !NOT_A_COMMAND.test(bare)) return "qr";
    if (text.length > 80) return null;
    if (DASHBOARD_INTENT.test(text)) return "dashboard";
    if (CODE_INTENT.test(text)) return "code";
    if (!NOT_PAGES.test(text) && PAGES_INTENT.some((re) => re.test(text))) return "pages";
    return null;
  }

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

  // Slugs of the pages published in the signed-in user's repo (p/<slug>/).
  async function listPages() {
    const token = localStorage.getItem("ghToken");
    const owner = localStorage.getItem("ghOwner");
    if (!token || !owner) throw Object.assign(new Error("signin"), { code: "signin" });
    const r = await fetch(`${GITHUB_API}/repos/${owner}/${REPO_NAME}/contents/p`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (r.status === 404) return [];
    if (r.status === 401) throw Object.assign(new Error("auth"), { code: "auth" });
    if (!r.ok) throw Object.assign(new Error("http"), { code: "http", status: r.status });
    const items = await r.json();
    return (Array.isArray(items) ? items : [])
      .filter((i) => i && i.type === "dir" && /^[a-z0-9-]+$/.test(i.name))
      .map((i) => i.name)
      .sort();
  }

  // Safe mini-markdown: ``` blocks, `code`, **bold**. Never uses innerHTML.
  function renderRich(target, text, copyable) {
    target.textContent = "";
    text.split("```").forEach((chunk, i) => {
      if (i % 2 === 1) {
        const code = chunk.replace(/^[\w+#.-]*\n/, "").replace(/\n$/, "");
        const pre = el("pre");
        pre.appendChild(el("code", "", code));
        if (copyable) {
          const wrap = el("div", "codewrap");
          const copy = el("button", "copy", "Copy");
          copy.type = "button";
          copy.addEventListener("click", async () => {
            try { await navigator.clipboard.writeText(code); copy.textContent = "Copied ✓"; }
            catch { copy.textContent = "Press Ctrl+C"; }
            setTimeout(() => { copy.textContent = "Copy"; }, 1600);
          });
          wrap.append(copy, pre);
          target.appendChild(wrap);
          return;
        }
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

  // ── QR code encoder ─────────────────────────────────────
  // Small self-contained encoder: byte mode, error correction M, versions 1-10
  // (enough for links up to ~210 characters). No external libraries.
  // QR START
  const QR = (() => {
    const EXP = new Array(512), LOG = new Array(256);
    let gx = 1;
    for (let i = 0; i < 255; i++) { EXP[i] = gx; LOG[gx] = i; gx <<= 1; if (gx & 0x100) gx ^= 0x11d; }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
    const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

    function rsGen(deg) {
      let g = [1];
      for (let i = 0; i < deg; i++) {
        const n = new Array(g.length + 1).fill(0);
        for (let j = 0; j < g.length; j++) { n[j] ^= g[j]; n[j + 1] ^= mul(g[j], EXP[i]); }
        g = n;
      }
      return g;
    }
    function rsEc(data, len) {
      const g = rsGen(len), res = new Array(len).fill(0);
      for (const b of data) {
        const f = b ^ res[0];
        res.shift(); res.push(0);
        if (f) for (let i = 0; i < len; i++) res[i] ^= mul(g[i + 1], f);
      }
      return res;
    }

    // [ec codewords per block, blocks in group 1, data cw each, blocks in group 2, data cw each]
    const VERSIONS = [null,
      [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0],
      [24, 2, 43, 0, 0], [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39],
      [22, 3, 36, 2, 37], [26, 4, 43, 1, 44],
    ];
    const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
      [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
    const bit = (x, i) => ((x >>> i) & 1) === 1;

    function penalty(m) {
      const n = m.length;
      let p = 0;
      const line = (get) => {
        let run = 1;
        for (let i = 1; i < n; i++) {
          if (get(i) === get(i - 1)) { run++; if (run === 5) p += 3; else if (run > 5) p += 1; }
          else run = 1;
        }
        let s = "";
        for (let i = 0; i < n; i++) s += get(i) ? "1" : "0";
        for (const pat of ["10111010000", "00001011101"]) {
          let k = s.indexOf(pat);
          while (k !== -1) { p += 40; k = s.indexOf(pat, k + 1); }
        }
      };
      for (let r = 0; r < n; r++) line((i) => m[r][i]);
      for (let c = 0; c < n; c++) line((i) => m[i][c]);
      for (let r = 0; r < n - 1; r++) {
        for (let c = 0; c < n - 1; c++) {
          const v = m[r][c];
          if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) p += 3;
        }
      }
      let dark = 0;
      for (const row of m) for (const v of row) if (v) dark++;
      p += Math.max(0, Math.ceil(Math.abs(dark * 20 - n * n * 10) / (n * n)) - 1) * 10;
      return p;
    }

    function matrix(text) {
      const bytes = Array.from(new TextEncoder().encode(text));
      let v = 0;
      for (let i = 1; i <= 10; i++) {
        const [, b1, d1, b2, d2] = VERSIONS[i];
        if (4 + (i < 10 ? 8 : 16) + bytes.length * 8 <= (b1 * d1 + b2 * d2) * 8) { v = i; break; }
      }
      if (!v) throw new Error("too long");
      const [ec, b1, d1, b2, d2] = VERSIONS[v];
      const capBits = (b1 * d1 + b2 * d2) * 8;

      // bit stream: mode 0100, length, bytes, terminator, padding
      const bits = [];
      const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
      push(4, 4);
      push(bytes.length, v < 10 ? 8 : 16);
      bytes.forEach((b) => push(b, 8));
      push(0, Math.min(4, capBits - bits.length));
      while (bits.length % 8) bits.push(0);
      for (let pad = 0xec; bits.length < capBits; pad ^= 0xec ^ 0x11) push(pad, 8);
      const data = [];
      for (let i = 0; i < bits.length; i += 8) {
        let b = 0;
        for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
        data.push(b);
      }

      // split into blocks, add error correction, interleave
      const sizes = [...Array(b1).fill(d1), ...Array(b2).fill(d2)];
      const blocks = [];
      let pos = 0;
      for (const sz of sizes) {
        const d = data.slice(pos, pos + sz);
        pos += sz;
        blocks.push({ d, e: rsEc(d, ec) });
      }
      const words = [];
      for (let i = 0; i < Math.max(d1, d2); i++) for (const b of blocks) if (i < b.d.length) words.push(b.d[i]);
      for (let i = 0; i < ec; i++) for (const b of blocks) words.push(b.e[i]);

      // function patterns
      const size = 17 + 4 * v;
      const m = Array.from({ length: size }, () => new Array(size).fill(false));
      const fn = Array.from({ length: size }, () => new Array(size).fill(false));
      const setXY = (x, y, dark) => { m[y][x] = dark; fn[y][x] = true; };
      for (let i = 0; i < size; i++) { setXY(6, i, i % 2 === 0); setXY(i, 6, i % 2 === 0); }
      const finder = (cx, cy) => {
        for (let dy = -4; dy <= 4; dy++) {
          for (let dx = -4; dx <= 4; dx++) {
            const x = cx + dx, y = cy + dy;
            if (x < 0 || x >= size || y < 0 || y >= size) continue;
            const d = Math.max(Math.abs(dx), Math.abs(dy));
            setXY(x, y, d !== 2 && d !== 4);
          }
        }
      };
      finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
      const al = ALIGN[v];
      for (let i = 0; i < al.length; i++) {
        for (let j = 0; j < al.length; j++) {
          if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
          for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              setXY(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
            }
          }
        }
      }
      const drawFormat = (mask) => {
        const d = mask; // error correction level M has format bits 00
        let rem = d;
        for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
        const f = ((d << 10) | rem) ^ 0x5412;
        for (let i = 0; i <= 5; i++) setXY(8, i, bit(f, i));
        setXY(8, 7, bit(f, 6)); setXY(8, 8, bit(f, 7)); setXY(7, 8, bit(f, 8));
        for (let i = 9; i < 15; i++) setXY(14 - i, 8, bit(f, i));
        for (let i = 0; i < 8; i++) setXY(size - 1 - i, 8, bit(f, i));
        for (let i = 8; i < 15; i++) setXY(8, size - 15 + i, bit(f, i));
        setXY(8, size - 8, true);
      };
      drawFormat(0);
      if (v >= 7) {
        let rem = v;
        for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
        const vb = (v << 12) | rem;
        for (let i = 0; i < 18; i++) {
          const a = size - 11 + (i % 3), b = Math.floor(i / 3);
          setXY(a, b, bit(vb, i)); setXY(b, a, bit(vb, i));
        }
      }

      // place data bits in the zigzag order
      let k = 0;
      for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let vert = 0; vert < size; vert++) {
          for (let j = 0; j < 2; j++) {
            const x = right - j;
            const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
            if (!fn[y][x] && k < words.length * 8) { m[y][x] = bit(words[k >>> 3], 7 - (k & 7)); k++; }
          }
        }
      }

      // pick the mask with the lowest penalty
      const applyMask = (mask) => {
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            let inv;
            switch (mask) {
              case 0: inv = (x + y) % 2 === 0; break;
              case 1: inv = y % 2 === 0; break;
              case 2: inv = x % 3 === 0; break;
              case 3: inv = (x + y) % 3 === 0; break;
              case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
              case 5: inv = ((x * y) % 2) + ((x * y) % 3) === 0; break;
              case 6: inv = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
              default: inv = ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0;
            }
            if (!fn[y][x] && inv) m[y][x] = !m[y][x];
          }
        }
      };
      let best = 0, bestScore = Infinity;
      for (let mask = 0; mask < 8; mask++) {
        applyMask(mask); drawFormat(mask);
        const score = penalty(m);
        if (score < bestScore) { best = mask; bestScore = score; }
        applyMask(mask);
      }
      applyMask(best); drawFormat(best);
      return m;
    }
    return { matrix };
  })();
  // QR END

  // Crisp, scalable preview (SVG data URL) with the standard 4-module quiet zone.
  function qrSvgUrl(m) {
    const n = m.length, q = 4, size = n + q * 2;
    let d = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m[r][c]) d += `M${c + q} ${r + q}h1v1h-1z`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
      `<rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#111"/></svg>`;
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }

  function downloadQrPng(m, name) {
    const n = m.length, q = 4, scale = 10, px = (n + q * 2) * scale;
    const cv = document.createElement("canvas");
    cv.width = cv.height = px;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = "#111";
    m.forEach((row, r) => row.forEach((v, c) => { if (v) ctx.fillRect((c + q) * scale, (r + q) * scale, scale, scale); }));
    cv.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }, "image/png");
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

  /* ── tabs ── */
  .tabs {
    display: flex; gap: 4px; margin: 10px 14px 0; padding: 3px;
    background: rgba(124,58,237,.08); border-radius: 13px;
  }
  .tab {
    flex: 1; border: 0; cursor: pointer; font: inherit; font-size: 13px; font-weight: 600;
    padding: 6px 10px; border-radius: 10px; color: var(--muted); background: transparent;
    transition: background .15s ease, color .15s ease, box-shadow .15s ease;
  }
  .tab:hover:not(:disabled):not(.on) { color: var(--accent); }
  .tab.on { background: #fff; color: var(--accent); box-shadow: 0 1px 6px rgba(124,58,237,.18); }
  .tab:disabled:not(.on) { opacity: .5; cursor: default; }
  .tab:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

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
  .codewrap { position: relative; }
  .codewrap pre { padding-top: 26px; max-height: 280px; }
  .copy {
    position: absolute; top: 12px; right: 6px; z-index: 1; border: 0; cursor: pointer;
    font: inherit; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 7px;
    color: #ece8ff; background: rgba(255,255,255,.14);
  }
  .copy:hover { background: rgba(255,255,255,.26); }
  .copy:focus-visible { outline: 2px solid #bd75ff; outline-offset: 1px; }
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
  .qr { white-space: normal; text-align: center; }
  .qr img { display: block; width: 200px; height: 200px; max-width: 100%; margin: 2px auto 8px;
            border-radius: 12px; background: #fff; border: 1px solid rgba(124,58,237,.14); }
  .qrcap { font-size: 12px; color: var(--muted); margin-bottom: 8px; overflow-wrap: anywhere; }
  .qr .xrow { justify-content: center; }
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
    const subText = el("span", "", MODEL_LABEL);
    sub.appendChild(subText);
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
    const sendBtn = el("button", "send");
    sendBtn.type = "submit";
    sendBtn.disabled = true;
    sendBtn.setAttribute("aria-label", "Send");
    sendBtn.innerHTML = ICON.send;
    form.append(input, sendBtn);

    const fine = el("p", "fine");

    // tabs
    const tabs = el("div", "tabs");
    tabs.setAttribute("role", "tablist");
    const tabBtns = Object.keys(MODES).map((key) => {
      const b = el("button", "tab", MODES[key].label);
      b.type = "button";
      b.dataset.mode = key;
      b.setAttribute("role", "tab");
      tabs.appendChild(b);
      return b;
    });

    panel.append(head, tabs, log, form, fine);
    island.append(fab, panel);
    root.append(style, island);

    // ── state ──
    const loadHistory = (key) => store.get(key).filter(
      (m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string"
    );
    const histories = {
      chat: loadHistory(MODES.chat.storeKey),
      code: loadHistory(MODES.code.storeKey),
    };
    let mode = "chat";
    try {
      const saved = sessionStorage.getItem(TAB_KEY);
      if (saved && MODES[saved]) mode = saved;
    } catch { /* ignore */ }
    const cfg = () => MODES[mode];
    let history = histories[mode];
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
        renderRich(b, text, mode === "code");
        const page = cfg().exportable ? extractPage(text) : null;
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

    // Local reply that is also kept in this tab's history.
    function say(userText, replyText) {
      addBubble("assistant", replyText);
      history.push({ role: "user", content: userText }, { role: "assistant", content: replyText });
      history = history.slice(-40);
      histories[mode] = history;
      store.set(cfg().storeKey, history);
    }

    // ── your pages + QR codes ──
    let pagesCache = null; // { at, list }
    const pageUrl = (slug) => `${SITE_URL}/p/${slug}/`;

    function addQr(url, slug) {
      let m;
      try { m = QR.matrix(url); }
      catch { addBubble("assistant", "That link is too long for me to turn into a QR code."); return; }
      const b = el("div", "msg bot qr");
      const img = el("img");
      img.alt = `QR code for ${url}`;
      img.src = qrSvgUrl(m);
      const cap = el("div", "qrcap", url.replace(/^https?:\/\//, ""));
      const row = el("div", "xrow");
      const dl = el("button", "xbtn", "Download PNG");
      dl.type = "button";
      dl.addEventListener("click", () => { try { downloadQrPng(m, `qr-${slug || "link"}.png`); } catch { dl.textContent = "Couldn't save"; } });
      const copy = el("button", "ghost", "Copy link");
      copy.type = "button";
      copy.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(url); copy.textContent = "Copied ✓"; }
        catch { copy.textContent = "Copy failed"; }
        setTimeout(() => { copy.textContent = "Copy link"; }, 1600);
      });
      const open = el("button", "ghost", "Open");
      open.type = "button";
      open.addEventListener("click", () => window.open(url, "_blank", "noopener,noreferrer"));
      row.append(dl, copy, open);
      b.append(img, cap, row);
      log.appendChild(b);
      scrollDown();
    }

    function addSignInRow(kind) {
      const row = el("div", "actions");
      const b = el("button", "act", "Sign in with GitHub");
      b.type = "button";
      b.addEventListener("click", () => {
        try {
          sessionStorage.setItem(OPEN_KEY, "1");
          sessionStorage.setItem(PENDING_KEY, kind === "qr" ? "qr" : "pages");
        } catch { /* ignore */ }
        location.assign(AUTH_URL);
      });
      row.appendChild(b);
      log.appendChild(row);
      scrollDown();
    }

    // Ask which of the user's pages they mean, then open it or make its QR code.
    async function showPicker(kind, userText) {
      const reply = (t) => (userText != null ? say(userText, t) : addBubble("assistant", t));

      if (!isSignedIn()) {
        reply(kind === "qr"
          ? "Sign in so I can find your pages. Or paste a link and I'll make a QR code for it."
          : "Sign in with GitHub and I'll list the pages you've published.");
        addSignInRow(kind);
        return;
      }

      setBusy(true);
      const typing = el("div", "msg bot typing");
      typing.append(el("i"), el("i"), el("i"));
      log.appendChild(typing);
      scrollDown();

      let pages;
      try {
        if (pagesCache && Date.now() - pagesCache.at < 30000) pages = pagesCache.list;
        else { pages = await listPages(); pagesCache = { at: Date.now(), list: pages }; }
      } catch (e) {
        typing.remove();
        setBusy(false);
        if (e.code === "auth" || e.code === "signin") {
          reply("Your sign-in expired. Sign in again and I'll find your pages.");
          addSignInRow(kind);
        } else {
          reply(`GitHub didn't answer${e.status ? ` (${e.status})` : ""}. Try again in a moment.`);
        }
        return;
      }
      typing.remove();
      setBusy(false);

      if (!pages.length) {
        reply("You haven't published any pages yet. Open New Page to make your first one.");
        const row = el("div", "actions");
        const b = el("button", "act", "Open New Page");
        b.type = "button";
        b.addEventListener("click", () => go({ href: "/dashboard.html#new", external: false }));
        row.appendChild(b);
        log.appendChild(row);
        scrollDown();
        return;
      }

      // If the message already names one of the pages, offer just that one.
      const lower = (userText || "").toLowerCase();
      const named = pages.find((n) =>
        new RegExp(`(^|[^a-z0-9-])${n.replace(/[-]/g, "\\-")}($|[^a-z0-9-])`).test(lower));
      const shown = named ? [named] : pages.slice(0, 10);

      const verb = kind === "qr" ? "make a QR code for" : "open";
      if (named) reply(`Here's the page to ${verb}:`);
      else if (pages.length === 1) reply(`You have one published page. Press it to ${verb === "open" ? "open it" : "make its QR code"}:`);
      else reply(`You have ${pages.length} published pages. Which one do you want to ${verb}?`);

      const row = el("div", "actions");
      shown.forEach((slug) => {
        const b = el("button", "act", slug);
        b.type = "button";
        b.title = pageUrl(slug);
        b.addEventListener("click", () => {
          if (kind === "qr") addQr(pageUrl(slug), slug);
          else window.open(pageUrl(slug), "_blank", "noopener,noreferrer");
        });
        row.appendChild(b);
      });
      log.appendChild(row);
      if (!named && pages.length > shown.length) {
        addNote(`Showing the first ${shown.length}. Type a page name, like "${kind === "qr" ? "QR code for " : "open "}${pages[shown.length]}", to get the others.`);
      }
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
      box.appendChild(el("h3", "", cfg().title));
      box.appendChild(el("p", "", cfg().blurb));
      const chips = el("div", "chips");
      cfg().suggestions.forEach((s) => {
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
      tabBtns.forEach((b) => { b.disabled = v; });
    }

    function applyMode() {
      const c = cfg();
      subText.textContent = c.model;
      input.placeholder = c.placeholder;
      input.maxLength = c.maxChars;
      input.setAttribute("aria-label", c.placeholder.replace("…", ""));
      fine.textContent = `${c.model} can make mistakes. Verify important info.`;
      panel.setAttribute("aria-label", `Rigel assistant, ${c.label} tab`);
      tabBtns.forEach((b) => {
        const on = b.dataset.mode === mode;
        b.classList.toggle("on", on);
        b.setAttribute("aria-selected", String(on));
      });
    }

    function setMode(next) {
      if (busy || next === mode || !MODES[next]) return;
      mode = next;
      history = histories[mode];
      try { sessionStorage.setItem(TAB_KEY, mode); } catch { /* ignore */ }
      applyMode();
      restore();
      input.focus();
    }
    tabBtns.forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));

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

      const intent = isRetry ? null : detectIntent(text);

      // "create code" while signed in: make sure the Code tab handles it.
      if (intent === "code" && isSignedIn() && mode !== "code") setMode("code");

      clearEmpty();
      if (!isRetry) {
        addBubble("user", text);
        if (redacted) addNote("I removed what looked like a token from your message. Never share tokens in chat; revoke it on GitHub if it was real.");
      }

      // Instant actions: answered locally, no API call.
      if (intent === "dashboard") {
        const here = location.pathname.endsWith("/dashboard.html");
        say(text, here ? "You're already on the dashboard." : "Taking you to the dashboard…");
        setTimeout(() => go({ href: "/dashboard.html", external: false }), here ? 0 : 600);
        return;
      }
      if (intent === "qr") {
        const given = (text.match(URL_RE) || [])[0];
        if (given) {
          const link = given.replace(/[).,;!?]+$/, "");
          let ok = false;
          try { ok = /^https?:$/.test(new URL(link).protocol); } catch { ok = false; }
          if (!ok) say(text, "That doesn't look like a valid link. Paste a full address starting with https://");
          else { say(text, "Here's your QR code:"); addQr(link, ""); }
        } else {
          await showPicker("qr", text);
        }
        return;
      }
      if (intent === "pages") {
        await showPicker("open", text);
        return;
      }
      if (intent === "code" && !isSignedIn()) {
        say(text, "You need to sign in with GitHub first. Taking you to sign in…");
        try {
          sessionStorage.setItem(OPEN_KEY, "1");
          sessionStorage.setItem(PENDING_KEY, "code");
        } catch { /* ignore */ }
        setTimeout(() => location.assign(AUTH_URL), 700);
        return;
      }

      setBusy(true);
      const typing = el("div", "msg bot typing");
      typing.append(el("i"), el("i"), el("i"));
      typing.setAttribute("aria-label", "Rigel is typing");
      log.appendChild(typing);
      scrollDown();

      controller = new AbortController();
      const c = cfg();
      const timer = setTimeout(() => controller.abort(), c.timeout);

      try {
        const res = await fetch(`${c.api}/v1/chat`, {
          method: "POST",
          mode: "cors",
          credentials: "omit",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: text,
            history: forServer(history.slice(-c.turns)),
            ...(c.newTokens ? { max_new_tokens: c.newTokens } : {}),
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
        histories[mode] = history;
        store.set(c.storeKey, history);
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
      histories[mode] = history;
      store.set(cfg().storeKey, history);
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

    applyMode();
    restore();

    // Back from GitHub sign-in after a "create code" request.
    try {
      const pending = sessionStorage.getItem(PENDING_KEY);
      if (pending) {
        sessionStorage.removeItem(PENDING_KEY);
        if (pending === "code" && isSignedIn()) {
          setMode("code");
          addNote(`Signed in as ${localStorage.getItem("ghOwner")}. What would you like to build?`);
          setOpen(true, true);
        } else if ((pending === "pages" || pending === "qr") && isSignedIn()) {
          setMode("chat");
          addNote(`Signed in as ${localStorage.getItem("ghOwner")}.`);
          setOpen(true, true);
          showPicker(pending === "qr" ? "qr" : "open", null);
        }
      }
    } catch { /* ignore */ }

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
