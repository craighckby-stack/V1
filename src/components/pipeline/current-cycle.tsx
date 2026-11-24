"use client";

import { motion, AnimatePresence } from "framer-motion";
import { Activity, FileCode, Check, X, GitBranch, Cpu } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { usePipelineStore } from "@/lib/pipeline-store";
import { cn } from "@/lib/utils";

// Memoize consensus display functions to prevent unnecessary re-computations
const consensusMap: Record<string, string> = {
  "APPROVED": "APR",
  "CONDITIONAL_APPROVAL": "COND",
  "REQUIRES_REWRITE": "REJ",
};

const getConsensusDisplay = (consensus: string): string => {
  return consensusMap[consensus] || consensus;
};

const consensusClassMap: Record<string, string> = {
  "APPROVED": "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  "CONDITIONAL_APPROVAL": "bg-amber-500/15 text-amber-300 border-amber-500/40",
  "REQUIRES_REWRITE": "bg-rose-500/15 text-rose-300 border-rose-500/40",
};

const getConsensusClass = (consensus: string): string => {
  // Covers REQUIRES_REWRITE and any other unexpected string via default
  return consensusClassMap[consensus] || "bg-rose-500/15 text-rose-300 border-rose-500/40";
};

export function CurrentCycle() {
  const cycle = usePipelineStore((s) => s.loopState?.currentCycle);

  if (!cycle) {
    return (
      <Card className="bg-slate-950/60 border-slate-800/60 backdrop-blur transition-colors shadow-lg" aria-label="No active pipeline cycle detected">
        <CardHeader className="pb-4">
          <CardTitle className="text-slate-100 flex items-center gap-2 text-lg font-semibold leading-snug">
            <Activity className="h-5 w-5 text-emerald-400" aria-hidden="true" />
            Current Cycle
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-500 italic">
            No active cycle. Trigger one from the Autonomous Loop panel above.
          </p>
        </CardContent>
      </Card>
    );
  }

  // Validate cycle status to handle unexpected values
  const validStatuses = ["running", "completed", "halted"];
  const status = validStatuses.includes(cycle.status) ? cycle.status : "unknown";

  const fileResults = cycle.fileResults || [];
  const totalFiles = fileResults.length;
  
  // Calculate pushedFiles efficiently
  const pushedFiles = fileResults.reduce((count, r) => count + (r.pushed ? 1 : 0), 0);
  
  // Safely determine firstProofHash only if files exist
  const firstProofHash = totalFiles > 0 ? fileResults[0]?.proofHash : undefined;

  let cardBgClass = "bg-rose-950/30 border-rose-800/50";
  let cardBadgeClass = "bg-rose-500/15 text-rose-300 border-rose-500/40 hover:bg-rose-500/20";
  let activityColor = "text-slate-400";

  if (status === "running") {
    cardBgClass = "bg-cyan-950/40 border-cyan-700/50";
    cardBadgeClass = "bg-cyan-500/15 text-cyan-300 border-cyan-500/40 hover:bg-cyan-500/20";
    activityColor = "text-cyan-400 animate-pulse";
  } else if (status === "completed") {
    cardBgClass = "bg-emerald-950/30 border-emerald-800/50";
    cardBadgeClass = "bg-emerald-500/15 text-emerald-300 border-emerald-500/40 hover:bg-emerald-500/20";
    activityColor = "text-slate-400";
  } else if (status === "halted") {
    cardBgClass = "bg-amber-950/30 border-amber-800/50";
    cardBadgeClass = "bg-amber-500/15 text-amber-300 border-amber-500/40 hover:bg-amber-500/20";
    activityColor = "text-slate-400";
  }

  return (
    <Card
      className={cn(
        "backdrop-blur border transition-colors duration-200 shadow-lg",
        cardBgClass
      )}
      aria-live="polite"
    >
      <CardHeader className="pb-4">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <CardTitle className="text-slate-100 flex items-center gap-2 text-lg leading-snug">
            <Activity
              className={cn(
                "h-5 w-5",
                activityColor
              )}
              aria-hidden="true"
            />
            Cycle #{cycle.cycleNumber ?? 0}
            <span className="text-xs text-slate-400 font-normal uppercase tracking-widest hidden sm:inline ml-1">
              {cycle.mode}
            </span>
          </CardTitle>
          <Badge
            variant="outline"
            className={cn(
              "uppercase text-[10px] tracking-widest px-3 py-1 transition-colors",
              cardBadgeClass
            )}
            aria-label={`Current cycle status: ${status}`}
          >
            {status}
          </Badge>
        </div >
        <div className="text-xs text-slate-500 font-mono mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-slate-800/60 pt-3">
          <span className="inline-flex items-center gap-1">
            <GitBranch className="h-3 w-3 text-slate-500" aria-hidden="true" />
            {cycle.targetRepo ?? 'N/A'}:{cycle.branch ?? 'N/A'}
          </span >
          <span aria-label={`Started at ${cycle.startedAt ? new Date(cycle.startedAt).toLocaleTimeString() : 'unknown time'}`}>
            started: {cycle.startedAt ? new Date(cycle.startedAt).toLocaleTimeString() : 'unknown'}
          </span>
          <span aria-label={`Scanned ${cycle.filesScanned ?? 0} files`}>
            scanned: {cycle.filesScanned ?? 0}
          </span>
          <span aria-label={`Committed ${cycle.filesCommitted ?? 0} files`}>
            committed: {cycle.filesCommitted ?? 0}
          </span>
        </div >
      </CardHeader>
      <CardContent>
        {totalFiles === 0 ? (
          <p className="text-sm text-slate-500 italic">No file results yet…</p>
        ) : (
          <div className="space-y-2 max-h-80 overflow-y-auto pr-2 custom-scrollbar">
            <AnimatePresence initial={false}>
              {fileResults.map((r, idx) => (
                <motion.div
                  key={`${r.path}-${idx}`}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.2 }}
                  whileHover={{ scale: 1.005, boxShadow: "0 4px 12px rgba(0,0,0,0.3)" }}
                  className="flex items-center gap-3 rounded-lg border border-slate-800/60 bg-slate-900/40 px-3 py-2 transition-all duration-150 focus-visible:ring-2 focus-visible:ring-cyan-500"
                  role="listitem"
                  aria-label={`File result for ${r.path} with consensus ${getConsensusDisplay(r.consensus)}`}
                >
                  <FileCode className="h-4 w-4 text-slate-400 shrink-0" aria-hidden="true" />
                  <span className="text-sm font-mono text-slate-200 truncate flex-1" title={r.path}>
                    {r.path}
                  </span>
                  <span className="text-xs text-amber-300 font-mono tabular-nums shrink-0 hidden sm:inline">AST {r.astScore}</span>
                  <span
                    className={cn(
                      "text-xs px-2 py-0.5 rounded border uppercase tracking-wider shrink-0",
                      getConsensusClass(r.consensus)
                    )}
                  >
                    {getConsensusDisplay(r.consensus)}
                  </span>
                  <span className="text-xs font-mono text-slate-500 shrink-0 hidden md:block">{r.proofHash}</span>
                  <span className="shrink-0" aria-hidden="true">
                    {r.pushed ? (
                      <Check className="h-3.5 w-3.5 text-emerald-400" />
                    ) : (
                      <X className="h-3.5 w-3.5 text-slate-600" />
                    )}
                  </span>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
        <div className="flex items-center gap-3 pt-4 mt-3 border-t border-slate-800/60 text-xs text-slate-500">
          <Cpu className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
          <span className="text-sm">
            {totalFiles} file(s) processed · {pushedFiles} pushed
            · proof {firstProofHash ? firstProofHash.substring(0, 8) + '...' : "—"}
          </span>
        </div >
      </CardContent>
    </Card>
  );
}