"use client";

import { useEffect, useState, useRef } from "react";
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
  const abortControllerRef = useRef<AbortController | null>(null);

  async function refresh() {
    if (loading) return; // Prevent concurrent fetches
    
    // Cancel any pending request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    
    abortControllerRef.current = new AbortController();
    setLoading(true);
    
    try {
      const res = await fetch("/api/autonomous/recent-cycles", {
        signal: abortControllerRef.current.signal
      });
      
      if (res.status === 0) {
        // Status 0 is not a standard HTTP status; this likely means the request was aborted or failed before HTTP response.
        // We rely on the catch block for AbortError, but log this unusual status if it occurs.
        console.warn("API request returned status 0, likely aborted or network error.");
        return; 
      }
      
      if (!res.ok) {
        throw new Error(`Failed to fetch recent cycles: HTTP status ${res.status} ${res.statusText}`);
      }
      
      const data = await res.json();

      // Strict validation: ensure data is an object containing a 'cycles' array of the correct type.
      if (typeof data !== 'object' || data === null || !('cycles' in data) || !Array.isArray(data.cycles)) {
        throw new Error("Invalid API response structure: expected object containing a 'cycles' array of AutonomousCycleSummary.");
      }
      
      // Validate each cycle in the array: ensure it's an object and has required identifiers.
      const apiResponseCycles = data.cycles.filter(c => 
        c && typeof c === 'object' && 'id' in c && 'cycleNumber' in c
      ) as AutonomousCycleSummary[];
      
      setFetched(apiResponseCycles);
    } catch (error) {
      if (error instanceof Error && error.name !== 'AbortError') {
        // Improved error handling: log the full error object for better debugging context
        const errorMessage = error.message || "Unknown error during fetch or parsing.";
        console.error("Error refreshing recent cycles from API:", error);
      }
    } finally {
      setLoading(false);
      abortControllerRef.current = null;
    }
  }

  useEffect(() => {
    refresh();
    
    return () => {
      // Cleanup abort controller on component unmount
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  // Merge: in-memory recent from WS (most recent first) + DB fetch (dedup by id).
  // Use Map for O(N) deduplication. WS data (cyclesFromStore) takes precedence.
  const seen = new Map<string, AutonomousCycleSummary>();
  
  // Process WS data first to ensure precedence, then API data.
  cyclesFromStore.forEach(c => {
    if (c && c.id) { 
      seen.set(c.id, c);
    }
  });
  
  fetched.forEach(c => {
    if (c && c.id && !seen.has(c.id)) {
      seen.set(c.id, c);
    }
  });

  // Convert map values back to array. Map preserves insertion order (WS first, then API additions).
  const merged = Array.from(seen.values());

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
              {merged.map((c) => {
                const statusColor = STATUS_COLOR[c.status || 'error'] || "bg-slate-500/15 text-slate-300 border-slate-500/40";
                const dateStr = c.startedAt ? new Date(c.startedAt).toLocaleString() : "Invalid date";
                
                return (
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
                          statusColor
                        )}
                      >
                        {c.status || 'unknown'}
                      </Badge>
                      <span className="ml-auto text-xs text-slate-300 font-mono shrink-0">
                        {dateStr}
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
                );
              })}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}