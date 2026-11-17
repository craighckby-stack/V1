"use client";

import { useEffect } from "react";
import { BrainCircuit, ShieldX, ShieldCheck, BookOpen } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { usePipelineStore } from "@/lib/pipeline-store";
import { cn } from "@/lib/utils";

const PROVENANCE_META: Record<string, { icon: typeof ShieldCheck; color: string; bg: string }> = {
  clean: { icon: ShieldCheck, color: "text-emerald-300", bg: "bg-emerald-500/15 border-emerald-500/40" },
  failure: { icon: ShieldX, color: "text-rose-300", bg: "bg-rose-500/15 border-rose-500/40" },
  synthesis: { icon: BrainCircuit, color: "text-cyan-300", bg: "bg-cyan-500/15 border-cyan-500/40" },
  contradicted: { icon: ShieldX, color: "text-amber-300", bg: "bg-amber-500/15 border-amber-500/40" },
};

export function MemoryBank() {
  const entries = usePipelineStore((s) => s.memoryEntries);
  const setEntries = usePipelineStore((s) => s.setMemoryEntries);
  // Assuming the store might also hold a loading state, but based only on provided code,
  // we rely on entries.length === 0 to indicate initial/empty state.
  // If a dedicated loading state existed in the store, it should be used here.

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/memory/entries");
        if (!res.ok) {
          throw new Error(`Failed to fetch memory entries: HTTP status ${res.status} for endpoint /api/memory/entries`);
        }
        const data = await res.json();
        
        // Validate API response structure
        if (!data || !Array.isArray(data.entries)) {
          throw new Error("Invalid API response structure: expected 'entries' array in response body.");
        }
        
        // State update is safe here as useEffect dependencies are stable or handled by React lifecycle
        setEntries(data.entries);
      } catch (error) {
        // Log the error with context
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error("Error loading memory entries from API:", { error: errorMessage, context: "MemoryBank fetch" });
      }
    })();
  }, [setEntries]);

  return (
    <Card className="bg-slate-950/60 border border-slate-800/60 backdrop-blur transition-shadow duration-200 hover:shadow-2xl">
      <CardHeader className="pb-4 pt-6 sm:pb-6">
        <CardTitle className="text-slate-100 flex items-center gap-3 text-xl sm:text-2xl">
          <span 
            className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500/30 to-cyan-500/30 ring-1 ring-emerald-500/40 transition-transform duration-150 hover:scale-[1.05] focus-visible:ring-2 focus-visible:ring-emerald-400"
            aria-label="Memory Bank Icon representing stored knowledge"
          >
            <BookOpen className="h-5 w-5 text-emerald-300" aria-hidden="true" />
          </span>
          Memory Bank 
          <span className="text-xs text-slate-400 font-normal ml-2 hidden sm:inline">(RAG)</span> 
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {entries.length === 0 ? (
          <div className="py-16 text-center px-6">
            <p className="text-base text-slate-500 italic">Loading memory entries... If this persists, check the network console for API errors.</p>
          </div>
        ) : (
          <ScrollArea className="h-[300px] pr-4">
            <div className="space-y-4 p-4 sm:p-6">
              {entries.map((entry) => {
                // Validate entry structure
                if (!entry || typeof entry !== 'object' || !entry.id) {
                  console.warn("Invalid memory entry missing required fields or is not an object:", entry);
                  return null;
                }

                const meta = PROVENANCE_META[entry.provenance] ?? PROVENANCE_META.clean;
                const Icon = meta.icon;
                return (
                  <div
                    key={entry.id}
                    className="rounded-xl border border-slate-800/60 bg-slate-900/40 p-4 transition-all duration-200 hover:border-emerald-600/50 focus-visible:ring-2 focus-visible:ring-emerald-500"
                    role="region"
                    aria-labelledby={`entry-title-${entry.id}`}
                  >
                    <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 mb-3">
                      <Icon className={cn("h-4 w-4", meta.color)} aria-hidden="true" />
                      <Badge
                        variant="outline"
                        className={cn("text-[11px] uppercase tracking-wider transition-colors duration-150", meta.bg)}
                        aria-label={`${entry.provenance} provenance`}
                      >
                        {entry.provenance}
                      </Badge>
                      <Badge
                        variant="outline"
                        className="text-[11px] uppercase tracking-wider bg-slate-700/40 text-slate-300 border-slate-600/40 transition-colors duration-150"
                        aria-label={`Trust level: ${entry.trust ?? "unknown"}`}
                      >
                        {entry.trust ?? "unknown"}
                      </Badge>
                      {entry.filePath && (
                        <span className="ml-auto text-[10px] text-slate-500 font-mono truncate px-1 whitespace-nowrap" title={entry.filePath}>
                          {entry.filePath}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-slate-200 leading-relaxed mb-2">{entry.content ?? ""}</p>
                    {entry.diagnosis && (
                      <p className="text-xs text-slate-400 mt-1 italic border-l-2 border-cyan-600/50 pl-2">→ {entry.diagnosis}</p>
                    )}
                    {entry.cleanSnippet && (
                      <pre className="text-[10px] font-mono text-cyan-300 mt-3 bg-slate-950/60 border border-slate-800/60 rounded px-3 py-2 overflow-x-auto whitespace-pre-wrap break-words shadow-inner">
                        {entry.cleanSnippet}
                      </pre>
                    )}
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