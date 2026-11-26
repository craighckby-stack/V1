"use client";

/**
 * Gemini Panel — the operator surface for the LLM provider chain.
 *
 * The loop serves every llmComplete call through a two-leg chain:
 *   gemini (when a key is configured) → z.ai (always available)
 * Gemini is a SEPARATE free-tier quota from Google, so configuring it
 * multiplies the loop's effective throughput and gives the 429 gate a
 * second provider to drain onto.
 *
 * This panel:
 *   - Polls GET /api/self-enhance/llm-config every 5s while open
 *     (status, model, last error, geo-block cooldown, per-model
 *     circuit breakers, proxy presence). The key itself is NEVER
 *     returned by the API.
 *   - [SAVE & VERIFY] POSTs the pasted key: Google verifies it with a
 *     5-token call; 429 (quota exhausted but key valid) and geo-block
 *     (key valid, region unsupported) are both SAVED with warnings —
 *     a good key is never punished for the sandbox's geography.
 *   - [CLEAR] DELETEs the stored config (confirm first).
 *
 * Style: matches the existing terminal aesthetic — black background,
 * #e0e0e0 text, #777777 dim, #ff4444 errors, #ffaa33 warnings.
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

interface GeminiHealth {
  locationBlockedUntilMs: number;
  breakers: Record<string, number>;
  proxyConfigured: boolean;
  disabled?: boolean;
}

interface LlmConfigView {
  configured: boolean;
  model?: string;
  lastUsedAt?: string | null;
  lastError?: string | null;
  providerOrder?: string;
  geminiHealth?: GeminiHealth;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

const MODEL_OPTIONS = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-pro"];

export function GeminiPanel({ open, onClose }: Props) {
  const [cfg, setCfg] = useState<LlmConfigView | null>(null);
  const [key, setKey] = useState("");
  const [model, setModel] = useState(MODEL_OPTIONS[0]);
  const [showKey, setShowKey] = useState(false);
  const [loading, setLoading] = useState(false);
  const [rebooting, setRebooting] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "warn" | "err"; text: string } | null>(null);
  // BUG-4 fix: capture the auto-close timeout so a stale one can't close
  // a re-opened panel. Cleared on unmount + on reopen.
  const autoCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Initialize to 0 (not Date.now()) so the server-rendered HTML and the
  // client's first render produce the SAME value — `Date.now()` as the
  // useState initializer runs on both server and client at different
  // instants, causing a hydration mismatch on any visible countdown text.
  // The real wall-clock value is set by the useEffect below the moment the
  // panel opens, before the first interval tick, so the countdown is
  // correct from the first visible frame.
  const [nowTick, setNowTick] = useState(0);
  const keyRef = useRef<HTMLInputElement>(null);

  // Sync-once gate: the 5s poll must NOT keep resetting `model` while the
  // operator is choosing — previously every poll snapped the select back
  // to the server's stored value mid-edit (the typed/picked value was
  // silently lost before [SAVE]). The server value is read once per open;
  // after that the local state is the source of truth until SAVE.
  const syncedModelRef = useRef(false);

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/self-enhance/llm-config", { cache: "no-store" });
      if (!res.ok) {
        throw new Error(`Failed to fetch LLM config: HTTP status ${res.status}`);
      }
      const data = (await res.json()) as LlmConfigView;
      setCfg(data);
      if (!syncedModelRef.current && data.model && MODEL_OPTIONS.includes(data.model)) {
        syncedModelRef.current = true;
        setModel(data.model);
      }
    } catch (error) {
      // Poll failure is non-fatal — keep the last snapshot on screen, but log the error for debugging.
      console.error("Error during LLM config polling:", error);
    }
  }, []);

  // Poll while open; tick every second so the geo-block countdown animates.
  useEffect(() => {
    if (!open) return;
    // Set the real wall-clock value NOW (before the first interval tick at
    // +1000ms) so the countdown is correct on the first visible frame.
    // The useState initializer is 0 to avoid the hydration mismatch
    // described above; this is where the real time enters the state.
    setNowTick(Date.now());
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
      // BUG-4 fix: clear any stale auto-close timer from a prior save.
      if (autoCloseTimer.current) {
        clearTimeout(autoCloseTimer.current);
        autoCloseTimer.current = null;
      }
      // Fresh sync each open — the stored model may have changed elsewhere.
      syncedModelRef.current = false;
    }
  }, [open]);

  // BUG-4 fix: clear the auto-close timer on unmount.
  useEffect(() => () => {
    if (autoCloseTimer.current) clearTimeout(autoCloseTimer.current);
  }, []);

  if (!open) return null;

  const save = async () => {
    const trimmed = key.trim();
    if (!trimmed) {
      setMsg({ kind: "err", text: "Paste a Gemini API key first (aistudio.google.com → Get API key)." });
      return;
    }
    setLoading(true);
    setMsg(null);
    try {
      const res = await fetch("/api/self-enhance/llm-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ geminiApiKey: trimmed, model }),
      });
      
      if (!res.ok) {
        // Attempt to read error body for better context before parsing as JSON
        const errorText = await res.text();
        throw new Error(`API save failed with status ${res.status}: ${errorText.substring(0, 100)}`);
      }

      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        warning?: string;
        locationBlocked?: boolean;
        model?: string;
      };
      
      if (!data.ok) {
        setMsg({ kind: "err", text: data.error ?? "Save failed due to unknown API response." });
        return;
      }

      // Key saved (verified, or location-blocked-but-valid). The loop
      // does NOT auto-reboot on key save — that was the reported "starts
      // straight away" bug. Saving a key is now a pure config change;
      // the loop picks up the new provider on its next cycle (if running)
      // or when the operator presses [REBOOT LOOP NOW] / [START].
      setKey("");
      setMsg({
        kind: data.locationBlocked ? "warn" : "ok",
        text:
          (data.warning ??
          `Key verified and saved — the loop calls ${data.model ?? model} FIRST and falls back to Z.AI on any failure.`) +
          "\n\nThe loop picks up the new provider on its next cycle. Press [REBOOT LOOP NOW] to apply immediately.",
      });
      void poll();
      // H2: auto-close after 2s. BUG-4 fix: capture the timer so a stale
      // one can't close a re-opened panel.
      if (autoCloseTimer.current) clearTimeout(autoCloseTimer.current);
      autoCloseTimer.current = setTimeout(() => onClose(), 2000);
    } catch (e) {
      setMsg({ kind: "err", text: (e instanceof Error ? e.message : "An unknown error occurred during save.") });
    } finally {
      setLoading(false);
    }
  };

  // [REBOOT LOOP NOW] — the explicit "apply the new key now" gesture.
  // Decoupled from save() so a key save never starts the loop (the
  // reported "starts straight away" bug). Restarts the loop in this
  // session; does NOT change the [START]/[STOP] armed state (a stopped
  // loop stays stopped for future boots — press [START] to re-arm).
  const rebootNow = async () => {
    setRebooting(true);
    setMsg(null);
    try {
      const rb = await fetch("/api/self-enhance/reboot", { method: "POST" });
      if (!rb.ok) {
        // Only attempt to read text if the response was not OK
        const errorText = await rb.text();
        throw new Error(`HTTP error! Status: ${rb.status}. Response body snippet: ${errorText.substring(0, 100)}`);
      }
      const rbData = (await rb.json()) as { rebooted?: boolean; message?: string; error?: string };
      setMsg({
        kind: rbData.rebooted ? "ok" : "err",
        text: rbData.rebooted
          ? `Loop rebooted — ${rbData.message ?? "running with the new provider chain."}`
          : `Reboot failed: ${rbData.error ?? "unknown error from API response"}`,
      });
      // SMELL-12 fix: refresh the panel's status after a successful reboot.
      if (rbData.rebooted === true) void poll();
    } catch (e) {
      // Provide more actionable context on the failure
      setMsg({ kind: "err", text: `Failed to initiate reboot request to /api/self-enhance/reboot. Check network or API availability. Details: ${(e as Error).message}` });
    } finally {
      setRebooting(false);
    }
  };

  const clear = async () => {
    if (!window.confirm("Clear the stored Gemini key?\n\nThe loop falls back to Z.AI-only until a new key is saved.")) return;
    setLoading(true);
    setMsg(null);
    try {
      // Read the result — a DELETE that failed server-side (DB unavailable,
      // write error) used to report success while the poll right after
      // re-rendered STATUS as "configured", contradicting the message on
      // screen. Fake-success is the exact anti-pattern cripple-check F11
      // purged elsewhere in this panel set.
      const res = await fetch("/api/self-enhance/llm-config", { method: "DELETE" });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || data.ok === false) {
        setMsg({
          kind: "err",
          text: `Clear failed — the key is still stored and active. ${data.error ?? `HTTP ${res.status}`}`,
        });
        return;
      }
      setMsg({ kind: "ok", text: "Gemini config cleared — provider chain is Z.AI-only again." });
      void poll();
    } catch (e) {
      setMsg({ kind: "err", text: `Clear request failed: ${(e as Error).message} — the key may still be stored.` });
    } finally {
      setLoading(false);
    }
  };

  const health = cfg?.geminiHealth;
  const geoBlockedForMs = health ? Math.max(0, (health.locationBlockedUntilMs ?? 0) - nowTick) : 0;
  const activeBreakers = Object.entries(health?.breakers ?? {});

  return (
    <div
      role="dialog"
      aria-label="Gemini panel — LLM provider chain configuration"
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
            <span style={{ color: PROMPT_COLOR, fontWeight: "bold" }}>GEMINI</span>
            <span style={{ color: DIM_COLOR, marginLeft: "8px" }}>
              — second LLM quota, chain: {cfg?.providerOrder ?? "gemini → z.ai"}
            </span>
          </div>
          <button type="button" onClick={onClose} aria-label="Close the Gemini panel" style={btnStyle}>
            [ CLOSE ]
          </button>
        </div>

        {/* Provider chain explainer */}
        <div style={{ color: DIM_COLOR, marginBottom: "12px", fontSize: "12px", lineHeight: 1.5 }}>
          Paste a Gemini API key and the loop calls Google FIRST — a separate free-tier
          quota — falling back to Z.AI on any failure. Gemini failures never trip the
          Z.AI 429 gate, and vice versa. Prompts (source code being enhanced) will be
          sent to Google while this is active. <span style={{ color: WARN_COLOR }}>Saving a verified key does NOT start the loop — it is a pure config change. The loop picks up the new provider on its next cycle (if running). Press [REBOOT LOOP NOW] to apply immediately, or [START] in the console to arm + start (which persists across boots).</span>
        </div>

        {/* Gemini status */}
        <div style={{ borderTop: `1px solid ${DIM_COLOR}`, paddingTop: "8px", marginBottom: "12px" }}>
          <div style={{ color: DIM_COLOR, marginBottom: "4px" }}>STATUS</div>
          <div>
            {cfg?.configured ? (
              <>
                configured · model <span style={{ color: OK_COLOR }}>{cfg.model}</span>
                {cfg.lastUsedAt && (
                  <span style={{ color: DIM_COLOR }}>
                    {" "}· last used {new Date(cfg.lastUsedAt).toLocaleTimeString()}
                  </span>
                )}
              </>
            ) : (
              <span style={{ color: WARN_COLOR }}>not configured — loop runs on the Z.AI quota only</span>
            )}
          </div>
          {cfg?.lastError && (
            <div style={{ color: ERROR_COLOR, marginTop: "4px", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              last error: {cfg.lastError}
            </div>
          )}
          {geoBlockedForMs > 0 && (
            <div style={{ color: WARN_COLOR, marginTop: "4px" }}>
              geo-blocked — calls short-circuited for another{" "}
              <span style={{ fontVariantNumeric: "tabular-nums" }}>
                {Math.floor(geoBlockedForMs / 60000)}:{String(Math.floor((geoBlockedForMs % 60000) / 1000)).padStart(2, "0")}
              </span>{" "}
              (recovery probes every 60s)
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
          <div style={{ color: DIM_COLOR, marginTop: "4px", fontSize: "12px" }}>
            {health?.proxyConfigured
              ? "proxy: GEMINI_PROXY_BASE_URL configured — calls route through the geo-bypass proxy."
              : "proxy: not configured — direct calls from this network's region may be geo-blocked by Google. Deploy the FREE Cloudflare Worker in /proxy/ (wrangler deploy) to bypass."}
          </div>
          {health?.disabled && (
            <div style={{ color: WARN_COLOR, marginTop: "4px" }}>
              ⏸ GEMINI_DISABLED=true — Gemini leg skipped entirely, running Z.AI-only with zero overhead. Clear the env var to re-enable.
            </div>
          )}
        </div>

        {/* Key input */}
        <div style={{ marginBottom: "12px" }}>
          <div style={{ color: DIM_COLOR, marginBottom: "4px" }}>Gemini API Key</div>
          <div style={{ display: "flex", gap: "4px" }}>
            <input
              ref={keyRef}
              type={showKey ? "text" : "password"}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !loading) void save();
              }}
              placeholder="AIza... (or the proxy's shared secret)"
              autoComplete="off"
              spellCheck={false}
              aria-label="Gemini API key"
              style={inputStyle}
            />
            <button type="button" onClick={() => setShowKey((v) => !v)} style={btnStyle}>
              {showKey ? "[HIDE]" : "[SHOW]"}
            </button>
          </div>
        </div>

        {/* Model select */}
        <div style={{ marginBottom: "12px" }}>
          <div style={{ color: DIM_COLOR, marginBottom: "4px" }}>Primary model</div>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            aria-label="Primary Gemini model"
            style={{
              ...inputStyle,
              flex: "0 1 auto",
              width: "100%",
              cursor: "pointer",
            }}
          >
            {MODEL_OPTIONS.map((m) => (
              <option key={m} value={m} style={{ background: "#000" }}>
                {m}
              </option>
            ))}
          </select>
          <div style={{ color: DIM_COLOR, fontSize: "12px", marginTop: "4px" }}>
            On overload (429/503) the call cascades to the other models within ~15s before
            falling back to Z.AI.
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
            {loading ? "[ … ]" : "[ SAVE · VERIFY ]"}
          </button>
          {cfg?.configured && (
            <button
              type="button"
              onClick={() => void rebootNow()}
              disabled={loading || rebooting}
              style={{
                ...btnStyle,
                opacity: loading || rebooting ? 0.5 : 1,
                cursor: loading || rebooting ? "wait" : "pointer",
                borderColor: WARN_COLOR,
                color: WARN_COLOR,
              }}
            >
              {rebooting ? "[ … ]" : "[ REBOOT LOOP NOW ]"}
            </button>
          )}
          {cfg?.configured && (
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
          The key is stored server-side in the local database only — it is never returned
          by any API and never pushed to Git. Get a free key at aistudio.google.com. If
          Google rejects the region (this sandbox egresses via HK), deploy the geo-bypass
          proxy in <span style={{ color: PROMPT_COLOR }}>/proxy/</span> and set
          GEMINI_PROXY_BASE_URL — the proxy swaps the shared secret for the real key.
        </div>
      </div>
    </div>
  );
}
