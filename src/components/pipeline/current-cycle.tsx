"use client";

import { motion, AnimatePresence } from "framer-motion";
import { Activity, FileCode, Check, X, GitBranch, Cpu } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { usePipelineStore } from "@/lib/pipeline-store";
import { cn } from "@/lib/utils";

export function CurrentCycle() {
  const cycle = usePipelineStore((s) => s.loopState?.currentCycle) ?? null;

  if (!cycle) {
    return (
      <Card className="bg-slate-950/60 border-slate-800/60 backdrop-blur">
        <CardHeader className="pb-3">
          <CardTitle className="text-slate-100 flex items-center gap-2 text-base">
            <Activity className="h-4 w-4 text-emerald-400" />
            Current Cycle
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-slate-500 italic">
            No active cycle. Trigger one from the Autonomous Loop panel above.
          </p>
        </CardContent>
      </Card>
    );
  }

  // Validate cycle status to handle unexpected values
  const status = cycle.status === "running" || cycle.status === "completed" || 
                 cycle.status === "halted" ? cycle.status : "unknown";

  // Validate consensus values to handle unexpected results
  const getConsensusDisplay = (consensus: string) => {
    if (consensus === "APPROVED") return "APR";
    if (consensus === "CONDITIONAL_APPROVAL") return "COND";
    if (consensus === "REQUIRES_REWRITE") return "REJ";
    return consensus;
  };

  const getConsensusClass = (consensus: string) => {
    if (consensus === "APPROVED")
      return "bg-emerald-500/15 text-emerald-300 border-emerald-500/40";
    if (consensus === "CONDITIONAL_APPROVAL")
      return "bg-amber-500/15 text-amber-300 border-amber-500/40";
    if (consensus === "REQUIRES_REWRITE")
      return "bg-rose-500/15 text-rose-300 border-rose-500/40";
    return "bg-rose-500/15 text-rose-300 border-rose-500/40";
  };

  return (
    <Card
      className={cn(
        "backdrop-blur border transition-colors",
        status === "running"
          ? "bg-cyan-950/40 border-cyan-700/50"
          : status === "completed"
          ? "bg-emerald-950/30 border-emerald-800/50"
          : status === "halted"
          ? "bg-amber-950/30 border-amber-800/50"
          : "bg-rose-950/30 border-rose-800/50"
      )}
    >
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-slate-100 flex items-center gap-2 text-base">
            <Activity
              className={cn(
                "h-4 w-4",
                status === "running" ? "text-cyan-400 animate-pulse" : "text-slate-400"
              )}
            />
            Cycle #{cycle.cycleNumber}{" "}
            <span className="text-xs text-slate-400 font-normal uppercase tracking-widest">
              {cycle.mode}
            </span>
          </CardTitle>
          <Badge
            variant="outline"
            className={cn(
              "uppercase text-[10px] tracking-widest",
              status === "running"
                ? "bg-cyan-500/15 text-cyan-300 border-cyan-500/40"
                : status === "completed"
                ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
                : status === "halted"
                ? "bg-amber-500/15 text-amber-300 border-amber-500/40"
                : "bg-rose-500/15 text-rose-300 border-rose-500/40"
            )}
          >
            {status}
          </Badge>
        </div>
        <div className="text-xs text-slate-500 font-mono mt-2 flex flex-wrap gap-x-4 gap-y-1">
          <span className="inline-flex items-center gap-1">
            <GitBranch className="h-3 w-3" />
            {cycle.targetRepo}:{cycle.branch}
          </span>
          <span>started: {new Date(cycle.startedAt).toLocaleTimeString()}</span>
          <span>scanned: {cycle.filesScanned}</span>
          <span>committed: {cycle.filesCommitted}</span>
        </div>
      </CardHeader>
      <CardContent>
        {(!cycle.fileResults || cycle.fileResults.length === 0) ? (
          <p className="text-xs text-slate-500 italic">No file results yet…</p>
        ) : (
          <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
            <AnimatePresence>
              {cycle.fileResults.map((r, idx) => (
                <motion.div
                  key={`${r.path}-${idx}`}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="flex items-center gap-3 rounded-md border border-slate-800/60 bg-slate-900/40 px-3 py-2"
                >
                  <FileCode className="h-4 w-4 text-slate-400 shrink-0" />
                  <span className="text-xs font-mono text-slate-200 truncate flex-1" title={r.path}>
                    {r.path}
                  </span>
                  <span className="text-[10px] text-amber-300 font-mono tabular-nums">AST {r.astScore}</span>
                  <span
                    className={cn(
                      "text-[10px] px-1.5 py-0.5 rounded border uppercase tracking-wider",
                      getConsensusClass(r.consensus)
                    )}
                  >
                    {getConsensusDisplay(r.consensus)}
                  </span>
                  <span className="text-[10px] font-mono text-slate-500">{r.proofHash}</span>
                  {r.pushed ? (
                    <Check className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                  ) : (
                    <X className="h-3.5 w-3.5 text-slate-600 shrink-0" />
                  )}
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
        <div className="flex items-center gap-3 pt-3 mt-3 border-t border-slate-800/60 text-[10px] text-slate-500">
          <Cpu className="h-3.5 w-3.5" />
          <span>
            {cycle.fileResults?.length || 0} file(s) processed · {cycle.fileResults?.filter(r => r.pushed).length || 0} pushed
            · proof {cycle.fileResults && cycle.fileResults.length > 0 ? cycle.fileResults[0].proofHash : "—"}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}