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

export function ConsoleStream({ lines, logRef }: ConsoleStreamProps) {
  // Validate input lines
  if (!Array.isArray(lines)) {
    console.error("ConsoleStream: lines prop must be an array");
    return null;
  }

  return (
    <div
      ref={logRef}
      style={{
        flex: 1,
        overflowY: "auto",
        paddingRight: "4px",
      }}
    >
      {lines.map((line) => {
        // Skip invalid line entries
        if (
          !line || 
          typeof line !== "object" || 
          !line.id || 
          typeof line.id !== "string" || 
          !line.id.trim() ||
          !line.type || 
          !["system", "command", "output", "log"].includes(line.type)
        ) {
          return null;
        }

        const color =
          line.type === "command"
            ? USER_INPUT_COLOR
            : line.type === "log"
            ? COLOR_MAP[line.logType ?? "info"]
            : TEXT_COLOR;

        return (
          <div key={line.id} style={{ color, whiteSpace: "pre-wrap" }}>
            {line.type === "command" && "> "}
            {line.type === "log" && line.ts && (
              <span style={{ color: DIM_COLOR }}>[{line.ts}] </span>
            )}
            {line.text || "\u00a0"}
          </div>
        );
      })}
    </div>
  );
}

export default ConsoleStream;