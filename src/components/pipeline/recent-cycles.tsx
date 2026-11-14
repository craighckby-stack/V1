"use client";

import { useEffect, useState } from "react";
import { History, RefreshCw, GitCommit } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { usePipelineStore, AutonomousCycleSummary } from "@/lib/pipeline-store";
import { cn } from "@/lib/utils";

const STATUS_COLOR: Record<string, string> = {
  completed: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  running: "bg-cyan-500/15 text-cyan-300 border-cyan-500/40",
  halted: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  error: "bg-rose-500/15 text-rose-300 border-rose-500/40",
};

export function RecentCycles() {
  const cyclesFromStore = usePipelineStore((s) => s.loopState?.recentCycles) ?? [];
  const [fetched, setFetched] = useState<AutonomousCycleSummary[]>([]);
  const [loading, setLoading] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const res = await fetch("/api/autonomous/recent-cycles");
      if (!res.ok) {
        throw new Error(`Failed to fetch recent cycles: HTTP status ${res.status} ${res.statusText}`);
      }
      const data = await res.json();
      const apiResponse = data as { cycles: AutonomousCycleSummary[] };
      if (typeof apiResponse !== 'object' || apiResponse === null || !Array.isArray(apiResponse.cycles)) {
        throw new Error("Invalid API response: expected object containing a 'cycles' array.");
      }
      setFetched(apiResponse.cycles);
    } catch (error) {
      console.error("Error refreshing recent cycles from API:", error instanceof Error ? error.message : String(error));
      setFetched([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  // Merge: in-memory recent from WS (most recent first) + DB fetch (dedup by id).
  const seen = new Set<string>();
  const merged = [...cyclesFromStore, ...fetched].filter((c) => {
    if (!c || !c.id) return false;
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });

  return (
    <Card className="bg-slate-950/60 border-slate-800/60 backdrop-blur shadow-xl">
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between flex-col sm:flex-row gap-3">
          <CardTitle className="text-slate-100 flex items-center gap-2 text-lg font-semibold">
            <History className="h-5 w-5 text-violet-300" aria-hidden="true" />
            Recent Autonomous Cycles
          </CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={loading}
            className="h-10 px-4 text-sm bg-slate-900/60 border-slate-700 hover:bg-slate-800 text-slate-300 transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-violet-500"
            aria-label={loading ? "Refreshing cycles..." : "Refresh recent cycles"}
          >
            <RefreshCw className={cn("h-4 w-4 mr-2", loading && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {merged.length === 0 ? (
          <p className="text-sm text-slate-300 italic py-8 text-center">
            No cycles yet. Start the autonomous loop or trigger one to see history.
          </p>
        ) : (
          <ScrollArea className="h-[300px] pr-4">
            <div className="space-y-2">
              {merged.map((c) => (
                <div
                  key={c.id}
                  className="rounded-lg border border-slate-800/60 bg-slate-900/40 p-3 hover:bg-slate-900/70 transition-all duration-150 focus-visible:ring-2 focus-visible:ring-violet-500"
                >
                  <div className="flex items-center gap-3 mb-1">
                    <span className="text-sm font-mono text-amber-300 shrink-0">#{c.cycleNumber}</span>
                    <Badge
                      variant="outline"
                      className="text-[10px] uppercase tracking-wider bg-slate-700/40 text-slate-300 border-slate-600/40"
                    >
                      {c.mode}
                    </Badge>
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[10px] uppercase tracking-wider",
                        STATUS_COLOR[c.status] ?? "bg-slate-500/15 text-slate-300 border-slate-500/40"
                      )}
                    >
                      {c.status}
                    </Badge>
                    <span className="ml-auto text-xs text-slate-300 font-mono shrink-0">
                      {c.startedAt ? new Date(c.startedAt).toLocaleString() : "Invalid date"}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-sm text-slate-300 font-mono mt-1">
                    <span className="truncate flex-1" title={c.targetRepo}>
                      {c.targetRepo}:{c.branch}
                    </span>
                    <span className="text-cyan-300 shrink-0">scanned {c.filesScanned}</span>
                    <span className="text-emerald-300 shrink-0">committed {c.filesCommitted}</span>
                    {c.proofHash && (
                      <span className="inline-flex items-center gap-1 text-fuchsia-300 shrink-0">
                        <GitCommit className="h-3 w-3" aria-hidden="true" />
                        <span className="sr-only">Proof hash:</span>
                        {c.proofHash}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}