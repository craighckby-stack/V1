"use client";

import { motion, AnimatePresence } from "framer-motion";
import { Scale, ShieldCheck, GitGraph, CheckCircle2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { usePipelineStore } from "@/lib/pipeline-store";
import { cn } from "@/lib/utils";

const SPEAKER_COLOR: Record<string, string> = {
  security: "from-rose-500/30 to-rose-700/20 ring-rose-500/40",
  architecture: "from-cyan-500/30 to-cyan-700/20 ring-cyan-500/40",
  lead: "from-emerald-500/30 to-emerald-700/20 ring-emerald-500/40",
};

const STANCE_COLOR: Record<string, string> = {
  OPPOSE: "bg-rose-500/15 text-rose-300 border-rose-500/40",
  ENDORSE: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  SYNTHESIS: "bg-cyan-500/15 text-cyan-300 border-cyan-500/40",
};

export function DebateChamber() {
  const report = usePipelineStore((s) => s.pipelineReport);

  if (!report) {
    return (
      <Card className="bg-slate-950/60 border-slate-800/60 backdrop-blur">
        <CardHeader className="pb-3">
          <CardTitle className="text-slate-100 flex items-center gap-2 text-base">
            <Scale className="h-4 w-4 text-emerald-400" />
            Code Review Tribunal
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-slate-500 italic py-6 text-center">
            Run the pipeline to convene the dual-perspective review (Security vs Architecture).
          </p>
        </CardContent>
      </Card>
    );
  }

  const verdict = report.reviewVerdict;
  const consensusPct = verdict?.consensusCoefficient ? Math.round(verdict.consensusCoefficient * 100) : 0;
  const frictionPct = verdict?.cognitiveFriction ? Math.round(verdict.cognitiveFriction * 100) : 0;

  return (
    <Card className="bg-slate-950/60 border-slate-800/60 backdrop-blur">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="text-slate-100 flex items-center gap-2 text-base">
            <Scale className="h-4 w-4 text-emerald-400" />
            Code Review Tribunal
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className={cn(
                "uppercase text-[10px] tracking-widest",
                verdict?.consensus === "APPROVED"
                  ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
                  : verdict?.consensus === "CONDITIONAL_APPROVAL"
                  ? "bg-amber-500/15 text-amber-300 border-amber-500/40"
                  : "bg-rose-500/15 text-rose-300 border-rose-500/40"
              )}
            >
              {verdict?.consensus?.replace("_", " ") || "UNKNOWN"}
            </Badge>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-widest text-slate-500">Consensus</div>
              <div className="text-lg font-semibold text-emerald-300 tabular-nums leading-none">
                {consensusPct}%
              </div>
            </div>
          </div>
        </div>
        <div className="space-y-2 mt-3">
          <div>
            <div className="flex items-center justify-between text-[10px] text-slate-500 mb-1">
              <span>Consensus Coefficient</span>
              <span className="tabular-nums text-emerald-300">{consensusPct}%</span>
            </div>
            <Progress
              value={consensusPct}
              className="h-1.5 bg-slate-800/60 [&>div]:bg-emerald-500"
            />
          </div>
          <div>
            <div className="flex items-center justify-between text-[10px] text-slate-500 mb-1">
              <span>Cognitive Friction</span>
              <span className="tabular-nums text-amber-300">{frictionPct}%</span>
            </div>
            <Progress
              value={frictionPct}
              className="h-1.5 bg-slate-800/60 [&>div]:bg-amber-500"
            />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-2.5">
          <AnimatePresence>
            {(verdict?.arguments || []).map((arg, idx) => (
              <motion.div
                key={`${arg.speaker}-${idx}`}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: idx * 0.08 }}
                className={cn(
                  "rounded-lg border p-3 bg-gradient-to-br",
                  SPEAKER_COLOR[arg.speaker] ?? SPEAKER_COLOR.lead,
                  "border-slate-700/60"
                )}
              >
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-xl">{arg.avatar}</span>
                  <span className="text-sm font-semibold text-slate-100">{arg.speakerName}</span>
                  <Badge
                    variant="outline"
                    className={cn("text-[9px] uppercase tracking-widest", STANCE_COLOR[arg.stance] ?? "")}
                  >
                    {arg.stance}
                  </Badge>
                  <span className="ml-auto text-[10px] text-slate-400 font-mono">
                    friction {(arg.cognitiveFriction * 100).toFixed(0)}%
                  </span>
                </div>
                <p className="text-xs text-slate-200 leading-relaxed">{arg.statement}</p>
                {(arg.citations || []).length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {arg.citations.map((c) => (
                      <span
                        key={c}
                        className="text-[10px] text-slate-400 font-mono px-1.5 py-0.5 rounded bg-slate-950/40 border border-slate-800/60"
                      >
                        {c}
                      </span>
                    ))}
                  </div>
                )}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        <div className="mt-3 pt-3 border-t border-slate-800/60 space-y-2">
          <div className="flex items-start gap-2">
            <ShieldCheck className="h-3.5 w-3.5 text-rose-300 mt-0.5 shrink-0" />
            <div className="flex-1">
              <div className="text-[10px] uppercase tracking-widest text-slate-500">Security Findings</div>
              <ul className="text-xs text-slate-300 space-y-0.5 mt-0.5">
                {(verdict?.securityPoints || []).map((p, i) => (
                  <li key={i}>• {p}</li>
                ))}
              </ul>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <GitGraph className="h-3.5 w-3.5 text-cyan-300 mt-0.5 shrink-0" />
            <div className="flex-1">
              <div className="text-[10px] uppercase tracking-widest text-slate-500">Architecture Findings</div>
              <ul className="text-xs text-slate-300 space-y-0.5 mt-0.5">
                {(verdict?.architecturePoints || []).map((p, i) => (
                  <li key={i}>• {p}</li>
                ))}
              </ul>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-300 mt-0.5 shrink-0" />
            <div className="flex-1">
              <div className="text-[10px] uppercase tracking-widest text-slate-500">Lead Verdict</div>
              <p className="text-xs text-slate-200 mt-0.5">{verdict?.leadSummary || "No summary available"}</p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}