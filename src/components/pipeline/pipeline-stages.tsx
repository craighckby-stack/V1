"use client";

import { motion, AnimatePresence } from "framer-motion";
import {
  Layers,
  ShieldCheck,
  Cpu,
  GitCompare,
  Scale,
  GitCommit,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Circle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { usePipelineStore, PipelineStageState } from "@/lib/pipeline-store";
import { cn } from "@/lib/utils";

const STAGE_META: Record<
  string,
  { icon: typeof Layers; color: string; bg: string; ring: string }
> = {
  stage0_ingestion: {
    icon: Layers,
    color: "text-violet-300",
    bg: "bg-violet-500/10",
    ring: "ring-violet-500/40",
  },
  stage1_sanitization: {
    icon: ShieldCheck,
    color: "text-rose-300",
    bg: "bg-rose-500/10",
    ring: "ring-rose-500/40",
  },
  stage2_reasoning: {
    icon: Cpu,
    color: "text-cyan-300",
    bg: "bg-cyan-500/10",
    ring: "ring-cyan-500/40",
  },
  stage3_ast_gate: {
    icon: GitCompare,
    color: "text-amber-300",
    bg: "bg-amber-500/10",
    ring: "ring-amber-500/40",
  },
  stage4_review: {
    icon: Scale,
    color: "text-emerald-300",
    bg: "bg-emerald-500/10",
    ring: "ring-emerald-500/40",
  },
  stage5_convergence: {
    icon: GitCommit,
    color: "text-fuchsia-300",
    bg: "bg-fuchsia-500/10",
    ring: "ring-fuchsia-500/40",
  },
};

const STATUS_ICON: Record<string, typeof CheckCircle2> = {
  pending: Circle,
  running: Loader2,
  succeeded: CheckCircle2,
  blocked: AlertTriangle,
  skipped: Circle,
};

const STATUS_COLOR: Record<string, string> = {
  pending: "text-slate-500",
  running: "text-cyan-400",
  succeeded: "text-emerald-400",
  blocked: "text-amber-400",
  skipped: "text-slate-500",
};

type StageDetails = {
  llmUsed?: boolean;
  parserUsed?: string;
  usedLlm?: boolean;
};

function StageCard({ stage }: { stage: PipelineStageState }) {
  if (!stage.id) {
    // Guard clause for malformed state from the store
    console.error("PipelineStageState received without an ID:", stage);
    return null;
  }

  const meta = STAGE_META[stage.id] ?? STAGE_META.stage0_ingestion;
  const Icon = meta.icon;
  const StatusIcon = STATUS_ICON[stage.status] ?? Circle;
  const color = STATUS_COLOR[stage.status] ?? "text-slate-500";
  const isRunning = stage.status === "running";
  const details = stage.details as StageDetails | undefined;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        "relative rounded-lg border p-3.5 transition-all overflow-hidden",
        "bg-slate-900/40",
        isRunning
          ? "border-cyan-500/50 shadow-[0_0_24px_-12px] shadow-cyan-500/50"
          : stage.status === "succeeded"
          ? "border-emerald-500/30"
          : stage.status === "blocked"
          ? "border-amber-500/40"
          : "border-slate-800/60"
      )}
    >
      {isRunning && (
        <div className="absolute inset-0 -z-10 bg-gradient-to-r from-cyan-500/5 via-transparent to-transparent animate-pulse" />
      )}
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "shrink-0 inline-flex h-9 w-9 items-center justify-center rounded-md ring-1",
            meta.bg,
            meta.ring
          )}
        >
          <Icon className={cn("h-4.5 w-4.5", meta.color)} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold text-slate-100 truncate">{stage.name}</span>
            <StatusIcon
              className={cn("h-4 w-4 shrink-0", color, isRunning && "animate-spin")}
            />
          </div>
          <p className="text-xs text-slate-400 mt-1 leading-snug line-clamp-2">{stage.summary}</p>
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            {stage.durationMs !== undefined && (
              <div className="text-[10px] text-slate-500 font-mono">{stage.durationMs}ms</div>
            )}
            {stage.id === "stage2_reasoning" &&
              details?.llmUsed && (
                <span className="text-[9px] uppercase tracking-widest px-1.5 py-0.5 rounded border bg-emerald-500/15 text-emerald-300 border-emerald-500/40">
                  LLM
                </span>
              )}
            {stage.id === "stage3_ast_gate" &&
              details?.parserUsed && (
                <span
                  className={cn(
                    "text-[9px] uppercase tracking-widest px-1.5 py-0.5 rounded border",
                    details.parserUsed === "typescript"
                      ? "bg-cyan-500/15 text-cyan-300 border-cyan-500/40"
                      : "bg-slate-500/15 text-slate-300 border-slate-500/40"
                  )}
                >
                  {details.parserUsed === "typescript"
                    ? "TS Compiler API"
                    : "Regex fallback"}
                </span>
              )}
            {stage.id === "stage4_review" &&
              details?.usedLlm && (
                <span className="text-[9px] uppercase tracking-widest px-1.5 py-0.5 rounded border bg-emerald-500/15 text-emerald-300 border-emerald-500/40">
                  LLM Tribunal
                </span>
              )}
            {stage.id === "stage4_review" &&
              details?.usedLlm === false && (
                <span className="text-[9px] uppercase tracking-widest px-1.5 py-0.5 rounded border bg-amber-500/15 text-amber-300 border-amber-500/40">
                  Rule-based
                </span>
              )}
          </div >
        </div>
      </div>
    </motion.div>
  );
}

export function PipelineStages() {
  const report = usePipelineStore((s) => s.pipelineReport);

  // Build a default state when no report yet exists (all pending).
  const emptyStages: PipelineStageState[] = [
    { id: "stage0_ingestion", name: "0. Pattern Ingestion Helper", status: "pending", summary: "Waiting to initialize pattern sources" },
    { id: "stage1_sanitization", name: "1. Security Sanitizer Helper", status: "pending", summary: "Waiting for credential and entropy scan" },
    { id: "stage2_reasoning", name: "2. Modular Agent Helper", status: "pending", summary: "Waiting for bounded ReAct reasoning loop" },
    { id: "stage3_ast_gate", name: "3. AST Verification Helper", status: "pending", summary: "Waiting for AST symbol retention check" },
    { id: "stage4_review", name: "4. Code Review Helper", status: "pending", summary: "Waiting for dual-perspective review" },
    { id: "stage5_convergence", name: "5. Commit & Convergence Helper", status: "pending", summary: "Waiting for convergence evaluation" },
  ];

  const stages = report ? Object.values(report.stages) : emptyStages;
  const statusCounts = stages.reduce(
    (acc, s) => {
      if (s.status) {
        acc[s.status] = (acc[s.status] ?? 0) + 1;
      }
      return acc;
    },
    {} as Record<string, number>
  );
  const totalStages = stages.length;
  
  let progressPct = 0;
  if (totalStages > 0) {
    progressPct = Math.round(
      ((statusCounts.succeeded ?? 0) +
        (statusCounts.blocked ?? 0) * 0.5 +
        (statusCounts.skipped ?? 0)) /
        totalStages *
        100
    );
  }


  return (
    <Card className="bg-slate-950/60 border-slate-800/60 backdrop-blur">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-slate-100 flex items-center gap-2 text-base">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br from-violet-500/30 to-cyan-500/30 ring-1 ring-violet-500/40">
              <Layers className="h-4 w-4 text-violet-300" />
            </span>
            6-Stage Refactoring Pipeline
          </CardTitle>
          <div className="flex items-center gap-3">
            {report && (
              <Badge
                variant="outline"
                className={cn(
                  "uppercase text-[10px] tracking-widest",
                  report.status === "COMPLETED"
                    ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
                    : report.status === "REJECTED"
                    ? "bg-rose-500/15 text-rose-300 border-rose-500/40"
                    : report.status === "HALTED"
                    ? "bg-amber-500/15 text-amber-300 border-amber-500/40"
                    : "bg-cyan-500/15 text-cyan-300 border-cyan-500/40"
                )}
              >
                {report.status}
              </Badge>
            )}
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-widest text-slate-500">AST Score</div>
              <div className="text-lg font-semibold text-amber-300 tabular-nums leading-none">
                {report?.astScore ?? "—"}
              </div>
            </div>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Progress
            value={progressPct}
            className="h-1.5 bg-slate-800/60 data-[state=loading]:bg-slate-800"
          />
          <span className="text-xs text-slate-400 font-mono tabular-nums">{progressPct}%</span>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
          <AnimatePresence>
            {stages.map((stage) => (
              <StageCard key={stage.id} stage={stage} />
            ))}
          </AnimatePresence>
        </div>
      </CardContent>
    </Card>
  );
}