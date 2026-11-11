/**
 * Real LLM agent loop for code refactoring.
 *
 * Wraps z-ai-web-dev-sdk and produces actual refactored code (instead of
 * the cosmetic comment-injection the previous stub did). The output is
 * then run through the real AST diff gate so the system can genuinely
 * reject LLM output that drops symbols.
 *
 * If the SDK is unreachable (e.g. no API access, sustained 429), the call
 * returns ok:false after bounded retries. Callers must surface the failure
 * honestly — never substitute a fabricated "deterministic" refactor.
 */

import ZAI from "z-ai-web-dev-sdk";
import { geminiComplete } from "./gemini-direct";
import { nvidiaComplete } from "./nvidia-direct";

// The SDK's default export has a private constructor, so derive the instance
// type from the async create() factory instead.
type ZAIType = Awaited<ReturnType<typeof ZAI.create>>;

// ── Turbopack multi-instance fix (audit 3, B4) ──────────────────────────
// Module-level `let` state is PER-MODULE-INSTANCE in Turbopack dev mode:
// the same file loads into multiple module graphs (one per route
// boundary), and a hot-swap re-evaluates the module fresh. The OLD
// selfEnhanceLoop's closure kept the OLD agent-llm's `blockedUntil`
// (set to +30min mid-outage) while the NEW loop imported a FRESH module
// with blockedUntil=0 — the "shared" gate stopped being shared exactly
// when it mattered, and both loops hammered the API simultaneously.
// Same bug, same fix as hot-swap.ts STATE_SLOT: the mutable gate state
// lives on globalThis, which is one object per PROCESS no matter how
// many module instances exist.
interface LlmGateState {
  zaiPromise: Promise<ZAIType> | null;
  blockedUntil: number;
  strikes: number;
  llmCallQueue: Promise<unknown>;
  /** Z.ai cortex injection state — warmed at SERVER BOOT (see
   *  instrumentation.ts) so the provider connection exists BEFORE the
   *  first request (the boot splash reads it via /api/boot/scan). Lives
   *  on the same globalThis slot so the warmed SDK instance (zaiPromise)
   *  is the EXACT instance llmComplete callers reuse — one injection,
   *  one process, across hot-swaps. */
  cortex: ZaiCortexInternal;
}

/** Internal (mutable) cortex state. The public snapshot type below is
 *  what APIs/UI see — this one carries the throttle timestamp. */
interface ZaiCortexInternal {
  state: "cold" | "warming" | "ready" | "error";
  injected: boolean;
  pingMs?: number;
  model?: string;
  error?: string;
  note?: string;
  warmedAt?: string;
  /** Epoch ms of the last warm attempt — throttles error-path retries. */
  lastAttemptMs?: number;
}

/** Public cortex snapshot (API response / boot-splash vitals). */
export interface ZaiCortexInfo {
  state: "cold" | "warming" | "ready" | "error";
  injected: boolean;
  pingMs?: number;
  model?: string;
  error?: string;
  warmedAt?: string;
  /** Present when the connection is VERIFIED but the provider answered
   *  with a rate limit (429): the round trip completed — end-to-end
   *  connectivity is proven, only the quota is cooling. Kept separate
   *  from `error` (which means the connection could NOT be verified). */
  note?: string;
}

const LLM_GATE_SLOT = "__llmGateState";
function gateState(): LlmGateState {
  const g = globalThis as unknown as { [LLM_GATE_SLOT]?: LlmGateState };
  if (!g[LLM_GATE_SLOT]) {
    g[LLM_GATE_SLOT] = {
      zaiPromise: null,
      blockedUntil: 0,
      strikes: 0,
      llmCallQueue: Promise.resolve(),
      cortex: { state: "cold", injected: false },
    };
  } else if (!g[LLM_GATE_SLOT].cortex) {
    // Stale-slot healing: the slot may have been created by a PREVIOUS
    // module generation (before the cortex field existed) — Turbopack
    // keeps the globalThis object across re-imports, so an old-shape slot
    // outlives the module that made it. Without this heal, cortex reads
    // would crash on `undefined.state` in exactly the process that most
    // needs the injection (one that booted before this change).
    g[LLM_GATE_SLOT].cortex = { state: "cold", injected: false };
  }
  return g[LLM_GATE_SLOT]!;
}

async function getZai(): Promise<ZAIType> {
  const gs = gateState();
  if (!gs.zaiPromise) {
    gs.zaiPromise = ZAI.create().catch((err) => {
      gateState().zaiPromise = null;
      throw err;
    });
  }
  return gs.zaiPromise;
}

// ── Fix A: shared rate-limit gate ──────────────────────────────────────────
// Module-level state shared by EVERY llmComplete caller (ratchet, enhance,
// debate tribunal, chat-task). When the provider returns a
// sustained 429, we set `blockedUntil` to now + an escalating cooldown.
//
// ── Fix A2 (audit 2): serialized dispatch ────────────────────────────
// The gate alone did NOT protect parallel callers: debate-llm launches its
// Security and Architecture reviews with Promise.all, and BOTH calls passed
// the gate check before either had finished its in-call retries — so both
// hammered the API during an outage, both exhausted, and both incremented
// `strikes`, turning ONE outage into a double escalation (2min gate, then
// the next failure starting at 15min). llmComplete now runs on a module-
// level promise queue: the second call doesn't start until the first
// finishes, and if the first set the gate, the second returns immediately
// with rateLimited:true — which is what the comment below used to claim
// but couldn't actually guarantee.
//
// `strikes` is the escalation counter. Each gate-set uses strikes (capped at
// 3) to pick a cooldown from COOLDOWNS_MS, then increments strikes. A single
// success resets strikes to 0 — so one good call after a 2min cooldown
// de-escalates instead of staying at 30min forever. (The mutable state
// itself lives on globalThis — see gateState() above for why.)
const COOLDOWNS_MS = [2, 5, 15, 30].map((m) => m * 60_000); // 2min, 5min, 15min, 30min

// Hard ceiling on a SINGLE provider call (audit 3): a hung SDK call (socket
// open, zero bytes flowing) used to stall the process-wide serialization
// queue forever — every llmComplete consumer (ratchet, enhance, debate
// tribunal, red-team) waits on that one queue. See the race in
// performLlmComplete for why a plain SDK option isn't enough.
const LLM_CALL_TIMEOUT_MS = 180_000; // 180s

/** Milliseconds until the gate opens. 0 means clear. Callers (the loop) can
 *  poll this to decide whether to attempt a call or sleep until it clears. */
export function llmCooldownMs(): number {
  return Math.max(0, gateState().blockedUntil - Date.now());
}

/** True iff the gate is currently blocking all calls. Convenience wrapper. */
export function llmIsCoolingDown(): boolean {
  return gateState().blockedUntil > Date.now();
}

/** Snapshot of the shared rate-limit gate, for the status API and UI.
 *  `level` is the CURRENT escalation state (1-4): the cooldown that's active
 *  now was set from COOLDOWNS_MS[level-1] (2/5/15/30 min). The next 429
 *  after this one escalates to level+1; one successful call resets to 0. */
export interface LlmGateInfo {
  active: boolean;
  /** Milliseconds until the gate opens (0 when inactive). */
  remainingMs: number;
  /** Epoch ms when the gate opens (0 when inactive) — the UI ticks against
   *  this so the countdown stays accurate between polls. */
  endsAtMs: number;
  /** Escalation level of the ACTIVE cooldown (1=2min, 2=5min, 3=15min, 4=30min). */
  level: number;
}

export function llmGateInfo(): LlmGateInfo {
  const now = Date.now();
  const gs = gateState();
  const active = gs.blockedUntil > now;
  return {
    active,
    remainingMs: active ? gs.blockedUntil - now : 0,
    endsAtMs: active ? gs.blockedUntil : 0,
    level: active ? Math.min(gs.strikes, 4) : 0,
  };
}

// ── Z.AI CORTEX AUTO-INJECTION ─────────────────────────────────────
// "Inject before the splash screen": instrumentation.ts calls
// warmZaiCortex() at SERVER BOOT — before the first HTTP request, so
// before the boot splash fetches /api/boot/scan. The warm does two
// things:
//   1. ZAI.create() — the SDK handshake, cached in the shared
//      zaiPromise (the SAME instance every llmComplete call reuses —
//      no second connection, no duplicate client).
//   2. A one-shot minimal ping (a 4-token completion) — honest
//      end-to-end verification that the provider actually answers,
//      with measured latency + the serving model recorded.
// The ping bypasses the 429 gate/serialization queue on purpose: it is
// a health check, not work — it must report the PROVIDER, not the
// loop's own throttling (the LLM CORTEX splash line already reports
// the gate). Never throws, never blocks: fire-and-forget.
const CORTEX_PING_TIMEOUT_MS = 20_000;
const CORTEX_ERROR_RETRY_MS = 30_000;

/** Idempotent, throttled, fire-and-forget. Safe to call from
 *  instrumentation (boot) AND from /api/boot/scan (lazy kick when the
 *  process predates the instrumentation hook). */
export function warmZaiCortex(): void {
  const c = gateState().cortex;
  const now = Date.now();
  if (c.state === "warming" || c.state === "ready") return; // already injected / in flight
  if (
    c.state === "error" &&
    c.lastAttemptMs &&
    now - c.lastAttemptMs < CORTEX_ERROR_RETRY_MS
  ) {
    return; // errored recently — don't hammer a dead provider on every scan
  }
  c.state = "warming";
  c.lastAttemptMs = now;
  void (async () => {
    const t0 = performance.now();
    try {
      const zai = await getZai();
      const createWithOptions = zai.chat.completions.create as unknown as (
        body: Parameters<typeof zai.chat.completions.create>[0],
        options?: { signal?: AbortSignal }
      ) => Promise<any>;
      const signal = AbortSignal.timeout(CORTEX_PING_TIMEOUT_MS);
      const completion = await Promise.race([
        createWithOptions(
          {
            messages: [{ role: "user", content: "Reply with exactly: pong" }],
            thinking: { type: "disabled" },
            max_tokens: 4,
          } as Parameters<typeof zai.chat.completions.create>[0],
          { signal }
        ),
        new Promise<never>((_, reject) => {
          const timeoutError = () =>
            new Error(`cortex ping timed out after ${CORTEX_PING_TIMEOUT_MS / 1000}s`);
          if (signal.aborted) {
            reject(timeoutError());
            return;
          }
          signal.addEventListener("abort", () => reject(timeoutError()), { once: true });
        }),
      ]);
      // Any resolved completion = provider answered. Content is not
      // required for a health check (models may reply tersely); the
      // resolve itself is the proof of an end-to-end path.
      c.state = "ready";
      c.injected = true;
      c.pingMs = Math.round(performance.now() - t0);
      c.model =
        typeof completion?.model === "string" ? completion.model : undefined;
      c.warmedAt = new Date().toISOString();
      c.error = undefined;
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      // A 429 is a structured HTTP answer FROM THE PROVIDER — the full
      // SDK→API round trip completed, so end-to-end connectivity is
      // VERIFIED even though the quota is cooling. Report it honestly as
      // ready-with-note (the work-call gate handles actual throttling;
      // this health check reports the connection, and the connection
      // works). Anything else (network, timeout, 5xx) is a real error.
      const isRateLimit = /\b429\b|too many requests|rate.?limit/i.test(raw);
      // OPERATOR FIX (2026-11-11): token-rotation awareness (same fix as
      // performLlmComplete's catch). An auth failure here means the cached
      // instance's token was retired by the platform's /etc/.z-ai-config
      // rotation — drop the instance so the next warm (30s retry) or any
      // llmComplete call re-reads the freshly rotated config. See the
      // longer comment in performLlmComplete for the live evidence.
      if (/\b401\b|missing x-token|unauthorized/i.test(raw)) {
        gateState().zaiPromise = null;
      }
      if (isRateLimit) {
        c.state = "ready";
        c.injected = true;
        c.pingMs = Math.round(performance.now() - t0);
        c.note = "PROVIDER REACHED — 429 QUOTA COOLING";
        c.warmedAt = new Date().toISOString();
        c.error = undefined;
      } else {
        c.state = "error";
        c.injected = false;
        // Compact the reason (SDK errors can embed full JSON bodies).
        c.error = raw.replace(/\s+/g, " ").slice(0, 120);
      }
    }
  })();
}

/** Public snapshot of the cortex injection (copy — callers can't mutate). */
export function zaiCortexStatus(): ZaiCortexInfo {
  const c = gateState().cortex;
  return {
    state: c.state,
    injected: c.injected,
    pingMs: c.pingMs,
    model: c.model,
    error: c.error,
    note: c.note,
    warmedAt: c.warmedAt,
  };
}

export interface LlmCallOptions {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
  /** Optional JSON schema for NIM `guided_json` (constrained decoding
   *  at the token level). Forwarded to NVIDIA's hosted NIM catalog when
   *  it serves the call; the OpenAI/Z.AI leg ignores it (its own guided-
   *  json mode is invoked separately by callers that need it). The
   *  debate tribunal passes the verdict schema here for ~3/3 schema
   *  adherence vs prompt-only ~70%. */
  guidedJson?: Record<string, unknown>;
  /** Fired before each retry backoff. Lets callers surface the retry in
   *  real time instead of going silent for the full ~150s 429 backoff
   *  window (10s + 20s + 40s + 80s). The live view stays honest about
   *  what's happening during the quiet gaps. */
  onRetry?: (info: {
    attempt: number;      // which attempt just failed (1..maxAttempts-1)
    maxAttempts: number;  // total attempts the caller will make
    isRateLimit: boolean; // true if the error looks like a 429
    delayMs: number;      // how long we'll wait before the next attempt
    error: string;        // the error from the failed attempt
  }) => void;
}

export interface LlmCallResult {
  ok: boolean;
  content: string;
  error?: string;
  attempts: number;
  latencyMs: number;
  /** True iff the call did NOT succeed because of rate limiting — either the
   *  gate was already active when llmComplete was entered (returned
   *  immediately, 0 attempts), or the in-call retries exhausted on a 429
   *  and the gate was just set by this call. Distinct from a generic
   *  `ok:false` (network error, empty response, parse failure) which does
   *  NOT set the gate. Callers should treat rateLimited as "defer, don't
   *  burn an attempt" rather than "fail this file permanently". */
  rateLimited?: boolean;
  /** Which model actually served the call (from the API response —
   *  honest provenance for the task engine's records; undefined only
   *  if the provider omits the field). */
  modelUsed?: string;
  /** Present when a fallback provider served the call after a higher
   *  tier failed: records WHICH errorKind triggered the fallthrough —
   *  honest provenance for why a call landed on the fallback. Formats:
   *  `nvidia:<errorKind>`, `gemini:<errorKind>`. */
  fallbackFrom?: string;
}

/**
 * Single-shot LLM call with bounded retry. Returns `ok: false` when the
 * SDK is unavailable; callers must surface that honestly (skip the stage /
 * block the write) — never fabricate output.
 *
 * Dispatch is SERIALIZED (Fix A2): every call — including parallel callers
 * such as debate-llm's Promise.all — executes through a single queue, so
 * the shared rate-limit gate is checked with full knowledge of the previous
 * call's outcome instead of racing it.
 */
export function llmComplete(opts: LlmCallOptions): Promise<LlmCallResult> {
  // The serialization queue lives on globalThis (gateState) — see the
  // multi-instance note above. Exactly one llmComplete body executes at a
  // time, process-wide, across every module instance.
  const gs0 = gateState();
  const run = gs0.llmCallQueue.then(() => performLlmComplete(opts));
  // Advance the chain regardless of outcome; the queue itself never fails.
  gs0.llmCallQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function performLlmComplete(opts: LlmCallOptions): Promise<LlmCallResult> {
  const started = performance.now();
  let lastError: string | undefined;

  // ── Provider chain: NVIDIA → Gemini → Z.AI (three-leg) ──────────────
  // When an NVIDIA key is configured (NVIDIA panel / llm-config),
  // every call tries NVIDIA's free hosted NIM catalog FIRST — no geo-
  // block from the HK sandbox, ~1.7s tribunal / 14s refactor on Bolt,
  // $0 rate-limit-only free tier. Only on any NVIDIA failure does the
  // call fall through to the Gemini leg (with its geo-bypass proxy)
  // and then to the Z.AI SDK chain. Three hard rules keep the providers
  // from interfering:
  //   1. NVIDIA / Gemini failures NEVER set the Z.AI 429 gate below
  //      (separate quotas — an NVIDIA 410 or a Google outage must not
  //      freeze the Z.AI leg), and the Z.AI gate never blocks NVIDIA
  //      or Gemini attempts. Each leg has its OWN defenses: per-model
  //      circuit breakers, dead-model cooldowns with 60s recovery
  //      probes, and transient retries.
  //   2. When NVIDIA is unconfigured, nvidiaComplete short-circuits with
  //      errorKind "not-configured" and the behavior below is identical
  //      to the historical Gemini-first path — zero overhead beyond
  //      one tiny DB read per call. Same for Gemini unconfigured → Z.AI.
  //   3. `guided_json` is forwarded to NVIDIA only (Gemini's own
  //      schema-enforcement path is separate; the Z.AI SDK has no such
  //      field). When the NVIDIA leg serves a tribunal call, the JSON
  //      output is guaranteed valid against the schema at the token-
  //      sampling level — ~3/3 adherence in testing vs prompt-only ~70%.
  // The attempt still runs on the process-wide serialization queue
  // (llmComplete chains every performLlmComplete) — parallel callers
  // can't hammer NVIDIA any more than they could Z.AI.
  const nv = await nvidiaComplete({
    systemPrompt: opts.systemPrompt,
    userPrompt: opts.userPrompt,
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
    guidedJson: opts.guidedJson,
  });
  if (nv.ok) {
    // Chain success — de-escalate the Z.AI gate counter exactly like a
    // Z.AI success does (one good call resets strikes to 0).
    gateState().strikes = 0;
    return {
      ok: true,
      content: nv.content,
      attempts: 1,
      latencyMs: Math.round(performance.now() - started),
      modelUsed: `nvidia:${nv.model}`,
    };
  }
  // NVIDIA failed (or wasn't configured) — record why and fall through
  // to the Gemini leg. nv.errorKind === "not-configured" means the
  // operator hasn't pasted a key yet, so we don't surface that as a
  // fallback reason (the chain simply collapsed to the next tier).
  const nvFallbackNote =
    nv.errorKind === "not-configured" ? undefined : `nvidia:${nv.errorKind ?? "error"}`;

  // ── Gemini leg (tier 2) ───────────────────────────────────────────
  // When a Gemini key is configured (GEMINI panel / llm-config), every
  // call tries Google — a SEPARATE free-tier quota — and only falls
  // through to the Z.AI gateway leg on any Gemini failure.
  // Gemini failures NEVER set the Z.AI 429 gate below (separate quotas —
  // a Google outage must not freeze the Z.AI leg), and the Z.AI gate
  // never blocks Gemini attempts. The Gemini leg has its OWN defenses:
  // per-model circuit breakers, a location-block cooldown with 60s
  // recovery probes, and transient retries (gemini-direct.ts).
  const gem = await geminiComplete(opts);
  if (gem.ok) {
    // Chain success — de-escalate the Z.AI gate counter exactly like a
    // Z.AI success does (one good call resets strikes to 0).
    gateState().strikes = 0;
    return {
      ok: true,
      content: gem.content,
      attempts: 1,
      latencyMs: Math.round(performance.now() - started),
      modelUsed: `gemini:${gem.model}`,
    };
  }
  const fallbackNote = `gemini:${gem.errorKind ?? "error"}`;
  // When BOTH NVIDIA and Gemini failed (and both were configured), record
  // both failure reasons so the task engine's records show the full
  // cascade. When only Gemini was configured (NVIDIA not-configured),
  // nvFallbackNote is undefined and we record just the Gemini reason —
  // preserving the historical single-fallback format for that case.
  const combinedFallback =
    nvFallbackNote && gem.errorKind !== "not-configured"
      ? `${nvFallbackNote} → ${fallbackNote}`
      : fallbackNote;

  // Fix A: gate check. If a previous call (in this process, by any caller)
  // set the gate, return immediately — no in-call retries, no backoff sleep.
  // The caller sees rateLimited:true and defers. This is what stops the
  // ~150s-per-file 429 backoff spiral: instead of each call site doing its
  // own 5× retry, the FIRST 429 sets a 2min gate and all subsequent calls
  // (ratchet, enhance, debate, chat-task) return instantly.
  // (Re-read AFTER the Gemini attempt: the gate may have expired during
  // that call, in which case the Z.AI leg proceeds normally.)
  const cooldownMs = llmCooldownMs();
  if (cooldownMs > 0) {
    return {
      ok: false,
      content: "",
      error:
        gem.errorKind === "not-configured"
          ? `429 cooldown active — ${Math.round(cooldownMs / 1000)}s remaining`
          : `gemini unavailable (${gem.errorKind}); 429 cooldown active — ${Math.round(cooldownMs / 1000)}s remaining`,
      rateLimited: true,
      attempts: 0,
      latencyMs: Math.round(performance.now() - started),
      fallbackFrom: gem.errorKind === "not-configured" ? nvFallbackNote : combinedFallback,
    };
  }

  // Fix A: cut in-call retries from 5 to 2. The gate handles the long wait
  // (2min → 30min escalating); in-call only needs to cover transient blips
  // (a single 429 that clears in 10s, or a momentary network hiccup). With
  // maxAttempts=2, onRetry fires at most once per call — the live view is
  // less noisy AND the gate's cooldown replaces the 80s max in-call backoff.
  const maxAttempts = 2;
  let sawRateLimit = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const zai = await getZai();
      // Pass through temperature/maxTokens so callers can actually control
      // generation. Previously these were accepted by LlmCallOptions but
      // silently dropped here, leaving every call at the provider default.
      // We build the body as `any` because the SDK's CreateChatCompletionBody
      // type doesn't list max_tokens (but the upstream provider accepts it),
      // and we don't want to model the full OpenAI-compatible surface here.
      const createParams: Parameters<typeof zai.chat.completions.create>[0] = {
        messages: [
          // "system", not "assistant": instruction authority of the
          // tribunal/gate prompts depends on the provider treating this
          // turn as a directive, not as a prior assistant reply it may
          // freely continue or contradict. Standard chat-API role.
          { role: "system", content: opts.systemPrompt },
          { role: "user", content: opts.userPrompt },
        ],
        thinking: { type: "disabled" },
      } as Parameters<typeof zai.chat.completions.create>[0];
      if (opts.temperature !== undefined) {
        (createParams as Record<string, unknown>).temperature = opts.temperature;
      }
      if (opts.maxTokens !== undefined) {
        // OpenAI-style field name; the SDK forwards to the provider as-is.
        (createParams as Record<string, unknown>).max_tokens = opts.maxTokens;
      }
      // Timeout (audit 3): 180s ceiling per provider call. The SDK
      // (z-ai-web-dev-sdk@0.0.18) takes NO request-options argument —
      // `create(body)` is its entire signature (dist/index.d.ts) and its
      // internal fetch() passes no signal (dist/index.js); a signal inside
      // the body would just be JSON-serialized into the payload. So:
      //   1. Pass { signal } as a second options argument via a widened
      //      (cast) view of the method, so a future SDK that accepts
      //      standard request options honors the abort.
      //   2. Race the call against the SAME AbortSignal.timeout(180s) so
      //      the deadline is REAL with the current SDK: on abort the race
      //      rejects, the rejection lands in the catch below (NOT
      //      swallowed), and the existing retry/gate machinery takes
      //      over. The abandoned underlying fetch (unabortable through
      //      this SDK) is left to the runtime's own socket timeouts; its
      //      eventual rejection is handled by Promise.race and ignored.
      const timeoutSignal = AbortSignal.timeout(LLM_CALL_TIMEOUT_MS);
      // The SDK's signature is fixed-arity (`create(body)` — no options
      // parameter), so the second argument needs a widened view of the
      // method; casting the options OBJECT alone can't satisfy TS2554.
      const createWithOptions = zai.chat.completions.create as unknown as (
        body: Parameters<typeof zai.chat.completions.create>[0],
        options?: { signal?: AbortSignal }
      ) => Promise<any>;
      const callPromise = createWithOptions(
        createParams,
        // Not in the SDK's type surface (v0.0.18): standard fetch request
        // options — ignored by the current implementation; the race below
        // is what actually enforces the deadline.
        { signal: timeoutSignal }
      );
      const completion = await Promise.race([
        callPromise,
        new Promise<never>((_, reject) => {
          const timeoutError = () =>
            new Error(`LLM call timed out after ${LLM_CALL_TIMEOUT_MS / 1000}s`);
          if (timeoutSignal.aborted) {
            reject(timeoutError());
            return;
          }
          timeoutSignal.addEventListener("abort", () => reject(timeoutError()), {
            once: true,
          });
        }),
      ]);
      const content = completion.choices?.[0]?.message?.content ?? "";
      if (!content.trim()) {
        throw new Error("Empty LLM response");
      }
      // Success — reset the escalation counter. One good call after a
      // cooldown de-escalates (next 429 starts at 2min again, not 30min).
      gateState().strikes = 0;
      return {
        ok: true,
        content,
        attempts: attempt,
        latencyMs: Math.round(performance.now() - started),
        modelUsed: (completion as { model?: string }).model,
        // Z.AI served after NVIDIA + Gemini both failed (or were
        // unconfigured). Use combinedFallback to record the full
        // cascade. When NVIDIA wasn't configured and Gemini was, this
        // equals just `gemini:<reason>` (the historical format).
        fallbackFrom: combinedFallback,
      };
    } catch (err) {
      lastError = (err as Error).message;
      const isRateLimit = /\b429\b|too many requests|rate.?limit/i.test(lastError);
      if (isRateLimit) sawRateLimit = true;

      // OPERATOR FIX (2026-11-11): token-rotation awareness. The platform
      // rotates the token in /etc/.z-ai-config continuously (its mtime is
      // often < 5 min old); the SDK captures the token ONCE at ZAI.create()
      // and zaiPromise caches the instance forever. A retired token makes
      // every call fail with "401 missing X-Token header" — the gateway's
      // (misleading) response for an unknown token: the header IS sent,
      // it's just no longer valid. Observed live: a 21.5h outage with 2194
      // consecutive 401s while a fresh ZAI.create() against the same file
      // passed auth (empirically verified: fresh instance got 429 = auth
      // OK, quota cooling). Fix: drop the cached instance on ANY auth
      // failure; the next getZai() (this call's attempt 2, or any later
      // call) re-reads the freshly rotated config.
      if (/\b401\b|missing x-token|unauthorized/i.test(lastError)) {
        gateState().zaiPromise = null;
      }

      if (attempt < maxAttempts) {
        // For 429s: short backoff (was 10s base; now just 2-4s with jitter)
        // — the gate will handle the long wait if this retry also fails.
        // For other errors: quick retry — 400ms, 800ms (also jittered).
        const baseDelay = isRateLimit
          ? 2000 // 2s base; the gate (set below if this also 429s) does the long wait
          : 400 * attempt; // 400ms, 800ms
        // Best-effort Retry-After: if the SDK surfaces response headers,
        // honour the server's hint (capped at the in-call ceiling, not the
        // gate ceiling — the gate's own escalation is separate).
        const errAny = err as unknown as {
          headers?: Record<string, string>;
          response?: { headers?: Record<string, string> };
        };
        const retryAfterHeader =
          errAny?.headers?.["retry-after"] ??
          errAny?.response?.headers?.["retry-after"];
        let delay: number;
        if (retryAfterHeader) {
          const secs = Number(retryAfterHeader);
          if (Number.isFinite(secs) && secs > 0 && secs <= 10) {
            delay = secs * 1000;
          } else {
            delay = baseDelay * (0.8 + Math.random() * 0.4);
          }
        } else {
          delay = baseDelay * (0.8 + Math.random() * 0.4); // ±20% jitter
        }
        if (opts.onRetry) {
          opts.onRetry({
            attempt,
            maxAttempts,
            isRateLimit,
            delayMs: delay,
            error: lastError ?? "unknown error",
          });
        }
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  // In-call retries exhausted. If the failure was a 429, set the gate so
  // all callers (this one included, on its next invocation) defer
  // immediately. Escalating cooldown: 2min, 5min, 15min, 30min (±20% jitter).
  if (sawRateLimit) {
    const gs = gateState();
    const cooldown = COOLDOWNS_MS[Math.min(gs.strikes, 3)] * (0.8 + Math.random() * 0.4);
    gs.blockedUntil = Date.now() + cooldown;
    gs.strikes++; // post-increment: first 429 → 2min, second → 5min, etc.
  }

  return {
    ok: false,
    content: "",
    error: lastError ?? "LLM unavailable",
    rateLimited: sawRateLimit,
    attempts: maxAttempts,
    latencyMs: Math.round(performance.now() - started),
    fallbackFrom: combinedFallback,
  };
}

/**
 * Strip an LLM response down to just the code block. Handles ```lang\n...\n```
 * fences as well as raw code. If the model adds commentary before/after the
 * code, this isolates the FIRST fenced block (the code the model leads with
 * is the answer; later fences are usually illustrative examples or repeats).
 * If there are no fences, returns the trimmed original.
 */
export function extractCodeBlock(raw: string): string {
  if (!raw) return "";
  const fenceMatch = raw.match(/```(?:[a-zA-Z0-9_+-]*)?\n([\s\S]*?)```/);
  if (fenceMatch && fenceMatch[1]) {
    return fenceMatch[1].trim();
  }
  // No fence — assume the whole response is code (after stripping common commentary)
  return raw.trim();
}

/**
 * Extract BOTH the summary (text before the code block) AND the code block
 * from an LLM response. Used when the prompt asks the LLM to explain what it
 * changed before showing the code. Returns { summary, code }.
 */
export function extractSummaryAndCode(raw: string): { summary: string; code: string } {
  if (!raw) return { summary: "", code: "" };
  const fenceMatch = raw.match(/```(?:[a-zA-Z0-9_+-]*)?\n([\s\S]*?)```/);
  if (fenceMatch && fenceMatch[1]) {
    const code = fenceMatch[1].trim();
    // Everything before the opening fence is the summary
    const fenceStart = raw.indexOf("```");
    const summary = fenceStart > 0 ? raw.slice(0, fenceStart).trim() : "";
    return { summary, code };
  }
  // No fence — whole response is code, no summary
  return { summary: "", code: raw.trim() };
}
