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
import type { ZAI as ZAIType } from "z-ai-web-dev-sdk";

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
}

/**
 * Single-shot LLM call with retry + graceful degradation.
 * Returns `ok: false` when the SDK is unavailable; callers must handle
 * this by falling back to a deterministic alternative.
 */
export async function llmComplete(opts: LlmCallOptions): Promise<LlmCallResult> {
  const started = performance.now();
  let lastError: string | undefined;
  const maxAttempts = 2;

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
      };
    } catch (err) {
      lastError = (err as Error).message;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 400 * attempt));
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
