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
  useEffect(() => {
    if (!start || text.length === 0 || ms <= 0) return;
    const total = text.length;
    const t0 = performance.now();
    let raf: number;
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