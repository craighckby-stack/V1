/**
 * Scramble — text that resolves out of CRT noise (audit H2 refactor:
 * extracted from boot-splash.tsx so the effect + rAF logic is testable
 * and reusable independently of the splash ceremony).
 */

"use client";

import { useEffect, useState } from "react";

const GLYPHS = "█▓▒░■<>/\\|=+*#%";

/** Text that resolves out of CRT noise, left to right. Initial state is
 *  the final text — the scramble begins (and first repaints into noise)
 *  only once `start` flips true, inside the rAF callback. */
export function Scramble({ text, start, ms, className }: { text: string; start: boolean; ms: number; className?: string }) {
  const [out, setOut] = useState(text);

  // HOOK ORDER FIX (rules-of-hooks): this effect runs BEFORE the
  // empty-text early return below — a conditional hook call crashes
  // whenever `text` switches between empty and non-empty.
  //
  // PURITY FIX (react-hooks/set-state-in-effect): the "reset to final
  // text" paths (!start, ms<=0, empty text) no longer call setOut
  // synchronously inside the effect body. Instead the render derives the
  // display value (`animating ? out : text` below) — same visible result
  // in every transition, without an in-effect setState. The only state
  // writes left are inside the async rAF tick callback, which the rule
  // permits.
  useEffect(() => {
    // Nothing to animate: not started, invalid duration, or empty text.
    // The derived render below shows the final text for these cases.
    if (!start || ms <= 0 || text.length === 0) return;

    const total = text.length;
    const t0 = performance.now();
    let raf: number | undefined = undefined;

    const tick = (now: DOMHighResTimeStamp) => {
      const p = Math.min(1, (now - t0) / ms);
      const solved = Math.floor(p * total);
      const unsolvedLength = total - solved;

      // Build the solved prefix
      const solvedPrefix = text.slice(0, solved);

      // Build the scrambled tail efficiently
      // Optimized tail construction: use pre-allocated array for better performance
      const scrambledTail = Array(unsolvedLength).fill(0).map(() => 
        GLYPHS[Math.floor(Math.random() * GLYPHS.length)]
      ).join("");

      setOut(solvedPrefix + scrambledTail);

      if (p < 1) {
        raf = requestAnimationFrame(tick);
      }
    };

    raf = requestAnimationFrame(tick);
    return () => {
      if (raf !== undefined) {
        cancelAnimationFrame(raf);
      }
    };
  }, [start, text, ms]);

  if (text.length === 0) {
    return <span className={className}>{text}</span>;
  }

  // Derived display: while animating show the scramble state; otherwise
  // (never started, stopped mid-run, or invalid ms) show the final text.
  // This is behaviorally identical to the old in-effect reset — when
  // `start` flips false the cleanup cancels the rAF and this expression
  // snaps to `text` on the very next render.
  const animating = start && ms > 0;
  return <span className={className}>{animating ? out : text}</span>;
}