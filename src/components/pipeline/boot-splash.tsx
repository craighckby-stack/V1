"use client";

/**
 * BOOT SPLASH — the cold/warm boot ceremony.
 *
 * Not a static logo screen: it is a BIOS-style POST that reports the
 * machine's LIVE vitals, fetched from its own APIs while the CRT warms up:
 *   - mutation ledger  (/api/branches)          → "63 ON REMOTE · NEXT loop-64"
 *   - postmortem chain (/api/postmortems/chain) → "32 VERIFIED · 0 BROKEN"
 *   - prophecy engine  (/api/oracle/status)     → "0 SEEDED · 0 PENDING"
 *   - LLM cortex       (/api/self-enhance/status) → READY or GATE mm:ss
 *   - hot-swap bay     (/api/hot-swap/status)   → swaps this boot
 *   - uplink           (repo from /api/branches)
 *   - boot scan        (/api/boot/scan)        → NEW (additive): GitHub
 *     auto-connect identity (the sealed PAT is opened server-side, zero
 *     operator input), token-vault status, total mutations + failures,
 *     hot-swap lifetime count, autonomy status
 *
 * Sequence (cold boot): CRT power-on flash → POST lines stamp in one by
 * one → the LOOP sigil scrambles out of noise → the machine addresses the
 * observer and offers [ ▶ ENTER THE LOOP ] → pressing ENTER loads the
 * terminal. Splash → system, nothing in between.
 *
 * The rite fires on EVERY entry — warm boot or cold. Warm boots (already
 * entered this browser session) take the fast path — the SESSION RESUMED
 * line first, then the same seven boot/scan vitals lines appended after
 * it, so the live machine state is reported on EVERY entry, not just
 * the first. prefers-reduced-motion flattens
 * the fancy animation (the CRT effects go static) but does NOT cancel
 * the ceremony. Force the full cold POST with ?boot=force.
 *
 * Aesthetic: amber phosphor CRT (the terminal inside is white-on-black;
 * the amber screen is the machine's "face" before it lets you in).
 * Honors prefers-reduced-motion: everything renders instantly.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchVitals, scanPostLines, UNKNOWN_VITALS, type Vitals, type PostLine } from "@/lib/boot-vitals";
import { Scramble } from "./scramble";
import { ensureAudio, postBeep, powerOnThunk, stopAllAudio } from "@/lib/retro-boot-audio";

type Phase = "flash" | "post" | "title" | "invite" | "exit";

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

/** POST line counts. Cold = 8 original + 8 boot/scan lines. Warm = the
 *  SESSION RESUMED line + the same 8 boot/scan lines. (Warm boots used
 *  to show ONE line only — after the first entry, every reload looked
 *  like the splash "never updated". The scan lines now append on both
 *  paths: one definition, two ceremonies, same bytes.) */
const SCAN_LINE_COUNT = 8;
const COLD_POST_MS = (8 + SCAN_LINE_COUNT) * 130 + 260;
const WARM_POST_MS = (1 + SCAN_LINE_COUNT) * 130 + 260;


export function BootSplash({ onEnter }: { onEnter: () => void }) {
  const [phase, setPhase] = useState<Phase>("flash");
  const [shown, setShown] = useState(0);
  const [vitals, setVitals] = useState<Vitals>(UNKNOWN_VITALS);
  const [warm, setWarm] = useState(false);

  const timers = useRef<number[]>([]);
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
    // legitimizes the soundtrack under autoplay policy.
    ensureAudio();
    // Splash → system. The CRT collapse runs (bsp-crt--exit animation),
    // then the terminal loads. No prank, no crawl, no audio gag — the
    // machine asks, you press ENTER, you're in. A short happy POST beep
    // marks the handoff (the one piece of the old rite worth keeping —
    // it's the audio equivalent of the POST stamping OK).
    setPhase("exit");
    later(() => {
      powerOnThunk();
      postBeep();
      onEnterRef.current();
    }, reducedRef.current ? 120 : 720);
  }, [clearTimers, later]);

  const skip = useCallback(() => {
    if (enteredRef.current) return;
    const p = phaseRef.current;
    if (p === "exit") return;
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

    // Warm boots fetch vitals too now: their POST appends the same seven
    // boot/scan lines after the SESSION RESUMED line. The fetch races
    // the (fast) warm timeline and never blocks it — the first stamp
    // still lands at 650ms; late-arriving values fill their lines in
    // retroactively (POST lines re-render from live state).
    const vitalsP = fetchVitals()
      .then((v) => setVitals(v))
      .catch(() => setVitals(UNKNOWN_VITALS));

    if (isWarm) {
      // Warm boot: quick phosphor flash + the SESSION RESUMED line,
      // then the seven scan lines stamp in — the machine reports its
      // live vitals on EVERY entry — but it still asks. There is no
      // auto-enter: ENTER always runs the full rite (owner's "each
      // time" decree), so the invite is the stop.
      const warmPostAt = reducedRef.current ? 100 : 650;
      later(() => setPhase("post"), warmPostAt);
      // The invite flips in after the last (7th) line stamps + settle.
      later(
        () => setPhase((p) => (p === "post" ? "invite" : p)),
        warmPostAt + (reducedRef.current ? 150 : WARM_POST_MS)
      );
    } else {
      // Cold boot: wait for CRT warm-up AND vitals (≤1.8s), then POST.
      Promise.race([vitalsP, new Promise((r) => window.setTimeout(r, 1850))]).then(() => {
        later(
          () => {
            setPhase("post");
            const postMs = reducedRef.current ? 120 : COLD_POST_MS;
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
  // `warm` is settled (set at mount via a 0ms tick) long before "post"
  // can flip (≥100ms), so reading it here just picks the line count:
  // 15 cold / 8 warm.
  useEffect(() => {
    if (phase !== "post") return;
    const total = warm ? 1 + SCAN_LINE_COUNT : 8 + SCAN_LINE_COUNT;
    // Reset/complete the counter asynchronously (async setState keeps the
    // effect from triggering a cascading render on the same commit).
    const reset = window.setTimeout(() => setShown(reducedRef.current ? 99 : 0), 0);
    let iv = 0;
    if (!reducedRef.current) {
      iv = window.setInterval(() => {
        setShown((s) => {
          if (s >= total) {
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
  }, [phase, warm]);

  // Kill any still-sounding audio when the splash unmounts.
  useEffect(() => () => stopAllAudio(), []);

  // Keyboard: any key skips the SPLASH. No prank phase anymore, so no
  // ESC-only mercy hatch — every key works everywhere.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const p = phaseRef.current;
      if (p === "exit") {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      skip();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [skip]);

  // Focus the invitation button when it appears (keyboard entry point).
  useEffect(() => {
    if (phase === "invite") btnRef.current?.focus({ preventScroll: true });
  }, [phase]);

  const v = vitals;
  // Live clock: ticks once per second ONLY while a countdown is active
  // (the 429 quota gate OR the ARMED-RECOVERING settle window), so the
  // API QUOTA and AUTONOMY lines count down in real time. Anchored on
  // CLIENT-epoch endsAtMs values (set in fetchVitals) — the tick fills
  // the gap between the one-shot vitals fetch and ENTER; no idle
  // re-renders when neither countdown is active (same pattern as the
  // terminal's header chip).
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const needsTick =
      vitals.quotaState === "cooling" ||
      (v.livePhase === "ARMED-RECOVERING" && v.recoveryEndsAtMs > 0);
    if (!needsTick) return;
    // First tick via a 0ms timeout instead of a synchronous setState —
    // the sync call is the cascade the set-state-in-effect rule flags;
    // the one-frame delay is imperceptible for a 1s-granularity clock.
    const t = window.setTimeout(() => setNowMs(Date.now()), 0);
    const iv = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => {
      window.clearTimeout(t);
      window.clearInterval(iv);
    };
  }, [vitals.quotaState, v.livePhase, v.recoveryEndsAtMs]);
  // One definition of the scan lines feeds both ceremonies.
  const scan = scanPostLines(v, nowMs);
  const postLines: PostLine[] = warm
    ? [
        { label: "WARM BOOT", value: "SESSION RESUMED", stamp: "OK" },
        // The same seven scan lines as cold — the live vitals report on
        // every entry, so a reload never reads as "not updated".
        ...scan,
      ]
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
        { label: "LLM CORTEX", value: v.llm, stamp: v.llm === "READY" ? "OK" : "WAIT", warn: v.llm !== "READY" },
        { label: "HOT-SWAP BAY", value: `${v.swaps} SWAP(S) THIS BOOT`, stamp: "OK", warn: v.swaps === "??" },
        { label: "UPLINK", value: v.repo, stamp: "LINK", link: v.repo && v.repo !== "unlinked" && v.repo !== "??" ? `https://github.com/${v.repo}` : undefined },
        { label: "CYCLE COUNTER", value: `${v.cycles} COMPLETED`, stamp: "OK", warn: v.cycles === "??" },
        // ── boot/scan additions — appended AFTER the original 8, which are
        // byte-for-byte untouched above (operator: "enhance without changing
        // what's there"). Lines 9-15: auto-connect identity, provider
        // quota gate (live countdown), sealed-token
        // vault, total mutations + failures, live hot-swap success, autonomy.
        ...scan,
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

        <div className={`bsp-post ${warm ? "bsp-post--warm" : "bsp-post--cold"}`} aria-hidden>
          {(phase === "flash" ? [] : phase === "post" ? postLines.slice(0, shown) : postLines).map((l, i) => {
            // Honesty rule: an unreadable vital never stamps OK.
            const unknown = l.value.includes("??") || l.value === "unlinked";
            return (
              <div key={`${l.label}-${i}`} className={i === 0 && warm ? "bsp-dim" : undefined}>
                {i === 0 && !warm ? (
                  <span className="bsp-dim">LOOP SYSTEMS BIOS v4.2 — COLD BOOT</span>
                ) : (
                  <>
                    {l.link ? (
                      <>
                        {l.label} {".".repeat(Math.max(3, 24 - l.label.length))}{" "}
                        <a
                          href={l.link}
                          target="_blank"
                          rel="noreferrer"
                          className="bsp-link"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {l.value}
                        </a>
                      </>
                    ) : (
                      pad(l.label, l.value)
                    )}{" "}
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

      {phase !== "exit" && (
        <div className="bsp-hint bsp-dim" aria-hidden>
          {phase === "invite" ? "ENTER ⏎" : "▌ PRESS ANY KEY TO SKIP"}
        </div>
      )}

      {/* CRT dressing — scanlines, phosphor band, flicker, vignette */}
      <div className="bsp-scan" aria-hidden />
      <div className="bsp-band" aria-hidden />
      <div className="bsp-flicker" aria-hidden />
      <div className="bsp-vignette" aria-hidden />

    </div>
  );
}
