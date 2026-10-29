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
 */

import { db } from "@/lib/db";

const SINGLETON_ID = "singleton";

// Geo-bypass proxy base URL (opt-in via .env). When set, geminiComplete
// replaces the hardcoded Google host with this value. The rest of the
// URL construction is unchanged — the proxy is a transparent reverse
// proxy that injects the real key on its side.
const PROXY_BASE_URL = process.env.GEMINI_PROXY_BASE_URL?.replace(/\/$/, "") ?? null;
const GEMINI_BASE = PROXY_BASE_URL ?? "https://generativelanguage.googleapis.com";

// In-memory cooldown for location-blocked keys. When Google returns
// FAILED_PRECONDITION "location is not supported", we set this to
// Date.now() + 10min so the loop short-circuits Gemini calls instead of
// burning a request per task per cycle while the sandbox is geo-blocked.
// Resets on server restart (acceptable — a restart is also when the
// network egress might change).
let LOCATION_BLOCKED_UNTIL = 0;
const LOCATION_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

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
}

/**
 * Call Google's Gemini REST API directly. Returns the text from the first
 * candidate. On any failure (429, 5xx, network, malformed response), returns
 * ok:false so the caller can fall through to the Z.AI chain.
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
    return { ok: false, content: "", error: "Gemini not configured", latencyMs: 0, model: "" };
  }

  // SHORT-CIRCUIT for location-blocked keys: if the last call failed with a
  // location/region error, don't hammer Google again every cycle — it will
  // keep failing the same way until the network egress changes. Cool down
  // for 10 minutes before retrying. This stops the loop burning a Google
  // request per task per cycle when the sandbox is in an unsupported region.
  // The cooldown is in-memory (resets on server restart) — cheap and correct.
  if (
    LOCATION_BLOCKED_UNTIL > Date.now()
  ) {
    return {
      ok: false,
      content: "",
      error: "Gemini location-blocked (cooldown — retrying later)",
      latencyMs: 0,
      model: cfg.model,
    };
  }

  const url = `${GEMINI_BASE}/v1beta/models/${cfg.model}:generateContent?key=${cfg.apiKey}`;
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
      // Detect the location-blocked error (FAILED_PRECONDITION with
      // "location is not supported") and arm the cooldown so the loop
      // short-circuits subsequent Gemini calls for 10 minutes instead of
      // re-burning the request every cycle while the sandbox is geo-blocked.
      if (/FAILED_PRECONDITION/i.test(errText) && /location/i.test(errText)) {
        LOCATION_BLOCKED_UNTIL = Date.now() + LOCATION_COOLDOWN_MS;
      }
      const friendlyError = /location/i.test(errText)
        ? (PROXY_BASE_URL
            ? `Gemini location not supported even via proxy at ${PROXY_BASE_URL} — proxy may also be in a blocked region; check /proxy/README.md`
            : `Gemini location not supported (key is valid; cool-down 10min — will work from a supported region, or set GEMINI_PROXY_BASE_URL; see /proxy/README.md)`)
        : `Gemini ${res.status}: ${errText.slice(0, 160)}`;
      // Record the error for the UI but don't fail the whole call chain
      await db.llmConfig
        .update({
          where: { id: SINGLETON_ID },
          data: { lastError: friendlyError },
        })
        .catch(() => {});
      return {
        ok: false,
        content: "",
        error: friendlyError,
        latencyMs: Math.round(performance.now() - started),
        model: cfg.model,
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
        ok: false,
        content: "",
        error: `Gemini blocked: ${json.promptFeedback.blockReason}`,
        latencyMs: Math.round(performance.now() - started),
        model: cfg.model,
      };
    }

    const content = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    if (!content.trim()) {
      return {
        ok: false,
        content: "",
        error: "Gemini returned empty content",
        latencyMs: Math.round(performance.now() - started),
        model: cfg.model,
      };
    }

    // Success — clear any stale lastError, record lastUsedAt
    await db.llmConfig
      .update({
        where: { id: SINGLETON_ID },
        data: { lastUsedAt: new Date(), lastError: null },
      })
      .catch(() => {});

    return {
      ok: true,
      content,
      latencyMs: Math.round(performance.now() - started),
      model: cfg.model,
    };
  } catch (e) {
    await db.llmConfig
      .update({
        where: { id: SINGLETON_ID },
        data: { lastError: `network: ${(e as Error).message.slice(0, 200)}` },
      })
      .catch(() => {});
    return {
      ok: false,
      content: "",
      error: `Gemini network error: ${(e as Error).message}`,
      latencyMs: Math.round(performance.now() - started),
      model: cfg.model,
    };
  }
}
