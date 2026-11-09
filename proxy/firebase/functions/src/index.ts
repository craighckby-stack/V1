/**
 * Gemini Geo-Bypass Proxy — Firebase Cloud Functions (Gen 1) edition.
 *
 * WHY FIREBASE BYPASSES THE GEO-BLOCK — DETERMINISTICALLY
 * ────────────────────────────────────────────────────────
 * Google's Gemini API geo-blocks by CALLER IP ("location is not
 * supported" for the HK sandbox egress). A Firebase Cloud Function
 * deployed to `us-central1` (Iowa) runs inside Google Cloud — its
 * outbound fetch to generativelanguage.googleapis.com egresses from
 * a US Google IP. Google does not geo-block its own network, so the
 * call goes through every time. Unlike the Cloudflare Worker's Smart
 * Placement (which needs a few requests to warm up), the Firebase
 * region is pinned AT DEPLOY TIME — the bypass works on the very
 * first request, no warm-up, no uncertainty.
 *
 * Trade-off vs the Cloudflare Worker: cold starts. Gen 1 functions
 * on the free plan scale to zero, so the first call after idle can
 * take ~2–5s to boot the container. LOOP's call timeout is 120s and
 * its 60s recovery-probe loop retries automatically, so a cold start
 * is invisible to the pipeline (worst case: one probe fails, the next
 * one 60s later hits the warm instance).
 *
 * PLAN REQUIREMENTS (the honest part)
 * ──────────────────────────────────
 * Gen 1 functions run on the FREE Spark plan — no credit card, 125K
 * invocations/month (LOOP uses ~6K). Gen 2 requires the Blaze plan
 * (card on file; usage stays $0 — Blaze's free tier is 2M
 * invocations/month). This file is written Gen 1 for the strictly
 * free, no-card path. If your project forces Gen 2/Blaze, either
 * accept the card-on-file (still $0/month at LOOP's volume) or use
 * the Cloudflare Worker in /proxy/ (always free, always no-card).
 *
 * SDK note: firebase-functions v6 moved Gen 1 to the "firebase-
 * functions/v1" namespace. Options (region/timeout/memory) go through
 * the region().runWith().https.onRequest() builder — the plain
 * onRequest() export only accepts a handler. functions.config() is
 * marked deprecated in favor of params/Secret Manager, but params
 * require the Blaze plan — config() is the free-path way to hold the
 * two secrets, set via `firebase functions:config:set`.
 *
 * HOW THE ROUTING WORKS
 * ─────────────────────
 * LOOP calls `${GEMINI_PROXY_BASE_URL}/v1beta/models/<model>:generateContent`.
 * Firebase Hosting (free) rewrites /v1beta/**, /v1/**, and /health to
 * this function, preserving the original path — so the function sees
 * the exact upstream path and just swaps the host. GEMINI_PROXY_BASE_URL
 * is the Hosting domain: https://<project-id>.web.app
 *
 * CONTRACT (identical to the Fly.io and Cloudflare editions)
 * ────────────────────────────────────────────────────────────
 *   1. Validates ?key=<secret> against functions config proxy.secret
 *      (constant-time compare).
 *   2. Swaps the secret for the real key (config gemini.key) in the
 *      query string before forwarding to Google.
 *   3. Returns the response unchanged. Note: the request body is
 *      buffered (express.json), so this edition serves non-streaming
 *      generateContent — which is all LOOP's pipeline uses. The CF
 *      Worker edition covers SSE if you ever need it.
 *
 * No logging of request/response bodies. The key is scrubbed from any
 * error message before it reaches the Functions log.
 */
import { region, config } from "firebase-functions/v1";

const UPSTREAM = "https://generativelanguage.googleapis.com";

// ── Constant-time string compare (avoid timing oracle on the secret) ──
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const geminiProxy = region("us-central1")
  // us-central1 = deterministic US egress (the whole point). 256MB is the
  // smallest function size; 2 max instances caps blast radius; 120s covers
  // a cold start + a slow generation with margin.
  .runWith({ timeoutSeconds: 120, memory: "256MB", maxInstances: 2 })
  .https.onRequest(async (req, res) => {
    const cfg = config();
    const PROXY_SECRET: string = cfg.proxy?.secret ?? "";
    const GEMINI_API_KEY: string = cfg.gemini?.key ?? "";

    // Health probe — no auth, no logging.
    if (req.method === "GET" && req.path === "/health") {
      res.status(200).json({ ok: true, ts: Date.now() });
      return;
    }

    // Startup guard — Functions have no boot hook, so missing secrets
    // surface on the first request with a clear fix-it message.
    if (!PROXY_SECRET || !GEMINI_API_KEY) {
      res.status(500).json({
        error: {
          code: 500,
          message:
            "Proxy secrets not set. Run: firebase functions:config:set proxy.secret=<hex> gemini.key=<AIza...> then firebase deploy --only functions",
          status: "INTERNAL",
        },
      });
      return;
    }

    // Only forward Gemini API paths. Everything else is a 404.
    if (!req.path.startsWith("/v1beta/") && !req.path.startsWith("/v1/")) {
      res.status(404).send("Not Found");
      return;
    }

    // Validate the shared secret. LOOP sends it as ?key=<secret>, exactly
    // where Google expects its own key — so the caller's code doesn't change.
    const callerKey = (req.query.key as string | undefined) ?? "";
    if (!callerKey || !timingSafeEqual(callerKey, PROXY_SECRET)) {
      // Gemini-shaped 401 so LOOP's existing error parsing doesn't need a
      // special case for "proxy rejected".
      res.status(401).json({
        error: {
          code: 401,
          message: "API key not valid. Please pass a valid API key.",
          status: "UNAUTHENTICATED",
        },
      });
      return;
    }

    // Swap the secret for the real key. Rebuild the URL with the upstream
    // host and the real key in the query string.
    const url = new URL(req.url, "https://relay.invalid"); // req.url preserves path+search from the Hosting rewrite
    const forwardUrl = new URL(url.pathname + url.search, UPSTREAM);
    forwardUrl.searchParams.set("key", GEMINI_API_KEY);

    // Buffer the request body. Gen 1's express.json already parsed it —
    // re-serialize. A raw string passes through as-is. GETs have no body.
    // We build FRESH headers (content-type only) — never forward the
    // sandbox's host/fingerprints upstream.
    let body: string | undefined;
    if (typeof req.body === "object" && req.body !== null) {
      body = JSON.stringify(req.body);
    } else if (typeof req.body === "string" && req.body.length > 0) {
      body = req.body;
    }

    try {
      const up = await fetch(forwardUrl.toString(), {
        method: req.method,
        headers: { "content-type": "application/json" },
        body,
        // 110s ceiling: under the function's own 120s limit so a stalled
        // upstream becomes a clean 502 instead of the function timing out.
        signal: AbortSignal.timeout(110_000),
      });
      // Non-streaming passthrough (generateContent JSON). The response
      // body is returned byte-for-byte with the upstream content-type.
      res
        .status(up.status)
        .set(
          "content-type",
          up.headers.get("content-type") ?? "application/json"
        )
        .send(Buffer.from(await up.arrayBuffer()));
    } catch (err) {
      // Key-leak scrub: fetch/connection errors embed the request URL
      // (which now contains the REAL GEMINI_API_KEY) in their message.
      // Redact every occurrence before it reaches the Functions log.
      const rawMsg: string = (err as Error)?.message ?? String(err);
      const safeMsg = GEMINI_API_KEY
        ? rawMsg.split(GEMINI_API_KEY).join("***")
        : rawMsg;
      console.error("[geminiProxy] upstream error:", safeMsg);
      res.status(502).json({
        error: {
          code: 502,
          message: "Proxy upstream failure.",
          status: "INTERNAL",
        },
      });
    }
  });
