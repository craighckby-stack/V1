import { NextResponse } from "next/server";
import { liveSelfEnhanceLoop } from "@/lib/pipeline/autonomous/self-enhance-loop";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** User veto on system-defined input: skip the next pending task. */
export async function POST() {
  const result = await liveSelfEnhanceLoop().skipNext();
  return NextResponse.json(result);
}
