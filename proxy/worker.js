/**
 * Blueprint-ify proxy: a Cloudflare Worker that lets visitors draw on your Claude
 * account without a key of their own. It forwards the page's requests to the Claude
 * Messages API with your key, which never leaves the Worker.
 *
 * Settings (wrangler.toml [vars] and secrets):
 *   ANTHROPIC_API_KEY  secret, required: your Claude API key
 *   ALLOWED_ORIGINS    comma-separated sites that may call it, e.g. https://you.github.io
 *   ACCESS_CODE        secret, optional: a code visitors type into the page
 */
const MODELS = new Set(["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]);
const MAX_TOKENS = 32000;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("origin") || "";
    const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const open = allowed.includes("*");
    const ok = open || allowed.includes(origin);
    const cors = {
      "access-control-allow-origin": open ? "*" : ok ? origin : "null",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type, anthropic-version, x-access-code",
      "access-control-max-age": "86400",
      vary: "origin",
    };
    const reply = (status, message) =>
      new Response(JSON.stringify({ type: "error", error: { type: "proxy_error", message } }), {
        status, headers: { ...cors, "content-type": "application/json" },
      });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/v1/messages") return reply(404, "Not found.");
    if (!ok) return reply(403, "This site may not use this proxy.");
    if (env.ACCESS_CODE && request.headers.get("x-access-code") !== env.ACCESS_CODE) return reply(401, "Access code needed.");
    if (!env.ANTHROPIC_API_KEY) return reply(500, "The proxy has no API key set.");

    let body;
    try { body = await request.json(); } catch { return reply(400, "The request was not JSON."); }
    if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 4) return reply(400, "Unexpected messages.");

    // only what the page sends: a model from the list, a capped length, the messages
    const clean = {
      model: MODELS.has(body.model) ? body.model : "claude-sonnet-5-5",
      max_tokens: Math.min(Number(body.max_tokens) || 16000, MAX_TOKENS),
      stream: body.stream === true,
      messages: body.messages,
    };
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": env.ANTHROPIC_API_KEY },
      body: JSON.stringify(clean),
    });
    const headers = new Headers(cors);
    headers.set("content-type", upstream.headers.get("content-type") || "application/json");
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
