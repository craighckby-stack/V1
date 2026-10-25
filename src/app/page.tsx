"use client";

import { useEffect } from "react";
import { motion } from "framer-motion";
import { Github, BookOpen, ArrowDown } from "lucide-react";
import { useLoopSocket } from "@/hooks/use-loop-socket";
import { usePipelineStore } from "@/lib/pipeline-store";
import { HeaderBar } from "@/components/pipeline/header-bar";
import { LoopControlPanel } from "@/components/pipeline/loop-control-panel";
import { PipelineStages } from "@/components/pipeline/pipeline-stages";
import { LogStream } from "@/components/pipeline/log-stream";
import { CurrentCycle } from "@/components/pipeline/current-cycle";
import { RecentCycles } from "@/components/pipeline/recent-cycles";
import { MemoryBank } from "@/components/pipeline/memory-bank";
import { PostmortemPanel } from "@/components/pipeline/postmortem-panel";
import { ManualPipelineRunner } from "@/components/pipeline/manual-runner";
import { DebateChamber } from "@/components/pipeline/debate-chamber";
import { AstInspectorModal } from "@/components/pipeline/ast-inspector-modal";

export default function HomePage() {
  useLoopSocket();
  const setLoopState = usePipelineStore((s) => s.setLoopState);
  const setWsConnected = usePipelineStore((s) => s.setWsConnected);

  // Initial state fetch — if WS service is down we still seed the store.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/autonomous/status");
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setLoopState(data);
      } catch {
        /* ignore */
      }
    })();
    // Periodic fallback poll every 5s — only used when WS is disconnected.
    const interval = setInterval(async () => {
      if (usePipelineStore.getState().wsConnected) return;
      try {
        const res = await fetch("/api/autonomous/status");
        if (!res.ok) return;
        const data = await res.json();
        setLoopState(data);
        setWsConnected(false);
      } catch {
        /* ignore */
      }
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [setLoopState, setWsConnected]);

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-100">
      {/* Background ambiance */}
      <div
        className="fixed inset-0 -z-10 opacity-20 pointer-events-none"
        style={{
          backgroundImage:
            "radial-gradient(ellipse 80% 60% at 50% -10%, rgba(245, 158, 11, 0.18), transparent), radial-gradient(ellipse 60% 40% at 100% 100%, rgba(34, 211, 238, 0.12), transparent), radial-gradient(ellipse 60% 40% at 0% 100%, rgba(244, 63, 94, 0.10), transparent)",
        }}
      />

      <HeaderBar />

      {/* Hero section */}
      <section className="relative overflow-hidden border-b border-slate-800/60">
        <div className="absolute inset-0">
          <img
            src="/pipeline-hero.png"
            alt=""
            className="h-full w-full object-cover opacity-30"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-slate-950/60 via-slate-950/80 to-slate-950" />
        </div>
        <div className="relative mx-auto max-w-[1600px] px-4 lg:px-6 py-10 lg:py-14">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="max-w-3xl"
          >
            <div className="inline-flex items-center gap-2 rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-[11px] uppercase tracking-widest text-amber-300">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
              Autonomous self-enhancement loop · active
            </div>
            <h2 className="mt-4 text-3xl lg:text-4xl font-bold tracking-tight text-slate-50">
              A pipeline that{" "}
              <span className="bg-gradient-to-r from-amber-300 via-rose-300 to-cyan-300 bg-clip-text text-transparent">
                refactors itself
              </span>{" "}
              without you asking.
            </h2>
            <p className="mt-3 text-sm lg:text-base text-slate-300 max-w-2xl leading-relaxed">
              Six-stage refactoring flow with real LLM reasoning (z-ai-web-dev-sdk),
              TypeScript Compiler API for AST symbol retention, TF-IDF RAG memory,
              an LLM-driven dual-perspective review tribunal, and a halt governor —
              all driven by an autonomous loop engine in{" "}
              <span className="font-mono text-amber-300">scheduled</span>,{" "}
              <span className="font-mono text-cyan-300">watch</span>, or{" "}
              <span className="font-mono text-rose-300">continuous</span> mode. Pushes only
              when every gate passes.
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-3 text-xs text-slate-400">
              <span className="inline-flex items-center gap-1.5">
                <Github className="h-3.5 w-3.5" />
                GitHub REST API integration
              </span>
              <span className="text-slate-600">·</span>
              <span className="inline-flex items-center gap-1.5">
                <BookOpen className="h-3.5 w-3.5" />
                RAG memory bank
              </span>
              <span className="text-slate-600">·</span>
              <span className="font-mono">WebSocket :3003</span>
              <span className="text-slate-600">·</span>
              <span className="font-mono">SQLite + Prisma</span>
            </div>
            <div className="mt-6 flex items-center gap-2 text-xs text-slate-500 animate-bounce">
              <ArrowDown className="h-4 w-4" />
              Configure the loop, save, then start it
            </div>
          </motion.div>
        </div>
      </section>

      <main className="flex-1 mx-auto w-full max-w-[1600px] px-4 lg:px-6 py-6 space-y-6">
        {/* Row 1: Loop control (full width) */}
        <LoopControlPanel />

        {/* Row 2: Pipeline stages + Live logs (2/3 + 1/3) */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2">
            <PipelineStages />
          </div>
          <div className="lg:col-span-1">
            <LogStream />
          </div>
        </div>

        {/* Row 3: Current cycle + Debate chamber */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <CurrentCycle />
          <DebateChamber />
        </div>

        {/* Row 4: Manual runner + Recent cycles */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2">
            <ManualRunnerWrapper />
          </div>
          <div className="lg:col-span-1">
            <RecentCycles />
          </div>
        </div>

        {/* Row 5: Postmortem constraints + Memory bank */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <PostmortemPanel />
          <MemoryBank />
        </div>

        {/* Footer */}
        <footer className="mt-auto pt-6 pb-8 border-t border-slate-800/60">
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
            <div className="flex items-center gap-3">
              <span className="font-mono">Architecture Helper Pipeline · v4.3</span>
              <span className="text-slate-700">·</span>
              <span>Next.js 16 + App Router</span>
              <span className="text-slate-700">·</span>
              <span>Socket.IO :3003</span>
              <span className="text-slate-700">·</span>
              <span>Prisma SQLite</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-slate-600">Autonomous modes:</span>
              <span className="font-mono text-amber-300">scheduled</span>
              <span className="text-slate-700">·</span>
              <span className="font-mono text-cyan-300">watch</span>
              <span className="text-slate-700">·</span>
              <span className="font-mono text-rose-300">continuous</span>
              <span className="text-slate-700">·</span>
              <span className="font-mono text-emerald-300">manual</span>
            </div>
          </div>
        </footer>
      </main>

      {/* AST inspector modal */}
      <AstInspectorModal />
    </div>
  );
}

function ManualRunnerWrapper() {
  return <ManualPipelineRunner />;
}
