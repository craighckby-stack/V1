import { NextResponse } from "next/server";
import { liveSelfEnhanceLoop } from "@/lib/pipeline/autonomous/self-enhance-loop";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  liveSelfEnhanceLoop().stop();
  return NextResponse.json({ stopped: true });
}
