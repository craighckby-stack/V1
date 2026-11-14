"use client";

/**
 * NVIDIA Panel — operator surface for the tier-1 LLM provider.
 *
 * LOOP's LLM chain is: nvidia → gemini → z.ai. When an NVIDIA key is
 * configured, every llmComplete call tries NVIDIA's free hosted NIM
 * catalog FIRST — no geo-block from the HK sandbox, ~1.7s tribunal /
 * 14s refactor on Bolt, $0 rate-limit-only free tier. Only on any
 * NVIDIA failure does the call fall through to Gemini, then Z.AI.
 *
 * This panel:
 *   - Polls GET /api/self-enhance/llm-config every 5s while open
 *     (NVIDIA status, model id, last error, circuit breakers). The
 *     key itself is NEVER returned by the API.
 *   - [SAVE & VERIFY] POSTs { kind:"nvidia", nvidiaApiKey, model }:
 *     the route calls NIM with a 3-token "say OK" probe. 429 (quota
 *     cooling) and 410 (model EOL — pick a new model id) are saved
 *     with warnings so the operator knows the key state precisely.
 *   - [CLEAR] DELETEs { kind:"nvidia" } (confirms first; the Gemini
 *     key is untouched).
 *
 * Why a separate panel: the existing Gemini panel is already ~440
 * lines and concerns itself with the geo-block cooldown / proxy
 * state. The NVIDIA leg has NONE of those concerns (no geo-block
 * from HK), so a separate panel keeps each provider's surface
 * focused. The header bar shows both [NVIDIA] and [GEMINI] buttons.
 *
 * Style: matches the existing terminal aesthetic.
 */

import { useCallback, useEffect, useRef, useState } from "react";

const PROMPT_COLOR = "#e0e0e0";
const DIM_COLOR = "#777777";
const ERROR_COLOR = "#ff4444";
const WARN_COLOR = "#ffaa33";
const OK_COLOR = "#7ee787";

const btnStyle: React.CSSProperties = {
  background: "#000",
  border: `1px solid ${DIM_COLOR}`,
  color: PROMPT_COLOR,
  fontFamily: "inherit",
  fontSize: "inherit",
  padding: "4px 10px",
  cursor: "pointer",
};

const inputStyle: React.CSSProperties = {
  flex: 1,
  background: "#000",
  border: `1px solid ${DIM_COLOR}`,
  color: PROMPT_COLOR,
  fontFamily: "inherit",
  fontSize: "inherit",
  padding: "4px 8px",
  outline: "none",
  minWidth: 0,
};

interface NvidiaHealth {
  breakers: Record<string, number>;
  disabled?: boolean;
}

interface NvidiaConfigView {
  configured: boolean;
  model?: string;
  lastUsedAt?: string | null;
  lastError?: string | null;
  health?: NvidiaHealth;
}

interface LlmConfigView {
  configured: boolean;
  providerOrder?: string;
  nvidia?: NvidiaConfigView;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

// The tested-fastest free-catalog model (1.7s tribunal / 14s refactor
// in real LOOP testing). The other options are working alternatives
// discovered during the catalog probe — slower but viable as
// fallbacks if Bolt rotates out.
const MODEL_OPTIONS = [
  "nvidia/nemotron-3.5-bolt-e4b",
  "nvidia/nemotron-3.5-lightning-30b-a3b",
  "poolside/laguna-xs-2.1",
  "stepfun-ai/step-5-preview",
  "z-ai/glm-5.3-flash",
];

export function NvidiaPanel({ open, onClose }: Props) {
  const [cfg, setCfg] = useState<LlmConfigView | null>(null);
  const [nvCfg, setNvCfg] = useState<NvidiaConfigView | null>(null);
  const [key, setKey] = useState("");
  const [model, setModel] = useState(MODEL_OPTIONS[0]);
  const [showKey, setShowKey] = useState(false);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "warn" | "err"; text: string } | null>(null);
  const [nowTick, setNowTick] = useState(Date.now());
  const keyRef = useRef<HTMLInputElement>(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/self-enhance/llm-config", { cache: "no-store" });
      const data = (await res.json()) as LlmConfigView;
      setCfg(data);
      setNvCfg(data.nvidia ?? null);
      if (data.nvidia?.model && MODEL_OPTIONS.includes(data.nvidia.model)) {
        setModel(data.nvidia.model);
      }
    } catch {
      // Poll failure is non-fatal — keep the last snapshot on screen.
    }
  }, []);

  // Poll while open; tick every second so the breaker countdown animates.
  useEffect(() => {
    if (!open) return;
    void poll();
    const pollIv = setInterval(() => void poll(), 5000);
    const tickIv = setInterval(() => setNowTick(Date.now()), 1000);
    return () => {
      clearInterval(pollIv);
      clearInterval(tickIv);
    };
  }, [open, poll]);

  // Reset transient state when the panel reopens.
  useEffect(() => {
    if (open) {
      setMsg(null);
      setKey("");
      setShowKey(false);
    }
  }, [open]);

  if (!open) return null;

  const save = async () => {
    const trimmed = key.trim();
    if (!trimmed) {
      setMsg({ kind: "err", text: "Paste an NVIDIA API key first (build.nvidia.com → profile → API keys)." });
      return;
    }
    setLoading(true);
    setMsg(null);
    try {
      const res = await fetch("/api/self-enhance/llm-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "nvidia", nvidiaApiKey: trimmed, model }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        warning?: string;
        model?: string;
        verified?: boolean;
        forceSaved?: boolean;
      };
      if (!data.ok) {
        setMsg({ kind: "err", text: data.error ?? "Save failed" });
        return;
      }

      // Key saved (verified, or saved-with-warning). Now reboot the
      // self-enhancement loop so it picks up the new tier-1 provider
      // immediately. The Gemini panel does the same — both panels
      // share the same singleton LlmConfig row, so rebooting once
      // after either save covers both.
      const keyLine =
        data.warning ??
        `Key verified and saved — the loop now calls ${data.model ?? model} FIRST (NVIDIA → Gemini → Z.AI).`;
      let rebootLine = "";
      try {
        const rb = await fetch("/api/self-enhance/reboot", { method: "POST" });
        const rbData = (await rb.json()) as {
          rebooted?: boolean;
          message?: string;
          error?: string;
        };
        rebootLine = rbData.rebooted
          ? `\n\nSYSTEM REBOOTED — ${rbData.message ?? "self-enhancement loop restarted with NVIDIA as tier 1."}`
          : `\n\nReboot failed: ${rbData.error ?? "unknown error"} — the loop is NOT running. Press [START] in the console.`;
      } catch (e) {
        rebootLine = `\n\nReboot request failed: ${(e as Error).message}`;
      }

      setKey("");
      setMsg({
        kind: data.verified === false && data.warning ? "warn" : "ok",
        text: keyLine + rebootLine,
      });
      void poll();
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setLoading(false);
    }
  };

  const clear = async () => {
    if (!window.confirm("Clear the stored NVIDIA key?\n\nThe loop falls back to Gemini → Z.AI until a new NVIDIA key is saved.")) return;
    setLoading(true);
    setMsg(null);
    try {
      await fetch("/api/self-enhance/llm-config", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "nvidia" }),
      });
      setMsg({ kind: "ok", text: "NVIDIA config cleared — provider chain is Gemini → Z.AI again." });
      void poll();
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setLoading(false);
    }
  };

  const health = nvCfg?.health;
  const activeBreakers = Object.entries(health?.breakers ?? {});

  return (
    <div
      role="dialog"
      aria-label="NVIDIA panel — tier-1 LLM provider configuration"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.85)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: "16px",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#000",
          border: `1px solid ${DIM_COLOR}`,
          color: PROMPT_COLOR,
          fontFamily: "'Courier New', 'Lucida Console', monospace",
          fontSize: "13px",
          lineHeight: 1.4,
          padding: "16px",
          maxWidth: "640px",
          width: "calc(100% - 32px)",
          maxHeight: "calc(100vh - 64px)",
          overflowY: "auto",
        }}
      >
        {/* Header */}
        <div
          style={{
            borderBottom: `1px solid ${DIM_COLOR}`,
            paddingBottom: "8px",
            marginBottom: "12px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <span style={{ color: PROMPT_COLOR, fontWeight: "bold" }}>NVIDIA</span>
            <span style={{ color: DIM_COLOR, marginLeft: "8px" }}>
              — tier 1 LLM, chain: {cfg?.providerOrder ?? "nvidia → gemini → z.ai"}
            </span>
          </div>
          <button type="button" onClick={onClose} aria-label="Close the NVIDIA panel" style={btnStyle}>
            [ CLOSE ]
          </button>
        </div>

        {/* Provider chain explainer */}
        <div style={{ color: DIM_COLOR, marginBottom: "12px", fontSize: "12px", lineHeight: 1.5 }}>
          Paste an NVIDIA API key (from <span style={{ color: PROMPT_COLOR }}>build.nvidia.com</span>) and the
          loop calls the hosted NIM catalog FIRST — <span style={{ color: OK_COLOR }}>no geo-block from the
          HK sandbox</span>, ~1.7s tribunal / 14s refactor on Bolt, $0 rate-limit-only free tier. Falls through
          to Gemini → Z.AI on any NVIDIA failure. NVIDIA failures never trip the Gemini or Z.AI gates (separate
          quotas). Prompts (your source code) will be sent to NVIDIA while this is active.{" "}
          <span style={{ color: WARN_COLOR }}>Saving a verified key reboots the self-enhancement loop immediately.</span>
        </div>

        {/* NVIDIA status */}
        <div style={{ borderTop: `1px solid ${DIM_COLOR}`, paddingTop: "8px", marginBottom: "12px" }}>
          <div style={{ color: DIM_COLOR, marginBottom: "4px" }}>STATUS</div>
          <div>
            {nvCfg?.configured ? (
              <>
                configured · model <span style={{ color: OK_COLOR }}>{nvCfg.model}</span>
                {nvCfg.lastUsedAt && (
                  <span style={{ color: DIM_COLOR }}>
                    {" "}· last used {new Date(nvCfg.lastUsedAt).toLocaleTimeString()}
                  </span>
                )}
              </>
            ) : (
              <span style={{ color: WARN_COLOR }}>
                not configured — loop runs on the Gemini → Z.AI chain only (no tier-1 NVIDIA leg)
              </span>
            )}
          </div>
          {nvCfg?.lastError && (
            <div style={{ color: ERROR_COLOR, marginTop: "4px", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              last error: {nvCfg.lastError}
            </div>
          )}
          {activeBreakers.length > 0 && (
            <div style={{ color: WARN_COLOR, marginTop: "4px" }}>
              circuit breakers tripped:{" "}
              {activeBreakers
                .map(([m, until]) => `${m} (${Math.max(0, Math.round(((until as number) - nowTick) / 1000))}s)`)
                .join(", ")}
            </div>
          )}
          {health?.disabled && (
            <div style={{ color: WARN_COLOR, marginTop: "4px" }}>
              ⏸ NVIDIA_DISABLED=true — NVIDIA leg skipped entirely. Clear the env var to re-enable.
            </div>
          )}
        </div>

        {/* Key input */}
        <div style={{ marginBottom: "12px" }}>
          <div style={{ color: DIM_COLOR, marginBottom: "4px" }}>NVIDIA API Key</div>
          <div style={{ display: "flex", gap: "4px" }}>
            <input
              ref={keyRef}
              type={showKey ? "text" : "password"}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !loading) void save();
              }}
              placeholder="nvapi-... (from build.nvidia.com)"
              autoComplete="off"
              spellCheck={false}
              aria-label="NVIDIA API key"
              style={inputStyle}
            />
            <button type="button" onClick={() => setShowKey((v) => !v)} style={btnStyle}>
              {showKey ? "[HIDE]" : "[SHOW]"}
            </button>
          </div>
        </div>

        {/* Model select */}
        <div style={{ marginBottom: "12px" }}>
          <div style={{ color: DIM_COLOR, marginBottom: "4px" }}>Model id</div>
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="nvidia/nemotron-3.5-bolt-e4b"
            autoComplete="off"
            spellCheck={false}
            aria-label="NVIDIA model id"
            list="nv-model-options"
            style={{ ...inputStyle, flex: "0 1 auto", width: "100%" }}
          />
          <datalist id="nv-model-options">
            {MODEL_OPTIONS.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <div style={{ color: DIM_COLOR, fontSize: "12px", marginTop: "4px" }}>
            Free-catalog model id from build.nvidia.com. Tested defaults: Bolt (1.7s/14s, the fastest),
            Lightning 30B (18s, stronger reasoning), Laguna XS (6s, code-focused). Models rotate without
            notice — if the loop reports a 410, pick a new id from the catalog and re-save.
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "4px" }}>
          <button
            type="button"
            onClick={() => void save()}
            disabled={loading}
            style={{
              ...btnStyle,
              opacity: loading ? 0.5 : 1,
              cursor: loading ? "wait" : "pointer",
              borderColor: OK_COLOR,
              color: OK_COLOR,
            }}
          >
            {loading ? "[ … ]" : "[ SAVE · VERIFY · REBOOT ]"}
          </button>
          {nvCfg?.configured && (
            <button
              type="button"
              onClick={() => void clear()}
              disabled={loading}
              style={{
                ...btnStyle,
                opacity: loading ? 0.5 : 1,
                cursor: loading ? "wait" : "pointer",
                borderColor: ERROR_COLOR,
                color: ERROR_COLOR,
              }}
            >
              [ CLEAR KEY ]
            </button>
          )}
          <button type="button" onClick={onClose} style={btnStyle}>
            [ CLOSE ]
          </button>
        </div>

        {/* Status / error */}
        {msg && (
          <div
            style={{
              color: msg.kind === "ok" ? OK_COLOR : msg.kind === "warn" ? WARN_COLOR : ERROR_COLOR,
              marginTop: "10px",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
            role="status"
          >
            {msg.text}
          </div>
        )}

        {/* Footer hint */}
        <div style={{ color: DIM_COLOR, marginTop: "12px", fontSize: "12px", lineHeight: 1.5 }}>
          The key is stored server-side in the local database only — never returned by any API, never pushed
          to Git. Get a free key at <span style={{ color: PROMPT_COLOR }}>build.nvidia.com</span> (profile →
          API keys → generate). The free hosted catalog is a prototype endpoint: models rotate without
          notice. LOOP classifies 410 Gone as a permanent error and falls through to the next provider
          automatically — the loop never stalls, but you&apos;ll see the failure in this panel&apos;s last-error line.
        </div>
      </div>
    </div>
  );
}
