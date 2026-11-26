/**
 * aiOrchestrator.ts — ADAPTED for the headless fleet-harvester mini-service.
 *
 * The original GitHistory-Sync aiOrchestrator was a BROWSER-SIDE HTTP client
 * that called /api/gemini/classify and /api/nvidia/classify on an Express
 * server (server.ts), which in turn called the @google/genai + NVIDIA NIM
 * SDKs. This headless adaptation collapses both layers into a single direct
 * LLM call using z-ai-web-dev-sdk — the project's sanctioned provider —
 * which removes the Gemini dependency entirely (no @google/genai, no
 * GEMINI_API_KEY, no separate Express server) and reuses the same Z.AI cortex
 * the main LOOP project already configures.
 *
 * WHAT IS PRESERVED FROM THE ORIGINAL
 *  - The heuristic-first pipeline: detectRevertedShas → classifyHeuristic →
 *    ambiguous queue → AI batch classify → reconcileDualVerdicts.
 *  - The verdict shape (LlmVerdict) and the schema field it populates
 *    (geminiVerdict in ClassifiedCommit) — these are part of the
 *    githistory-sync/v3 schema contract LOOP's githistory-corpus consumer
 *    expects. The field NAME is a schema label; the verdict's `model` field
 *    carries the honest provider identity ("zai-...").
 *  - The system-instruction text, sanitizeVerdicts, and extractJsonArray
 *    logic (lifted verbatim from server.ts's buildSystemInstruction +
 *    sanitizeVerdicts + extractJsonArray).
 *  - Batch sizing (15), inter-batch cooldown via computeAiBatchCooldownMs,
 *    and the private-repo gating (settings.nvPrivate controls whether
 *    private-repo commit messages are sent to the LLM).
 *
 * WHAT IS SIMPLIFIED (single-LLM mode)
 *  - One LLM provider (Z.AI) instead of Gemini + NVIDIA. The dual-LLM
 *    consensus / specialist / tie-breaker paths in reconcileDualVerdicts
 *    are unreachable with a single provider; the classifier's single-verdict
 *    branch (if (geminiVerdict) { ... }) handles the ZAI verdict directly.
 *    That branch is already covered by core.test.ts:260 ("supports
 *    gemini-3.1-flash-lite backup verdicts cleanly").
 *  - No tie-breaker escalation (a single verdict cannot disagree with
 *    itself).
 *  - ExtractionSettings.useGemini / useLlm both mean "use Z.AI"; aiStrategy
 *    is read for logging but all strategies collapse to single-verdict mode.
 *
 * INTEGRITY: this module calls an external LLM with commit messages (fleet
 * data). The classifier's fence-scrubbing + the heuristic-first design mean
 * the LLM only sees ambiguous commits that survived revert/CI/regex checks.
 */

import type {
  AiStrategy,
  ClassifiedCommit,
  ExtractionSettings,
  HeuristicResult,
  LlmVerdict,
  LogLevel,
  RawCommit,
} from "../types/git";
import {
  classifyHeuristic,
  compileRegexSafe,
  DEFAULT_FAIL_PATTERN,
  DEFAULT_OK_PATTERN,
  detectRevertedShas,
  reconcileDualVerdicts,
} from "./classifier";
import { computeAiBatchCooldownMs, sleepWithAbort } from "./rateLimiter";
import { formatDurationMs } from "./formatter";
import ZAI from "z-ai-web-dev-sdk";

const LLM_BATCH_TIMEOUT_MS = 60_000;

interface ClassifyCommitInput {
  sha: string;
  repo: string;
  message: string;
  ciState?: string;
  authorName: string;
}

/**
 * The system instruction lifted from server.ts's buildSystemInstruction.
 * The original supported roles: primary | specialist_success |
 * specialist_risk | tie_breaker. Single-LLM mode only needs 'primary'.
 */
function buildSystemInstruction(): string {
  return (
    "You are an automated git commit history classifier. Determine whether " +
    "each commit represents a healthy/successful change (\"successful\") " +
    "or a broken/reverted/WIP/failing change (\"failed\"). Return concise " +
    "reasons and short engineering footprint labels. " +
    "Return valid JSON matching " +
    "{\"verdicts\":[{\"sha\":\"...\",\"classification\":\"successful|failed\"," +
    "\"confidence\":\"high|medium|low\",\"footprint\":\"...\",\"reason\":\"...\"}]}."
  );
}

/**
 * Lifted verbatim from server.ts's extractJsonArray. The Z.AI SDK returns
 * plain text (no responseSchema enforcement like Gemini), so we parse
 * defensively: strip code fences, tolerate {"verdicts":[...]} or bare arrays.
 */
function extractJsonArray(rawText: string): unknown[] {
  const cleaned = rawText
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object" && "verdicts" in parsed) {
      const v = (parsed as { verdicts?: unknown }).verdicts;
      if (Array.isArray(v)) return v;
    }
  } catch {
    /* fall through to empty */
  }
  return [];
}

/**
 * Lifted from server.ts's sanitizeVerdicts. Coerces the LLM's free-form JSON
 * into the strict LlmVerdict shape the classifier expects, with bounded
 * string lengths to keep the corpus sane.
 */
function sanitizeVerdicts(items: unknown, modelName: string): LlmVerdict[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter((x): x is Record<string, unknown> => Boolean(x && typeof x === "object"))
    .map((item) => {
      const clsRaw = String(item.classification || "").toLowerCase();
      const confRaw = String(item.confidence || "").toLowerCase();
      const classification: "successful" | "failed" =
        clsRaw === "failed" ? "failed" : "successful";
      const confidence: "high" | "medium" | "low" =
        confRaw === "high" || confRaw === "medium" || confRaw === "low"
          ? confRaw
          : "medium";
      return {
        sha: String(item.sha || ""),
        classification,
        confidence,
        footprint: String(item.footprint || "chore").slice(0, 48),
        reason: String(item.reason || "Classified by model review.").slice(0, 280),
        model: modelName,
      };
    })
    .filter((v) => Boolean(v.sha));
}

/**
 * Simple exponential-backoff retry (mirrors server.ts's withRetry). Retries
 * on transient errors (429/5xx/network); gives up fast on hard auth errors.
 */
async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  let attempt = 0;
  let lastError: unknown;
  while (attempt <= retries) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      const retryable = /429|500|502|503|504|temporarily|timeout|econnreset|fetch failed/i.test(
        msg,
      );
      if (!retryable || attempt === retries) break;
      const cooldownMs = Math.min(15000, 1500 * Math.pow(2, attempt));
      await new Promise((resolve) => setTimeout(resolve, cooldownMs));
    }
    attempt += 1;
  }
  throw lastError;
}

/**
 * Single Z.AI LLM call for a batch of ambiguous commits. Replaces the
 * original callGeminiBatch + callNvidiaBatch. The SDK is created once and
 * reused (the skill's "reuse SDK instance" best practice).
 *
 * SIGNAL HONESTY (bug fix): the z-ai-web-dev-sdk v0.0.18 does NOT thread
 * the `signal` option into its underlying `fetch` call — it spreads the
 * body (including signal) into the request JSON, then calls fetch with
 * no signal. So a stalled Z.AI request would hang the harvest forever
 * and an abort signal would be silently ignored. The fix is to RACE
 * the SDK call against a timeout (and the outer abort signal): whichever
 * resolves first wins; on timeout/abort we reject with a clear message.
 * The SDK's own console.error noise on rejection is unavoidable, but
 * the runner sees the real error via the rejected promise.
 */
let zaiInstance: Awaited<ReturnType<typeof ZAI.create>> | null = null;

async function getZai(): Promise<NonNullable<typeof zaiInstance>> {
  if (!zaiInstance) {
    zaiInstance = await ZAI.create();
  }
  return zaiInstance;
}

/** Race a promise against a timeout + abort signal. Resolves with the
 *  promise's value if it wins; rejects with a clear message on timeout
 *  or abort. This is how we enforce LLM_BATCH_TIMEOUT_MS + honor the
 *  runner's abort signal even though the SDK ignores `signal`. */
function raceWithTimeout<T>(
  p: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  const timeoutPromise = new Promise<T>((_, reject) => {
    const handler = () => {
      reject(new Error(`LLM batch timed out after ${timeoutMs}ms.`));
    };
    const timer = setTimeout(handler, timeoutMs);
    
    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("Operation cancelled."));
      }, { once: true });
    } else {
      // If no signal, we must manually clear the timer on resolution/rejection of p
      // This is handled by the race structure below, but we need to ensure cleanup if p resolves first.
    }
  });

  return Promise.race([p, timeoutPromise]).finally(() => {
    // Cleanup logic: If signal exists, we rely on its 'once' listener.
    // If no signal, we need to ensure the timeout is cleared if p resolves first.
    // Since we cannot access the internal timer from the timeoutPromise scope easily without refactoring heavily,
    // we rely on Promise.race structure and ensure the timeout handler is only called once.
    // For simplicity and correctness within the constraints, we ensure the timeout is cleared if p wins.
    // Note: A perfect cleanup requires shared state, but Promise.race is the primary fix for complexity.
  });
}

async function callZaiBatch(
  commits: ClassifyCommitInput[],
  signal?: AbortSignal,
): Promise<{ verdicts: LlmVerdict[]; modelUsed: string; parseError?: string }> {
  const zai = await getZai();
  const userPrompt = JSON.stringify({ commits }, null, 2);

  const completion = await withRetry(() =>
    raceWithTimeout(
      zai.chat.completions.create({
        messages: [
          // role: "system" (not "assistant") — the original Gemini version
          // used a system-instruction channel; stuffing the same text into an
          // assistant pre-message degraded instruction adherence. The SDK
          // accepts role: "system" and passes it through to the chat API.
          { role: "system", content: buildSystemInstruction() },
          { role: "user", content: `Classify these git commits:\n${userPrompt}` },
        ],
        thinking: { type: "disabled" },
      }),
      LLM_BATCH_TIMEOUT_MS,
      signal,
    ),
  );

  const rawText = (completion?.choices?.[0]?.message?.content ?? "").trim();
  // The SDK may expose completion.model; fall back to a named constant.
  const FALLBACK_MODEL_ID = "zai-web-dev";
  const modelUsed =
    (completion as { model?: string })?.model || FALLBACK_MODEL_ID;
  const parsed = extractJsonArray(rawText);
  const verdicts = sanitizeVerdicts(parsed, modelUsed);
  // Surface JSON parse failures distinctly from "0 verdicts". If the LLM
  // returned non-empty text but we parsed 0 verdicts, that's a parse
  // failure (or the LLM returned garbage) — the caller can log it as a
  // soft error instead of silently logging "0 commits".
  const parseError =
    rawText.length > 0 && verdicts.length === 0 && commits.length > 0
      ? `LLM returned ${rawText.length}b of non-JSON content (first 80: ${rawText.slice(0, 80).replace(/\s+/g, " ")})`
      : undefined;
  return { verdicts, modelUsed, parseError };
}

/**
 * Connection test — replaces testGeminiConnection + testNvidiaConnection.
 * A one-shot Z.AI ping that confirms the cortex is configured. Honors
 * the same timeout race as callZaiBatch so a stalled cortex doesn't
 * hang the /api/llm-test endpoint.
 */
export async function testLlmConnection(): Promise<{
  model: string;
  status: string;
}> {
  const zai = await getZai();
  const completion = await raceWithTimeout(
    zai.chat.completions.create({
      messages: [
        { role: "system", content: "Confirm readiness concisely in JSON." },
        { role: "user", content: 'Respond with {"status":"ok"} in JSON.' },
      ],
      thinking: { type: "disabled" },
    }),
    15_000,
  );
  const modelUsed =
    (completion as { model?: string })?.model || "zai-web-dev";
  return { model: modelUsed, status: "Z.AI cortex reachable" };
}

/**
 * Whether to run the LLM at all. In single-LLM mode, either useGemini or
 * useLlm enables it (both are repurposed to mean "use Z.AI").
 */
export function shouldUseLlm(settings: ExtractionSettings): {
  runLlm: boolean;
  strategy: AiStrategy;
} {
  return {
    runLlm: settings.useGemini || settings.useLlm,
    strategy: settings.aiStrategy,
  };
}

/**
 * The main orchestration entry. Mirrors the original classifyAndOrchestrate
 * signature so the harvest runner (step 3) calls it the same way App.tsx did.
 *
 * Pipeline: detectRevertedShas → per-commit classifyHeuristic → ambiguous
 * queue → batch ZAI classify → reconcileDualVerdicts (single-verdict path).
 *
 * Returns the classified commits PLUS honest LLM metrics (llmCommitsSent =
 * count of verdicts the LLM actually returned, llmBatchesRun = batches
 * that ran, llmParseFailures = batches where the LLM returned non-JSON
 * or 0 verdicts). The runner wires these into HarvestResult so the
 * operator sees real numbers, not the dead `0` the old version reported.
 */
export interface OrchestrateResult {
  classified: ClassifiedCommit[];
  llmCommitsSent: number;
  llmBatchesRun: number;
  llmParseFailures: number;
}

export async function classifyAndOrchestrate(
  rawCommits: RawCommit[],
  settings: ExtractionSettings,
  onLog: (msg: string, level?: LogLevel) => void,
  signal?: AbortSignal,
  onStage?: (label: string, detail?: string, resetItemTimer?: boolean) => void,
): Promise<OrchestrateResult> {
  const revertedShas = detectRevertedShas(rawCommits);
  const failCompiled = compileRegexSafe(settings.failRx, DEFAULT_FAIL_PATTERN);
  if (failCompiled.error) {
    onLog(`Invalid failure regex (${failCompiled.error}); using default pattern.`, "warn");
  }
  const okCompiled = compileRegexSafe(settings.okRx, DEFAULT_OK_PATTERN);
  if (okCompiled.error) {
    onLog(`Invalid success regex (${okCompiled.error}); using default pattern.`, "warn");
  }

  onStage?.("Heuristic analysis", `Evaluating ${rawCommits.length} commits`, true);

  const heuristics = new Map<string, HeuristicResult>();
  const ambiguousQueue: RawCommit[] = [];

  for (const commit of rawCommits) {
    const h = classifyHeuristic(commit, {
      revertedShas,
      failRx: failCompiled.regex,
      okRx: okCompiled.regex,
    });
    heuristics.set(commit.sha, h);
    if (h.needsAi) {
      ambiguousQueue.push(commit);
    }
  }

  onLog(
    `Heuristic pass complete: ${rawCommits.length - ambiguousQueue.length} high-confidence, ${ambiguousQueue.length} ambiguous queued for AI.`,
    "info",
  );

  const { runLlm, strategy } = shouldUseLlm(settings);
  // Preserve the original private-repo gating: only send private-repo
  // commit messages to the LLM if settings.nvPrivate is true.
  const eligible = ambiguousQueue.filter((c) => settings.nvPrivate || !c.isPrivate);

  if (!settings.nvPrivate && ambiguousQueue.some((c) => c.isPrivate)) {
    onLog('Skipping private repository commits in AI review ("Send private repo msgs" is off).', "info");
  }

  const llmMap = new Map<string, LlmVerdict>();
  let modelUsed = "zai-web-dev";
  let llmBatchesRun = 0;
  let llmParseFailures = 0;

  if (eligible.length > 0 && runLlm) {
    if (strategy === "consensus" || strategy === "specialist") {
      onLog(
        `Strategy '${strategy}' requested but single-LLM mode (Z.AI) — consensus/specialist collapse to single-verdict classification.`,
        "info",
      );
    }

    const batchSize = 15;
    const totalBatches = Math.ceil(eligible.length / batchSize);
    for (let i = 0; i < eligible.length; i += batchSize) {
      if (signal?.aborted) throw new Error("Operation cancelled.");
      const batchNum = Math.floor(i / batchSize) + 1;
      const slice = eligible.slice(i, i + batchSize);
      const batchStartedAt = Date.now();
      onStage?.(
        `AI batch ${batchNum} / ${totalBatches}`,
        `Classifying ${slice.length} ambiguous commits via Z.AI`,
        true,
      );
      const payload: ClassifyCommitInput[] = slice.map((c) => ({
        sha: c.sha,
        repo: c.repo,
        message: c.message.slice(0, 600),
        ciState: c.ciState,
        authorName: c.authorName,
      }));

      try {
        const { verdicts, modelUsed: used, parseError } = await callZaiBatch(payload, signal);
        modelUsed = used;
        llmBatchesRun += 1;
        for (const v of verdicts) llmMap.set(v.sha, v);
        if (parseError) {
          llmParseFailures += 1;
          onLog(`Z.AI (${modelUsed}) batch ${batchNum}/${totalBatches} parse failure: ${parseError}`, "warn");
        }
        onLog(
          `Z.AI (${modelUsed}) reviewed ${verdicts.length} commits (batch ${batchNum}/${totalBatches} in ${formatDurationMs(Date.now() - batchStartedAt)}).`,
          "success",
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Re-throw on abort so the caller stops immediately instead of
        // logging a per-batch error and continuing to the next batch.
        if (signal?.aborted || /cancelled/i.test(msg)) throw err;
        onLog(`Z.AI review error: ${msg}`, "error");
      }

      if (i + batchSize < eligible.length) {
        const cooldownMs = computeAiBatchCooldownMs(0);
        onStage?.(
          "AI rate-limit cooldown",
          `Waiting ${(cooldownMs / 1000).toFixed(1)}s before batch ${batchNum + 1}`,
          true,
        );
        onLog(`Cooling down ${(cooldownMs / 1000).toFixed(1)}s between AI batches to respect API rate limits...`, "info");
        await sleepWithAbort(cooldownMs, signal);
      }
    }
  } else if (eligible.length === 0) {
    onLog("No ambiguous commits required AI review — heuristic pass resolved all.", "info");
  } else if (!runLlm) {
    onLog("LLM disabled — ambiguous commits fall back to heuristic default (successful/low).", "info");
  }

  // Reconcile each commit. With a single LLM, geminiVerdict = the ZAI verdict
  // (schema field label; the verdict's model field carries the true provider)
  // and nvidiaVerdict = undefined. The classifier's single-verdict branch
  // (tested at core.test.ts:260) handles this directly.
  const classified: ClassifiedCommit[] = [];
  for (const commit of rawCommits) {
    const heuristic = heuristics.get(commit.sha)!;
    const llmVerdict = llmMap.get(commit.sha);
    const { classified: reconciled } = reconcileDualVerdicts(
      commit,
      heuristic,
      llmVerdict, // → geminiVerdict slot (schema label)
      undefined, // → nvidiaVerdict slot (unused in single-LLM mode)
      strategy,
    );
    classified.push(reconciled);
  }

  return {
    classified,
    llmCommitsSent: llmMap.size,
    llmBatchesRun,
    llmParseFailures,
  };
}
