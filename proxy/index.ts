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
// `?? ""` narrows to plain `string` so the handlers below type-check
// (TS2345) — the empty-string fallback is inert because the guard below
// exits the process when either secret is unset/falsy.
const PROXY_SECRET: string = process.env.PROXY_SECRET ?? "";
const GEMINI_API_KEY: string = process.env.GEMINI_API_KEY ?? "";
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
// async + `return await` (not a bare `return fetch(...)`) so a rejected
// upstream fetch throws INSIDE this function and the try/catch in
// Bun.serve's fetch handler turns it into a Gemini-shaped 502. Returning
// the promise un-awaited made the catch dead code and typed the handler
// as Response while it actually returned Promise<Response> (TS2740).
async function handleProxy(req: Request): Promise<Response> {
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
  // a no-op. AWAITED so a network failure rejects here, propagates to the
  // serve handler's catch, and becomes a 502 instead of an unhandled
  // rejection the caller sees as a hung request.
  //
  // Upstream timeout (audit 3): a stalled Gemini connection used to hang
  // this request — and LOOP's LLM callers behind it — forever; the catch
  // in Bun.serve's fetch handler claimed timeouts became 502s, but nothing
  // ever timed out. The 120s abort makes that promise true: the fetch
  // rejects on abort, the rejection lands in that catch → Gemini-shaped
  // 502 → LOOP falls through to the Z.AI chain. Note this bounds TOTAL
  // stream duration too (streamGenerateContent SSE must finish inside
  // 120s), which every current Gemini response comfortably does.
  return await fetch(forwardUrl.toString(), {
    method: req.method,
    headers: forwardHeaders,
    body: req.body ?? undefined,
    signal: AbortSignal.timeout(120_000),
    // @ts-expect-error: duplex is a Node/Bun-specific option accepted by fetch
    duplex: "half",
  });
}

// ── Server ────────────────────────────────────────────────────────────
const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    // Health probe first — no auth, no logging.
    const health = healthResponse(req);
    if (health) return health;

    try {
      // AWAITED so handleProxy's rejections (upstream DNS failure, timeout,
      // socket reset) land in this catch and become a 502 — returning the
      // promise would escape the try/catch entirely.
      return await handleProxy(req);
    } catch (err) {
      // Key-leak scrub (audit 3): fetch/connection errors embed the full
      // request URL in their message — and we inject the REAL GEMINI_API_KEY
      // into that URL's query string, so an unsanitized log line would paste
      // Google's key straight into Fly.io logs. The header of this file
      // promises the key never appears in logs; make it true. Split/join on
      // the actual key value so EVERY occurrence is redacted, whatever the
      // runtime quotes (Bun error messages often contain the whole URL).
      // Empty key is impossible here (the startup guard exits), but guard
      // anyway — split("") would shred the message into single characters.
      const rawMsg: string = (err as Error)?.message ?? String(err);
      const safeMsg = GEMINI_API_KEY
        ? rawMsg.split(GEMINI_API_KEY).join("***")
        : rawMsg;
      // Never leak internals to the caller. A 502 tells LOOP to fall through
      // to the Z.AI chain, which is the correct behavior on proxy failure.
      // (This is the ONLY site that logs error text; the 502 body is fixed
      // and carries no URL/key material.)
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
});

console.log(`[proxy] Gemini geo-bypass proxy listening on :${PORT}`);
console.log(`[proxy] Upstream: ${UPSTREAM}`);
console.log(`[proxy] Health:   GET http://localhost:${PORT}/health`);

// Keep the server reference alive (Bun.serve is the running process).
void server;
