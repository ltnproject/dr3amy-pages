/**
 * Dr3amy Pages — AI proxy Worker (Groq) for the "Work" (Code) tab
 * ------------------------------------------------------------
 * This Worker is a SEPARATE deployment from worker.js (GitHub OAuth).
 * It is used ONLY by the Work/Code tab of the Rigel widget. The Chat
 * tab is untouched and keeps talking to its original backend.
 *
 * Model strategy (in order):
 *   1. openai/gpt-oss-120b          — primary
 *   2. llama-3.3-70b-versatile      — fallback if #1 errors
 *   3. If #2 also errors, the Worker does NOT call any model a third
 *      time. It returns a normal-looking chat reply that explains the
 *      free tier is unavailable right now and points the user at the
 *      "bring your own API key" guide page, with a button the widget
 *      renders that navigates there.
 *
 * Required Worker secret:
 *   GROQ_API_KEY   — https://console.groq.com/keys
 *
 * Optional Worker vars (set in wrangler-ai.toml or the dashboard):
 *   PRIMARY_MODEL   (default: openai/gpt-oss-120b)
 *   FALLBACK_MODEL  (default: llama-3.3-70b-versatile)
 *   BYOK_GUIDE_PATH (default: /byok-guide.html)
 *
 * Deploy separately:
 *   wrangler deploy --config wrangler-ai.toml
 *
 * Then point RIGEL_CODE_API in rigel-widget.js at this Worker's URL
 * (no query string needed — this Worker only ever serves Work/Code).
 */

const ALLOWED_ORIGIN = "https://dr3amy.creepers.pro";
const GROQ_API = "https://api.groq.com/openai/v1/chat/completions";

const DEFAULT_PRIMARY_MODEL  = "openai/gpt-oss-120b";
const DEFAULT_FALLBACK_MODEL = "llama-3.3-70b-versatile";
const DEFAULT_BYOK_GUIDE_PATH = "/byok-guide.html";

const SYSTEM_CODE = `You are Rigel Code, an expert software engineer built into Dr3amy Pages. \
Help the user write, debug, and refactor code. Be precise and practical. \
Always put code in fenced code blocks with the correct language tag. \
Explain your reasoning briefly after the code.`;

const BYOK_MESSAGE = (guidePath) =>
  `Rigel's free Work model is at capacity right now (both the primary and backup models ` +
  `returned errors), so I can't answer this one. ` +
  `You can keep working by bringing your own API key — ChatGPT, Claude, OpenRouter, or Google AI Studio ` +
  `all work. The guide below walks through getting a key and wiring it in.`;

// ── CORS helpers ────────────────────────────────────────────────────────────

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function preflight(origin) {
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

function denied(msg = "Forbidden") {
  return new Response(msg, { status: 403 });
}

function error(msg, status = 500) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function chatReply(origin, reply, actions = []) {
  return new Response(JSON.stringify({ reply, actions }), {
    status: 200,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

// ── Groq call (single attempt, returns null on any failure) ────────────────

async function tryGroq(model, messages, maxTokens, apiKey) {
  let res;
  try {
    res = await fetch(GROQ_API, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature: 0.7,
        stream: false,
      }),
    });
  } catch {
    return null; // network error — let caller fall back
  }

  if (!res.ok) return null; // 4xx/5xx — let caller fall back

  let data;
  try {
    data = await res.json();
  } catch {
    return null;
  }

  const reply = data?.choices?.[0]?.message?.content?.trim();
  return reply || null;
}

// ── Main handler ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      if (origin !== ALLOWED_ORIGIN) return denied();
      return preflight(origin);
    }

    if (origin !== ALLOWED_ORIGIN) return denied();

    const referer = request.headers.get("Referer") || "";
    let ref;
    try { ref = new URL(referer); } catch { return denied(); }
    if (ref.origin !== ALLOWED_ORIGIN) return denied();
    if (ref.pathname.startsWith("/p/")) return denied(); // no AI on published /p/ pages

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    if (url.pathname !== "/v1/chat") {
      return new Response("Not Found", { status: 404 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return error("Invalid JSON", 400);
    }

    const { message, history = [], max_new_tokens } = body;
    if (typeof message !== "string" || !message.trim()) {
      return error("Missing message", 400);
    }

    const messages = [
      { role: "system", content: SYSTEM_CODE },
      ...history.map((m) => ({ role: m.role, content: String(m.content) })),
      { role: "user", content: message.trim() },
    ];

    const groqKey = env.GROQ_API_KEY;
    if (!groqKey) return error("GROQ_API_KEY not configured", 503);

    const primaryModel  = env.PRIMARY_MODEL  || DEFAULT_PRIMARY_MODEL;
    const fallbackModel = env.FALLBACK_MODEL || DEFAULT_FALLBACK_MODEL;
    const guidePath      = env.BYOK_GUIDE_PATH || DEFAULT_BYOK_GUIDE_PATH;
    const maxTokens = max_new_tokens ?? 2048;

    // 1. Primary model: openai/gpt-oss-120b
    let reply = await tryGroq(primaryModel, messages, maxTokens, groqKey);

    // 2. Fallback model: llama-3.3-70b-versatile
    if (!reply) {
      reply = await tryGroq(fallbackModel, messages, maxTokens, groqKey);
    }

    // 3. Both failed — redirect to BYOK guide instead of a hard error
    if (!reply) {
      return chatReply(origin, BYOK_MESSAGE(guidePath), [
        { label: "Bring your own API key", href: guidePath },
      ]);
    }

    return chatReply(origin, reply, []);
  },
};
