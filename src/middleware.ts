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
 *   - If LOOP_API_KEY is unset/empty the gate fails OPEN with a one-time
 *     console.warn — keeps the system bootable if env loading hiccups.
 *     The env var is read per-request (not at module load) so a dev-server
 *     env reload is honored without recompiling.
 *
 * Rate limiting (mutations only):
 *   - In-memory sliding window per client IP: max 60 requests / 60s → 429.
 *     IP comes from the first x-forwarded-for segment, fallback "local".
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

/** Fail-open warning fires at most once per server process. */
let warnedUnconfigured = false;

export function middleware(req: NextRequest) {
  // ── 1. Read-only verbs pass through untouched (polling, health checks) ──
  if (!MUTATING_METHODS.has(req.method.toUpperCase())) {
    return NextResponse.next();
  }

  // ── 2. Rate limit FIRST: sliding window per client IP, authed or not ───
  // (The old order ran auth before accounting, so 401 brute-force guesses
  // were never counted and the API key could be guessed unthrottled.)
  const ip =
    (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "local";
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
  if (expectedKey) {
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
  } else if (!warnedUnconfigured) {
    // Fail-open ONLY while unconfigured — keeps the system bootable.
    warnedUnconfigured = true;
    console.warn(
      "[middleware] LOOP_API_KEY is not set — mutating API routes are UNPROTECTED (fail-open). " +
        "Set LOOP_API_KEY in .env to lock them down."
    );
  }

  return NextResponse.next();
}

export const config = {
  // API routes only — never intercept pages, static assets, or RSC payloads.
  matcher: "/api/:path*",
};
