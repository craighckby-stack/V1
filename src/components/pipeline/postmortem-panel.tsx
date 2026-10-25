"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  AlertOctagon,
  FileWarning,
  RefreshCw,
  X,
  ChevronDown,
  ChevronRight,
  History,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

interface PostmortemRecord {
  id: string;
  targetRepo: string;
  branch: string;
  filePath: string;
  status: "active" | "resolved";
  failureType: string;
  symptom: string;
  evidence: string;
  constraints: string;
  attempts: number;
  lastAttemptAt: string;
}

const FAILURE_COLOR: Record<string, string> = {
  AST_SYMBOL_DROPPED: "bg-rose-500/15 text-rose-300 border-rose-500/40",
  AST_STRUCTURAL_DRIFT: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  BRANDING_INJECTION: "bg-purple-500/15 text-purple-300 border-purple-500/40",
  REVIEW_REJECTED: "bg-orange-500/15 text-orange-300 border-orange-500/40",
  SANITIZER_REDACTION: "bg-cyan-500/15 text-cyan-300 border-cyan-500/40",
  HEADER_STRIPPED: "bg-red-500/15 text-red-300 border-red-500/40",
  COMPILE_ERROR: "bg-red-500/15 text-red-300 border-red-500/40",
  ZERO_DIFF_SATURATION: "bg-slate-500/15 text-slate-300 border-slate-500/40",
  OTHER: "bg-slate-500/15 text-slate-300 border-slate-500/40",
};

export function PostmortemPanel() {
  const { toast } = useToast();
  const [postmortems, setPostmortems] = useState<PostmortemRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const res = await fetch("/api/postmortems");
      const data = await res.json();
      if (Array.isArray(data?.postmortems)) {
        setPostmortems(data.postmortems);
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }

  async function dismiss(id: string, filePath: string) {
    try {
      const res = await fetch(`/api/postmortems?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to dismiss postmortem");
      setPostmortems((prev) => prev.filter((p) => p.id !== id));
      toast({
        title: "Postmortem dismissed",
        description: `Constraints for ${filePath} removed.`,
      });
    } catch (e) {
      toast({
        title: "Dismiss failed",
        description: (e as Error).message,
        variant: "destructive",
      });
    }
  }

  useEffect(() => {
    refresh();
    // Refresh every 10s — postmortems are created/resolved by the loop
    const interval = setInterval(refresh, 10000);
    return () => clearInterval(interval);
  }, []);

  return (
    <Card className="bg-slate-950/60 border-slate-800/60 backdrop-blur">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-slate-100 flex items-center gap-2 text-base">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br from-rose-500/30 to-amber-500/30 ring-1 ring-rose-500/40">
              <AlertOctagon className="h-4 w-4 text-rose-300" />
            </span>
            Postmortem Constraints
            <span className="text-xs text-slate-500 font-normal">
              (per-file failure memory)
            </span>
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className={cn(
                "text-[10px] uppercase tracking-widest",
                postmortems.length > 0
                  ? "bg-rose-500/15 text-rose-300 border-rose-500/40"
                  : "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
              )}
            >
              {postmortems.length} active
            </Badge>
            <Button
              variant="outline"
              size="sm"
              onClick={refresh}
              disabled={loading}
              className="h-7 text-xs bg-slate-900/60 border-slate-700 hover:bg-slate-800 text-slate-300"
            >
              <RefreshCw className={cn("h-3 w-3 mr-1.5", loading && "animate-spin")} />
              Refresh
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {postmortems.length === 0 ? (
          <p className="text-xs text-slate-500 italic py-6 text-center">
            No active postmortems. Files that fail the AST gate or review tribunal
            will appear here as constraints for the next attempt.
          </p>
        ) : (
          <ScrollArea className="h-[320px] pr-3">
            <div className="space-y-2">
              <AnimatePresence>
                {postmortems.map((pm) => (
                  <motion.div
                    key={pm.id}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, x: -8 }}
                    className={cn(
                      "rounded-md border p-3 transition-colors",
                      expanded === pm.id
                        ? "bg-slate-900/70 border-slate-700"
                        : "bg-slate-900/40 border-slate-800/60 hover:border-slate-700"
                    )}
                  >
                    <div
                      className="flex items-start gap-2 cursor-pointer"
                      onClick={() => setExpanded(expanded === pm.id ? null : pm.id)}
                    >
                      {expanded === pm.id ? (
                        <ChevronDown className="h-3.5 w-3.5 text-slate-400 mt-1 shrink-0" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 text-slate-400 mt-1 shrink-0" />
                      )}
                      <FileWarning className="h-3.5 w-3.5 text-rose-400 mt-1 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge
                            variant="outline"
                            className={cn(
                              "text-[9px] uppercase tracking-widest",
                              FAILURE_COLOR[pm.failureType] ?? FAILURE_COLOR.OTHER
                            )}
                          >
                            {pm.failureType.replace(/_/g, " ")}
                          </Badge>
                          <span className="text-[10px] text-slate-500 font-mono">
                            attempt #{pm.attempts}
                          </span>
                          <span className="text-[10px] text-slate-500 font-mono ml-auto">
                            {new Date(pm.lastAttemptAt).toLocaleString()}
                          </span>
                        </div>
                        <div className="text-xs font-mono text-slate-200 mt-1 truncate" title={pm.filePath}>
                          {pm.filePath}
                        </div>
                        <div className="text-[11px] text-slate-400 mt-0.5 line-clamp-1">
                          {pm.symptom}
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          dismiss(pm.id, pm.filePath);
                        }}
                        className="h-6 w-6 p-0 text-slate-500 hover:text-rose-400 hover:bg-rose-500/10"
                        title="Dismiss postmortem"
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                    {expanded === pm.id && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        transition={{ duration: 0.2 }}
                        className="mt-3 pt-3 border-t border-slate-800/60 space-y-2"
                      >
                        <div>
                          <div className="text-[10px] uppercase tracking-widest text-rose-400 mb-1 flex items-center gap-1">
                            <History className="h-3 w-3" />
                            Evidence
                          </div>
                          <pre className="text-[10px] font-mono text-slate-400 bg-slate-950/60 border border-slate-800/60 rounded px-2 py-1.5 overflow-x-auto whitespace-pre-wrap max-h-32 overflow-y-auto">
                            {pm.evidence}
                          </pre>
                        </div>
                        <div>
                          <div className="text-[10px] uppercase tracking-widest text-amber-400 mb-1">
                            Constraints (injected into next LLM attempt)
                          </div>
                          <pre className="text-[10px] font-mono text-amber-200/90 bg-slate-950/60 border border-amber-900/40 rounded px-2 py-1.5 overflow-x-auto whitespace-pre-wrap max-h-32 overflow-y-auto">
                            {pm.constraints}
                          </pre>
                        </div>
                      </motion.div>
                    )}
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
