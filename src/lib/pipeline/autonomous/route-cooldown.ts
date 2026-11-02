/**
 * Per-route cooldown guard (concept: Commit-puller repo's
 * RATE_LIMIT_COOLDOWNS middleware + Harvester's cooldown-timers-anywhere).
 *
 * A tiny in-memory route-level cooldown that prevents the trigger
 * endpoints (self-enhance/trigger, autonomous/trigger) from being
 * fired twice in quick succession. The loop runtime already guards
 * against re-entry (status === "running" check), but a SECOND request
 * that arrives while the first is still compiling the route handler
 * can slip through before the runtime flips to "running" — this guard
 * catches it at the HTTP layer with a clear 429 + Retry-After, instead
 * of letting both requests race into the runtime.
 *
 * State is module-level (process-wide), keyed by route path. Each
 * entry holds the cooldown duration + the last-fired epoch ms. The
 * guard is OPT-IN: a route calls assertRouteCooldown(path, minIntervalMs)
 * and gets back { ok, retryAfterMs } — ok:false means reject with 429.
 *
 * Not a full rate-limiter (no sliding window, no per-IP) — the loop is
 * a single-operator tool, not a public API. This is specifically the
 * "you just clicked the button, wait for the cycle to start before
 * clicking again" guard.
 */

interface RouteCooldownEntry {
  intervalMs: number;
  lastFired: number;
}

const routeCooldowns = new Map<string, RouteCooldownEntry>();

/** Check + arm a route cooldown. Returns ok:true if the caller may
 *  proceed (and arms the cooldown for minIntervalMs); ok:false with
 *  retryAfterMs if the route is still cooling (caller should 429).
 *
 *  Usage in a route:
 *    const cd = assertRouteCooldown("/api/self-enhance/trigger", 5000);
 *    if (!cd.ok) return NextResponse.json({error: ...}, {status: 429, headers: {...}});
 */
export function assertRouteCooldown(
  route: string,
  minIntervalMs: number
): { ok: boolean; retryAfterMs: number } {
  // Input validation
  if (typeof route !== 'string' || route.trim() === '') {
    throw new Error('Route must be a non-empty string');
  }
  
  if (typeof minIntervalMs !== 'number' || !Number.isFinite(minIntervalMs) || minIntervalMs <= 0) {
    throw new Error('minIntervalMs must be a positive finite number');
  }

  const now = Date.now();
  const entry = routeCooldowns.get(route);
  if (entry && entry.intervalMs === minIntervalMs) {
    const elapsed = now - entry.lastFired;
    if (elapsed < minIntervalMs) {
      return { ok: false, retryAfterMs: Math.ceil((minIntervalMs - elapsed) / 1000) };
    }
    entry.lastFired = now;
    return { ok: true, retryAfterMs: 0 };
  }
  routeCooldowns.set(route, { intervalMs: minIntervalMs, lastFired: now });
  return { ok: true, retryAfterMs: 0 };
}

/** Read-only snapshot — for a status/debug endpoint. */
export function routeCooldownStatus(): Record<
  string,
  { intervalMs: number; lastFired: number; remainingMs: number }
> {
  const now = Date.now();
  const out: Record<string, { intervalMs: number; lastFired: number; remainingMs: number }> = {};
  
  // Clean up expired entries to prevent memory leak
  for (const [route, entry] of routeCooldowns) {
    const remaining = Math.max(0, entry.intervalMs - (now - entry.lastFired));
    if (remaining === 0) {
      routeCooldowns.delete(route);
    } else {
      out[route] = { intervalMs: entry.intervalMs, lastFired: entry.lastFired, remainingMs: remaining };
    }
  }
  return out;
}