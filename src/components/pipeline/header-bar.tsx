"use client";

import { Activity, Wifi, WifiOff, Cpu, ShieldCheck, Brain, FileSearch } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { usePipelineStore } from "@/lib/pipeline-store";
import { cn } from "@/lib/utils";

export function HeaderBar() {
  const wsConnected = usePipelineStore((s) => s.wsConnected);
  const loopState = usePipelineStore((s) => s.loopState);
  const status = loopState?.status ?? "idle";
  const stats = loopState?.stats ?? null;

  const statusColor: Record<string, string> = {
    idle: "bg-slate-500/15 text-slate-300 border-slate-500/40",
    running: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
    paused: "bg-amber-500/15 text-amber-300 border-amber-500/40",
    error: "bg-rose-500/15 text-rose-300 border-rose-500/40",
  };

  return (
    <header className="sticky top-0 z-40 backdrop-blur-md bg-slate-950/70 border-b border-slate-800/60">
      <div className="mx-auto max-w-[1600px] px-4 lg:px-6 py-3 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <div className="relative h-9 w-9 shrink-0 rounded-lg overflow-hidden ring-1 ring-amber-500/40 bg-slate-900">
            <img
              src="/pipeline-hero.png"
              alt="Pipeline"
              className="h-full w-full object-cover opacity-80"
            />
            <div className="absolute inset-0 bg-gradient-to-br from-amber-500/20 to-rose-500/20" />
          </div>
          <div className="min-w-0">
            <h1 className="text-sm font-semibold text-slate-100 truncate">
              Architecture Helper Pipeline
              <span className="ml-2 text-[10px] text-amber-300 font-mono uppercase tracking-widest">
                v4.2 · LLM-enhanced
              </span>
            </h1>
            <p className="text-[11px] text-slate-500 truncate">
              Autonomous self-enhancement · 6-stage refactoring · real LLM + TS Compiler API AST + TF-IDF RAG
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Subsystem health */}
          <Badge
            variant="outline"
            className="text-[10px] uppercase tracking-widest bg-slate-900/60 text-slate-300 border-slate-700/60"
          >
            <Cpu className="h-3 w-3 mr-1 text-cyan-400" />
            6-Stage
          </Badge>
          <Badge
            variant="outline"
            className="text-[10px] uppercase tracking-widest bg-emerald-900/40 text-emerald-300 border-emerald-700/40"
            title="Real LLM via z-ai-web-dev-sdk"
          >
            <Brain className="h-3 w-3 mr-1 text-emerald-400" />
            LLM
          </Badge>
          <Badge
            variant="outline"
            className="text-[10px] uppercase tracking-widest bg-cyan-900/40 text-cyan-300 border-cyan-700/40"
            title="TypeScript Compiler API AST parser"
          >
            <FileSearch className="h-3 w-3 mr-1 text-cyan-400" />
            TS AST
          </Badge>
          <Badge
            variant="outline"
            className="text-[10px] uppercase tracking-widest bg-slate-900/60 text-slate-300 border-slate-700/60"
          >
            <ShieldCheck className="h-3 w-3 mr-1 text-rose-400" />
            Sanitizer
          </Badge>
          <Badge
            variant="outline"
            className="text-[10px] uppercase tracking-widest bg-slate-900/60 text-slate-300 border-slate-700/60"
          >
            <Activity className="h-3 w-3 mr-1 text-emerald-400" />
            AST Gate
          </Badge>

          {/* Loop status */}
          <Badge
            variant="outline"
            className={cn("text-[10px] uppercase tracking-widest whitespace-nowrap", statusColor[status])}
          >
            <span
              className={cn(
                "mr-1 inline-block h-1.5 w-1.5 rounded-full",
                status === "running" ? "bg-emerald-400 animate-pulse" : "bg-current"
              )}
            />
            loop: {status}
          </Badge>

          {/* WS connection */}
          <Badge
            variant="outline"
            className={cn(
              "text-[10px] uppercase tracking-widest whitespace-nowrap",
              wsConnected
                ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
                : "bg-slate-500/15 text-slate-400 border-slate-500/40"
            )}
          >
            {wsConnected ? <Wifi className="h-3 w-3 mr-1" /> : <WifiOff className="h-3 w-3 mr-1" />}
            {wsConnected ? "ws live" : "ws idle"}
          </Badge>

          {/* Cycle count */}
          {stats && stats.totalRuns !== undefined && (
            <Badge
              variant="outline"
              className="text-[10px] uppercase tracking-widest bg-slate-900/60 text-amber-300 border-amber-700/40 whitespace-nowrap"
            >
              cycles: <span className="ml-1 font-mono tabular-nums">{stats.totalRuns}</span>
            </Badge>
          )}
        </div>
      </div>
    </header>
  );
}