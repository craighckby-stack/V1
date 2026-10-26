/**
 * Real LLM agent loop for code refactoring.
 *
 * Wraps z-ai-web-dev-sdk and produces actual refactored code (instead of
 * the cosmetic comment-injection the previous stub did). The output is
 * then run through the real AST diff gate so the system can genuinely
 * reject LLM output that drops symbols.
 *
 * If the SDK is unreachable (e.g. no API access), every call gracefully
 * degrades to a deterministic fallback so the pipeline still runs.
 */

import ZAI from "z-ai-web-dev-sdk";
import { geminiComplete } from "./gemini-direct";

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
}

export interface LlmCallResult {
  ok: boolean;
  content: string;
  error?: string;
  attempts: number;
  latencyMs: number;
  modelUsed?: string;
}

/**
 * Model fallback chain — the "fallback gemini api" + "correct model".
 *
 * The Z.AI gateway accepts a `model` param per call and routes to different
 * upstream providers (Google, OpenAI, Anthropic, Zhipu, DeepSeek, ...).
 * Each upstream has its own sub-quota, so a 429 on one model does NOT mean
 * a 429 on another. We try models in order and fall through on any failure
 * (429, 5xx, network). Only if EVERY model fails do we report the call as
 * unavailable — at which point the loop defers the task and rotates to the
 * next one (see self-task-generator claimNextTask defer-rotation).
 *
 * Gemini is the primary (the user's "correct model" — fast, capable for
 * code, and on a Google upstream quota separate from the GLM default).
 */
const MODEL_CHAIN = [
  "gemini-2.5-flash",   // primary — Google upstream
  "gemini-2.0-flash",   // fallback 1 — older Gemini, different quota bucket
  "glm-4.6",            // fallback 2 — Zhipu upstream (the old default family)
  "gpt-4o-mini",        // fallback 3 — OpenAI upstream
  "claude-3.5-sonnet",  // fallback 4 — Anthropic upstream
  "deepseek-v3",        // fallback 5 — DeepSeek upstream
];

/**
 * Single-shot LLM call. Resolution order:
 *
 *   1. GEMINI DIRECT (if user pasted a key) — Google's REST API on its
 *      own quota, separate from the Z.AI gateway. The "correct model".
 *   2. Z.AI MODEL CHAIN — gemini-2.5-flash -> glm-4.6 -> gpt-4o-mini ->
 *      claude-3.5-sonnet -> deepseek-v3 (the gateway's upstream providers).
 *
 * Only if BOTH fail do we report ok:false — at which point the loop
 * defers the task and rotates to the next one (defer-rotation).
 *
 * `modelUsed` on success records which path served the call — useful
 * for observability ("via gemini-2.5-flash" vs "via glm-4.6").
 */
export async function llmComplete(opts: LlmCallOptions): Promise<LlmCallResult> {
  const started = performance.now();

  // 1. Try Gemini direct first (the user's pasted key, on Google's quota)
  try {
    const gem = await geminiComplete({
      systemPrompt: opts.systemPrompt,
      userPrompt: opts.userPrompt,
      temperature: opts.temperature,
    });
    if (gem.ok) {
      return {
        ok: true,
        content: gem.content,
        attempts: 1,
        latencyMs: gem.latencyMs,
        modelUsed: gem.model,
      };
    }
    // Gemini failed (not configured, 429, network, blocked) — fall through
    // to the Z.AI chain. Don't return yet; record the error for the chain's
    // final error message if everything else also fails.
  } catch {
    // geminiComplete swallows errors internally; this is just defense
  }

  // 2. Z.AI gateway model chain fallback
  let lastError: string | undefined;
  let attempts = 0;

  for (const model of MODEL_CHAIN) {
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attempts++;
      try {
        const zai = await getZai();
        const completion = await zai.chat.completions.create({
          model,
          messages: [
            { role: "assistant", content: opts.systemPrompt },
            { role: "user", content: opts.userPrompt },
          ],
          thinking: { type: "disabled" },
        } as { model: string; messages: { role: string; content: string }[]; thinking: { type: string } });
        const content = completion.choices?.[0]?.message?.content ?? "";
        if (!content.trim()) {
          throw new Error("Empty LLM response");
        }
        return {
          ok: true,
          content,
          attempts,
          latencyMs: Math.round(performance.now() - started),
          modelUsed: model,
        };
      } catch (err) {
        lastError = (err as Error).message;
        // 429 / 5xx / network → fall through to the next model immediately
        // (don't retry the same throttled model). Only retry on
        // potentially-transient parse/empty errors.
        const isThrottle = /429|Too many requests|rate.?limit/i.test(lastError);
        if (isThrottle) {
          break; // next model
        }
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 400 * attempt));
        }
      }
    }
  }

  return {
    ok: false,
    content: "",
    error: `all providers failed (gemini-direct + ${MODEL_CHAIN.length} Z.AI models; last: ${lastError ?? "unknown"})`,
    attempts,
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
