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

  if (text.length === 0) {
    return <span className={className}>{text}</span>;
  }

  useEffect(() => {
    if (!start) return;
    
    // Input validation: ms must be positive for animation timing
    if (ms <= 0) {
      setOut(text);
      return;
    }

    const total = text.length;
    const t0 = performance.now();
    let raf = 0;

    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / ms);
      const solved = Math.floor(p * total);

      // Build the solved prefix
      const solvedPrefix = text.slice(0, solved);
      
      // Build the scrambled tail efficiently
      const scrambledTailChars = Array.from({ length: total - solved }, (_, i) => {
        const index = solved + i;
        const ch = text[index];
        return (ch === "\n" || ch === " ") 
          ? ch 
          : GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
      });
      
      setOut(solvedPrefix + scrambledTailChars.join(''));
      
      if (p < 1) {
        raf = requestAnimationFrame(tick);
      }
    };
    
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [start, text, ms]);
  
  return <span className={className}>{out}</span>;
}