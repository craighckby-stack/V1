/**
 * Gemini Geo-Bypass Proxy — single-file Bun server.
 *
 * Why this exists
 * ---------------
 * The LOOP sandbox egresses through Hong Kong, which Google's Gemini API
 * refuses to serve (FAILED_PRECONDITION "location is not supported"). This
 * proxy runs in a supported region (Fly.io pinned to `sgp`) and forwards
 * requests to generativelanguage.googleapis.com, injecting the real Gemini
 * API key server-side. The key never transits the sandbox — LOOP only ever
 * holds the shared secret.
 *
 * What it does (three things, nothing more)
 * -----------------------------------------
 *   1. Validates the `key=` query param against PROXY_SECRET. Rejects with
 *      401 if absent or mismatched. This stops it being an open proxy.
 *   2. Swaps the validated secret for the real GEMINI_API_KEY in the query
 *      string before forwarding. The upstream request carries Google's key,
 *      never the caller's secret.
 *   3. Streams the response back unchanged. Both generateContent (JSON) and
 *      streamGenerateContent (SSE/chunked) pass through transparently.
 *
 * What it does NOT do
 * -------------------
 *   - No logging of request or response bodies (privacy + log hygiene).
 *   - No rate limiting beyond what the upstream provider enforces. LOOP's
 *     own cooldown machinery handles 429 backoff (see agent-llm.ts).
 *   - No model allowlisting — LOOP picks the model; the proxy is dumb.
 *
 * Security model
 * --------------
 * The shared secret is a bearer token. Anyone who has it can use your Gemini
 * quota. Treat it like the Gemini key itself. If it leaks, rotate both
 * PROXY_SECRET and GEMINI_API_KEY. The secret is checked with a constant-time
 * comparison to avoid timing oracle attacks.
 *
 * Run locally:  PROXY_SECRET=xxx GEMINI_API_KEY=yyy bun run index.ts
 * Health check: GET /health → 200 { ok: true }
 */

// ── Configuration ──────────────────────────────────────────────────────
const PROXY_SECRET = process.env.PROXY_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PORT = Number(process.env.PORT ?? 8787);
const UPSTREAM = "https://generativelanguage.googleapis.com";

if (!PROXY_SECRET || !GEMINI_API_KEY) {
  console.error(
    "[proxy] FATAL: PROXY_SECRET and GEMINI_API_KEY must both be set.",
  );
  console.error(
    "[proxy] Set them with: fly secrets set PROXY_SECRET=... GEMINI_API_KEY=...",
  );
  process.exit(1);
}

// ── Constant-time string compare (avoid timing oracle on the secret) ──
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── Health probe (no auth) — for Fly.io readiness checks ──────────────
function healthResponse(req: Request): Response | null {
  if (new URL(req.url).pathname === "/health") {
    return new Response(
      JSON.stringify({ ok: true, ts: Date.now() }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return null;
}

// ── Main proxy handler ────────────────────────────────────────────────
function handleProxy(req: Request): Response {
  const url = new URL(req.url);

  // Only forward Gemini API paths. Anything else is a 404 — this is not a
  // general-purpose proxy.
  if (!url.pathname.startsWith("/v1beta/") && !url.pathname.startsWith("/v1/")) {
    return new Response("Not Found", { status: 404 });
  }

  // Validate the shared secret. LOOP sends it as ?key=<secret>, exactly
  // where Google expects its own key — so the caller's code doesn't change.
  const callerKey = url.searchParams.get("key");
  if (!callerKey || !timingSafeEqual(callerKey, PROXY_SECRET)) {
    // Return a Gemini-shaped 401 so LOOP's existing error parsing in
    // gemini-direct.ts doesn't need a special case for "proxy rejected".
    return new Response(
      JSON.stringify({
        error: {
          code: 401,
          message: "API key not valid. Please pass a valid API key.",
          status: "UNAUTHENTICATED",
        },
      }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  }

  // Swap the secret for the real key. We rebuild the URL with the upstream
  // host and the real key in the query string — Google's REST API expects
  // the key there, so we don't move it into a header.
  const forwardUrl = new URL(url.pathname + url.search, UPSTREAM);
  forwardUrl.searchParams.set("key", GEMINI_API_KEY);

  // Pass the request through. Method, headers, body all preserved. We strip
  // hop-by-hop and proxy-discovery headers so we don't confuse upstream.
  const forwardHeaders = new Headers(req.headers);
  forwardHeaders.delete("host");
  forwardHeaders.delete("content-length");
  forwardHeaders.delete("x-forwarded-for");
  forwardHeaders.delete("x-forwarded-proto");
  forwardHeaders.delete("cf-connecting-ip");
  forwardHeaders.delete("fly-client-ip");

  // fetch() with duplex:'half' lets us stream a request body upstream if the
  // caller is streaming one; for the typical generateContent JSON body it's
  // a no-op.
  return fetch(forwardUrl.toString(), {
    method: req.method,
    headers: forwardHeaders,
    body: req.body ?? undefined,
    // @ts-expect-error: duplex is a Node/Bun-specific option accepted by fetch
    duplex: "half",
  });
}

// ── Server ────────────────────────────────────────────────────────────
const server = Bun.serve({
  port: PORT,
  fetch(req) {
    // Health probe first — no auth, no logging.
    const health = healthResponse(req);
    if (health) return health;

    try {
      return handleProxy(req);
    } catch (err) {
      // Never leak internals to the caller. A 502 tells LOOP to fall through
      // to the Z.AI chain, which is the correct behavior on proxy failure.
      console.error("[proxy] handler error:", (err as Error).message);
      return new Response(
        JSON.stringify({
          error: {
            code: 502,
            message: "Proxy upstream failure.",
            status: "INTERNAL",
          },
        }),
        { status: 502, headers: { "content-type": "application/json" } },
      );
    }
  },
});

console.log(`[proxy] Gemini geo-bypass proxy listening on :${PORT}`);
console.log(`[proxy] Upstream: ${UPSTREAM}`);
console.log(`[proxy] Health:   GET http://localhost:${PORT}/health`);

// Keep the server reference alive (Bun.serve is the running process).
void server;
