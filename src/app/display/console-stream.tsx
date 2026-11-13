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
  if (!lines || !Array.isArray(lines)) {
    console.error("ConsoleStream: lines prop must be an array");
    return null;
  }

  // Validate logRef
  if (!logRef) {
    console.error("ConsoleStream: logRef prop is required");
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
        if (!line || typeof line !== "object" || !line.id || !line.type) {
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
          <div key={line.id} style={{ color, whiteSpace: "pre-wrap" }}>
            {line.type === "command" && "> "}
            {line.type === "log" && line.ts && (
              <span style={{ color: DIM_COLOR }}>
                [{typeof line.ts === "string" ? line.ts : ""}]{" "}
              </span>
            )}
            {line.text || "\u00a0"}
          </div>
        );
      })}
    </div>
  );
}

export default ConsoleStream;