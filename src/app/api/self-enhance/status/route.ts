import { NextResponse } from "next/server";
import { selfEnhanceLoop } from "@/lib/pipeline/autonomous/self-enhance-loop";
import { llmGateInfo } from "@/lib/pipeline/llm/agent-llm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    running: selfEnhanceLoop.isRunning(),
    stats: selfEnhanceLoop.getStats(),
    logs: selfEnhanceLoop.getLogs(),
    currentFile: selfEnhanceLoop.getCurrentFile(),
    // Shared LLM rate-limit gate state — powers the UI's live countdown.
    // `endsAtMs` is the anchor: the client ticks against it every second so
    // the countdown stays accurate between polls (poll is every 2s).
    llmGate: llmGateInfo(),
    // Per-file saturation state (phase 1: lockout-on-stable). The UI renders
    // the lockout panel from this — locked files get an [unlock] button,
    // the no-growth counter, and the last reason. When all eligible files
    // are locked, the UI shows "PASS COMPLETE — review & unlock".
    saturation: selfEnhanceLoop.getSaturation(),
  });
}
