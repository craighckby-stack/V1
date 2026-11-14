/**
 * NVIDIA Direct — calls NVIDIA's hosted NIM catalog (integrate.api.nvidia.com)
 * with the user-pasted API key. OpenAI-compatible Chat Completions endpoint.
 *
 * ── TIER 1 in the provider chain ──────────────────────────────────────
 * agent-llm.ts tries NVIDIA first (when a key is configured), then Gemini
 * (with the geo-bypass proxy), then the Z.AI SDK chain. NVIDIA is first
 * because:
 *   1. NO GEO-BLOCK from the HK sandbox (unlike Google Gemini). Saves the
 *      entire proxy deploy + cold-start dance.
 *   2. The hosted free catalog is fast — tested p50 ~1.7s tribunal,
 *      ~14s refactor on Bolt (nemotron-3.5-bolt-e4b). 18× the 30s target.
 *   3. $0 — rate-limit-only free tier, ~6K calls/month for LOOP vs
 *      125K-2M headroom depending on plan.
 *
 * ── The trade-off NVIDIA's docs won't tell you about ──────────────────
 * The hosted API catalog is a PROTOTYPE endpoint. Models rotate WITHOUT
 * NOTICE — every model NVIDIA's own docs recommend in this conversation
 * (qwen/qwen2.5-coder-32b-instruct, meta/llama-3.3-70b-instruct,
 * deepseek-ai/deepseek-r1) was already HTTP 410 Gone when tested. The
 * default model below (Bolt) is itself a ~6-month preview window.
 *
 * That's why this module classifies 410 as a permanent error
 * (`errorKind: "model-not-found"`) — so the chain falls through to the
 * next provider without burning retries on a dead model id. The operator
 * swaps in a new model id via the config panel; the loop never stalls.
 *
 * ── guided_json for the review tribunal ───────────────────────────────
 * NVIDIA NIM supports `guided_json` (constrained decoding at the token
 * level — output is guaranteed valid JSON against the supplied schema).
 * Used by the debate tribunal in debate-llm.ts via the `guidedJson`
 * option below. Schema adherence: 3/3 in testing vs prompt-only ~70%.
 *
 * ── Error classification ──────────────────────────────────────────────
 * Mirrors GeminiCallResult's errorKind enum so agent-llm.ts can switch
 * uniformly across providers. Kinds:
 *   - "model-not-found" (404 / 410) — permanent; advance to next provider
 *   - "quota" (429) — permanent; agent-llm.ts owns the cooldown gate
 *   - "auth" (401/403) — permanent; bad key, no retry
 *   - "network" — transient; retryable
 *   - "transient" (502/503/504/overloaded) — retryable
 *   - "empty" — the model returned 200 with no content; not retryable
 *   - "http" — generic other-HTTP error
 *   - "not-configured" — no NVIDIA key saved; tier 1 is a no-op
 */
import { db } from "@/lib/db";

const SINGLETON_ID = "singleton";

// ── Endpoint ───────────────────────────────────────────────────────────
const NVIDIA_BASE = "https://integrate.api.nvidia.com/v1/chat/completions";

// ── Call deadline ──────────────────────────────────────────────────────
// Mirrors agent-llm.ts LLM_CALL_TIMEOUT_MS. Without a hard ceiling, a
// hung socket (connection open, zero bytes flowing) stalls the
// process-wide serialized llmComplete queue — every consumer (ratchet,
// enhance, tribunal, red-team) waits on that one queue.
const NVIDIA_CALL_TIMEOUT_MS = 120_000; // 120s
const NVIDIA_PROBE_TIMEOUT_MS = 15_000; // 15s for verify + recovery probes

// ── Retry config ──────────────────────────────────────────────────────
// Transient errors get retried up to MAX_RETRIES times. 429 is NOT
// retried here — agent-llm.ts owns the cross-provider 429 cooldown.
const MAX_RETRIES = 2;
const RETRY_DELAYS_MS = [500, 1500]; // 0.5s, then 1.5s (plus jitter)
const JITTER_MS = 200;

// ── Per-model circuit breaker (concept: same as gemini-direct.ts) ────
// When a model returns 429 / 503, trip a 15s breaker so subsequent
// calls skip it. The 410 case (model gone) does NOT trip the breaker —
// a deprecated model id is a config issue, not an overload, and we
// don't want to penalize a future reconfiguration.
const CIRCUIT_BREAKER_COOLDOWN_MS = 15_000;
// The breaker map MUST live on globalThis so all Turbopack route-graph
// instances share one view. A module-level `new Map()` is per-instance
// (Turbopack re-evaluates the module per route graph) — a breaker
// tripped in one graph is invisible to the others, and quota burns
// across graphs. Same pattern as agent-llm.ts / gemini-direct.ts.
const BREAKER_SLOT = "__nvidiaBreakers";
type BreakerMap = Map<string, number>;
function nvidiaBreakers(): BreakerMap {
  const g = globalThis as unknown as { [BREAKER_SLOT]?: BreakerMap };
  let breakers = g[BREAKER_SLOT];
  if (!breakers) {
    breakers = new Map<string, number>();
    g[BREAKER_SLOT] = breakers;
  }
  return breakers;
}

function breakerClear(model: string): boolean {
  const breakers = nvidiaBreakers();
  const until = breakers.get(model);
  if (!until) return true;
  if (Date.now() >= until) {
    breakers.delete(model);
    return true;
  }
  return false;
}

function tripBreaker(model: string): void {
  nvidiaBreakers().set(model, Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS);
}

/** Snapshot of the per-model breaker map — for the status API + UI. */
export function nvidiaModelBreakers(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [model, until] of nvidiaBreakers()) {
    if (until > Date.now()) out[model] = until;
  }
  return out;
}

/** One-shot health snapshot for the status API + UI. Pure in-memory read
 *  — cheap enough for every status poll, no I/O, never throws. */
export function nvidiaHealthSnapshot(): {
  breakers: Record<string, number>;
  disabled: boolean;
} {
  return {
    breakers: nvidiaModelBreakers(),
    disabled: process.env.NVIDIA_DISABLED === "true",
  };
}

// ── Cooldown state for the whole NVIDIA leg (mirrors gemini-direct.ts) ──
// 410 Gone on the configured model arms a 10-min cooldown so subsequent
// calls skip straight to the next provider (Gemini → Z.AI) instead of
// re-burning a request on a known-dead model id. Every 60s during
// cooldown, a recovery probe is sent — if the operator swapped the
// model id (and the new one works), the cooldown clears immediately.
// Both slots live on globalThis (same rule as gemini-direct's shared
// slot): module-local `let`s fragment across Turbopack route graphs, so
// a dead-model cooldown discovered in one graph stayed unknown in the
// rest and every graph re-burned a request on the dead model.
const __nvidiaSharedSlot = globalThis as unknown as {
  __nvidiaDirectShared?: { modelDeadUntil: number; lastProbeAt: number };
};
if (!__nvidiaSharedSlot.__nvidiaDirectShared) {
  __nvidiaSharedSlot.__nvidiaDirectShared = { modelDeadUntil: 0, lastProbeAt: 0 };
}
const nvidiaShared = __nvidiaSharedSlot.__nvidiaDirectShared;
const DEAD_COOLDOWN_MS = 10 * 60 * 1000; // 10 min
const RECOVERY_PROBE_INTERVAL_MS = 60 * 1000; // 60s

interface NvidiaConfig {
  apiKey: string;
  model: string;
}

/** Read the stored NVIDIA config (with key) — server-side only. */
export async function getNvidiaConfig(): Promise<NvidiaConfig | null> {
  const row = await db.llmConfig.findUnique({ where: { id: SINGLETON_ID } }).catch(() => null);
  if (!row) return null;
  // Empty key = not configured (the column has @default("")). Treat the
  // same as no row — agent-llm.ts falls through to the next provider.
  if (!row.nvidiaApiKey) return null;
  return { apiKey: row.nvidiaApiKey, model: row.nvidiaModel || "nvidia/nemotron-3.5-bolt-e4b" };
}

/** Public view (key never included) — for the UI status indicator. */
export async function getNvidiaConfigPublic(): Promise<{
  configured: boolean;
  model?: string;
  lastUsedAt?: string | null;
  lastError?: string | null;
}> {
  const row = await db.llmConfig.findUnique({ where: { id: SINGLETON_ID } }).catch(() => null);
  if (!row || !row.nvidiaApiKey) return { configured: false };
  return {
    configured: true,
    model: row.nvidiaModel,
    lastUsedAt: row.nvidiaLastUsedAt?.toISOString() ?? null,
    lastError: row.nvidiaLastError,
  };
}

export interface NvidiaCallResult {
  ok: boolean;
  content: string;
  error?: string;
  latencyMs: number;
  model: string;
  // Error classification — mirrors GeminiCallResult's errorKind enum so
  // agent-llm.ts can switch uniformly. Omitted when ok:true.
  errorKind?:
    | "model-not-found"
    | "quota"
    | "auth"
    | "network"
    | "transient"
    | "empty"
    | "http"
    | "not-configured";
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

/** Classify an error into a kind. Mirrors gemini-direct.ts. */
function classifyError(status: number | null, errText: string): NvidiaCallResult["errorKind"] {
  if (status === null) return "network";
  // 410 Gone — the model id is dead (EOL on the free catalog). This is
  // the failure mode NVIDIA's docs gloss over; surface it clearly.
  if (status === 410 || /end of life|no longer available/i.test(errText)) return "model-not-found";
  if (status === 404) return "model-not-found";
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "quota";
  if (isTransientStatus(status) || isTransientBody(errText)) return "transient";
  return "http";
}

// ── The single attempt ────────────────────────────────────────────────
interface CallOpts {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  /** Optional JSON schema for `guided_json` (constrained decoding).
   *  Used by the debate tribunal to guarantee schema adherence. */
  guidedJson?: Record<string, unknown>;
}

async function callNvidiaOnce(
  cfg: NvidiaConfig,
  opts: CallOpts,
  started: number,
  model: string,
): Promise<{ result: NvidiaCallResult; transient: boolean; overload: boolean }> {
  // OpenAI-compatible Chat Completions body. `guided_json` is a NIM-
  // specific extension; the endpoint ignores fields it doesn't know.
  const body: Record<string, unknown> = {
    model,
    messages: [
      // "system" (not "assistant"): instruction authority of the
      // tribunal/gate prompts depends on the provider treating this
      // turn as a directive, not as a prior assistant reply it may
      // freely continue or contradict.
      { role: "system", content: opts.systemPrompt },
      { role: "user", content: opts.userPrompt },
    ],
    temperature: opts.temperature ?? 0.1,
  };
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
  if (opts.guidedJson !== undefined) body.guided_json = opts.guidedJson;

  try {
    const res = await fetch(NVIDIA_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      // Hard 120s deadline: on abort the fetch rejects, the catch
      // below classifies it as network/transient, and the cascade
      // either retries or falls through to the Gemini leg.
      signal: AbortSignal.timeout(NVIDIA_CALL_TIMEOUT_MS),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      const kind = classifyError(res.status, errText);
      const transient = kind === "transient";
      const overload = kind === "quota" || kind === "transient";

      // Arm the dead-model cooldown ONLY for model-not-found — the
      // failure mode that persists until the operator swaps the id.
      if (kind === "model-not-found") {
        nvidiaShared.modelDeadUntil = Date.now() + DEAD_COOLDOWN_MS;
      }

      // Friendly error: surface 410 distinctly so the operator knows
      // to swap the model id (not the key, not the network).
      const friendlyError =
        kind === "model-not-found"
          ? `NVIDIA ${model} ${res.status} (model ${res.status === 410 ? "end-of-life" : "not found"} — open the NVIDIA panel and pick a current model id from the catalog; cool-down 10min)`
          : `NVIDIA ${model} ${res.status}: ${errText.slice(0, 160)}`;

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
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      error?: { message?: string };
    };

    // NIM can return 200 with an error envelope (rare, but real).
    if (json.error?.message && !json.choices?.length) {
      return {
        result: {
          ok: false,
          content: "",
          error: `NVIDIA error: ${json.error.message}`,
          latencyMs: Math.round(performance.now() - started),
          model,
          errorKind: "http",
        },
        transient: false,
        overload: false,
      };
    }

    const content = json.choices?.[0]?.message?.content ?? "";
    if (!content.trim()) {
      return {
        result: {
          ok: false,
          content: "",
          error: "NVIDIA returned empty content",
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
        error: `NVIDIA network error: ${msg}`,
        latencyMs: Math.round(performance.now() - started),
        model,
        errorKind: "network",
      },
      transient: true, // network blips often clear on retry
      overload: true, // a network error on one model is worth trying the next
    };
  }
}

// ── Recovery probe (mirrors gemini-direct.ts probeGemini) ────────────
async function probeNvidia(cfg: NvidiaConfig, model: string): Promise<{ ok: boolean; error?: string }> {
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: "hi" }],
    temperature: 0,
    max_tokens: 1,
  };
  try {
    const res = await fetch(NVIDIA_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(NVIDIA_PROBE_TIMEOUT_MS),
    });
    if (res.ok) return { ok: true };
    const errText = await res.text().catch(() => "");
    const kind = classifyError(res.status, errText);
    // Only model-not-found or auth means "still dead/bad".
    // 429 / 503 / etc. mean the upstream is reachable, just busy —
    // treat those as "block lifted, but busy" and clear the cooldown.
    if (kind === "model-not-found" || kind === "auth") {
      return { ok: false, error: `probe ${kind}` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "probe network error" };
  }
}

/**
 * Call NVIDIA's hosted NIM catalog. Returns the first choice's content.
 * On any failure (429, 5xx, network, malformed response, 410 dead model),
 * returns ok:false so the caller (agent-llm.ts) can fall through to the
 * next provider in the chain.
 *
 * Retry behavior: transient errors (network, 502/503/504, "overloaded")
 * get retried up to MAX_RETRIES times. Permanent errors (401, 410, 429)
 * return immediately.
 *
 * Cooldown behavior: model-not-found (410/404) arms a 10-min cooldown
 * during which calls short-circuit. Every 60s during cooldown, a tiny
 * recovery probe is sent; if the operator swapped the model id and the
 * new one works, the cooldown clears immediately.
 *
 * OpenAI Chat Completions format:
 *   POST /v1/chat/completions  (Authorization: Bearer KEY)
 *   body: { model, messages: [{role, content}], temperature?, max_tokens?, guided_json? }
 *   resp: { choices: [{ message: { content, role }, finish_reason }], usage }
 */
export async function nvidiaComplete(opts: {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  /** JSON schema for NIM `guided_json` (constrained decoding). When
   *  set, the output is guaranteed valid JSON against the schema at
   *  the token-sampling level — better than prompt-only enforcement. */
  guidedJson?: Record<string, unknown>;
}): Promise<NvidiaCallResult> {
  const started = performance.now();

  // ── NVIDIA_DISABLED: zero-overhead skip ────────────────────────────
  // When NVIDIA_DISABLED=true is in the env, skip the NVIDIA leg
  // ENTIRELY — no DB read, no probe, no failed call. The three-leg
  // chain collapses to Gemini → Z.AI instantly on every call.
  if (process.env.NVIDIA_DISABLED === "true") {
    return {
      ok: false,
      content: "",
      error: "NVIDIA disabled (NVIDIA_DISABLED=true) — running Gemini → Z.AI only",
      latencyMs: 0,
      model: "",
      errorKind: "not-configured",
    };
  }

  const cfg = await getNvidiaConfig();
  if (!cfg) {
    return {
      ok: false,
      content: "",
      error: "NVIDIA not configured",
      latencyMs: 0,
      model: "",
      errorKind: "not-configured",
    };
  }

  // ── Dead-model cooldown short-circuit, with recovery probe ────────
  // If the last call returned model-not-found (410/404), short-circuit
  // for 10min. But every 60s, send a probe — if the operator swapped
  // the model id (and the new one works), the cooldown clears and the
  // real call proceeds immediately. Cuts average wasted cooldown from
  // 10min to ~60s when the model is swapped.
  if (nvidiaShared.modelDeadUntil > Date.now()) {
    const dueForProbe = Date.now() - nvidiaShared.lastProbeAt > RECOVERY_PROBE_INTERVAL_MS;
    if (dueForProbe) {
      nvidiaShared.lastProbeAt = Date.now();
      const probe = await probeNvidia(cfg, cfg.model);
      if (probe.ok) {
        nvidiaShared.modelDeadUntil = 0;
      } else {
        return {
          ok: false,
          content: "",
          error: `NVIDIA model ${cfg.model} is gone (cooldown — recovery probe failed: ${probe.error}; next probe in ${Math.round(RECOVERY_PROBE_INTERVAL_MS / 1000)}s)`,
          latencyMs: Math.round(performance.now() - started),
          model: cfg.model,
          errorKind: "model-not-found",
        };
      }
    } else {
      const secondsUntilProbe = Math.round(
        (RECOVERY_PROBE_INTERVAL_MS - (Date.now() - nvidiaShared.lastProbeAt)) / 1000,
      );
      return {
        ok: false,
        content: "",
        error: `NVIDIA model ${cfg.model} is gone (cooldown — recovery probe in ${secondsUntilProbe}s)`,
        latencyMs: 0,
        model: cfg.model,
        errorKind: "model-not-found",
      };
    }
  }

  // ── Skip if the configured model's breaker is tripped ──────────────
  // Unlike gemini-direct.ts (which has a cascade), NVIDIA here has a
  // single model. If its breaker is tripped, return quota-kind so the
  // chain falls through to Gemini. agent-llm.ts's 429 cooldown gate
  // handles the long wait.
  if (!breakerClear(cfg.model)) {
    return {
      ok: false,
      content: "",
      error: `NVIDIA ${cfg.model} on circuit breaker (recent 429/503) — defer to next provider`,
      latencyMs: Math.round(performance.now() - started),
      model: cfg.model,
      errorKind: "quota",
      retries: 0,
    };
  }

  let lastResult: NvidiaCallResult | null = null;
  let totalAttemptsUsed = 0;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Accumulate honestly — the old `= attempt` reset the counter per
    // model/loop so exhausted retries underreported the real attempt count.
    totalAttemptsUsed++;
    const { result, transient, overload } = await callNvidiaOnce(cfg, opts, started, cfg.model);
    lastResult = result;

    if (result.ok) {
      // Success — clear any stale lastError, record lastUsedAt.
      await db.llmConfig
        .update({
          where: { id: SINGLETON_ID },
          data: { nvidiaLastUsedAt: new Date(), nvidiaLastError: null },
        })
        .catch(() => {});
      return { ...result, retries: totalAttemptsUsed - 1 };
    }

    // Permanent errors — return immediately (don't burn retries).
    if (
      result.errorKind === "model-not-found" ||
      result.errorKind === "auth" ||
      result.errorKind === "empty" ||
      result.errorKind === "quota"
    ) {
      await db.llmConfig
        .update({
          where: { id: SINGLETON_ID },
          data: { nvidiaLastError: result.error?.slice(0, 200) ?? "NVIDIA error" },
        })
        .catch(() => {});
      // Quota trips the breaker so the next call skips for 15s.
      if (overload) tripBreaker(cfg.model);
      return { ...result, retries: totalAttemptsUsed - 1 };
    }

    // Transient (network / 502/503/504 / overloaded): retry if we
    // have retries left AND the error is transient. Otherwise trip
    // the breaker and return.
    if (transient && attempt < MAX_RETRIES) {
      await sleep(RETRY_DELAYS_MS[attempt] ?? 1500);
      continue;
    }

    // Either retries exhausted on a transient, or generic http error.
    // Trip the breaker if overload-class; record and return.
    if (overload) tripBreaker(cfg.model);
    await db.llmConfig
      .update({
        where: { id: SINGLETON_ID },
        data: { nvidiaLastError: result.error?.slice(0, 200) ?? "NVIDIA error" },
      })
      .catch(() => {});
    return { ...result, retries: totalAttemptsUsed - 1 };
  }

  // Should be unreachable (loop returns on every path above), but keep
  // the type system honest: a lastResult is always set after the loop.
  return { ...(lastResult as NvidiaCallResult), retries: totalAttemptsUsed - 1 };
}

/**
 * Verify an NVIDIA API key with a tiny "say OK" probe. Used by the
 * llm-config POST route to validate the key before persisting it.
 *
 * Returns the upstream HTTP status so the route can give a precise
 * "key bad" vs "key valid, model gone" vs "key valid, network error"
 * message — same idea as the Gemini verify step.
 */
export async function verifyNvidiaKey(
  apiKey: string,
  model: string,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const res = await fetch(NVIDIA_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "say OK" }],
        temperature: 0,
        max_tokens: 3,
      }),
      signal: AbortSignal.timeout(NVIDIA_PROBE_TIMEOUT_MS),
    });
    if (res.ok) return { ok: true, status: 200 };
    const errText = await res.text().catch(() => "");
    return { ok: false, status: res.status, error: errText.slice(0, 200) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
