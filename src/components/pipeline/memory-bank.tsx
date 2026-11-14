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
          throw new Error(`Failed to fetch memory entries: HTTP status ${res.status}`);
        }
        const data = await res.json();
        if (!cancelled && data && Array.isArray(data.entries)) {
          setEntries(data.entries);
        }
      } catch (error) {
        // Log the error with context instead of silently ignoring it
        console.error("Error loading memory entries from API:", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setEntries]);

  return (
    <Card className="bg-slate-950/60 border-slate-800/60 backdrop-blur">
      <CardHeader className="pb-3">
        <CardTitle className="text-slate-100 flex items-center gap-2 text-base">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br from-emerald-500/30 to-cyan-500/30 ring-1 ring-emerald-500/40">
            <BookOpen className="h-4 w-4 text-emerald-300" />
          </span>
          Memory Bank <span className="text-xs text-slate-500 font-normal">(RAG)</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="text-xs text-slate-500 italic py-6 text-center">Fetching memory entries from API...</p>
        ) : (
          <ScrollArea className="h-[280px] pr-3">
            <div className="space-y-2">
              {entries.map((entry) => {
                const meta = PROVENANCE_META[entry.provenance] ?? PROVENANCE_META.clean;
                const Icon = meta.icon;
                return (
                  <div
                    key={entry.id}
                    className="rounded-md border border-slate-800/60 bg-slate-900/40 p-3"
                  >
                    <div className="flex items-center gap-2 mb-1.5">
                      <Icon className={cn("h-3.5 w-3.5", meta.color)} />
                      <Badge
                        variant="outline"
                        className={cn("text-[9px] uppercase tracking-widest", meta.bg)}
                      >
                        {entry.provenance}
                      </Badge>
                      <Badge
                        variant="outline"
                        className="text-[9px] uppercase tracking-widest bg-slate-700/40 text-slate-300 border-slate-600/40"
                      >
                        {entry.trust ?? "unknown"}
                      </Badge>
                      {entry.filePath && (
                        <span className="ml-auto text-[10px] text-slate-500 font-mono truncate" title={entry.filePath}>
                          {entry.filePath}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-200 leading-relaxed">{entry.content}</p>
                    {entry.diagnosis && (
                      <p className="text-[11px] text-slate-400 mt-1 italic">→ {entry.diagnosis}</p>
                    )}
                    {entry.cleanSnippet && (
                      <pre className="text-[10px] font-mono text-cyan-300 mt-1.5 bg-slate-950/60 border border-slate-800/60 rounded px-2 py-1 overflow-x-auto">
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