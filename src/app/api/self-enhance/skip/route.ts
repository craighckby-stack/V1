import { NextResponse } from "next/server";
import { selfEnhanceLoop } from "@/lib/pipeline/autonomous/self-enhance-loop";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** User veto on system-defined input: skip the next pending task. */
export async function POST() {
  const result = await selfEnhanceLoop.skipNext();
  return NextResponse.json(result);
}
