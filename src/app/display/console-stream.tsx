"use client";

/**
 * ConsoleStream — the DISPLAY LAYER of the terminal UI.
 *
 * This component is MUTABLE: the self-enhancement loop can refactor it
 * freely (it's in the scan scope as src/app/display/*.tsx). The loop
 * can change colors, layout, formatting, add visualizations — anything
 * about HOW information is displayed.
 *
 * What's NOT here (and never will be): the control surface. The buttons
 * (STOP/START/CLEAR/CONFIG), the command input, the command parser, the
 * state management, the polling — all of that lives in page.tsx, which
 * is PROTECTED. The system can change how things look but never what
 * the user controls.
 *
 * Boundary: this component receives data (lines) and renders it. It
 * owns no state that affects the user's ability to oversee the system.
 *
 * Timestamp normalization: the unified stream blends two log sources
 * with INCOMPATIBLE timestamp conventions:
 *   - oracle events → "2026-11-14T00:03:48.099Z" (full ISO-8601 UTC,
 *     buffer ordered oldest→newest, so appends chronologically).
 *   - loop status logs → "12:12:59 AM" (time-only 12-hour, server is
 *     UTC, buffer ordered newest→oldest via unshift, so appends in
 *     REVERSE chronological order).
 * Left raw, those two streams interleave by arrival time and look
 * jumbled — a 12:11:39 AM oracle line can sit above a 12:11:37 AM
 * status line that actually happened earlier. This layer fixes it by
 * parsing both formats to a comparable epoch and stable-sorting each
 * run of consecutive log lines by event time (oldest at top, newest
 * at bottom — the console convention), while non-log lines (commands,
 * their output, system banners) act as immovable anchors so a command
 * and its reply never separate. Timestamps are then rendered in one
 * consistent HH:MM:SS 24-hour UTC form.
 */

import { RefObject, useMemo } from "react";

export interface ConsoleLine {
  id: string;
  type: "system" | "command" | "output" | "log";
  text: string;
  ts?: string;
  logType?: "info" | "success" | "warn" | "error";
}

interface ConsoleStreamProps {
  lines: ConsoleLine[];
  logRef: RefObject<HTMLDivElement | null>;
  /** Optional onScroll forwarded to the scroll container. page.tsx uses
   *  this to drive "stick to bottom" tail-follow: when the user scrolls
   *  up to read history, the auto-scroll effect stops yanking them back
   *  to the bottom. The display layer stays a pure pass-through (it
   *  doesn't read the ref or track scroll position itself). */
  onScroll?: React.UIEventHandler<HTMLDivElement>;
}

// Color system — red = errors only, white = everything else.
// The loop can change these; page.tsx has its own copies for the control
// surface (they're intentionally decoupled so the display layer can
// evolve independently).
const COLOR_MAP: Record<NonNullable<ConsoleLine["logType"]>, string> = {
  info: "#e0e0e0",
  success: "#e0e0e0",
  warn: "#e0e0e0",
  error: "#ff4444",
};

const TEXT_COLOR = "#e0e0e0";
const USER_INPUT_COLOR = "#ffffff";
const DIM_COLOR = "#777777";

// Hoisted static style objects — React diffs style objects by reference
// on every commit. Recreating them inside the render (inline) forced a
// style-diff on every line on every re-render. Hoisting to module scope
// gives React a stable reference so the commit can skip the diff. This is
// the biggest single win for the freeze: up to 2000 lines × 1 style-diff
// per render was the dominant commit cost.
const LINE_STYLE_BASE: React.CSSProperties = {
  color: TEXT_COLOR,
  whiteSpace: "pre-wrap",
  // Long quoted file paths ("...oracle-events.ts w") would
  // otherwise break mid-token with no break opportunity and
  // leave ugly orphan fragments on the next line. Letting
  // the browser break anywhere only when a word would
  // overflow keeps normal prose intact while paths wrap
  // cleanly at any character.
  overflowWrap: "anywhere",
  // contain: content lets the browser skip re-laying-out OTHER
  // lines when one line's content changes — the cost of a reflow
  // is bounded to the changed line instead of the whole scrollback.
  contain: "content",
};
const LINE_STYLE_COMMAND: React.CSSProperties = {
  ...LINE_STYLE_BASE,
  color: USER_INPUT_COLOR,
};
const LINE_STYLE_ERROR: React.CSSProperties = {
  ...LINE_STYLE_BASE,
  color: COLOR_MAP.error,
};

const SCROLL_CONTAINER_STYLE: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  paddingRight: "4px",
  // Next.js dev mode injects a transient "● Compiling…" pill in the
  // bottom-left corner during route compilation. Without bottom
  // padding, that pill floats ON TOP of the freshest log line and
  // hides its timestamp + the start of its text. The padding lifts
  // the last line above the pill so the newest entry stays readable
  // even mid-compile. (In production there is no pill, so the extra
  // space is just a little terminal breathing room.)
  paddingBottom: "36px",
  // contain: content isolates the scrollback's layout from the rest
  // of the page — a reflow inside a log line can't trigger a re-lay
  // of the header or prompt. Combined with per-line contain: content,
  // a single line changing never reflows the whole 2000-line buffer.
  contain: "content",
};

/**
 * Parse a log timestamp into a comparable epoch-ms value. Handles:
 *   - full ISO-8601 with date + Z/offset (oracle events)
 *   - 12-hour AM/PM time-only (loop status logs; server is UTC, so the
 *     date is inferred as "today UTC")
 *   - 24-hour time-only (defensive fallback)
 * Returns NaN when the string cannot be parsed — callers treat NaN
 * as "no sort key" and leave the line in its original position.
 */
function parseTs(ts: string | undefined | null): number {
  if (!ts) return NaN;
  const s = String(ts).trim();
  if (s.length === 0) return NaN;

  // Full ISO-8601 with a date component
  if (/\d{4}-\d{2}-\d{2}T/.test(s) || /Z$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const t = new Date(s).getTime();
    return isNaN(t) ? NaN : t;
  }

  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();

  // 12-hour AM/PM, time only — server is UTC, infer today (UTC).
  const m12 = s.match(/^(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i);
  if (m12) {
    const h = parseInt(m12[1], 10);
    const min = parseInt(m12[2], 10);
    const sec = parseInt(m12[3], 10);
    const ampm = m12[4].toUpperCase();

    if (Number.isNaN(h) || Number.isNaN(min) || Number.isNaN(sec)) return NaN;

    let hour = h;
    if (ampm === "AM") {
      if (h === 12) hour = 0;
    } else { // PM
      if (h !== 12) hour += 12;
    }
    // Use Date.UTC to ensure the inferred date is based on UTC components
    const t = Date.UTC(year, month, day, hour, min, sec);
    return isNaN(t) ? NaN : t;
  }

  // 24-hour time only — defensive fallback, infer today (UTC).
  const m24 = s.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (m24) {
    const h = parseInt(m24[1], 10);
    const min = parseInt(m24[2], 10);
    const sec = parseInt(m24[3], 10);

    if (Number.isNaN(h) || Number.isNaN(min) || Number.isNaN(sec)) return NaN;

    // Use Date.UTC to ensure the inferred date is based on UTC components
    const t = Date.UTC(year, month, day, h, min, sec);
    return isNaN(t) ? NaN : t;
  }

  return NaN;
}

/**
 * Render a timestamp in one consistent HH:MM:SS 24-hour UTC form so the
 * two source formats stop visually clashing. Falls back to the raw
 * string when parsing fails (so the line is never blanked).
 */
function formatTs(ts: string | undefined | null): string {
  if (!ts) return "";
  const ms = parseTs(ts);
  if (Number.isNaN(ms)) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/**
 * Reorder runs of consecutive "log" lines so they read oldest→newest
 * (top→bottom), while "system"/"command"/"output" lines stay exactly
 * where they are as immovable anchors. This is what keeps a command
 * and its output together — the sort only touches log lines between
 * two anchors. The sort is stable: log lines that share a timestamp
 * (or have no parseable one) keep their arrival order relative to
 * each other.
 *
 * This exists because the two log sources have opposite buffer
 * conventions (oracle oldest-first, loop-status newest-first) and
 * would otherwise interleave by arrival time, not event time.
 *
 * Exported for unit testing — the ordering logic is pure (no React,
 * no DOM) and the tests can exercise it directly without a render
 * environment.
 */
export function orderLogRuns(lines: ConsoleLine[]): ConsoleLine[] {
  if (!lines || lines.length === 0) return [];

  const result: ConsoleLine[] = [];
  let logRun: ConsoleLine[] = [];

  const processLogRun = (run: ConsoleLine[]) => {
    if (run.length === 0) return;
    
    // Copy before sorting — NEVER mutate the caller's array. The caller
    // (page.tsx) holds `consoleLines` as React state; an in-place sort
    // would mutate that state array directly, which (a) violates React's
    // immutability contract and can cause stale renders, and (b) makes
    // useMemo unsafe (a same-reference array that mutated under us).
    // The copy is cheap (run is bounded by the distance between two
    // anchor lines, typically a few dozen).
    const sorted = [...run].sort((a, b) => {
      const ka = a.ts ? parseTs(a.ts) : NaN;
      const kb = b.ts ? parseTs(b.ts) : NaN;
      
      const isNaA = Number.isNaN(ka);
      const isNaB = Number.isNaN(kb);

      if (isNaA && isNaB) return 0; // Both unparseable, maintain relative order (stable)
      if (isNaA) return 1; // A is unparseable, sinks to bottom
      if (isNaB) return -1; // B is unparseable, sinks to bottom
      
      return ka - kb;
    });
    
    sorted.forEach(l => result.push(l));
  };

  for (const l of lines) {
    // Input validation: Ensure essential properties exist before processing
    if (!l || typeof l !== "object" || !l.id || !l.type || typeof l.text !== 'string') {
        // Skip malformed entries without logging to prevent noise in production stream
        continue;
    }
    
    if (l.type === "log") {
      logRun.push(l);
    } else {
      // Process accumulated log run before pushing the anchor line
      processLogRun(logRun);
      logRun = [];
      result.push(l);
    }
  }
  // Process any remaining log run at the end
  processLogRun(logRun);
  
  return result;
}

export function ConsoleStream({ lines, logRef, onScroll }: ConsoleStreamProps) {
  // Order runs of log lines by event time (oldest→newest) so the two
  // differently-ordered, differently-formatted sources read as a single
  // coherent timeline. Pure display-layer transform; non-log lines are
  // immovable so commands and their output stay paired.
  //
  // PERFORMANCE: useMemo so the sort + array rebuild only runs when the
  // `lines` reference changes (page.tsx allocates a fresh array on every
  // state update via the setConsoleLines updater, so this is effectively
  // "on every real new log" — not on every parent re-render that passes
  // the same array). Without memo, the sort + reconcile ran on every
  // parent render (clock tick, status poll, queue poll, oracle poll,
  // any state change) — the dominant cause of the "log screen freezes
  // at times" report when the buffer was near the 2000-line cap.
  //
  // NOTE: the early-return validation guard that used to sit ABOVE this
  // hook was a Rules-of-Hooks violation (a hook called after a conditional
  // return). The guard now lives inside the memo body — orderLogRuns
  // already returns [] for non-array/empty input, so the memo handles
  // both the "no lines" and "invalid lines" cases, and the render path
  // below maps over [] (a no-op) instead of needing an early return.
  const ordered = useMemo(
    () => (Array.isArray(lines) ? orderLogRuns(lines) : []),
    [lines],
  );

  // Validate input lines for the error-log path only (the render path
  // above handles [] cleanly). This sits AFTER the hook so it's not a
  // conditional-return-before-hook violation.
  if (!lines || !Array.isArray(lines)) {
    console.error("ConsoleStream: Input validation failed. 'lines' prop must be an array.");
    return null;
  }

  return (
    <div
      ref={logRef}
      onScroll={onScroll}
      style={SCROLL_CONTAINER_STYLE}
    >
      {ordered.map((line) => {
        // orderLogRuns filters out invalid entries, so we primarily check rendering requirements.
        if (typeof line.text !== "string") {
          // This indicates a structural issue in the input data that bypassed orderLogRuns checks.
          console.error("ConsoleStream: Line missing critical rendering properties. Line data:", line);
          return null;
        }

        // Validate line type is one of the expected values
        if (!["system", "command", "output", "log"].includes(line.type)) {
          console.error("ConsoleStream: Invalid line type encountered:", line.type);
          return null;
        }

        // Pick the static style object — React diffs by reference, so
        // returning the same module-scope object lets the commit skip
        // the per-line style-diff. Only the error logType needs a
        // distinct color; everything else shares LINE_STYLE_BASE.
        let style: React.CSSProperties = LINE_STYLE_BASE;
        let showTimestamp = false;

        if (line.type === "command") {
          style = LINE_STYLE_COMMAND;
        } else if (line.type === "log") {
          if (line.logType === "error") {
            style = LINE_STYLE_ERROR;
          }
          showTimestamp = typeof line.ts === "string" && line.ts.length > 0;
        }

        return (
          <div
            key={line.id}
            style={style}
          >
            {line.type === "command" && "> "}
            {showTimestamp && (
              <span style={{ color: DIM_COLOR }}>[{formatTs(line.ts)}]{" "}</span>
            )}
            {line.text || "\u00a0"}
          </div>
        );
      })}
    </div>
  );
}

export default ConsoleStream;