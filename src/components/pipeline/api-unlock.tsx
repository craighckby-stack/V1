"use client";

/**
 * API UNLOCK — the UI half of the API-key gate (auth middleware, audit:
 * "zero auth on 56 API routes").
 *
 * Contract with the gate:
 *   - page.tsx patches window.fetch so every mutating /api/* request
 *     carries the "x-loop-key" header from localStorage["loopApiKey"],
 *     and any 401 from an /api/* path dispatches the
 *     "loop-api-unauthorized" CustomEvent on window.
 *   - This panel listens for that event and offers a BIOS-styled key
 *     prompt, fixed bottom-right above the terminal.
 *
 * Behavior:
 *   - On mount it checks localStorage for a stored key; when absent it
 *     renders a subtle dim hint (no key = every mutation will 401).
 *   - On 401 it shows the API LOCKED panel: a password input + UNLOCK
 *     button. Submitting stores the key and reloads the page so the
 *     patched fetch attaches it from then on.
 *   - Escape dismisses the panel until the next 401.
 *
 * Aesthetic: amber/emerald phosphor on black, monospace — matches the
 * BIOS terminal. No blue/indigo.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

const STORAGE_KEY = "loopApiKey";
const UNAUTHORIZED_EVENT = "loop-api-unauthorized";

/** Subscribe to localStorage `storage` events (cross-tab changes of the
 *  key). Same-tab programmatic writes don't fire it, but the panel only
 *  reads this on mount/subscribe — the unlock flow reloads the page,
 *  which re-reads fresh anyway. */
function subscribeToStorage(callback: () => void): () => void {
  window.addEventListener("storage", callback);
  return () => window.removeEventListener("storage", callback);
}

/** Client snapshot: is a key stored? (localStorage can throw in private
 *  browsing — treat as absent, same as the old try/catch.) */
function readHasKeySnapshot(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

export function ApiUnlock() {
  const [locked, setLocked] = useState(false);
  // useSyncExternalStore is the blessed pattern for client-only values
  // (the old version called setState synchronously inside useEffect —
  // the exact cascade the react-hooks/set-state-in-effect rule flags).
  // Server snapshot: false ("no key") avoids a hydration mismatch.
  const hasKey = useSyncExternalStore(
    subscribeToStorage,
    readHasKeySnapshot,
    () => false,
  );
  // null until the healthz fetch lands, then whether the server's
  // middleware is actually configured to gate mutations (LOOP_API_KEY
  // is set in .env). The middleware fails OPEN when the env var is
  // unset — mutations are NOT actually locked in that case, so the
  // "API KEY NOT SET — MUTATIONS LOCKED" hint would be a lie. We hide
  // it until the server confirms it's gating. On fetch failure we
  // leave this null (fail-safe: don't claim "locked" when we can't
  // verify) — the unlock panel on 401 is independent and still fires.
  const [mutationGateConfigured, setMutationGateConfigured] = useState<boolean | null>(null);
  const [value, setValue] = useState("");

  // Listen for 401s from the patched fetch. (The hasKey read moved to
  // useSyncExternalStore above; the hint shows when BOTH (a) no key is
  // stored AND (b) the server confirms it has LOOP_API_KEY configured.)
  useEffect(() => {
    let cancelled = false;
    let abortController: AbortController | null = null;
    
    const checkHealthz = async () => {
      abortController = new AbortController();
      try {
        const response = await fetch("/api/healthz", { 
          cache: "no-store",
          signal: abortController.signal 
        });
        if (!response.ok) return;
        const data = await response.json();
        if (cancelled) return;
        const cfg = (data as { mutationGate?: { configured?: unknown } } | null)?.mutationGate?.configured;
        setMutationGateConfigured(typeof cfg === "boolean" ? cfg : null);
      } catch (error) {
        if (!cancelled && error instanceof Error && error.name !== "AbortError") {
          setMutationGateConfigured(null);
        }
      }
    };

    checkHealthz().catch(() => {
      // Ensure we handle any uncaught promise rejections
      if (!cancelled) {
        setMutationGateConfigured(null);
      }
    });

    const onUnauthorized = () => setLocked(true);
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    
    return () => {
      cancelled = true;
      if (abortController) {
        abortController.abort();
      }
      window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    };
  }, []);

  // Escape dismisses the panel until the next 401.
  useEffect(() => {
    if (!locked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setLocked(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [locked]);

  const unlock = useCallback(() => {
    const key = value.trim();
    if (!key) {
      return;
    }
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(STORAGE_KEY, key);
      } catch (error) {
        // Handle potential localStorage errors (e.g., quota exceeded)
        console.error("Failed to store API key:", error);
        return;
      }
    }
    // Reload so the patched fetch attaches the key to every mutation.
    window.location.reload();
  }, [value]);

  // ── Locked: the BIOS-styled key prompt (bottom-right, z-50) ─────────────
  if (locked) {
    return (
      <div
        role="dialog"
        aria-label="API locked — enter API key"
        className="fixed bottom-4 right-4 z-50 w-[min(380px,92vw)] border border-amber-500/70 bg-black/95 p-4 font-mono text-xs leading-relaxed text-emerald-400 shadow-[0_0_32px_rgba(0,0,0,0.9)]"
      >
        <div className="mb-2 border-b border-amber-500/40 pb-1 font-bold tracking-[0.2em] text-amber-400">
          API LOCKED
        </div>
        <p className="mb-3 text-emerald-300/90">
          A mutating request was rejected (401). Enter the API key to unlock
          this terminal.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            unlock();
          }}
        >
          <label
            htmlFor="api-unlock-key"
            className="mb-1 block tracking-widest text-emerald-400"
          >
            ENTER API KEY
          </label>
          <div className="flex gap-2">
            <input
              id="api-unlock-key"
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder="••••••••••••"
              className="min-w-0 flex-1 border border-emerald-800 bg-black px-2 py-1 font-mono text-emerald-300 caret-emerald-400 outline-none placeholder:text-emerald-900 focus:border-emerald-400"
            />
            <button
              type="submit"
              disabled={!value.trim()}
              className="cursor-pointer border border-amber-500/70 bg-black px-3 py-1 font-mono tracking-widest text-amber-400 hover:bg-amber-500/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              UNLOCK
            </button>
          </div>
        </form>
        <p className="mt-3 border-t border-amber-500/30 pt-2 text-[10px] text-amber-500/90">
          Key is in the server&apos;s .env (LOOP_API_KEY) — ask the operator.
        </p>
        <p className="mt-1 text-[10px] text-neutral-500">
          ESC dismisses until the next rejected request
        </p>
      </div>
    );
  }

  // ── Unlocked but keyless: a subtle hint that mutations are gated.
  // ONLY shown when the server CONFIRMS it has LOOP_API_KEY configured
  // (the middleware fails open otherwise — mutations aren't actually
  // locked, so the hint would be a lie). On fetch-failure or while the
  // fetch is in flight, `mutationGateConfigured` is null and the hint
  // stays hidden — we never claim "locked" when we can't verify it.
  // The unlock panel on 401 is independent and still fires if the
  // server ever rejects a mutation.
  if (hasKey === false && mutationGateConfigured === true) {
    return (
      <div className="pointer-events-none fixed bottom-1.5 right-2 z-50 font-mono text-[10px] tracking-widest text-amber-600/50">
        API KEY NOT SET — MUTATIONS LOCKED
      </div>
    );
  }

  return null;
}