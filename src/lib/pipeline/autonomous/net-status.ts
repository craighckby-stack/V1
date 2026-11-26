/**
 * Net Status — process-wide network/outage tracker (10-day endurance test).
 *
 * WHY THIS EXISTS (operator, 2026-11-24): the endurance test requires the
 * loop to survive ONLINE and OFFLINE for 10 days unattended. Before this
 * module, a network outage produced a fatal cascade:
 *
 *   LLM calls fail (3-leg chain, each leg retrying)  → files defer (OK)
 *   git push fails  → notePushFailure() → 5 consecutive → SAFE-MODE
 *   → the continuous loop BREAKS → the system HALTS until an operator
 *   clears safe-mode. Five offline mutations = a dead loop. That defeats
 *   the entire point of an unattended run.
 *
 * The fix has two halves:
 *   1. push-target.ts: a NETWORK-class push failure no longer counts
 *      toward the push-failure circuit breaker (a breaker for "git is
 *      wedged" must not fire for "the network is down" — one needs an
 *      operator, the other needs patience).
 *   2. THIS module: a shared, process-global outage detector. LLM and
 *      push call-sites feed it failures/successes; after 3 consecutive
 *      network-class failures the process flags OFFLINE. While offline:
 *        - the loop's cycle idles instead of burning doomed LLM calls
 *          (deterministic SelfTasks still drain — they need no LLM and
 *          their writes COMMIT locally, deferring the push)
 *        - pushes are skipped entirely (commit-only) so a 60s git
 *          timeout never burns cycle time
 *        - a cheap probe (HEAD to the push host) runs on a backing-off
 *          schedule; the FIRST successful response recovers the system
 *          and the next successful push carries every deferred commit
 *          (per-branch pushes are HEAD-based — accumulated local
 *          commits ride along automatically).
 *
 * PERSISTENCE: deliberately NONE. Offline state is ephemeral — a worker
 * restart reconverges within ≤3 real call failures, and a stale offline
 * flag must never outlive the outage it described (fail-open: a restart
 * always assumes ONLINE until proven otherwise, because assuming offline
 * would silently stop pushes).
 *
 * INSTANCE: module-scope state on globalThis (same pattern as the LLM
 * gate in agent-llm.ts) so the worker's singleton loop and any
 * same-process callers share ONE tracker. The dev server (a separate
 * process) gets its own instance — harmless; only the worker's loop
 * makes the calls that matter.
 */

/** Error-text signatures of a network-level failure (vs auth/quota/parse).
 *  Matched case-insensitively against the STRING forms of: git push/fetch
 *  stderr, fetch()/SDK exceptions, and Node DNS/socket error codes. */
const NETWORK_ERROR_RE =
  /could not resolve host|enotfound|eai_again|econnrefused|econnreset|etimedout|ehostunreach|enetunreach|epipe|connection timed out|connection was reset|failed to connect|unable to connect|network request failed|network error|fetch failed|socket hang up|dns lookup|tls connection|network is unreachable|temporary failure in name resolution|internet connection/i;

/** True iff the error text looks like a NETWORK-level failure. Used to
 *  split "the network is down" (patience + local work) from "git/LLM is
 *  wedged" (operator attention). Conservative by design: auth failures
 *  (401/403), rate limits (429), divergences, and parse errors all read
 *  as NOT-network so every existing safety path still fires. */
export function isNetworkErrorText(s: string | null | undefined): boolean {
  if (!s) return false;
  return NETWORK_ERROR_RE.test(s);
}

/** How many consecutive network-class failures trip OFFLINE. 3 = within
 *  one bad cycle (the whole-file scan attempts several files), yet
 *  resilient to a single transient blip. */
const OFFLINE_THRESHOLD = 3;

/** Probe schedule: first recheck 15s after entering offline, doubling up
 *  to a 5-minute floor. The loop's cycle gap is 5s, so probes naturally
 *  interleave with idle cycles. */
const PROBE_BASE_MS = 15_000;
const PROBE_MAX_MS = 5 * 60_000;
const PROBE_MAX_INTERVAL_MS = PROBE_MAX_MS;

export interface NetStatusSnapshot {
  offline: boolean;
  /** ISO time the offline state was entered (null when online). */
  since: string | null;
  /** Consecutive network-class failures observed (resets on any success). */
  consecutiveFailures: number;
  /** The most recent network-class error text (truncated; for logs/UI). */
  lastError: string | null;
  /** Which call-site last reported (llm | push | probe). */
  lastSource: string | null;
  /** ISO time of the last confirmed ONLINE signal. */
  lastSuccessAt: string | null;
  /** Epoch ms of the next scheduled connectivity probe. */
  nextProbeAt: number | null;
  /** Current probe backoff interval (ms). */
  probeIntervalMs: number;
  /** How many network-class failures were suppressed (not counted toward
   *  the push breaker) — honest accounting for the digest. */
  totalSuppressedPushFailures: number;
}

interface NetState {
  offline: boolean;
  since: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  lastSource: string | null;
  lastSuccessAt: string | null;
  nextProbeAt: number;
  probeIntervalMs: number;
  totalSuppressedPushFailures: number;
}

/** globalThis carrier — see the module doc. */
const G = globalThis as typeof globalThis & { __loopNetState?: NetState };

function state(): NetState {
  if (!G.__loopNetState) {
    G.__loopNetState = {
      offline: false,
      since: null,
      consecutiveFailures: 0,
      lastError: null,
      lastSource: null,
      lastSuccessAt: null,
      nextProbeAt: Date.now(), // Initialize to now, assuming online until proven otherwise
      probeIntervalMs: PROBE_BASE_MS,
      totalSuppressedPushFailures: 0,
    };
  }
  return G.__loopNetState;
}

/** Report a network-class failure. Returns `wentOffline: true` exactly
 *  once — when this failure crossed the threshold — so the caller can
 *  log the transition loudly (the module itself has no logger). */
export function noteNetworkFailure(source: string, err: string | null | undefined): { wentOffline: boolean } {
  const s = state();
  s.consecutiveFailures++;
  const errorText = (err ?? "").replace(/\s+/g, " ").substring(0, 200) || "network error";
  s.lastError = errorText;
  s.lastSource = source;
  if (!s.offline && s.consecutiveFailures >= OFFLINE_THRESHOLD) {
    s.offline = true;
    s.since = new Date().toISOString();
    s.probeIntervalMs = PROBE_BASE_MS;
    s.nextProbeAt = Date.now() + s.probeIntervalMs;
    return { wentOffline: true };
  }
  return { wentOffline: false };
}

/** Report a successful network operation (any LLM success, any push
 *  success, any successful probe). Clears the failure streak; returns
 *  `recovered: true` exactly once — on the offline→online transition. */
export function noteNetworkSuccess(source: string): { recovered: boolean } {
  const s = state();
  s.consecutiveFailures = 0;
  s.lastSource = source;
  s.lastSuccessAt = new Date().toISOString();
  if (s.offline) {
    s.offline = false;
    s.since = null;
    s.nextProbeAt = 0;
    s.probeIntervalMs = PROBE_BASE_MS;
    return { recovered: true };
  }
  return { recovered: false };
}

/** Snapshot for status payloads (copy — callers can't mutate). */
export function getNetStatus(): NetStatusSnapshot {
  const s = state();
  return {
    offline: s.offline,
    since: s.since,
    consecutiveFailures: s.consecutiveFailures,
    lastError: s.lastError,
    lastSource: s.lastSource,
    lastSuccessAt: s.lastSuccessAt,
    nextProbeAt: s.offline ? s.nextProbeAt : null,
    probeIntervalMs: s.probeIntervalMs,
    totalSuppressedPushFailures: s.totalSuppressedPushFailures,
  };
}

/** Fast predicate for the loop's cycle gate. */
export function isOffline(): boolean {
  return state().offline;
}

/** True when offline AND the backoff says it's time for another probe. */
export function nextProbeDue(): boolean {
  const s = state();
  return s.offline && Date.now() >= s.nextProbeAt;
}

/** Record a probe result: success recovers (and lets the caller log it);
 *  failure doubles the backoff (capped) and schedules the next probe. */
export function recordProbeResult(ok: boolean): { recovered: boolean } {
  const s = state();
  if (ok) {
    return noteNetworkSuccess("probe");
  }
  s.probeIntervalMs = Math.min(s.probeIntervalMs * 2, PROBE_MAX_INTERVAL_MS);
  s.nextProbeAt = Date.now() + s.probeIntervalMs;
  return { recovered: false };
}

/** Increment the "push failures suppressed" counter — called by
 *  push-target when a network-class failure is EXEMPTED from the
 *  circuit breaker (honest accounting for the daily digest). */
export function noteSuppressedPushFailure(): void {
  state().totalSuppressedPushFailures++;
}

/**
 * Cheap connectivity probe: HEAD to the push host (api.github.com — the
 * same host every git push and branch walk already uses). ANY HTTP
 * response — even a 403 rate-limit page — proves the network path is
 * up, so only a throw/abort/timeout counts as "down". 4s budget so an
 * offline probe never stalls a cycle.
 */
export async function probeConnectivity(): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    await fetch("https://api.github.com", {
      method: "HEAD",
      signal: ctrl.signal,
      headers: { "User-Agent": "LOOP-net-status-probe" },
      cache: "no-store",
    });
    clearTimeout(timer);
    return true;
  } catch (e) {
    clearTimeout(timer);
    // Check if the error was due to abortion (timeout) or a genuine network/fetch error.
    if (e instanceof DOMException && e.name === 'AbortError') {
      return false; // Timeout/Abort counts as failure for probe scheduling
    }
    // All other errors (network failure, DNS, etc.) count as failure.
    return false;
  }
}

/**
 * Combined gate for push paths: "may I attempt a network push?"
 *   - ONLINE (or not yet proven offline): yes.
 *   - OFFLINE and the backoff hasn't expired: no (defer, commit-only).
 *   - OFFLINE and a probe is due: probe NOW (≤4s). Recovered → yes
 *     (this also un-trips the tracker for everyone else). Still down →
 *     no, and the backoff doubles.
 */
export async function ensureOnlineForPush(): Promise<boolean> {
  const s = state();
  if (!s.offline) return true;
  if (Date.now() < s.nextProbeAt) return false;

  const up = await probeConnectivity();
  const { recovered } = recordProbeResult(up);

  // If recovered is true, the state is ONLINE, so we return true.
  if (recovered) {
    return true;
  }
  // If not recovered, the state is still offline. We return false to block the push.
  // If probeConnectivity returned true (up=true) but recordProbeResult didn't set recovered=true,
  // we must trust the probe result as the source of truth for this immediate check.
  if (up) {
      return true;
  }
  return false;
}