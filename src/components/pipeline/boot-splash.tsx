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
 * line first, then the same five boot/scan vitals lines appended after
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
import { ensureAudio, postBeep, powerOnThunk, stopAllAudio } from "@/lib/retro-boot-audio";

type Phase = "flash" | "post" | "title" | "invite" | "exit";

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

/** POST line counts. Cold = 8 original + 6 boot/scan lines. Warm = the
 *  SESSION RESUMED line + the same 6 boot/scan lines. (Warm boots used
 *  to show ONE line only — after the first entry, every reload looked
 *  like the splash "never updated". The scan lines now append on both
 *  paths: one definition, two ceremonies, same bytes.) */
const SCAN_LINE_COUNT = 6;
const COLD_POST_MS = (8 + SCAN_LINE_COUNT) * 130 + 260;
const WARM_POST_MS = (1 + SCAN_LINE_COUNT) * 130 + 260;

interface PostLine {
  label: string;
  value: string;
  stamp: string;
  warn?: boolean;
}

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
  // ── boot/scan additions (cold-boot POST lines 9-13) ──
  /** GitHub login from GET /user, "REFUSED" on auth failure, "" when no PAT is on file, "??" unreadable. */
  authLogin: string;
  /** "SEALED" | "PLAINTEXT" | "??" — is the PAT resting in an enc:v1: envelope. */
  vaultSealed: string;
  /** Postmortem JSON files on disk — the wipe-proof failure record. */
  scars: string;
  /** Persistent (restart-surviving) successful hot-swap count. */
  swapsLifetime: string;
  /** The live loop's status word, uppercased. */
  autonomy: string;
  // ── Z.ai cortex (auto-injected at server boot, before this splash) ──
  /** "ready" | "warming" | "error" | "cold" | "??" — the provider
   *  connection state from /api/boot/scan's zai field. */
  zaiState: string;
  /** Measured ping latency in ms ("??" unknown). */
  zaiPing: string;
  /** Truncated failure reason ("" when none). */
  zaiError: string;
  /** Ready-state note — e.g. "PROVIDER REACHED — 429 QUOTA COOLING"
   *  when the connection is verified but the quota is cooling. */
  zaiNote: string;
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
  authLogin: "??",
  vaultSealed: "??",
  scars: "??",
  swapsLifetime: "??",
  autonomy: "??",
  zaiState: "??",
  zaiPing: "??",
  zaiError: "",
  zaiNote: "",
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
    const [br, chain, oracle, status, hotswap, scan] = await Promise.all([
      get("/api/branches", 3000),
      get("/api/postmortems/chain", 1800),
      get("/api/oracle/status", 1800),
      get("/api/self-enhance/status", 1800),
      get("/api/hot-swap/status", 1800),
      // boot/scan — auto-connect + vault + totals. Its own (longer) budget:
      // the GitHub /user round trip must not be killed by the fast local
      // endpoints' budget (same reasoning as the ledger fetch above).
      get("/api/boot/scan", 4000),
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
      // ── boot/scan mapping ──
      authLogin: (() => {
        if (scan === null) return "??"; // endpoint unreadable
        const a = asObj(pick(asObj(scan), "auth"));
        if (a === null) return ""; // auth:null — no PAT on file
        if (a.ok === true) return txt(pick(a, "login"), "??");
        return "REFUSED"; // GitHub rejected the sealed PAT
      })(),
      vaultSealed: (() => {
        const v = asObj(pick(asObj(scan), "vault"));
        if (!v) return "??";
        return v.sealed === true ? "SEALED" : "PLAINTEXT";
      })(),
      scars: txt(pick(asObj(scan), "scars")),
      swapsLifetime: txt(pick(asObj(pick(asObj(scan), "hotSwap")), "lifetime")),
      autonomy: txt(pick(asObj(pick(asObj(scan), "autonomy")), "status"), "??").toUpperCase(),
      // ── Z.ai cortex mapping ──
      zaiState: (() => {
        const z = asObj(pick(asObj(scan), "zai"));
        if (z === null) return "??"; // endpoint unreadable
        const s = pick(z, "state");
        return typeof s === "string" ? s : "??";
      })(),
      zaiPing: (() => {
        const z = asObj(pick(asObj(scan), "zai"));
        return typeof pick(z, "pingMs") === "number" ? String(pick(z, "pingMs")) : "??";
      })(),
      zaiError: (() => {
        const z = asObj(pick(asObj(scan), "zai"));
        const e = pick(z, "error");
        return typeof e === "string" ? e.slice(0, 48) : "";
      })(),
      zaiNote: (() => {
        const z = asObj(pick(asObj(scan), "zai"));
        const n = pick(z, "note");
        return typeof n === "string" ? n : "";
      })(),
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

/** The six boot/scan vitals lines — ONE definition, used by both
 *  ceremonies: cold appends them after the original 8 (which stay
 *  byte-for-byte untouched), warm appends them after the SESSION
 *  RESUMED line. Same bytes on every entry — the live machine state
 *  is never a cold-boot-only show. The Z.AI CORTEX line leads the
 *  group: its injection happens at SERVER BOOT, before this splash
 *  reads it — first in fact, first in report. */
function scanPostLines(v: Vitals): PostLine[] {
  return [
    {
      label: "Z.AI CORTEX",
      value:
        v.zaiState === "ready"
        ? v.zaiNote
          ? `AUTO-INJECTED · VERIFIED (${v.zaiPing}ms · 429 COOLING)`
          : `AUTO-INJECTED · VERIFIED (${v.zaiPing}ms PING)`
        : v.zaiState === "warming" ? "AUTO-INJECTING — HANDSHAKE IN FLIGHT"
        : v.zaiState === "error" ? `OFFLINE — ${v.zaiError || "PROVIDER UNREACHABLE"}`
        : v.zaiState === "cold" ? "NOT INJECTED — AWAITING BOOT KICK"
        : "UNREADABLE",
      stamp: v.zaiState === "ready" ? "OK" : v.zaiState === "warming" ? "WAIT" : "??",
      warn: v.zaiState !== "ready",
    },
    {
      label: "GITHUB AUTH",
      value:
        v.authLogin === "" ? "NO PAT ON FILE — ENTER VIA [CONFIG]"
        : v.authLogin === "??" ? "AUTO-CONNECT UNREADABLE"
        : v.authLogin === "REFUSED" ? "TOKEN REJECTED — RE-ENTER VIA [CONFIG]"
        : `AUTHENTICATED AS ${v.authLogin}`,
      stamp: v.authLogin === "REFUSED" ? "!!" : v.authLogin !== "" && v.authLogin !== "??" ? "OK" : "??",
      warn: v.authLogin === "" || v.authLogin === "??" || v.authLogin === "REFUSED",
    },
    {
      label: "TOKEN VAULT",
      value:
        v.vaultSealed === "SEALED" ? "AES-256-GCM · SEALED AT REST"
        : v.vaultSealed === "PLAINTEXT" ? "PLAINTEXT — KEY MISSING"
        : "UNREADABLE",
      stamp: v.vaultSealed === "SEALED" ? "OK" : "??",
      warn: v.vaultSealed !== "SEALED",
    },
    {
      label: "MUTATION TOTALS",
      value: `${v.branchesTotal} SUCCEEDED · ${v.scars} FAILED`,
      stamp: "OK",
      warn: v.branchesTotal === "??" || v.scars === "??",
    },
    {
      label: "HOT-SWAP LOG",
      value: `${v.swapsLifetime} LIFETIME · ${v.swaps} THIS BOOT`,
      stamp: "OK",
      warn: v.swapsLifetime === "??" || v.swaps === "??",
    },
    {
      label: "AUTONOMY",
      value:
        v.autonomy === "RUNNING" ? "LIVE — SELF-DRIVEN"
        : v.autonomy === "??" ? "UNREADABLE"
        : `ARMED — ${v.autonomy}`,
      stamp: v.autonomy === "RUNNING" ? "LIVE" : "OK",
      warn: v.autonomy === "ERROR" || v.autonomy === "??",
    },
  ];
}

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

    // Warm boots fetch vitals too now: their POST appends the same five
    // boot/scan lines after the SESSION RESUMED line. The fetch races
    // the (fast) warm timeline and never blocks it — the first stamp
    // still lands at 650ms; late-arriving values fill their lines in
    // retroactively (POST lines re-render from live state).
    const vitalsP = fetchVitals()
      .then((v) => setVitals(v))
      .catch(() => setVitals(UNKNOWN_VITALS));

    if (isWarm) {
      // Warm boot: quick phosphor flash + the SESSION RESUMED line,
      // then the five scan lines stamp in — the machine reports its
      // live vitals on EVERY entry — but it still asks. There is no
      // auto-enter: ENTER always runs the full rite (owner's "each
      // time" decree), so the invite is the stop.
      const warmPostAt = reducedRef.current ? 100 : 650;
      later(() => setPhase("post"), warmPostAt);
      // The invite flips in after the last (6th) line stamps + settle.
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
  // 13 cold / 6 warm.
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
  // One definition of the scan lines feeds both ceremonies.
  const scan = scanPostLines(v);
  const postLines: PostLine[] = warm
    ? [
        { label: "WARM BOOT", value: "SESSION RESUMED", stamp: "OK" },
        // The same five scan lines as cold — the live vitals report on
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
        { label: "LLM CORTEX", value: v.llm, stamp: v.llm.startsWith("GATE") ? "WAIT" : "OK", warn: v.llm.startsWith("GATE") },
        { label: "HOT-SWAP BAY", value: `${v.swaps} SWAP(S) THIS BOOT`, stamp: "OK", warn: v.swaps === "??" },
        { label: "UPLINK", value: v.repo, stamp: "LINK" },
        { label: "CYCLE COUNTER", value: `${v.cycles} COMPLETED`, stamp: "OK", warn: v.cycles === "??" },
        // ── boot/scan additions — appended AFTER the original 8, which are
        // byte-for-byte untouched above (operator: "enhance without changing
        // what's there"). Lines 9-13: auto-connect identity, sealed-token
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
        .bsp-post { min-height: ${warm ? "142px" : "288px"}; white-space: pre-wrap; word-break: break-word; }
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

        @media (max-width: 640px) {
          .bsp-crt { padding: 16px 14px; font-size: 11px; }
        }
        @media (prefers-reduced-motion: reduce) {
          .bsp-crt--flash, .bsp-crt--exit, .bsp-band, .bsp-flicker,
          .bsp-btn, .bsp-jitter, .bsp-hint { animation: none !important; }
        }
      `}</style>
    </div>
  );
}
