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
    let cancelled = false;
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
        
        if (!cancelled) {
          setEntries(data.entries);
        }
      } catch (error) {
        // Log the error with context instead of silently ignoring it
        console.error("Error loading memory entries from API:", error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setEntries]);

  return (
    <Card className="bg-slate-950/60 border border-slate-800/60 backdrop-blur transition-shadow duration-150 hover:shadow-lg">
      <CardHeader className="pb-4 pt-6">
        <CardTitle className="text-slate-100 flex items-center gap-3 text-lg sm:text-xl">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500/30 to-cyan-500/30 ring-1 ring-emerald-500/40 transition-transform duration-150 hover:scale-[1.02]">
            <BookOpen className="h-4 w-4 text-emerald-300" aria-hidden="true" />
          </span>
          Memory Bank <span className="text-sm text-slate-400 font-normal ml-1 hidden sm:inline">(RAG)</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {entries.length === 0 ? (
          <div className="py-10 text-center">
            <p className="text-sm text-slate-500 italic">Loading memory entries or no entries found.</p>
          </div>
        ) : (
          <ScrollArea className="h-[300px] pr-4">
            <div className="space-y-3">
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
                    className="rounded-lg border border-slate-800/60 bg-slate-900/40 p-3 transition-all duration-150 hover:border-emerald-600/50"
                    role="region"
                    aria-labelledby={`entry-title-${entry.id}`}
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <Icon className={cn("h-3.5 w-3.5", meta.color)} aria-hidden="true" />
                      <Badge
                        variant="outline"
                        className={cn("text-[10px] uppercase tracking-wider transition-colors duration-150", meta.bg)}
                        aria-label={`${entry.provenance} provenance`}
                      >
                        {entry.provenance}
                      </Badge>
                      <Badge
                        variant="outline"
                        className="text-[10px] uppercase tracking-wider bg-slate-700/40 text-slate-300 border-slate-600/40 transition-colors duration-150"
                        aria-label={`Trust level: ${entry.trust ?? "unknown"}`}
                      >
                        {entry.trust ?? "unknown"}
                      </Badge>
                      {entry.filePath && (
                        <span className="ml-auto text-[10px] text-slate-500 font-mono truncate" title={entry.filePath}>
                          {entry.filePath}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-slate-200 leading-relaxed mb-1">{entry.content ?? ""}</p>
                    {entry.diagnosis && (
                      <p className="text-xs text-slate-400 mt-1 italic">→ {entry.diagnosis}</p>
                    )}
                    {entry.cleanSnippet && (
                      <pre className="text-[10px] font-mono text-cyan-300 mt-2 bg-slate-950/60 border border-slate-800/60 rounded px-2 py-2 overflow-x-auto whitespace-pre-wrap break-words">
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