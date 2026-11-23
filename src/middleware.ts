import { NextRequest, NextResponse } from "next/server";

/**
 * API-key gate for mutating routes (audit: "zero auth on 56 API routes" —
 * anyone could POST to chat-task/apply, push, push-target, duress/purge…).
 *
 * Scope:
 *   - Matcher: /api/:path* ONLY. Pages, assets, and _next internals never
 *     touch this middleware.
 *   - Only POST/PUT/PATCH/DELETE are gated. GET/HEAD/OPTIONS pass through
 *     untouched so the UI's polling and health checks keep working.
 *
 * Auth:
 *   - process.env.LOOP_API_KEY must equal the request header "x-loop-key".
 *     Missing/wrong key → 401 with a message pointing the operator at the
 *     UI unlock panel (page.tsx patches fetch to attach the key from
 *     localStorage and listens for these 401s — see
 *     src/components/pipeline/api-unlock.tsx).
 *   - FAIL-CLOSED (operator hardening 2026-11-23, reviewer Priority 1):
 *     if LOOP_API_KEY is unset/empty, every mutating request is REJECTED
 *     with 503. The old fail-open ("keeps the system bootable") left all
 *     mutating routes unprotected whenever the key was forgotten — for a
 *     system that mutates its own code, an unauthenticated POST is not a
 *     boot-convenience issue, it is the whole threat model. A missing key
 *     must lock the gate, not open it. One console.error per process so
 *     the operator sees WHY the gate is closed.
 *     The env var is read per-request (not at module load) so a dev-server
 *     env reload is honored without recompiling.
 *
 * Rate limiting (mutations only):
 *   - In-memory sliding window per client IP: max 60 requests / 60s → 429.
 *   - IP comes from the first x-forwarded-for segment ONLY when
 *     TRUST_PROXY=1 (set it only if the fronting proxy is configured to
 *     OVERWRITE client-supplied XFF). Without TRUST_PROXY every client
 *     shares the single "local" bucket — an XFF-spoofing client cannot
 *     rotate rate-limit identities, which is exactly the spoof the old
 *     permissive XFF read enabled (reviewer finding, 2026-11-23).
 *   - The IP map is capped at ~1000 entries; when the cap is exceeded the
 *     OLDEST entries are evicted (the old wholesale clear() reset every
 *     IP's window — a spoofed-XFF flood rotating identities got a fresh
 *     window each time and the limit never tripped).
 *   - The limiter runs BEFORE the auth check so unauthenticated x-loop-key
 *     guesses are counted too (the old order returned 401 before any
 *     accounting — unlimited brute force on the API key).
 *
 * Runtime: Next 16 runs middleware on Node.js by default (dev + prod), so
 * process.env is the live server environment — no runtime config needed.
 */

/** Verbs that mutate state — the only ones this middleware gates. */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Sliding-window rate limit: max mutations per client IP… */
const RATE_LIMIT_MAX = 60;
/** …inside this window. */
const RATE_LIMIT_WINDOW_MS = 60_000;
/** Cap on tracked client IPs — the map is cleared when exceeded. */
const RATE_LIMIT_MAX_IPS = 1000;

/** ip → timestamps (ms) of accepted mutating requests still in the window. */
const hitsByIp = new Map<string, number[]>();

/** Fail-closed warning fires at most once per server process. */
let warnedUnconfigured = false;

/** Trust x-forwarded-for ONLY when the operator explicitly opted in —
 * the header is client-controlled unless the fronting proxy overwrites
 * it, and a spoofed XFF rotates rate-limit identities. */
function clientBucket(req: NextRequest): string {
  if (process.env.TRUST_PROXY === "1") {
    const xff = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
    if (xff) return xff;
  }
  return "local";
}

export function middleware(req: NextRequest) {
  // ── 1. Read-only verbs pass through untouched (polling, health checks) ──
  if (!MUTATING_METHODS.has(req.method.toUpperCase())) {
    return NextResponse.next();
  }

  // ── 2. Rate limit FIRST: sliding window per client IP, authed or not ───
  // (The old order ran auth before accounting, so 401 brute-force guesses
  // were never counted and the API key could be guessed unthrottled.)
  const ip = clientBucket(req);
  const now = Date.now();
  // Cap the tracked-IP map by evicting the OLDEST entries (Map preserves
  // insertion order). The old wholesale clear() reset every IP's window
  // when a spoofed-XFF flood rotated past the cap — the flood itself never
  // got limited and legit clients lost their counts too.
  while (hitsByIp.size > RATE_LIMIT_MAX_IPS) {
    const oldestKey = hitsByIp.keys().next().value;
    if (oldestKey === undefined) break;
    hitsByIp.delete(oldestKey);
  }

  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const recent = (hitsByIp.get(ip) ?? []).filter((t) => t > windowStart);
  if (recent.length >= RATE_LIMIT_MAX) {
    // Keep the trimmed window so the client stays blocked until it slides.
    hitsByIp.set(ip, recent);
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }
  recent.push(now);
  hitsByIp.set(ip, recent);

  // ── 3. Auth gate ──────────────────────────────────────────────────────────
  // Read per-request so an env reload (next dev watches .env files) is
  // picked up without touching this module.
  const expectedKey = process.env.LOOP_API_KEY;
  if (!expectedKey) {
    // FAIL-CLOSED: no key configured → the gate is LOCKED, not open.
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      console.error(
        "[middleware] LOOP_API_KEY is not set — mutating API routes are LOCKED (fail-closed). " +
          "Set LOOP_API_KEY in .env to enable mutations with the x-loop-key header."
      );
    }
    return NextResponse.json(
      {
        error:
          "mutation gate locked — LOOP_API_KEY is not configured on the server (fail-closed). Set it in .env, then send it as the x-loop-key header.",
      },
      { status: 503 }
    );
  }
  const providedKey = req.headers.get("x-loop-key");
  if (providedKey !== expectedKey) {
    return NextResponse.json(
      {
        error:
          "unauthorized — mutating API requires the x-loop-key header (enter the API key in the UI when prompted)",
      },
      { status: 401 }
    );
  }

  return NextResponse.next();
}

export const config = {
  // API routes only — never intercept pages, static assets, or RSC payloads.
  matcher: "/api/:path*",
};
