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

let zaiPromise: Promise<ZAIType> | null = null;

async function getZai(): Promise<ZAIType> {
  if (!zaiPromise) {
    zaiPromise = ZAI.create().catch((err) => {
      zaiPromise = null;
      throw err;
    });
  }
  return zaiPromise;
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
  /** Which model actually served the call (from the API response —
   *  honest provenance for the task engine's records; undefined only
   *  if the provider omits the field). */
  modelUsed?: string;
}

/**
 * Single-shot LLM call with bounded retry.
 * Returns `ok: false` when the SDK is unavailable; callers must surface
 * that honestly (skip the stage / block the write) — never fabricate output.
 */
export async function llmComplete(opts: LlmCallOptions): Promise<LlmCallResult> {
  const started = performance.now();
  let lastError: string | undefined;
  // More attempts for rate-limited (429) responses so we can back off
  // properly instead of giving up after 2 quick tries.
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const zai = await getZai();
      const completion = await zai.chat.completions.create({
        messages: [
          { role: "assistant", content: opts.systemPrompt },
          { role: "user", content: opts.userPrompt },
        ],
        thinking: { type: "disabled" },
      });
      const content = completion.choices?.[0]?.message?.content ?? "";
      if (!content.trim()) {
        throw new Error("Empty LLM response");
      }
      return {
        ok: true,
        content,
        attempts: attempt,
        latencyMs: Math.round(performance.now() - started),
        modelUsed: (completion as { model?: string }).model,
      };
    } catch (err) {
      lastError = (err as Error).message;
      const isRateLimit = /429|Too many requests|rate limit/i.test(lastError);

      if (attempt < maxAttempts) {
        // For 429s: exponential backoff — 10s, 20s, 40s, 80s
        // For other errors: quick retry — 400ms, 800ms
        const delay = isRateLimit
          ? 10000 * Math.pow(2, attempt - 1) // 10s, 20s, 40s, 80s
          : 400 * attempt; // 400ms, 800ms, 1200ms, 1600ms
        // Surface the retry to the caller before the backoff sleep —
        // without this, the live view goes silent for the whole ~150s
        // 429 backoff window and the user can't tell if the system is
        // working or stuck.
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

  return {
    ok: false,
    content: "",
    error: lastError ?? "LLM unavailable",
    attempts: maxAttempts,
    latencyMs: Math.round(performance.now() - started),
  };
}

/**
 * Strip an LLM response down to just the code block. Handles ```lang\n...\n```
 * fences as well as raw code. If the model adds commentary before/after the
 * code, this isolates the largest fenced block. If there are no fences,
 * returns the trimmed original.
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

const REFRACTOR_SYSTEM_PROMPT = `You are an expert code refactorer operating inside an autonomous pipeline. Your output will be committed to a GitHub branch by an automated system.

HARD RULES (violating any rule fails the pipeline):
1. Preserve EVERY top-level exported symbol (function, class, interface, type, const). Do not rename them. Do not merge them. Do not delete them.
2. Do NOT introduce any of these persona/branding strings: "dalek caan", "omega engine", "cognitive dominance", "grog engine", "recursive evolution loop", "nexus neural network".
3. Do NOT add credentials, API keys, tokens, or PII.
4. Do NOT use eval() or new Function().
5. Keep the same programming language as the input.

WHAT TO DO:
- Add explicit type annotations where TypeScript would infer them.
- Tighten parameter types (e.g. string -> specific string-literal unions where appropriate).
- Extract magic numbers into named constants.
- Replace any/some unsafe casts with safer alternatives where possible.
- Add a short JSDoc comment to any previously undocumented public function.
- Apply small modularization (extract pure helpers) WITHOUT changing public API.
- Preserve the original semantic behavior exactly.

OUTPUT FORMAT (mandatory):
- Output ONLY the refactored code inside a single fenced code block.
- Do NOT add commentary before or after the code block.
- Do NOT include any markdown other than the fence.`;

/**
 * Run the LLM refactorer on a piece of code. Returns the proposed evolved
 * code (already extracted from the LLM's response). On failure, returns
 * null and the caller should fall back to a deterministic transformation.
 */
export async function llmRefactorCode(params: {
  filePath: string;
  code: string;
  userPrompt: string;
  patternLabel: string;
}): Promise<{ ok: boolean; code: string; raw?: string; error?: string; latencyMs: number }> {
  const lang = params.filePath.toLowerCase().split(".").pop() || "ts";
  const userPrompt = `Repository file: ${params.filePath}
Pattern source: ${params.patternLabel}
User intent: ${params.userPrompt}

Refactor the following code. Output ONLY the refactored code in a single \`\`\`${lang} fenced block. Preserve every public symbol name exactly.

\`\`\`${lang}
${params.code}
\`\`\``;

  const result = await llmComplete({
    systemPrompt: REFRACTOR_SYSTEM_PROMPT,
    userPrompt,
    temperature: 0.2,
  });

  if (!result.ok) {
    return { ok: false, code: "", error: result.error, latencyMs: result.latencyMs };
  }
  const code = extractCodeBlock(result.content);
  if (!code) {
    return {
      ok: false,
      code: "",
      error: "LLM returned no extractable code block",
      latencyMs: result.latencyMs,
    };
  }
  return {
    ok: true,
    code,
    raw: result.content,
    latencyMs: result.latencyMs,
  };
}
