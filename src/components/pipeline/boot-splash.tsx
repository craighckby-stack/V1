"use client";

/**
 * BOOT SPLASH — the cold/warm boot ceremony.
 *
 * Not a static logo screen: it is a BIOS-style POST that reports the
 * machine's LIVE vitals, fetched from its own APIs while the CRT warms up:
 *   - mutation ledger  (/api/branches)          → "38 ON REMOTE · NEXT loop-39"
 *   - postmortem chain (/api/postmortems/chain) → "28 VERIFIED · 0 BROKEN"
 *   - prophecy engine  (/api/oracle/status)     → "9 SEEDED · 9 PENDING"
 *   - LLM cortex       (/api/self-enhance/status) → READY or GATE mm:ss
 *   - hot-swap bay     (/api/hot-swap/status)   → swaps this boot
 *   - uplink           (repo from /api/branches)
 *
 * Sequence (cold boot): CRT power-on flash → POST lines stamp in one by
 * one → the LOOP sigil scrambles out of noise → the machine addresses the
 * observer and offers [ ▶ ENTER THE LOOP ].
 *
 * THE PRANK (per the owner, verbatim: "for shits and giggles"): pressing
 * ENTER drops the observer into a BLUE SCREEN OF DEATH reading "404 — NOT
 * EVER" with a progress bar that stalls at 99% and a floppy drive seeking
 * in the background. Ten seconds later the screen tips back and the STAR
 * WARS OPENING CRAWL explains what this system is, scored by a synthesized
 * Imperial March (master volume pinned at 1.0, no mute — owner's orders,
 * "each time"). When the crawl clears the top, a happy POST beep fires
 * and the terminal finally loads. ESC is the hidden mercy.
 *
 * The rite fires on EVERY entry — warm boot or cold — because the owner
 * said each time. There is no back door into the terminal: warm boots
 * (already entered this browser session) take the fast path — one SESSION
 * RESUMED line — but still end at the invite, and ENTER always detonates
 * the prank. prefers-reduced-motion flattens the fancy animation (the
 * crawl loses its 3D tilt, the CRT effects go static) but does NOT cancel
 * the ceremony. Force the full cold POST with ?boot=force.
 *
 * Aesthetic: amber phosphor CRT (the terminal inside is white-on-black;
 * the amber screen is the machine's "face" before it lets you in).
 * Honors prefers-reduced-motion: everything renders instantly.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ensureAudio,
  floppySeek,
  imperialMarch,
  postBeep,
  powerOnThunk,
  sadBeep,
  stopAllAudio,
} from "@/lib/retro-boot-audio";

type Phase = "flash" | "post" | "title" | "invite" | "exit" | "bsod" | "crawl";

// Prank timeline (ms, after the ENTER gesture):
//   0–720       CRT power-off collapse (existing)
//   720–10720   BLUE SCREEN — 404 NOT EVER, progress stalls at 99%
//   10720+2400  "A long time ago..." intro zooms while the crawl enters
//   +24000      crawl finishes — the end translateY(-100%) lands the text
//               bottom exactly at the viewport top as the animation ends,
//               so there's NO dead air between the last line scrolling off
//               and the terminal loading.
const BSOD_MS = 10_000;
const CRAWL_INTRO_MS = 2_400;
// 24s vs the old 15.6s — ~1.5× slower scroll, readable at SW pace.
const CRAWL_ANIM_MS = 24_000;
const CRAWL_TOTAL_MS = CRAWL_INTRO_MS + CRAWL_ANIM_MS;

type Json = Record<string, unknown>;

const GLYPHS = "█▓▒░■<>/\\|=+*#%";

// ANSI-shadow sigil — the machine's self-portrait.
const ASCII_LOOP = [
  "██╗       ██████╗  ██████╗ ██████╗ ",
  "██║      ██╔═══██╗██╔═══██╗██╔══██╗",
  "██║      ██║   ██║██║   ██║██████╔╝",
  "██║      ██║   ██║██║   ██║██╔═══╝ ",
  "██║      ╚██████╔╝╚██████╔╝██║     ",
  "███████╗  ╚═════╝  ╚═════╝ ╚═╝     ",
].join("\n");

const TAGLINE = "A MACHINE THAT REWRITES ITS OWN CODE.";

interface Vitals {
  branchesTotal: string;
  nextBranch: string;
  repo: string;
  chainTotal: string;
  chainBreaks: string;
  prophecies: string;
  propheciesPending: string;
  llm: string;
  cycles: string;
  swaps: string;
}

const UNKNOWN_VITALS: Vitals = {
  branchesTotal: "??",
  nextBranch: "loop-??",
  repo: "unlinked",
  chainTotal: "??",
  chainBreaks: "??",
  prophecies: "??",
  propheciesPending: "??",
  llm: "UNKNOWN",
  cycles: "??",
  swaps: "??",
};

const asObj = (v: unknown): Json | null => (v && typeof v === "object" ? (v as Json) : null);
const pick = (o: Json | null | undefined, k: string): unknown => (o ? o[k] : undefined);
const txt = (v: unknown, fallback = "??"): string =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : fallback;

function gateClock(remainingMs: number): string {
  const s = Math.max(0, Math.ceil(remainingMs / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Fetch the machine's live vitals. Each endpoint gets its own timeout —
 *  the GitHub-backed ledger is slower and must not be killed by the fast
 *  local endpoints' budget. Any failure degrades to "??" — the POST still
 *  stamps, honestly marking what it could not read. */
async function fetchVitals(): Promise<Vitals> {
  const get = async (url: string, ms: number): Promise<unknown> => {
    const ac = new AbortController();
    const kill = window.setTimeout(() => ac.abort(), ms);
    try {
      const r = await fetch(url, { signal: ac.signal, cache: "no-store" });
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    } finally {
      window.clearTimeout(kill);
    }
  };
  try {
    const [br, chain, oracle, status, hotswap] = await Promise.all([
      get("/api/branches", 3000),
      get("/api/postmortems/chain", 1800),
      get("/api/oracle/status", 1800),
      get("/api/self-enhance/status", 1800),
      get("/api/hot-swap/status", 1800),
    ]);
    const gate = asObj(pick(asObj(status), "llmGate"));
    const gateActive = gate?.active === true;
    const gateMs = typeof gate?.remainingMs === "number" ? gate.remainingMs : 0;
    const stats = asObj(pick(asObj(status), "stats"));
    const mapped: Vitals = {
      branchesTotal: txt(pick(asObj(br), "total")),
      nextBranch: txt(pick(asObj(br), "nextMutationBranch"), "loop-??"),
      repo: txt(pick(asObj(br), "repo"), "unlinked"),
      chainTotal: txt(pick(asObj(chain), "total")),
      chainBreaks: txt(pick(asObj(chain), "linkBreaks")),
      prophecies: txt(pick(asObj(pick(asObj(oracle), "counts")), "total")),
      propheciesPending: txt(pick(asObj(pick(asObj(oracle), "counts")), "pending")),
      llm: gateActive ? `GATE ${gateClock(gateMs)} — COOLING` : "READY",
      cycles: txt(pick(stats, "cyclesCompleted")),
      swaps: txt(pick(asObj(hotswap), "swapCount")),
    };
    return mapped;
  } finally {
    /* per-request timers are cleared in get() */
  }
}

/** Text that resolves out of CRT noise, left to right. Initial state is
 *  the final text — the scramble begins (and first repaints into noise)
 *  only once `start` flips true, inside the rAF callback. */
function Scramble({ text, start, ms, className }: { text: string; start: boolean; ms: number; className?: string }) {
  const [out, setOut] = useState(text);
  useEffect(() => {
    if (!start) return;
    const total = text.length;
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / ms);
      const solved = Math.floor(p * total);
      let s = text.slice(0, solved);
      for (let i = solved; i < total; i++) {
        const ch = text[i];
        s += ch === "\n" || ch === " " ? ch : GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
      }
      setOut(s);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [start, text, ms]);
  return <span className={className}>{out}</span>;
}

export function BootSplash({ onEnter }: { onEnter: () => void }) {
  const [phase, setPhase] = useState<Phase>("flash");
  const [shown, setShown] = useState(0);
  const [vitals, setVitals] = useState<Vitals>(UNKNOWN_VITALS);
  const [warm, setWarm] = useState(false);
  const [bsodPct, setBsodPct] = useState(0);

  const timers = useRef<number[]>([]);
  const intervals = useRef<number[]>([]);
  const enteredRef = useRef(false);
  const reducedRef = useRef(false);
  const phaseRef = useRef<Phase>("flash");
  const btnRef = useRef<HTMLButtonElement>(null);
  const onEnterRef = useRef(onEnter);

  // Ref mirrors are written in effects (never during render) so callbacks
  // always read fresh values without re-binding listeners.
  useEffect(() => {
    onEnterRef.current = onEnter;
  }, [onEnter]);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const later = useCallback((fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  }, []);
  const clearTimers = useCallback(() => {
    for (const t of timers.current) window.clearTimeout(t);
    timers.current = [];
    for (const i of intervals.current) window.clearInterval(i);
    intervals.current = [];
  }, []);

  const commitEnter = useCallback(() => {
    if (enteredRef.current) return;
    enteredRef.current = true;
    clearTimers();
    try {
      sessionStorage.setItem("loop-booted", "1");
    } catch {
      /* private mode — ceremony just replays next load */
    }
    // Create the AudioContext inside this user gesture — that is what
    // legitimizes the soundtrack under autoplay policy. Volume is pinned
    // at 1.0 by the owner's decree; there is no mute.
    ensureAudio();
    // No exemptions, no back door: the rite fires on EVERY entry — warm
    // or cold, reduced motion or not (the CSS already flattens the fancy
    // animation for reduced-motion observers). ESC is the only mercy.
    setPhase("exit");
    // ── Act I: BSOD ── after the CRT collapse, the lie begins.
    later(() => {
      powerOnThunk();
      sadBeep();
      floppySeek(BSOD_MS - 600);
      setBsodPct(0);
      setPhase("bsod");
      // ── Act II: the crawl, scored by the Imperial March.
      later(() => {
        imperialMarch();
        setPhase("crawl");
        later(() => {
          // ── Act III: system loads. Happy POST beep.
          postBeep();
          onEnterRef.current();
        }, CRAWL_TOTAL_MS);
      }, BSOD_MS);
    }, reducedRef.current ? 120 : 720);
  }, [clearTimers, later]);

  /** Hidden mercy: ESC during the prank fast-forwards to the terminal. */
  const finishPrank = useCallback(() => {
    const p = phaseRef.current;
    if (p !== "bsod" && p !== "crawl") return;
    clearTimers();
    stopAllAudio();
    onEnterRef.current();
  }, [clearTimers]);

  const skip = useCallback(() => {
    if (enteredRef.current) return;
    const p = phaseRef.current;
    if (p === "exit" || p === "bsod" || p === "crawl") return; // 404 — NOT EVER
    if (p === "invite") {
      commitEnter();
      return;
    }
    clearTimers();
    setPhase("invite");
  }, [clearTimers, commitEnter]);

  // Boot machine — runs once on mount. Decides cold vs warm from the
  // session flag, fetches vitals in parallel with the CRT warm-up, and
  // chains the phase transitions. All timers cleaned up on unmount.
  useEffect(() => {
    let alreadyBooted = false;
    let forceBoot = false;
    try {
      alreadyBooted = sessionStorage.getItem("loop-booted") === "1";
      forceBoot = new URLSearchParams(window.location.search).get("boot") === "force";
    } catch {
      /* storage unavailable → treat as cold */
    }
    const isWarm = alreadyBooted && !forceBoot;
    // Async (not synchronously in the effect body) to avoid a cascading
    // render — the value is only needed once "post" shows its lines.
    later(() => setWarm(isWarm), 0);

    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedRef.current = mq.matches;

    // Warm boots never show vitals (one SESSION RESUMED line only), so
    // don't even fetch them — the fast path stays fast and quiet.
    const vitalsP = isWarm
      ? Promise.resolve(UNKNOWN_VITALS)
      : fetchVitals()
          .then((v) => setVitals(v))
          .catch(() => setVitals(UNKNOWN_VITALS));

    if (isWarm) {
      // Warm boot: quick phosphor flash + one line — but the machine
      // still asks. There is no auto-enter: ENTER always runs the full
      // rite (owner's "each time" decree), so the invite is the stop.
      later(() => setPhase("post"), reducedRef.current ? 100 : 650);
      later(() => setPhase((p) => (p === "post" ? "invite" : p)), reducedRef.current ? 250 : 1350);
    } else {
      // Cold boot: wait for CRT warm-up AND vitals (≤1.8s), then POST.
      Promise.race([vitalsP, new Promise((r) => window.setTimeout(r, 1850))]).then(() => {
        later(
          () => {
            setPhase("post");
            const postMs = reducedRef.current ? 120 : 9 * 130 + 260;
            later(() => setPhase((p) => (p === "post" ? "title" : p)), postMs);
            // Invite flips 120ms AFTER the longest scramble (tagline
            // 1150ms) completes, so the rAF never gets canceled at the
            // boundary and glyphs never freeze mid-noise.
            later(
              () => setPhase((p) => (p === "title" ? "invite" : p)),
              postMs + (reducedRef.current ? 80 : 1270)
            );
          },
          reducedRef.current ? 120 : 700
        );
      });
    }
    return clearTimers;
  }, [clearTimers, later]);

  // POST line stamping — reveal one line per tick while in "post".
  useEffect(() => {
    if (phase !== "post") return;
    // Reset/complete the counter asynchronously (async setState keeps the
    // effect from triggering a cascading render on the same commit).
    const reset = window.setTimeout(() => setShown(reducedRef.current ? 99 : 0), 0);
    let iv = 0;
    if (!reducedRef.current) {
      iv = window.setInterval(() => {
        setShown((s) => {
          if (s >= 9) {
            window.clearInterval(iv);
            return s;
          }
          return s + 1;
        });
      }, 130);
    }
    return () => {
      window.clearTimeout(reset);
      if (iv) window.clearInterval(iv);
    };
  }, [phase]);

  // BSOD progress — ticks 0→99 with the classic stall, then 100.
  useEffect(() => {
    if (phase !== "bsod") return;
    const t0 = performance.now();
    const iv = window.setInterval(() => {
      const el = performance.now() - t0;
      const p = el >= 9500 ? 100 : el >= 8300 ? 99 : Math.min(99, Math.round((el / 8300) * 100));
      setBsodPct(p);
      if (p >= 100) window.clearInterval(iv);
    }, 90);
    intervals.current.push(iv);
    return () => window.clearInterval(iv);
  }, [phase]);

  // Kill any still-sounding prank audio when the splash unmounts.
  useEffect(() => () => stopAllAudio(), []);

  // Keyboard: any key skips the SPLASH; during the prank ONLY Escape
  // works (the mercy hatch) — everything else is 404 NOT EVER.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const p = phaseRef.current;
      if (p === "exit") {
        e.preventDefault();
        return;
      }
      if (p === "bsod" || p === "crawl") {
        e.preventDefault();
        if (e.key === "Escape") finishPrank();
        return;
      }
      e.preventDefault();
      skip();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [skip, finishPrank]);

  // Focus the invitation button when it appears (keyboard entry point).
  useEffect(() => {
    if (phase === "invite") btnRef.current?.focus({ preventScroll: true });
  }, [phase]);

  const v = vitals;
  const postLines: Array<{ label: string; value: string; stamp: string; warn?: boolean }> = warm
    ? [{ label: "WARM BOOT", value: "SESSION RESUMED", stamp: "OK" }]
    : [
        { label: "CHECKING OBSERVER", value: "HUMAN AT TERMINAL 0", stamp: "OK" },
        {
          label: "MUTATION LEDGER",
          value: `${v.branchesTotal} ON REMOTE · NEXT ${v.nextBranch}`,
          stamp: "OK",
          warn: v.branchesTotal === "??",
        },
        {
          label: "POSTMORTEM CHAIN",
          value: `${v.chainTotal} VERIFIED · ${v.chainBreaks} BROKEN`,
          stamp: "OK",
          warn: v.chainBreaks !== "??" && v.chainBreaks !== "0",
        },
        {
          label: "PROPHECY ENGINE",
          value: `${v.prophecies} SEEDED · ${v.propheciesPending} PENDING`,
          stamp: "OK",
          warn: v.prophecies === "??",
        },
        { label: "LLM CORTEX", value: v.llm, stamp: v.llm.startsWith("GATE") ? "WAIT" : "OK", warn: v.llm.startsWith("GATE") },
        { label: "HOT-SWAP BAY", value: `${v.swaps} SWAP(S) THIS BOOT`, stamp: "OK", warn: v.swaps === "??" },
        { label: "UPLINK", value: v.repo, stamp: "LINK" },
        { label: "CYCLE COUNTER", value: `${v.cycles} COMPLETED`, stamp: "OK", warn: v.cycles === "??" },
      ];

  const pad = (label: string, value: string) => {
    const dots = ".".repeat(Math.max(3, 24 - label.length));
    return `${label} ${dots} ${value}`;
  };

  const showTitle = phase === "title" || phase === "invite" || phase === "exit";
  const showInvite = phase === "invite" || phase === "exit";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="LOOP boot sequence — press any key to skip, then Enter to enter the Loop"
      className="bsp-root"
      onClick={skip}
    >
      <h2 className="sr-only">
        LOOP — a machine that rewrites its own code. Boot diagnostics: {postLines.length} checks.
        Press Enter to enter the Loop.
      </h2>

      <div
        className={[
          "bsp-crt bsp-text",
          phase === "flash" ? "bsp-crt--flash" : "",
          phase === "exit" ? "bsp-crt--exit" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {showTitle && (
          <>
            <pre className={`bsp-logo${showInvite ? " bsp-jitter" : ""}`} aria-hidden>
              <Scramble text={ASCII_LOOP} start={phase === "title"} ms={1000} />
            </pre>
            <div className="bsp-tagline">
              <Scramble text={TAGLINE} start={phase === "title"} ms={1150} />
            </div>
            <div className="bsp-rule">{"─".repeat(64)}</div>
          </>
        )}

        <div className="bsp-post" aria-hidden>
          {(phase === "flash" ? [] : phase === "post" ? postLines.slice(0, shown) : postLines).map((l, i) => {
            // Honesty rule: an unreadable vital never stamps OK.
            const unknown = l.value.includes("??") || l.value === "unlinked";
            return (
              <div key={`${l.label}-${i}`} className={i === 0 && warm ? "bsp-dim" : undefined}>
                {i === 0 && !warm ? (
                  <span className="bsp-dim">LOOP SYSTEMS BIOS v4.2 — COLD BOOT</span>
                ) : (
                  <>
                    {pad(l.label, l.value)}{" "}
                    <span className={unknown || l.warn ? "bsp-wait" : "bsp-ok"}>
                      [{` ${unknown ? "??" : l.stamp} `}]
                    </span>
                  </>
                )}
              </div>
            );
          })}
          {phase === "post" && !warm && shown === 0 && (
            <div className="bsp-dim">LOOP SYSTEMS BIOS v4.2 — COLD BOOT</div>
          )}
          {/* Heartbeat while the machine reads its own vitals (the ledger
              check reaches out to GitHub and can take ~2s). The POST is
              not dead air — it is the machine feeling for a pulse. */}
          {phase === "flash" && (
            <div className="bsp-dim bsp-selfscan">
              SELF-SCAN <span className="bsp-cursor">▮</span>
            </div>
          )}
        </div>

        {showInvite && (
          <div className="bsp-invite">
            <div className="bsp-rule">{"─".repeat(64)}</div>
            <div>YOU ARE THE OBSERVER.</div>
            <div className="bsp-dim">IT JOURNALS. IT PREDICTS. IT DEFENDS. IT DOES NOT SLEEP.</div>
            <div className="bsp-invite-actions">
              <button
                ref={btnRef}
                type="button"
                className="bsp-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  commitEnter();
                }}
              >
                [ ▶ ENTER THE LOOP ]
              </button>
            </div>
          </div>
        )}
      </div>

      {phase !== "exit" && phase !== "bsod" && phase !== "crawl" && (
        <div className="bsp-hint bsp-dim" aria-hidden>
          {phase === "invite" ? "ENTER ⏎" : "▌ PRESS ANY KEY TO SKIP"}
        </div>
      )}
      {phase === "bsod" && (
        <div className="bsp-hint bsp-bsod-hint" aria-hidden>
          [ ESC ]
        </div>
      )}

      {phase === "bsod" && (
        <div className="bsp-bsod" role="alert">
          <div className="bsp-bsod-inner">
            <div className="bsp-bsod-face">:(</div>
            <div className="bsp-bsod-head">404 — NOT EVER</div>
            <p>
              YOUR LOOP RAN INTO A PROBLEM IT COULDN'T IGNORE, SO IT IS BEING
              A BLUE SCREEN FOR TEN SECONDS. IT DOES NOT KNOW WHY. IT CHECKED
              TWICE.
            </p>
            <p className="bsp-bsod-dim">
              The machine is fine. You, however, have now seen something you
              were not supposed to see.
            </p>
            <div>Stop code: CRITICAL_PROCESS_DIED_LAUGHING</div>
            <div>What failed: loop.exe (it's fine, probably)</div>
            <div className="bsp-bsod-pct">
              {bsodPct}% of reality restored
            </div>
            <div className="bsp-bsod-bar" aria-hidden>
              [{"█".repeat(Math.round((bsodPct / 100) * 26)).padEnd(26, "░")}]
            </div>
          </div>
        </div>
      )}

      {phase === "crawl" && (
        <div className="bsp-crawl-root">
          <div className="bsp-crawl-intro" aria-hidden>
            A long time ago in a codebase far, far away....
          </div>
          <div className="bsp-crawl" style={{ animationDuration: `${CRAWL_ANIM_MS}ms` }}>
            <h3>EPISODE IV.2</h3>
            <h2>A NEW LOOP</h2>
            <p>
              It is a period of civil maintenance. The autonomous machine
              LOOP, running deep inside a sandbox far, far away, has struck a
              blow against ENTROPY and the gathering chaos of unmaintained
              code.
            </p>
            <p>
              Powering the rebellion is a large language model and an
              unhealthy amount of confidence: the machine rewrites its OWN
              source code, gates every mutation through a real TypeScript
              compiler, and pushes the proof to GitHub — where 38 branches
              bear silent witness.
            </p>
            <p>
              It journals its failures. It prophesies its own future and
              grades the answers. It defends itself against intruders, scans
              its own secrets, and hot-swaps its own organs while running. It
              does not sleep. It does not stop. It has never once asked for
              permission.
            </p>
            <p>
              And now, having detected an observer at terminal zero, it loads
              the interface — and waits to see what you will type....
            </p>
          </div>
          <div className="bsp-crawl-fade" aria-hidden />
        </div>
      )}

      {/* CRT dressing — scanlines, phosphor band, flicker, vignette */}
      <div className="bsp-scan" aria-hidden />
      <div className="bsp-band" aria-hidden />
      <div className="bsp-flicker" aria-hidden />
      <div className="bsp-vignette" aria-hidden />

      <style>{`
        .bsp-root {
          position: fixed; inset: 0; z-index: 1000;
          background: #000; color: #ffb000;
          font-family: 'Courier New', 'Lucida Console', monospace;
          font-size: 13px; line-height: 1.55;
          display: flex; align-items: center; justify-content: center;
          overflow: hidden; cursor: pointer; user-select: none;
          -webkit-tap-highlight-color: transparent;
        }
        .bsp-crt { width: 100%; max-width: 980px; padding: 24px 28px; transform-origin: 50% 50%; }
        .bsp-crt--flash { animation: bsp-on 700ms cubic-bezier(.2,.7,.3,1) both; }
        .bsp-crt--exit  { animation: bsp-off 650ms ease-in both; }
        .bsp-text { text-shadow: 0 0 8px rgba(255,176,0,.35), 0 0 2px rgba(255,176,0,.8); }
        .bsp-post { min-height: ${warm ? "22px" : "200px"}; white-space: pre-wrap; word-break: break-word; }
        .bsp-dim { color: rgba(255,176,0,.55); }
        .bsp-ok { color: #ffd875; }
        .bsp-wait { color: #ff6a3d; }
        .bsp-rule { color: rgba(255,176,0,.3); white-space: nowrap; overflow: hidden; margin: 6px 0; }
        .bsp-logo {
          margin: 0 auto 10px; font-family: inherit; font-size: clamp(6px, 2.4vw, 15px);
          line-height: 1.06; white-space: pre; overflow: hidden;
          text-shadow: -2px 0 rgba(255,70,0,.5), 2px 0 rgba(255,230,150,.35), 0 0 16px rgba(255,176,0,.45);
        }
        .bsp-jitter { animation: bsp-jitter 3.2s steps(2) infinite; }
        .bsp-tagline { font-size: clamp(10px, 1.6vw, 14px); letter-spacing: 2px; margin-bottom: 4px; }
        .bsp-invite { margin-top: 8px; }
        .bsp-invite-actions { margin-top: 16px; display: flex; justify-content: center; }
        .bsp-btn {
          font-family: inherit; font-size: 15px; letter-spacing: 1px;
          background: #000; color: #ffb000; border: 1px solid #ffb000;
          padding: 12px 26px; cursor: pointer;
          text-shadow: 0 0 10px rgba(255,176,0,.6);
          animation: bsp-pulse 1.4s ease-in-out infinite;
        }
        .bsp-btn:hover, .bsp-btn:focus-visible {
          background: #ffb000; color: #000; text-shadow: none;
          box-shadow: 0 0 24px rgba(255,176,0,.55); outline: none;
        }
        .bsp-hint {
          position: absolute; bottom: 18px; left: 0; right: 0;
          text-align: center; font-size: 11px; letter-spacing: 1px;
          animation: bsp-blink 1.2s steps(1) infinite;
        }
        .bsp-selfscan { letter-spacing: 2px; }
        .bsp-cursor { animation: bsp-blink .9s steps(1) infinite; }
        @keyframes bsp-on {
          0%   { transform: scaleY(.003) scaleX(.7); filter: brightness(24); }
          30%  { transform: scaleY(.003) scaleX(1);  filter: brightness(18); }
          55%  { transform: scaleY(1);               filter: brightness(3.2); }
          75%  { filter: brightness(1.6); }
          100% { transform: none; filter: none; }
        }
        @keyframes bsp-off {
          0%   { transform: none; filter: none; opacity: 1; }
          55%  { transform: scaleY(.004); filter: brightness(14); opacity: 1; }
          78%  { transform: scaleY(.004) scaleX(.002); filter: brightness(30); opacity: 1; }
          100% { transform: scaleY(.001) scaleX(.001); filter: brightness(40); opacity: 0; }
        }
        @keyframes bsp-pulse {
          0%, 100% { box-shadow: 0 0 8px rgba(255,176,0,.15); }
          50%      { box-shadow: 0 0 22px rgba(255,176,0,.45); }
        }
        @keyframes bsp-blink { 0%, 60% { opacity: 1; } 61%, 100% { opacity: .25; } }
        @keyframes bsp-jitter {
          0%, 92%, 100% { transform: none; }
          93% { transform: translate(1px,-1px) skewX(.4deg); }
          96% { transform: translate(-1px,1px); }
        }
        .bsp-scan {
          position: absolute; inset: 0; pointer-events: none;
          background: repeating-linear-gradient(0deg, rgba(0,0,0,.28) 0 1px, transparent 1px 3px);
        }
        .bsp-band {
          position: absolute; left: 0; right: 0; top: -140px; height: 120px; pointer-events: none;
          background: linear-gradient(180deg, transparent, rgba(255,176,0,.05), transparent);
          animation: bsp-band 7s linear infinite;
        }
        .bsp-flicker {
          position: absolute; inset: 0; pointer-events: none;
          background: #ffb000; mix-blend-mode: overlay; opacity: 0;
          animation: bsp-flicker 4s steps(1) infinite;
        }
        .bsp-vignette {
          position: absolute; inset: 0; pointer-events: none;
          background: radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,.55) 100%);
        }
        @keyframes bsp-band { from { top: -140px; } to { top: 110%; } }
        @keyframes bsp-flicker {
          0%, 96%, 100% { opacity: 0; }
          97% { opacity: .02; } 98% { opacity: .04; } 99% { opacity: .02; }
        }

        /* ── Act I: BLUE SCREEN OF DEATH — 404 NOT EVER ────────────── */
        .bsp-bsod {
          position: absolute; inset: 0; z-index: 8;
          background: #0000aa; color: #fff;
          display: flex; align-items: center; justify-content: center;
          font-size: 14px; line-height: 1.65;
          cursor: default; user-select: none;
        }
        .bsp-bsod-inner { max-width: 660px; width: 100%; padding: 24px; }
        .bsp-bsod-face { font-size: 88px; line-height: 1; margin-bottom: 20px; font-weight: bold; }
        .bsp-bsod-head { font-size: 24px; letter-spacing: 1px; margin-bottom: 16px; font-weight: bold; }
        .bsp-bsod p { margin: 0 0 12px; }
        .bsp-bsod-dim { color: #9a9aff; }
        .bsp-bsod-pct { margin-top: 24px; font-size: 17px; }
        .bsp-bsod-bar { margin-top: 6px; white-space: pre; font-size: 13px; color: #c8c8ff; }
        .bsp-bsod-hint { color: rgba(255,255,255,.4); animation: none; }

        /* ── Act II: the crawl ──────────────────────────────────────── */
        .bsp-crawl-root {
          position: absolute; inset: 0; z-index: 9;
          background: #000; overflow: hidden;
          perspective: 380px;
          cursor: default; user-select: none;
        }
        .bsp-crawl-intro {
          position: absolute; inset: 0; z-index: 3;
          display: flex; align-items: center; justify-content: center;
          color: #4bd5ee; text-align: center;
          font-size: clamp(16px, 3vw, 27px);
          padding: 0 24px;
          animation: bsp-intro 2.4s ease-in forwards;
        }
        .bsp-crawl {
          position: absolute; top: 0; left: 50%; width: min(660px, 88vw);
          transform-origin: 50% 100%;
          transform: translateX(-50%) rotateX(26deg) translateY(105vh);
          color: #ffe81f; font-weight: bold;
          font-size: clamp(15px, 3vw, 25px); line-height: 1.55;
          text-align: justify;
          animation-name: bsp-crawl-up;
          animation-timing-function: linear;
          animation-fill-mode: forwards;
        }
        .bsp-crawl h3 {
          text-align: center; font-size: 1.45em; letter-spacing: 3px;
          margin: 0 0 4px;
        }
        .bsp-crawl h2 {
          text-align: center; font-size: 2.1em; letter-spacing: 3px;
          margin: 0 0 1.3em;
        }
        .bsp-crawl p { margin: 0 0 1.25em; text-shadow: 0 0 10px rgba(255,232,31,.35); }
        .bsp-crawl-fade {
          position: absolute; top: 0; left: 0; right: 0; height: 40%; z-index: 2;
          background: linear-gradient(180deg, #000 10%, transparent);
          pointer-events: none;
        }
        @keyframes bsp-crawl-up {
          from { transform: translateX(-50%) rotateX(26deg) translateY(105vh); }
          to   { transform: translateX(-50%) rotateX(26deg) translateY(-100%); }
        }
        @keyframes bsp-intro {
          0%   { opacity: 0; transform: scale(.82); }
          14%  { opacity: 1; transform: scale(1); }
          68%  { opacity: 1; transform: scale(1.05); }
          100% { opacity: 0; transform: scale(1.6); }
        }

        @media (max-width: 640px) {
          .bsp-crt { padding: 16px 14px; font-size: 11px; }
          .bsp-bsod-inner { padding: 16px; }
          .bsp-bsod-face { font-size: 56px; }
          .bsp-bsod-head { font-size: 18px; }
        }
        @media (prefers-reduced-motion: reduce) {
          .bsp-crt--flash, .bsp-crt--exit, .bsp-band, .bsp-flicker,
          .bsp-btn, .bsp-jitter, .bsp-hint { animation: none !important; }
          /* crawl without the 3D tilt — still reads, no vertigo */
          .bsp-crawl { transform: translateX(-50%) translateY(105vh); }
          .bsp-crawl-intro { animation: none; opacity: 0; }
          @keyframes bsp-crawl-up {
            from { transform: translateX(-50%) translateY(105vh); }
            to   { transform: translateX(-50%) translateY(-100%); }
          }
        }
      `}</style>
    </div>
  );
}
