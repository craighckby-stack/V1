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
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/autonomous/recent-cycles");
      
      if (!res.ok) {
        throw new Error(`Failed to fetch cycles: ${res.status} ${res.statusText}`);
      }
      
      const data = await res.json();
      
      // Validate response structure
      if (!data || typeof data !== 'object' || !Array.isArray(data?.cycles)) {
        throw new Error('Invalid response format from server');
      }
      
      // Validate each cycle in the response
      const validatedCycles = data.cycles.filter((cycle: any) => {
        return cycle && 
               typeof cycle === 'object' && 
               cycle.id && 
               typeof cycle.id === 'string' &&
               cycle.cycleNumber &&
               typeof cycle.cycleNumber === 'number';
      });
      
      setFetched(validatedCycles);
    } catch (err) {
      console.error('Error fetching recent cycles:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch cycles');
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
    <Card className="bg-slate-950/60 border-slate-800/60 backdrop-blur">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-slate-100 flex items-center gap-2 text-base">
            <History className="h-4 w-4 text-violet-300" />
            Recent Autonomous Cycles
          </CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={loading}
            className="h-7 text-xs bg-slate-900/60 border-slate-700 hover:bg-slate-800 text-slate-300"
          >
            <RefreshCw className={cn("h-3 w-3 mr-1.5", loading && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {error && (
          <div className="text-xs text-rose-500 italic py-2 text-center">
            Error: {error}
          </div>
        )}
        {merged.length === 0 ? (
          <p className="text-xs text-slate-500 italic py-6 text-center">
            No cycles yet. Start the autonomous loop or trigger one to see history.
          </p>
        ) : (
          <ScrollArea className="h-[280px] pr-3">
            <div className="space-y-1.5">
              {merged.map((c) => (
                <div
                  key={c.id}
                  className="rounded-md border border-slate-800/60 bg-slate-900/40 px-3 py-2 hover:bg-slate-900/70 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-amber-300">#{c.cycleNumber}</span>
                    <Badge
                      variant="outline"
                      className="text-[9px] uppercase tracking-widest bg-slate-700/40 text-slate-300 border-slate-600/40"
                    >
                      {c.mode || 'unknown'}
                    </Badge>
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[9px] uppercase tracking-widest",
                        STATUS_COLOR[c.status] ?? "bg-slate-500/15 text-slate-300 border-slate-500/40"
                      )}
                    >
                      {c.status}
                    </Badge>
                    <span className="ml-auto text-[10px] text-slate-500 font-mono">
                      {c.startedAt ? new Date(c.startedAt).toLocaleString() : 'Invalid date'}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 mt-1.5 text-[11px] text-slate-400 font-mono">
                    <span className="truncate flex-1" title={c.targetRepo}>
                      {c.targetRepo}:{c.branch}
                    </span>
                    <span className="text-cyan-300">scanned {c.filesScanned}</span>
                    <span className="text-emerald-300">committed {c.filesCommitted}</span>
                    {c.proofHash && (
                      <span className="inline-flex items-center gap-1 text-fuchsia-300">
                        <GitCommit className="h-3 w-3" />
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