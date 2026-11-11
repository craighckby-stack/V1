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
      <Card className="bg-slate-950/60 border-slate-800/60 backdrop-blur transition-shadow hover:shadow-lg">
        <CardHeader className="pb-3">
          <CardTitle className="text-slate-100 flex items-center gap-2 text-lg">
            <Scale className="h-5 w-5 text-emerald-400" aria-hidden="true" />
            Code Review Tribunal
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-500 italic py-8 text-center">
            Run the pipeline to convene the dual-perspective review (Security vs Architecture).
          </p>
        </CardContent>
      </Card>
    );
  }

  const verdict = report.reviewVerdict;
  if (!verdict) {
    return (
      <Card className="bg-slate-950/60 border-slate-800/60 backdrop-blur transition-shadow hover:shadow-lg">
        <CardHeader className="pb-3">
          <CardTitle className="text-slate-100 flex items-center gap-2 text-lg">
            <Scale className="h-5 w-5 text-emerald-400" aria-hidden="true" />
            Code Review Tribunal
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-500 italic py-8 text-center">
            Review verdict not available yet.
          </p>
        </CardContent>
      </Card>
    );
  }

  const consensusPct = Math.round(
    typeof verdict.consensusCoefficient === 'number' && !isNaN(verdict.consensusCoefficient) 
      ? verdict.consensusCoefficient * 100 
      : 0
  );
  const frictionPct = Math.round(
    typeof verdict.cognitiveFriction === 'number' && !isNaN(verdict.cognitiveFriction)
      ? verdict.cognitiveFriction * 100
      : 0
  );

  return (
    <Card className="bg-slate-950/60 border-slate-800/60 backdrop-blur transition-shadow hover:shadow-lg">
      <CardHeader className="pb-4">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <CardTitle className="text-slate-100 flex items-center gap-2 text-lg">
            <Scale className="h-5 w-5 text-emerald-400" aria-hidden="true" />
            Code Review Tribunal
          </CardTitle>
          <div className="flex items-center gap-3">
            <Badge
              variant="outline"
              className={cn(
                "uppercase text-xs tracking-widest transition-colors duration-150",
                verdict.consensus === "APPROVED"
                  ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40 hover:bg-emerald-500/20"
                  : verdict.consensus === "CONDITIONAL_APPROVAL"
                  ? "bg-amber-500/15 text-amber-300 border-amber-500/40 hover:bg-amber-500/20"
                  : "bg-rose-500/15 text-rose-300 border-rose-500/40 hover:bg-rose-500/20"
              )}
              aria-label={`Consensus status: ${verdict.consensus?.replace("_", " ")}`}
            >
              {verdict.consensus?.replace("_", " ") || "UNKNOWN"}
            </Badge>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-widest text-slate-500">Consensus</div>
              <div className="text-xl font-bold text-emerald-300 tabular-nums leading-none">
                {consensusPct}%
              </div>
            </div>
          </div>
        </div>
        <div className="space-y-3 mt-4">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between">
            <div className="text-[10px] text-slate-500 mb-1 sm:mb-0">Consensus Coefficient</div>
            <span className="tabular-nums text-emerald-300 text-base font-medium">{consensusPct}%</span>
          </div>
          <Progress
            value={consensusPct}
            className="h-2 bg-slate-800/60 [&>div]:bg-emerald-500 transition-all duration-300"
          />
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between">
            <div className="text-[10px] text-slate-500 mb-1 sm:mb-0">Cognitive Friction</div>
            <span className="tabular-nums text-amber-300 text-base font-medium">{frictionPct}%</span>
          </div>
          <Progress
            value={frictionPct}
            className="h-2 bg-slate-800/60 [&>div]:bg-amber-500 transition-all duration-300"
          />
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <AnimatePresence>
            {verdict.arguments?.map((arg, idx) => (
              <motion.div
                key={`${arg.speaker}-${idx}`}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 12 }}
                transition={{ delay: idx * 0.08, duration: 0.3 }}
                className={cn(
                  "rounded-xl border p-4 bg-gradient-to-br transition-shadow duration-200 hover:shadow-md",
                  SPEAKER_COLOR[arg.speaker] ?? SPEAKER_COLOR.lead,
                  "border-slate-700/60"
                )}
              >
                <div className="flex items-center gap-3 mb-2">
                  <span className="text-2xl">{arg.avatar}</span>
                  <span className="text-base font-semibold text-slate-100">{arg.speakerName}</span>
                  <Badge
                    variant="outline"
                    className={cn("text-[10px] uppercase tracking-widest transition-colors duration-150", STANCE_COLOR[arg.stance] ?? "")}
                    aria-label={`Stance: ${arg.stance}`}
                  >
                    {arg.stance}
                  </Badge>
                  <span className="ml-auto text-sm text-slate-400 font-mono">
                    Friction: {(typeof arg.cognitiveFriction === 'number' && !isNaN(arg.cognitiveFriction)) ? (arg.cognitiveFriction * 100).toFixed(0) : '0'}%
                  </span>
                </div>
                <p className="text-sm text-slate-200 leading-relaxed">{arg.statement}</p>
                {arg.citations && arg.citations.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {arg.citations.map((c) => (
                      <span
                        key={c}
                        className="text-[10px] text-slate-400 font-mono px-2 py-0.5 rounded bg-slate-950/40 border border-slate-800/60 focus-visible:ring-1 focus-visible:ring-cyan-500"
                        role="listitem"
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

        <div className="mt-6 pt-4 border-t border-slate-800/60 space-y-3">
          <div className="flex items-start gap-3">
            <ShieldCheck className="h-4 w-4 text-rose-300 mt-0.5 shrink-0 flex-shrink-0" aria-hidden="true" />
            <div className="flex-1 min-w-0">
              <div className="text-[10px] uppercase tracking-widest text-slate-500">Security Findings</div>
              <ul className="text-sm text-slate-300 space-y-1 mt-1 list-disc list-inside">
                {verdict.securityPoints?.map((p, i) => (
                  <li key={i} className="pl-1">{p}</li>
                ))}
              </ul>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <GitGraph className="h-4 w-4 text-cyan-300 mt-0.5 shrink-0 flex-shrink-0" aria-hidden="true" />
            <div className="flex-1 min-w-0">
              <div className="text-[10px] uppercase tracking-widest text-slate-500">Architecture Findings</div>
              <ul className="text-sm text-slate-300 space-y-1 mt-1 list-disc list-inside">
                {verdict.architecturePoints?.map((p, i) => (
                  <li key={i} className="pl-1">{p}</li>
                ))}
              </ul>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <CheckCircle2 className="h-4 w-4 text-emerald-300 mt-0.5 shrink-0 flex-shrink-0" aria-hidden="true" />
            <div className="flex-1 min-w-0">
              <div className="text-[10px] uppercase tracking-widest text-slate-500">Lead Verdict</div>
              <p className="text-sm text-slate-200 mt-1">{verdict.leadSummary || "No summary available"}</p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}