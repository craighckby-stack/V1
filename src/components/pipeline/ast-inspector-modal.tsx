"use client";

import { motion, AnimatePresence } from "framer-motion";
import {
  GitCommit,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  X,
  Copy,
  FileCode,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { usePipelineStore } from "@/lib/pipeline-store";
import { cn } from "@/lib/utils";

export function AstInspectorModal() {
  const inspectorFile = usePipelineStore((s) => s.inspectorFile);
  const setInspectorFile = usePipelineStore((s) => s.setInspectorFile);
  const { toast } = useToast();

  if (!inspectorFile) return null;
  
  // Validate required properties exist
  if (!inspectorFile.path || !inspectorFile.original || !inspectorFile.evolved || !inspectorFile.report) {
    toast({
      title: "Invalid file data",
      description: "The file data is missing required properties",
      variant: "destructive"
    });
    return null;
  }
  
  const { path, original, evolved, report } = inspectorFile;
  
  // Validate AST and sanitizer results exist
  if (!report.astDiffResult || !report.sanitizerResult) {
    toast({
      title: "Missing analysis data",
      description: "The file analysis is incomplete",
      variant: "destructive"
    });
    return null;
  }
  
  const ast = report.astDiffResult;
  const sanitizer = report.sanitizerResult;

  const violationIcon: Record<string, typeof CheckCircle2> = {
    high: XCircle,
    medium: AlertTriangle,
    low: AlertTriangle,
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4"
        onClick={() => setInspectorFile(null)}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 12 }}
          transition={{ duration: 0.2 }}
          className="bg-slate-900 border border-slate-700/60 rounded-xl shadow-2xl max-w-6xl w-full max-h-[90vh] overflow-hidden flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="px-6 py-4 border-b border-slate-800/60 flex items-center justify-between gap-4 bg-slate-950/40">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                <FileCode className="h-4 w-4 text-cyan-400 shrink-0" />
                <span className="truncate font-mono text-sm" title={path}>
                  {path}
                </span>
              </div>
              <div className="text-[11px] text-slate-400 mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="inline-flex items-center gap-1">
                  <GitCommit className="h-3 w-3" /> proof {report.proofCommitHash}
                </span>
                <span>AST {ast.astScore}/100</span>
                <span className="inline-flex items-center gap-1">
                  status
                  <Badge
                    variant="outline"
                    className={cn(
                      "ml-1 text-[9px] uppercase tracking-widest",
                      report.status === "COMPLETED"
                        ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
                        : report.status === "REJECTED"
                        ? "bg-rose-500/15 text-rose-300 border-rose-500/40"
                        : "bg-amber-500/15 text-amber-300 border-amber-500/40"
                    )}
                  >
                    {report.status}
                  </Badge>
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  navigator.clipboard.writeText(evolved)
                    .then(() => {
                      toast({ title: "Copied evolved code", description: `${evolved.length} bytes to clipboard` });
                    })
                    .catch((error) => {
                      toast({
                        title: "Failed to copy code",
                        description: "Could not copy to clipboard. Please try again.",
                        variant: "destructive"
                      });
                      console.error("Clipboard error:", error);
                    });
                }}
                className="bg-slate-900/60 border-slate-700 hover:bg-slate-800 text-slate-200"
              >
                <Copy className="h-3.5 w-3.5 mr-1.5" />
                Copy evolved
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setInspectorFile(null)}
                className="text-slate-400 hover:text-slate-100 hover:bg-slate-800"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-hidden grid grid-cols-1 lg:grid-cols-2 gap-px bg-slate-800/40">
            <div className="bg-slate-950/60 overflow-y-auto p-4">
              <div className="text-xs uppercase tracking-widest text-slate-500 mb-2 flex items-center justify-between">
                <span>Original</span>
                <span className="font-mono text-slate-400">{original.length} bytes</span>
              </div>
              <pre className="text-[11px] font-mono text-slate-300 whitespace-pre-wrap leading-relaxed">
                {original}
              </pre>
            </div>
            <div className="bg-slate-950/60 overflow-y-auto p-4 border-l border-slate-800/60">
              <div className="text-xs uppercase tracking-widest text-slate-500 mb-2 flex items-center justify-between">
                <span className="text-emerald-300">Evolved</span>
                <span className="font-mono text-slate-400">{evolved.length} bytes</span>
              </div>
              <pre className="text-[11px] font-mono text-emerald-200/90 whitespace-pre-wrap leading-relaxed">
                {evolved}
              </pre>
            </div>
          </div>

          {/* Footer: AST details */}
          <div className="border-t border-slate-800/60 bg-slate-950/40 p-4 grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <div className="text-[10px] uppercase tracking-widest text-slate-500">AST Symbol Map</div>
              <div className="text-xs text-slate-300 font-mono">
                <div>Original: <span className="text-amber-300">{ast.symbolMap.originalCount}</span></div>
                <div>Proposed: <span className="text-cyan-300">{ast.symbolMap.proposedCount}</span></div>
                <div>Retained: <span className="text-emerald-300">{ast.symbolMap.retainedCount}</span></div>
              </div>
              <div className="text-[10px] text-slate-500">
                Drift ratio: <span className="font-mono text-amber-300">{(ast.structuralDriftRatio * 100).toFixed(0)}%</span>
              </div>
            </div>
            <div className="space-y-1.5">
              <div className="text-[10px] uppercase tracking-widest text-slate-500">Sanitizer</div>
              <div className="text-xs text-slate-300">
                Clean:{" "}
                <span className={sanitizer.clean ? "text-emerald-300" : "text-rose-300"}>
                  {sanitizer.clean ? "YES" : "NO"}
                </span>
              </div>
              <div className="text-xs text-slate-300">
                Violations: <span className="font-mono text-amber-300">{sanitizer.violations.length}</span>
              </div>
              <div className="text-xs text-slate-300">
                High-entropy: <span className="font-mono text-amber-300">{sanitizer.highEntropyTokensFound}</span>
              </div>
            </div>
            <div className="space-y-1.5">
              <div className="text-[10px] uppercase tracking-widest text-slate-500">AST Violations</div>
              {ast.violations.length === 0 ? (
                <div className="text-xs text-emerald-300 flex items-center gap-1.5">
                  <CheckCircle2 className="h-3 w-3" /> None — passed all gates
                </div>
              ) : (
                <div className="space-y-1 max-h-24 overflow-y-auto pr-1">
                  {ast.violations.map((v, i) => {
                    const Icon = violationIcon[v.severity] ?? AlertTriangle;
                    return (
                      <div key={i} className="flex items-start gap-1.5 text-[11px]">
                        <Icon
                          className={cn(
                            "h-3 w-3 mt-0.5 shrink-0",
                            v.severity === "high"
                              ? "text-rose-400"
                              : v.severity === "medium"
                              ? "text-amber-400"
                              : "text-slate-400"
                          )}
                        />
                        <span className="text-slate-300">{v.message}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}