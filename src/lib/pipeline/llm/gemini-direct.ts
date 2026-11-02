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
let LOCATION_BLOCKED_UNTIL = 0;
const LOCATION_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes (upper bound)

// ── Recovery probe state ─────────────────────────────────────────────
// During cooldown, send a tiny probe every 60s. If the probe succeeds,
// clear the cooldown immediately. If it fails, leave the cooldown alone
// (don't extend it — the next probe will try again). This cuts average
// wasted cooldown time from 10min to ~60s when the block lifts early.
let LAST_PROBE_AT = 0;
const RECOVERY_PROBE_INTERVAL_MS = 60 * 1000; // 60s between probes

// ── Retry config ─────────────────────────────────────────────────────
// Transient errors get retried up to MAX_RETRIES times. The delays are
// exponential-ish with jitter to avoid thundering-herd on shared quota.
// 429 is NOT retried here — agent-llm.ts owns the cross-provider 429
// cooldown machinery, and double-handling would fight it.
const MAX_RETRIES = 2;
const RETRY_DELAYS_MS = [500, 1500]; // 0.5s, then 1.5s (plus jitter)
const JITTER_MS = 200; // ±0–200ms random jitter on each delay

interface GeminiConfig {
  apiKey: string;
  model: string;
}

/** Read the stored Gemini config (with key) — server-side only. */
export async function getGeminiConfig(): Promise<GeminiConfig | null> {
  const row = await db.llmConfig.findUnique({ where: { id: SINGLETON_ID } }).catch(() => null);
  if (!row) return null;
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
  if (!row) return { configured: false };
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
  opts: { systemPrompt: string; userPrompt: string; temperature?: number },
  started: number,
): Promise<{ result: GeminiCallResult; transient: boolean }> {
  const url = `${GEMINI_BASE}/v1beta/models/${cfg.model}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
  const body = {
    systemInstruction: { parts: [{ text: opts.systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: opts.userPrompt }] }],
    generationConfig: {
      temperature: opts.temperature ?? 0.1,
    },
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      const kind = classifyError(res.status, errText);
      const transient = kind === "transient";

      // Arm the cooldown ONLY for location-block — the only error that
      // persists for the sandbox's lifetime. Other errors (429, 503)
      // might lift on the very next call, so we don't penalize them
      // with a 10-min short-circuit.
      if (kind === "location-block") {
        LOCATION_BLOCKED_UNTIL = Date.now() + LOCATION_COOLDOWN_MS;
      }

      const friendlyError =
        kind === "location-block"
          ? PROXY_BASE_URL
            ? `Gemini location not supported even via proxy at ${PROXY_BASE_URL} — proxy may also be in a blocked region; check /proxy/README.md`
            : `Gemini location not supported (key is valid; cool-down 10min — will work from a supported region, or set GEMINI_PROXY_BASE_URL; see /proxy/README.md)`
          : `Gemini ${res.status}: ${errText.slice(0, 160)}`;

      return {
        result: {
          ok: false,
          content: "",
          error: friendlyError,
          latencyMs: Math.round(performance.now() - started),
          model: cfg.model,
          errorKind: kind,
        },
        transient,
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
          model: cfg.model,
          errorKind: "blocked-content",
        },
        transient: false, // content filters don't lift on retry
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
          model: cfg.model,
          errorKind: "empty",
        },
        transient: false,
      };
    }

    return {
      result: {
        ok: true,
        content,
        latencyMs: Math.round(performance.now() - started),
        model: cfg.model,
      },
      transient: false,
    };
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    return {
      result: {
        ok: false,
        content: "",
        error: `Gemini network error: ${msg}`,
        latencyMs: Math.round(performance.now() - started),
        model: cfg.model,
        errorKind: "network",
      },
      transient: true, // network blips often clear on retry
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
async function probeGemini(cfg: GeminiConfig): Promise<{ ok: boolean; error?: string }> {
  const url = `${GEMINI_BASE}/v1beta/models/${cfg.model}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 1 },
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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
}): Promise<GeminiCallResult> {
  const started = performance.now();
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
  // from 10min to ~60s when the block lifts early.
  if (LOCATION_BLOCKED_UNTIL > Date.now()) {
    const dueForProbe = Date.now() - LAST_PROBE_AT > RECOVERY_PROBE_INTERVAL_MS;
    if (dueForProbe) {
      LAST_PROBE_AT = Date.now();
      const probe = await probeGemini(cfg);
      if (probe.ok) {
        // Block lifted! Clear the cooldown and fall through to the
        // real call below.
        LOCATION_BLOCKED_UNTIL = 0;
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
        (RECOVERY_PROBE_INTERVAL_MS - (Date.now() - LAST_PROBE_AT)) / 1000,
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

  // ── Real call with retry ───────────────────────────────────────────
  let lastResult: GeminiCallResult | null = null;
  let attemptsUsed = 0;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    attemptsUsed = attempt;
    const { result, transient } = await callGeminiOnce(cfg, opts, started);
    lastResult = result;

    if (result.ok) {
      // Success — clear any stale lastError, record lastUsedAt.
      await db.llmConfig
        .update({
          where: { id: SINGLETON_ID },
          data: { lastUsedAt: new Date(), lastError: null },
        })
        .catch(() => {});
      return { ...result, retries: attempt };
    }

    // Permanent error — don't retry, record it for the UI.
    if (!transient) {
      await db.llmConfig
        .update({
          where: { id: SINGLETON_ID },
          data: { lastError: result.error?.slice(0, 200) ?? "Gemini error" },
        })
        .catch(() => {});
      return { ...result, retries: attempt };
    }

    // Transient error — retry with backoff (if attempts remain).
    if (attempt < MAX_RETRIES) {
      await sleep(RETRY_DELAYS_MS[attempt] ?? 1500);
    }
  }

  // All retries exhausted — record and return the last failure.
  await db.llmConfig
    .update({
      where: { id: SINGLETON_ID },
      data: { lastError: (lastResult?.error ?? "Gemini failed").slice(0, 200) },
    })
    .catch(() => {});

  return { ...(lastResult as GeminiCallResult), retries: attemptsUsed };
}
