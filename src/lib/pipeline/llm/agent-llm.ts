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
    };
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

export interface LlmCallOptions {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
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

  // Fix A: gate check. If a previous call (in this process, by any caller)
  // set the gate, return immediately — no in-call retries, no backoff sleep.
  // The caller sees rateLimited:true and defers. This is what stops the
  // ~150s-per-file 429 backoff spiral: instead of each call site doing its
  // own 5× retry, the FIRST 429 sets a 2min gate and all subsequent calls
  // (ratchet, enhance, debate, chat-task) return instantly.
  const cooldownMs = llmCooldownMs();
  if (cooldownMs > 0) {
    return {
      ok: false,
      content: "",
      error: `429 cooldown active — ${Math.round(cooldownMs / 1000)}s remaining`,
      rateLimited: true,
      attempts: 0,
      latencyMs: Math.round(performance.now() - started),
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
          { role: "assistant", content: opts.systemPrompt },
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
      const completion = await zai.chat.completions.create(createParams);
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
      };
    } catch (err) {
      lastError = (err as Error).message;
      const isRateLimit = /\b429\b|too many requests|rate.?limit/i.test(lastError);
      if (isRateLimit) sawRateLimit = true;

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
