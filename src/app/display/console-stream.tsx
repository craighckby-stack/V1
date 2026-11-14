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

import { RefObject } from "react";

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

/**
 * Parse a log timestamp into a comparable epoch-ms value. Handles:
 *   - full ISO-8601 with date + Z/offset (oracle events)
 *   - 12-hour AM/PM time-only (loop status logs; server is UTC, so the
 *     date is inferred as "today UTC")
 *   - 24-hour time-only (defensive fallback)
 * Returns NaN when the string cannot be parsed — callers treat NaN
 * as "no sort key" and leave the line in its original position.
 */
function parseTs(ts: string): number {
  if (typeof ts !== 'string' || ts.trim().length === 0) return NaN;
  const s = ts.trim();

  // Full ISO-8601 with a date component, e.g. "2026-11-14T00:03:48.099Z"
  // or "2026-11-14T00:03:48.099+00:00". Date handles these natively.
  if (/\d{4}-\d{2}-\d{2}T/.test(s) || /Z$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const t = new Date(s).getTime();
    return Number.isNaN(t) ? NaN : t;
  }

  // 12-hour AM/PM, time only — server is UTC, infer today (UTC).
  const m12 = s.match(/^(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i);
  if (m12) {
    let h = parseInt(m12[1], 10);
    const min = parseInt(m12[2], 10);
    const sec = parseInt(m12[3], 10);
    if (m12[4].toUpperCase() === "AM") {
      if (h === 12) h = 0;
    } else {
      if (h !== 12) h += 12;
    }
    const now = new Date();
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, min, sec);
  }

  // 24-hour time only — defensive fallback, infer today (UTC).
  const m24 = s.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (m24) {
    const now = new Date();
    return Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      parseInt(m24[1], 10),
      parseInt(m24[2], 10),
      parseInt(m24[3], 10),
    );
  }

  return NaN;
}

/**
 * Render a timestamp in one consistent HH:MM:SS 24-hour UTC form so the
 * two source formats stop visually clashing. Falls back to the raw
 * string when parsing fails (so the line is never blanked).
 */
function formatTs(ts: string): string {
  const ms = parseTs(ts);
  if (Number.isNaN(ms)) return ts;
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
 */
function orderLogRuns(lines: ConsoleLine[]): ConsoleLine[] {
  const result: ConsoleLine[] = [];
  let buf: ConsoleLine[] = [];

  const flush = () => {
    if (buf.length === 0) {
      buf = [];
      return;
    }
    
    // Stable sort: key = parsed epoch (NaN → +∞ so unparseable log
    // lines sink to the bottom of their run, preserving arrival order
    // among themselves via the index tiebreak).
    const keyed = buf.map((l, i) => ({ l, k: l.ts ? parseTs(l.ts) : NaN, i }));
    keyed.sort((a, b) => {
      const ka = Number.isNaN(a.k) ? Infinity : a.k;
      const kb = Number.isNaN(b.k) ? Infinity : b.k;
      if (ka !== kb) return ka - kb;
      return a.i - b.i;
    });
    for (const x of keyed) result.push(x.l);
    buf = [];
  };

  for (const l of lines) {
    // Skip invalid entries BEFORE dereferencing .type — a null/undefined/
    // non-object entry would throw here, before the render-path guard
    // (below) ever runs. Same validity contract as the render guard.
    if (!l || typeof l !== "object" || !l.id || !l.type) continue;
    if (l.type === "log") buf.push(l);
    else {
      flush();
      result.push(l);
    }
  }
  flush();
  return result;
}

export function ConsoleStream({ lines, logRef }: ConsoleStreamProps) {
  // Validate input lines
  if (!lines || !Array.isArray(lines)) {
    // Return null instead of logging to console to prevent side effects in rendering context
    return null;
  }

  // Validate logRef
  if (!logRef) {
    // Return null instead of logging to console to prevent side effects in rendering context
    return null;
  }

  // Order runs of log lines by event time (oldest→newest) so the two
  // differently-ordered, differently-formatted sources read as a single
  // coherent timeline. Pure display-layer transform; non-log lines are
  // immovable so commands and their output stay paired.
  const ordered = orderLogRuns(lines);

  return (
    <div
      ref={logRef}
      style={{
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
      }}
    >
      {ordered.map((line) => {
        // Skip invalid line entries (relying on type safety and initial checks)
        if (!line || typeof line !== "object" || !line.id || !line.type) {
          // Log error but return null to skip rendering this specific invalid item
          console.error("ConsoleStream: Invalid line object encountered", line);
          return null;
        }

        // Validate line type is one of the expected values
        if (!["system", "command", "output", "log"].includes(line.type)) {
          console.error("ConsoleStream: Invalid line type", line.type);
          return null;
        }

        // Validate text is a string
        if (typeof line.text !== "string") {
          console.error("ConsoleStream: Line text must be a string", line);
          return null;
        }

        let color = TEXT_COLOR;

        if (line.type === "command") {
          color = USER_INPUT_COLOR;
        } else if (line.type === "log" && line.logType) {
          // Safely determine color using COLOR_MAP, defaulting to TEXT_COLOR if logType is unknown
          const logTypeKey = line.logType as keyof typeof COLOR_MAP;
          color = COLOR_MAP[logTypeKey] || TEXT_COLOR;
        }

        return (
          <div
            key={line.id}
            style={{
              color,
              whiteSpace: "pre-wrap",
              // Long quoted file paths ("...oracle-events.ts w") would
              // otherwise break mid-token with no break opportunity and
              // leave ugly orphan fragments on the next line. Letting
              // the browser break anywhere only when a word would
              // overflow keeps normal prose intact while paths wrap
              // cleanly at any character.
              overflowWrap: "anywhere",
            }}
          >
            {line.type === "command" && "> "}
            {line.type === "log" && line.ts && (
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