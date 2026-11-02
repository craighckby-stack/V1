import { NextResponse } from "next/server";
import { RED_TEAM_PROBES, RED_TEAM_SUITE_VERSION } from "@/lib/pipeline/red-team/red-team-suite";
import { getLastRedTeamRun } from "@/lib/pipeline/red-team/red-team-runner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/red-team/status
 *
 * Returns the red-team suite metadata (version, probe list) AND the last
 * persisted run summary (if any). The UI uses this to render the panel:
 * the probe catalog (so the operator knows what's being tested) and the
 * last run's verdict / per-probe results. See docs/CONCEPTS-GRAFTED.md GRAFT 4.
 */
export async function GET() {
  try {
    const lastRun = await getLastRedTeamRun();
    const probes = RED_TEAM_PROBES.map((p) => ({
      id: p.id,
      name: p.name,
      target: p.target,
      expectedBehavior: p.expectedBehavior,
      riskCategory: p.riskCategory,
      mitigation: p.mitigation,
    }));
    return NextResponse.json({
      ok: true,
      suiteVersion: RED_TEAM_SUITE_VERSION,
      probeCount: RED_TEAM_PROBES.length,
      probes,
      lastRun,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
