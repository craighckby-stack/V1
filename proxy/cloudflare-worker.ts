/**
 * Gemini Geo-Bypass Proxy — Cloudflare Workers edition (FREE).
 *
 * Same contract as proxy/index.ts (the Fly.io Bun version) but runs on
 * Cloudflare Workers — which has a GENEROUS free tier (100,000
 * requests/day). LOOP makes ~50–200 LLM calls/day, so the free tier is
 * ~500× overkill. Zero cost, zero credit card.
 *
 * ── Why this bypasses the HK geo-block ───────────────────────────────
 * Cloudflare Workers run at the EDGE — normally near the caller. A call
 * from the HK sandbox would hit a HK edge colo, and the worker's
 * outbound fetch would egress from HK → same geo-block. BUT:
 *
 *   "Smart Placement" (free feature, enabled in wrangler.toml via
 *   [placement] mode = "smart") tells Cloudflare to OBSERVE the worker's
 *   outbound fetch calls, see they go to generativelanguage.googleapis.com
 *   (Google's US endpoints), and RELOCATE the worker to a colo near that
 *   backend. The outbound fetch then egresses from a US data center →
 *   Google sees a supported region → the geo-block is bypassed.
 *
 * Smart Placement takes a few requests to warm up (it needs traffic to
 * observe the pattern). During warm-up the worker runs at the edge
 * (HK), so the first handful of requests may still geo-block — but the
 * gemini-direct.ts client has a 60s recovery-probe loop that catches
 * the transition within a minute. After warm-up, every call egresses
 * from US. Free, reliable, no region pinning needed.
 *
 * ── Deploy (one command) ─────────────────────────────────────────────
 *   npm install -g wrangler        # or: npx wrangler
 *   wrangler login                 # opens browser, free Cloudflare account
 *   cd proxy
 *   wrangler secret put PROXY_SECRET    # paste: openssl rand -hex 32
 *   wrangler secret put GEMINI_API_KEY  # paste: your real AIza... key
 *   wrangler deploy
 *   # → outputs https://loop-gemini-proxy.<you>.workers.dev
 *
 * Then in LOOP's .env:
 *   GEMINI_PROXY_BASE_URL=https://loop-gemini-proxy.<you>.workers.dev
 *
 * And re-paste the PROXY_SECRET value (not the AIza key) in the LOOP
 * GEMINI panel. The verify step now routes through the worker → Google
 * sees US egress → your key works.
 *
 * ── What the worker does (three things, nothing more) ────────────────
 *   1. Validates ?key=<secret> against PROXY_SECRET (constant-time).
 *   2. Swaps the secret for the real GEMINI_API_KEY in the query string.
 *   3. Streams the response back unchanged (generateContent JSON +
 *      streamGenerateContent SSE both work).
 *
 * No logging of request/response bodies (privacy). No rate limiting
 * (LOOP's own cooldown machinery handles 429s). No model allowlisting
 * (LOOP picks the model; the proxy is dumb).
 */

export interface Env {
  /** The shared secret LOOP sends as ?key=. Generate with
   *  `openssl rand -hex 32`. Set via `wrangler secret put PROXY_SECRET`. */
  PROXY_SECRET: string;
  /** The real Google AI Studio key. Set via
   *  `wrangler secret put GEMINI_API_KEY`. Never appears in LOOP. */
  GEMINI_API_KEY: string;
}

const UPSTREAM = "https://generativelanguage.googleapis.com";

// ── Constant-time string compare (avoid timing oracle on the secret) ──
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// eslint-disable-next-line import/no-anonymous-default-export
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health probe — no auth, no logging. For wrangler/CF readiness checks.
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, ts: Date.now() }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // Only forward Gemini API paths. Anything else is a 404.
    if (
      !url.pathname.startsWith("/v1beta/") &&
      !url.pathname.startsWith("/v1/")
    ) {
      return new Response("Not Found", { status: 404 });
    }

    // Startup guard — Workers don't have a startup hook, so we check env
    // on the first request. A missing secret returns a clear 500 so the
    // operator sees it in wrangler tail before the first LOOP call.
    if (!env.PROXY_SECRET || !env.GEMINI_API_KEY) {
      return new Response(
        JSON.stringify({
          error: {
            code: 500,
            message:
              "Proxy secrets not set. Run: wrangler secret put PROXY_SECRET && wrangler secret put GEMINI_API_KEY",
            status: "INTERNAL",
          },
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }

    // Validate the shared secret. LOOP sends it as ?key=<secret>, exactly
    // where Google expects its own key — so the caller's code doesn't change.
    const callerKey = url.searchParams.get("key");
    if (!callerKey || !timingSafeEqual(callerKey, env.PROXY_SECRET)) {
      // Gemini-shaped 401 so LOOP's existing error parsing doesn't need a
      // special case for "proxy rejected".
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

    // Swap the secret for the real key. Rebuild the URL with the upstream
    // host and the real key in the query string.
    const forwardUrl = new URL(url.pathname + url.search, UPSTREAM);
    forwardUrl.searchParams.set("key", env.GEMINI_API_KEY);

    // Pass the request through. Strip hop-by-hop / proxy-discovery headers.
    const forwardHeaders = new Headers(request.headers);
    forwardHeaders.delete("host");
    forwardHeaders.delete("content-length");
    forwardHeaders.delete("x-forwarded-for");
    forwardHeaders.delete("x-forwarded-proto");
    forwardHeaders.delete("cf-connecting-ip");
    forwardHeaders.delete("cf-ipcountry");
    forwardHeaders.delete("cf-ray");
    forwardHeaders.delete("cf-visitor");
    forwardHeaders.delete("cf-worker");
    forwardHeaders.delete("true-client-ip");

    try {
      // fetch with a 120s abort so a stalled Gemini connection doesn't hang
      // the worker (and LOOP behind it) forever. The rejection becomes a
      // Gemini-shaped 502 → LOOP falls through to the Z.AI chain.
      //
      // duplex:'half' lets the request body stream upstream (needed for
      // streamGenerateContent SSE). AbortSignal.timeout is supported in
      // the Workers runtime.
      return await fetch(forwardUrl.toString(), {
        method: request.method,
        headers: forwardHeaders,
        body: request.body ?? undefined,
        signal: AbortSignal.timeout(120_000),
        // @ts-expect-error: duplex is a runtime-specific option
        duplex: "half",
      });
    } catch (err) {
      // Key-leak scrub: fetch/connection errors embed the full request URL
      // (which now contains the REAL GEMINI_API_KEY) in their message.
      // Redact every occurrence so wrangler tail never logs the key.
      const rawMsg: string = (err as Error)?.message ?? String(err);
      const safeMsg = env.GEMINI_API_KEY
        ? rawMsg.split(env.GEMINI_API_KEY).join("***")
        : rawMsg;
      console.error("[proxy] handler error:", safeMsg);
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
};
