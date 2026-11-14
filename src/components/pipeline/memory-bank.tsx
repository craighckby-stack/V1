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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/memory/entries");
        if (!res.ok) {
          throw new Error(`Failed to fetch memory entries: HTTP status ${res.status} for endpoint /api/memory/entries`);
        }
        const data = await res.json();
        if (!cancelled && typeof data === 'object' && data !== null && Array.isArray(data.entries)) {
          setEntries(data.entries);
        } else if (!cancelled && !Array.isArray(data?.entries)) {
          console.error("API response validation failed: 'entries' field is not an array or data is malformed.", data);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "An unknown error occurred during memory fetch.";
        console.error(`Error loading memory entries from API: ${errorMessage}`, error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setEntries]);

  return (
    <Card className="bg-slate-950/60 border-slate-800/60 backdrop-blur shadow-xl">
      <CardHeader className="pb-4">
        <CardTitle className="text-slate-100 flex items-center gap-3 text-lg">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500/30 to-cyan-500/30 ring-1 ring-emerald-500/40">
            <BookOpen className="h-5 w-5 text-emerald-300" aria-hidden="true" />
          </span>
          Memory Bank <span className="text-sm text-slate-500 font-normal hidden sm:inline">(RAG)</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="text-sm text-slate-500 italic py-8 text-center">No memory entries found. Attempting to fetch from API...</p>
        ) : (
          <ScrollArea className="h-[300px] pr-4">
            <div className="space-y-3">
              {entries.map((entry) => {
                const meta = PROVENANCE_META[entry.provenance] ?? PROVENANCE_META.clean;
                const Icon = meta.icon;
                return (
                  <div
                    key={entry.id}
                    className="rounded-lg border border-slate-800/60 bg-slate-900/40 p-4 transition-all duration-150 hover:border-emerald-600/50 hover:bg-slate-900/50 focus-visible:ring-2 focus-visible:ring-emerald-500/50"
                    role="region"
                    aria-labelledby={`entry-title-${entry.id}`}
                  >
                    <div className="flex items-center gap-3 mb-2">
                      <Icon className={cn("h-4 w-4", meta.color)} aria-hidden="true" />
                      <Badge
                        variant="outline"
                        className={cn("text-[10px] uppercase tracking-wider", meta.bg)}
                      >
                        {entry.provenance}
                      </Badge>
                      <Badge
                        variant="outline"
                        className="text-[10px] uppercase tracking-wider bg-slate-700/40 text-slate-300 border-slate-600/40"
                      >
                        {entry.trust ?? "unknown"}
                      </Badge>
                      {entry.filePath && (
                        <span className="ml-auto text-xs text-slate-500 font-mono truncate" title={entry.filePath}>
                          {entry.filePath}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-slate-200 leading-relaxed mb-2">{entry.content}</p>
                    {entry.diagnosis && (
                      <p className="text-xs text-slate-400 mt-1 italic">
                        <span className="sr-only">Diagnosis: </span>→ {entry.diagnosis}
                      </p>
                    )}
                    {entry.cleanSnippet && (
                      <pre className="text-xs font-mono text-cyan-300 mt-2 bg-slate-950/60 border border-slate-800/60 rounded px-3 py-2 overflow-x-auto whitespace-pre-wrap">
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