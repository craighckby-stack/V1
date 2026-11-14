/**
 * Gemini Direct — calls Google's Gemini REST API directly with a
 * user-pasted API key. No SDK, no Z.AI gateway — a separate quota.
 *
 * This is the "fallback gemini api" made primary: when the user pastes a
 * real Gemini key into the config panel, the loop calls Google FIRST and
 * only falls through to the Z.AI gateway chain (agent-llm.ts MODEL_CHAIN)
 * if Gemini fails or isn't configured.
 *
 * The key is a credential (like the GitHub PAT), not a goal. The system
 * still defines its own work via the SelfTask queue — this only changes
 * WHICH upstream serves the LLM call, not what work gets queued.
 *
 * ── Geo-bypass proxy (opt-in) ───────────────────────────────────────
 * The sandbox egresses through Hong Kong, which Google refuses to serve.
 * If GEMINI_PROXY_BASE_URL is set in the env, calls are routed through
 * that proxy instead of hitting generativelanguage.googleapis.com directly.
 * The user pastes the proxy's shared secret as the "Gemini API key" in
 * the config panel; the proxy swaps it for the real Google key server-side.
 * See /proxy/README.md for the deploy walkthrough. When unset, behavior
 * is unchanged (direct call to Google, will fail with location-blocked
 * from the HK sandbox — which the cooldown below handles gracefully).
 *
 * ── Retry & recovery (added 2026-10-29) ─────────────────────────────
 * Three improvements on top of the original single-shot call:
 *
 *   1. Transient retry with backoff. Network errors, 502/503/504, and
 *      Google's "overloaded/temporarily unavailable" responses get
 *      retried up to MAX_RETRIES times with exponential-ish delays and
 *      jitter. Permanent errors (401, 400, 404, location-block) do NOT
 *      retry — that would just burn the quota.
 *
 *   2. Recovery probe during cooldown. The original 10-min cooldown was
 *      a fixed timer: even if Google lifted the geo-block at minute 2,
 *      every call short-circuited until minute 10. Now, every
 *      RECOVERY_PROBE_INTERVAL_MS during cooldown, we send a tiny probe
 *      request. If it succeeds, the cooldown clears immediately and the
 *      real call proceeds. If it fails, the cooldown continues. This
 *      cuts the average wasted cooldown time from ~10min to ~60s when
 *      the block lifts early.
 *
 *   3. Better error classification. Errors are now tagged with a kind
 *      (location-block, quota, auth, network, model-not-found, blocked,
 *      empty, transient, http) so callers and the UI can react
 *      appropriately instead of pattern-matching on substrings.
 *
 * None of these defeat an IP-level geo-block — that's what the proxy is
 * for. But they make the system MUCH more responsive to transient
 * failures and to the block lifting, instead of waiting out fixed
 * timers.
 */

import { db } from "@/lib/db";

const SINGLETON_ID = "singleton";

// ── Endpoint selection ───────────────────────────────────────────────
// Direct Google endpoint (geo-blocked from the HK sandbox).
const DIRECT_BASE = "https://generativelanguage.googleapis.com";
// Geo-bypass proxy base URL (opt-in via .env). When set, all calls go
// through the proxy instead of hitting Google directly. The proxy is a
// transparent reverse proxy that injects the real Gemini key on its
// side — the caller's "key" is actually the proxy's shared secret.
const PROXY_BASE_URL = process.env.GEMINI_PROXY_BASE_URL?.replace(/\/$/, "") ?? null;
const GEMINI_BASE = PROXY_BASE_URL ?? DIRECT_BASE;

// ── Cooldown state ───────────────────────────────────────────────────
// In-memory cooldown for location-blocked keys. When Google returns
// FAILED_PRECONDITION "location is not supported", we set this to
// Date.now() + 10min so the loop short-circuits Gemini calls instead of
// burning a request per task per cycle while the sandbox is geo-blocked.
// Resets on server restart (acceptable — a restart is also when the
// network egress might change).
//
// ALL THREE mutable slots (geo-block cooldown, recovery-probe stamp,
// per-model circuit breakers) live on globalThis — the same rule as
// duress's safe-mode flag. Turbopack route graphs get separate module
// instances; a module-local `let` fragments the state, so a breaker
// tripped in one graph wouldn't protect the others (quota burn) and a
// geo-block discovered in one stayed unknown in the rest.
const __geminiSharedSlot = globalThis as unknown as {
  __geminiDirectShared?: {
    locationBlockedUntil: number;
    lastProbeAt: number;
    modelCircuitBreakers: Map<string, number>;
  };
};
if (!__geminiSharedSlot.__geminiDirectShared) {
  __geminiSharedSlot.__geminiDirectShared = {
    locationBlockedUntil: 0,
    lastProbeAt: 0,
    modelCircuitBreakers: new Map<string, number>(),
  };
}
const geminiShared = __geminiSharedSlot.__geminiDirectShared;
const LOCATION_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes (upper bound)

// ── Recovery probe state ─────────────────────────────────────────────
// During cooldown, send a tiny probe every 60s. If the probe succeeds,
// clear the cooldown immediately. If it fails, leave the cooldown alone
// (don't extend it — the next probe will try again). This cuts average
// wasted cooldown time from 10min to ~60s when the block lifts early.
// (probe stamp lives in geminiShared.lastProbeAt — shared across module
// graphs; see the slot above)
const RECOVERY_PROBE_INTERVAL_MS = 60 * 1000; // 60s between probes

// ── Retry config ─────────────────────────────────────────────────────
// Transient errors get retried up to MAX_RETRIES times. The delays are
// exponential-ish with jitter to avoid thundering-herd on shared quota.
// 429 is NOT retried here — agent-llm.ts owns the cross-provider 429
// cooldown machinery, and double-handling would fight it.
const MAX_RETRIES = 2;
const RETRY_DELAYS_MS = [500, 1500]; // 0.5s, then 1.5s (plus jitter)
const JITTER_MS = 200; // ±0–200ms random jitter on each delay

// ── Call deadline ──────────────────────────────────────────────────
// Hard ceiling on a SINGLE Google fetch (mirrors agent-llm.ts's
// LLM_CALL_TIMEOUT_MS for the Z.AI leg). Without it, a hung socket
// (connection open, zero bytes flowing) stalls the process-wide
// serialized llmComplete queue forever — every consumer (ratchet,
// enhance, tribunal, red-team) waits on that one queue. Native fetch
// accepts a signal directly, so the deadline is REAL here (unlike the
// SDK leg, which needs the Promise.race workaround).
const GEMINI_CALL_TIMEOUT_MS = 120_000; // 120s
const GEMINI_PROBE_TIMEOUT_MS = 10_000; // 10s (tiny probe, tight ceiling)

// ── Per-model circuit-breaker cascade (concept: Aether_Forge Ω repo) ──
// When the requested model returns 429 / 503 / RESOURCE_EXHAUSTED, trip a
// per-model circuit breaker for CIRCUIT_BREAKER_COOLDOWN_MS so subsequent
// calls skip straight to the next model in the cascade instead of
// re-hammering the same overloaded model. This directly addresses the HK
// geo-block's secondary failure mode: even after the block lifts, a single
// busy model used to burn every cycle's quota before falling through to
// the z-ai chain. With the cascade, one 429 on the primary model routes
// the NEXT call to a fallback model within ~15s — the user sees actual
// progress instead of a 10-min wait.
//
// The cascade order is: the configured model first, then a deduped list
// of known-good fallbacks. NOT_FOUND / INVALID_ARGUMENT for a model is
// NOT a circuit-breakable offense — it just advances to the next model
// without tripping (a deprecated model shouldn't penalize future calls
// that might reconfigure to a valid name). Only overload-class failures
// (429 / 503 / "overloaded" / RESOURCE_EXHAUSTED) trip the breaker.
const GEMINI_MODEL_CASCADE = [
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-2.5-pro",
];
const CIRCUIT_BREAKER_COOLDOWN_MS = 15_000; // 15s — short, so a brief overload self-heals fast
const modelCircuitBreakers = geminiShared.modelCircuitBreakers; // shared across module graphs

function breakerClear(model: string): boolean {
  const until = modelCircuitBreakers.get(model);
  if (!until) return true;
  if (Date.now() >= until) {
    modelCircuitBreakers.delete(model); // self-heal: clear once expired
    return true;
  }
  return false;
}

function tripBreaker(model: string): void {
  modelCircuitBreakers.set(model, Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS);
}

/** Snapshot of the per-model breaker map — for the status API + UI so the
 *  operator can see WHY a call landed on a fallback model. */
export function geminiModelBreakers(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [model, until] of modelCircuitBreakers) {
    if (until > Date.now()) out[model] = until;
  }
  return out;
}

/** One-shot health snapshot for the status API + UI: geo-block cooldown
 *  state, per-model breakers, and whether the geo-bypass proxy is
 *  configured. Pure in-memory read — cheap enough for every status poll,
 *  no I/O, never throws. */
export function geminiHealthSnapshot(): {
  locationBlockedUntilMs: number;
  breakers: Record<string, number>;
  proxyConfigured: boolean;
  disabled: boolean;
} {
  return {
    locationBlockedUntilMs: geminiShared.locationBlockedUntil,
    breakers: geminiModelBreakers(),
    proxyConfigured: !!PROXY_BASE_URL,
    disabled: process.env.GEMINI_DISABLED === "true",
  };
}

interface GeminiConfig {
  apiKey: string;
  model: string;
}

/** Read the stored Gemini config (with key) — server-side only.
 *  Returns null when no row exists OR when the row exists but
 *  geminiApiKey is empty (the @default("") lets an NVIDIA-only setup
 *  create a row without a Gemini key — this guard treats that case as
 *  "not configured" so the Gemini leg short-circuits cleanly). */
export async function getGeminiConfig(): Promise<GeminiConfig | null> {
  const row = await db.llmConfig.findUnique({ where: { id: SINGLETON_ID } }).catch(() => null);
  if (!row) return null;
  if (!row.geminiApiKey) return null;
  return { apiKey: row.geminiApiKey, model: row.geminiModel };
}

/** Public view (key never included) — for the UI status indicator. */
export async function getGeminiConfigPublic(): Promise<{
  configured: boolean;
  model?: string;
  lastUsedAt?: string | null;
  lastError?: string | null;
}> {
  const row = await db.llmConfig.findUnique({ where: { id: SINGLETON_ID } }).catch(() => null);
  if (!row || !row.geminiApiKey) return { configured: false };
  return {
    configured: true,
    model: row.geminiModel,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    lastError: row.lastError,
  };
}

export interface GeminiCallResult {
  ok: boolean;
  content: string;
  error?: string;
  latencyMs: number;
  model: string;
  // Error classification — callers can switch on this instead of
  // pattern-matching on error strings. Omitted when ok:true.
  errorKind?:
    | "location-block"
    | "quota"
    | "auth"
    | "network"
    | "model-not-found"
    | "blocked-content"
    | "empty"
    | "transient"
    | "http"
    | "not-configured";
  // How many retries were used (0 for first-attempt success). Useful
  // for observability — if retries > 0 routinely, the upstream is flaky.
  retries?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  const jitter = Math.floor(Math.random() * JITTER_MS);
  return new Promise((r) => setTimeout(r, ms + jitter));
}

/** Is this HTTP status worth retrying? (transient server-side issues.) */
function isTransientStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

/** Does this error body suggest a transient issue worth retrying? */
function isTransientBody(errText: string): boolean {
  return /overloaded|temporarily|try again|rate limit/i.test(errText);
}

/**
 * Classify an error into a kind. Used by callers to decide whether to
 * fall through to the z-ai chain (any error), retry (transient), or
 * surface a specific user-facing message.
 */
function classifyError(status: number | null, errText: string): GeminiCallResult["errorKind"] {
  // Network-level (no HTTP status at all)
  if (status === null) return "network";
  // Location / region block (the HK sandbox case)
  if (/FAILED_PRECONDITION/i.test(errText) && /location/i.test(errText)) return "location-block";
  if (/location/i.test(errText) && /not supported/i.test(errText)) return "location-block";
  // Auth
  if (status === 401 || status === 403) return "auth";
  // Quota (do NOT retry — agent-llm.ts handles 429 cooldown)
  if (status === 429) return "quota";
  // Model not found / deprecated
  if (status === 404 || /not found|deprecated|discontinued/i.test(errText)) return "model-not-found";
  // Transient (retry-worthy)
  if (isTransientStatus(status) || isTransientBody(errText)) return "transient";
  // Generic HTTP error
  return "http";
}

/**
 * One attempt to call Gemini. Returns the parsed result and a flag
 * indicating whether the error is transient (worth retrying) or
 * permanent (don't retry — would just burn quota).
 */
async function callGeminiOnce(
  cfg: GeminiConfig,
  opts: { systemPrompt: string; userPrompt: string; temperature?: number; maxTokens?: number },
  started: number,
  model: string,
): Promise<{ result: GeminiCallResult; transient: boolean; overload: boolean }> {
  const url = `${GEMINI_BASE}/v1beta/models/${model}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
  const body = {
    systemInstruction: { parts: [{ text: opts.systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: opts.userPrompt }] }],
    generationConfig: {
      temperature: opts.temperature ?? 0.1,
      // Caller-requested output ceiling (OpenAI-style max_tokens maps to
      // Google's maxOutputTokens). Omitted when unset — same as the Z.AI
      // leg, which only forwards the field when the caller provided it.
      ...(opts.maxTokens ? { maxOutputTokens: opts.maxTokens } : {}),
    },
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // Hard 120s deadline (see GEMINI_CALL_TIMEOUT_MS): on abort the
      // fetch rejects, the catch below classifies it as network/transient,
      // and the cascade either retries or falls through to the Z.AI leg.
      signal: AbortSignal.timeout(GEMINI_CALL_TIMEOUT_MS),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      const kind = classifyError(res.status, errText);
      const transient = kind === "transient";
      // `overload` is the cascade signal: true means this specific model
      // is busy/unavailable RIGHT NOW and another model might serve the
      // request. Trips the per-model breaker in geminiComplete so the
      // NEXT call skips this model for 15s. Quota (429) + transient
      // (503/overloaded) both qualify; model-not-found does NOT (a
      // deprecated model name shouldn't poison future reconfigured calls).
      const overload = kind === "quota" || kind === "transient";

      // Arm the location-block cooldown ONLY for location-block — the
      // only error that persists for the sandbox's lifetime. Other errors
      // (429, 503) might lift on the very next call, so we don't penalize
      // them with a 10-min short-circuit.
      if (kind === "location-block") {
        geminiShared.locationBlockedUntil = Date.now() + LOCATION_COOLDOWN_MS;
      }

      const friendlyError =
        kind === "location-block"
          ? PROXY_BASE_URL
            ? `Gemini location not supported even via proxy at ${PROXY_BASE_URL} — proxy may also be in a blocked region; check /proxy/README.md`
            : `Gemini location not supported (key is valid; cool-down 10min — will work from a supported region, or set GEMINI_PROXY_BASE_URL; see /proxy/README.md)`
          : `Gemini ${model} ${res.status}: ${errText.slice(0, 160)}`;

      return {
        result: {
          ok: false,
          content: "",
          error: friendlyError,
          latencyMs: Math.round(performance.now() - started),
          model,
          errorKind: kind,
        },
        transient,
        overload,
      };
    }

    const json = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      promptFeedback?: { blockReason?: string };
      error?: { message?: string };
    };

    // Google can return 200 with a blockReason and no candidates
    if (json.promptFeedback?.blockReason && !json.candidates?.length) {
      return {
        result: {
          ok: false,
          content: "",
          error: `Gemini blocked: ${json.promptFeedback.blockReason}`,
          latencyMs: Math.round(performance.now() - started),
          model,
          errorKind: "blocked-content",
        },
        transient: false, // content filters don't lift on retry
        overload: false,  // content block is prompt-specific, not model-specific
      };
    }

    const content = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    if (!content.trim()) {
      return {
        result: {
          ok: false,
          content: "",
          error: "Gemini returned empty content",
          latencyMs: Math.round(performance.now() - started),
          model,
          errorKind: "empty",
        },
        transient: false,
        overload: false,
      };
    }

    return {
      result: {
        ok: true,
        content,
        latencyMs: Math.round(performance.now() - started),
        model,
      },
      transient: false,
      overload: false,
    };
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    return {
      result: {
        ok: false,
        content: "",
        error: `Gemini network error: ${msg}`,
        latencyMs: Math.round(performance.now() - started),
        model,
        errorKind: "network",
      },
      transient: true, // network blips often clear on retry
      overload: true,  // a network error on ONE model is worth trying the next
    };
  }
}

/**
 * Send a tiny probe request to check if the geo-block has lifted.
 * Uses a minimal "say hi" prompt on the configured model — one token
 * out is enough to know the block is gone. Never arms or extends the
 * cooldown: a probe failure is non-punitive (we just try again next
 * interval). Returns ok:true if the upstream is reachable.
 */
async function probeGemini(cfg: GeminiConfig, model: string): Promise<{ ok: boolean; error?: string }> {
  const url = `${GEMINI_BASE}/v1beta/models/${model}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 1 },
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GEMINI_PROBE_TIMEOUT_MS),
    });
    if (res.ok) return { ok: true };
    const errText = await res.text().catch(() => "");
    const kind = classifyError(res.status, errText);
    // Only a location-block or auth failure means "still blocked".
    // 429 / 503 / etc. mean the upstream is reachable, just busy —
    // treat those as "block lifted, but busy" and clear the cooldown.
    if (kind === "location-block" || kind === "auth") {
      return { ok: false, error: `probe ${kind}` };
    }
    // Quota / transient / http all imply the block is GONE — clear it.
    return { ok: true };
  } catch {
    return { ok: false, error: "probe network error" };
  }
}

/**
 * Call Google's Gemini REST API directly. Returns the text from the first
 * candidate. On any failure (429, 5xx, network, malformed response), returns
 * ok:false so the caller can fall through to the Z.AI chain.
 *
 * Retry behavior: transient errors (network, 502/503/504, "overloaded")
 * get retried up to MAX_RETRIES times with backoff + jitter. Permanent
 * errors (401, 400, 404, location-block) return immediately.
 *
 * Cooldown behavior: location-blocked responses arm a 10-min cooldown
 * during which calls short-circuit. Every 60s during cooldown, a tiny
 * recovery probe is sent; if it succeeds, the cooldown clears and the
 * real call proceeds immediately — so when the block lifts, we recover
 * in ~60s instead of waiting out the full 10min.
 *
 * Google Gemini generateContent REST format:
 *   POST v1beta/models/{model}:generateContent?key=KEY
 *   body: { contents: [{role, parts:[{text}]}], systemInstruction?, generationConfig? }
 *   resp: { candidates: [{content: {parts: [{text}], role}}] }
 */
export async function geminiComplete(opts: {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  /** Caller-requested output ceiling — forwarded to Google as
   *  generationConfig.maxOutputTokens (mirrors the Z.AI leg's max_tokens
   *  passthrough). Omitted when unset. */
  maxTokens?: number;
}): Promise<GeminiCallResult> {
  const started = performance.now();
  // ── GEMINI_DISABLED: zero-overhead Z.AI-only mode ──────────────────
  // When GEMINI_DISABLED=true is in the env, skip the Gemini leg ENTIRELY
  // — no DB read, no probe, no failed call. This is the "I don't want to
  // deploy a proxy and Z.AI's quota is enough" option: the two-leg chain
  // collapses to Z.AI-only instantly on every call, saving the ~10ms DB
  // read + the location-block probe overhead. The operator can still
  // re-enable by clearing the env var (no key re-entry needed — the key
  // stays in the DB, just dormant).
  //
  // Use case: the sandbox is geo-blocked (HK egress), the operator can't
  // or won't deploy the free Cloudflare Worker proxy, and Z.AI's quota
  // alone is sufficient. Set GEMINI_DISABLED=true in .env, restart, done.
  if (process.env.GEMINI_DISABLED === "true") {
    return {
      ok: false,
      content: "",
      error: "Gemini disabled (GEMINI_DISABLED=true) — running Z.AI-only",
      latencyMs: 0,
      model: "",
      errorKind: "not-configured",
    };
  }
  const cfg = await getGeminiConfig();
  if (!cfg) {
    return {
      ok: false,
      content: "",
      error: "Gemini not configured",
      latencyMs: 0,
      model: "",
      errorKind: "not-configured",
    };
  }

  // ── Cooldown short-circuit, with recovery probe ────────────────────
  // If we're in a location-block cooldown, normally short-circuit. But
  // every 60s, send a probe — if the block lifted, clear the cooldown
  // and proceed with the real call. This cuts average wasted cooldown
  // from 10min to ~60s when the block lifts early. The probe uses the
  // first breaker-clear model so a tripped primary doesn't make the
  // probe itself fail spuriously.
  if (geminiShared.locationBlockedUntil > Date.now()) {
    const dueForProbe = Date.now() - geminiShared.lastProbeAt > RECOVERY_PROBE_INTERVAL_MS;
    if (dueForProbe) {
      geminiShared.lastProbeAt = Date.now();
      const probeModel = [cfg.model, ...GEMINI_MODEL_CASCADE].find((m) => breakerClear(m)) ?? cfg.model;
      const probe = await probeGemini(cfg, probeModel);
      if (probe.ok) {
        // Block lifted! Clear the cooldown and fall through to the
        // real call below.
        geminiShared.locationBlockedUntil = 0;
      } else {
        // Still blocked — return the cooldown message but mention the
        // probe so the operator knows we're actively checking, not
        // just sleeping.
        return {
          ok: false,
          content: "",
          error: `Gemini location-blocked (cooldown — recovery probe failed: ${probe.error}; next probe in ${Math.round(RECOVERY_PROBE_INTERVAL_MS / 1000)}s)`,
          latencyMs: Math.round(performance.now() - started),
          model: cfg.model,
          errorKind: "location-block",
        };
      }
    } else {
      const secondsUntilProbe = Math.round(
        (RECOVERY_PROBE_INTERVAL_MS - (Date.now() - geminiShared.lastProbeAt)) / 1000,
      );
      return {
        ok: false,
        content: "",
        error: `Gemini location-blocked (cooldown — recovery probe in ${secondsUntilProbe}s)`,
        latencyMs: 0,
        model: cfg.model,
        errorKind: "location-block",
      };
    }
  }

  // ── Cascade: try the requested model, then deduped fallbacks ──────
  // Build the ordered list of models to try: configured model first,
  // then the cascade, deduped. Skip any model whose per-model circuit
  // breaker is currently tripped (a 429/503 within the last 15s). If
  // every model is tripped, fall through to the z-ai chain honestly
  // rather than waiting — the caller's 429 cooldown gate (agent-llm.ts)
  // is the proper place to wait, not here.
  const modelsToTry = Array.from(new Set([cfg.model, ...GEMINI_MODEL_CASCADE])).filter(
    (m) => breakerClear(m),
  );
  if (modelsToTry.length === 0) {
    // Every model in the cascade is on a 15s breaker. This is rare
    // (needs a synchronized overload across 4 models); report it
    // honestly so the caller defers via its own 429 gate.
    const allBreakers = Array.from(modelCircuitBreakers.entries())
      .map(([m, until]) => `${m}@${Math.max(0, Math.round((until - Date.now()) / 1000))}s`)
      .join(", ");
    const error = `All Gemini cascade models on circuit breaker (${allBreakers || "none"}) — defer to caller`;
    await db.llmConfig
      .update({ where: { id: SINGLETON_ID }, data: { lastError: error.slice(0, 200) } })
      .catch(() => {});
    return {
      ok: false,
      content: "",
      error,
      latencyMs: Math.round(performance.now() - started),
      model: cfg.model,
      errorKind: "quota",
      retries: 0,
    };
  }

  let lastResult: GeminiCallResult | null = null;
  let totalAttemptsUsed = 0;

  for (let modelIdx = 0; modelIdx < modelsToTry.length; modelIdx++) {
    const modelCandidate = modelsToTry[modelIdx];
    // Per-model in-call retry: transient errors (network, 502/503/504,
    // "overloaded") get retried up to MAX_RETRIES times on the SAME model
    // before we give up on it and advance to the next model in the cascade.
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // Accumulate across the WHOLE cascade — the old `= attempt` reset
      // the counter per model, so cascade exhaustion reported the last
      // model's inner-loop index (0–2) instead of the real attempt count.
      totalAttemptsUsed++;
      const { result, transient, overload } = await callGeminiOnce(
        cfg,
        opts,
        started,
        modelCandidate,
      );
      lastResult = result;

      if (result.ok) {
        // Success on this model — clear any stale lastError, record
        // lastUsedAt. The modelUsed field tells the caller (and the UI)
        // which model actually served the request, so honest provenance
        // is preserved even when the configured primary was skipped.
        await db.llmConfig
          .update({
            where: { id: SINGLETON_ID },
            data: { lastUsedAt: new Date(), lastError: null },
          })
          .catch(() => {});
        return { ...result, retries: totalAttemptsUsed - 1 };
      }

      // Location-block: the whole upstream is region-blocked — arm the
      // global cooldown and return immediately. No point trying other
      // models; they'll all be blocked.
      if (result.errorKind === "location-block") {
        await db.llmConfig
          .update({
            where: { id: SINGLETON_ID },
            data: { lastError: result.error?.slice(0, 200) ?? "Gemini location-block" },
          })
          .catch(() => {});
        return { ...result, retries: totalAttemptsUsed - 1 };
      }

      // Auth / empty / blocked-content: NOT model-specific — retrying
      // another model won't help (the token is wrong, or the prompt
      // tripped a content filter on every model). Return immediately.
      if (
        result.errorKind === "auth" ||
        result.errorKind === "empty" ||
        result.errorKind === "blocked-content"
      ) {
        await db.llmConfig
          .update({
            where: { id: SINGLETON_ID },
            data: { lastError: result.error?.slice(0, 200) ?? "Gemini error" },
          })
          .catch(() => {});
        return { ...result, retries: totalAttemptsUsed - 1 };
      }

      // model-not-found: advance to the next model WITHOUT tripping the
      // breaker — a deprecated model name is a config issue, not an
      // overload, and we don't want to penalize a future reconfiguration.
      if (result.errorKind === "model-not-found") {
        break; // inner loop → next model in cascade
      }

      // quota (429) or transient (503/overloaded): if `overload`, trip
      // THIS model's breaker so the next geminiComplete call skips it for
      // 15s, then advance to the next model. If we still have in-call
      // retries AND the error is transient (not 429), retry the same
      // model first (a 503 often clears in 500ms).
      if (overload) {
        if (transient && attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAYS_MS[attempt] ?? 1500);
          continue; // retry same model
        }
        // Retries exhausted on a transient, OR a 429 (not retried in-call):
        // trip the breaker and advance to the next model.
        tripBreaker(modelCandidate);
        break; // inner loop → next model in cascade
      }

      // Generic http error (not classified into any of the above):
      // record and return — unknown errors shouldn't cascade blindly.
      await db.llmConfig
        .update({
          where: { id: SINGLETON_ID },
          data: { lastError: result.error?.slice(0, 200) ?? "Gemini http error" },
        })
        .catch(() => {});
      // Use the SAME accumulator as the sibling return paths above
      // (L642, L655, L672). The old `attempt` was the INNER loop index,
      // which resets to 0 per model in the cascade — a generic http error
      // on the 3rd model after 4 total attempts would report `retries: 0`
      // instead of the honest `retries: 3`.
      return { ...result, retries: totalAttemptsUsed - 1 };
    }
    // Advanced to the next model in the cascade.
  }

  // All models in the cascade exhausted — record and return the last
  // failure. The caller (agent-llm.ts) will set its own 429 gate and
  // defer; we've honestly tried every available model.
  await db.llmConfig
    .update({
      where: { id: SINGLETON_ID },
      data: { lastError: (lastResult?.error ?? "Gemini cascade exhausted").slice(0, 200) },
    })
    .catch(() => {});

  return { ...(lastResult as GeminiCallResult), retries: totalAttemptsUsed - 1 };
}
