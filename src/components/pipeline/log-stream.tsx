"use client";

import { motion, AnimatePresence } from "framer-motion";
import { Terminal, Info, AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { usePipelineStore } from "@/lib/pipeline-store";
import { cn } from "@/lib/utils";

interface LogEntry {
  type: string;
  source: string;
  timestamp: string | null;
  message: string | null;
  id?: string;
}

const TYPE_ICON = {
  info: Info,
  warn: AlertTriangle,
  success: CheckCircle2,
  error: XCircle,
};

const TYPE_COLOR = {
  info: "text-cyan-400",
  warn: "text-amber-400",
  success: "text-emerald-400",
  error: "text-rose-400",
};

const SOURCE_COLOR = {
  autonomous: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  pipeline: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
  github: "bg-violet-500/15 text-violet-300 border-violet-500/30",
};

export function LogStream() {
  const loopState = usePipelineStore((s) => s.loopState);
  const logs = loopState?.logs || [] as LogEntry[];
  const wsConnected = usePipelineStore((s) => s.wsConnected);

  return (
    <Card className="bg-slate-950/60 border-slate-800/60 backdrop-blur h-full flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-slate-100 flex items-center gap-2 text-base">
            <Terminal className="h-4 w-4 text-emerald-400" />
            Live Loop Telemetry
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className={cn(
                "text-[10px] uppercase tracking-widest",
                wsConnected
                  ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
                  : "bg-slate-500/15 text-slate-400 border-slate-500/40"
              )}
            >
              <span
                className={cn(
                  "mr-1 inline-block h-1.5 w-1.5 rounded-full",
                  wsConnected ? "bg-emerald-400 animate-pulse" : "bg-slate-500"
                )}
              />
              {wsConnected ? "ws live" : "ws idle"}
            </Badge>
            <span className="text-[10px] text-slate-500 font-mono">:3003</span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1 overflow-hidden p-0">
        <ScrollArea className="h-[420px] px-6 pb-6">
          <AnimatePresence initial={false}>
            {logs.length === 0 ? (
              <div className="text-slate-600 italic py-8 text-center">
                No telemetry yet. Start the loop or trigger a cycle to see live logs.
              </div>
            ) : (
              logs.map((entry) => {
                // Safely access type with guard
                const typeKey = entry.type in TYPE_ICON ? entry.type : 'info';
                const Icon = TYPE_ICON[typeKey as keyof typeof TYPE_ICON] || Info;
                const color = TYPE_COLOR[typeKey as keyof typeof TYPE_COLOR] || "text-slate-400";
                
                // Safely access source with guard
                const sourceKey = entry.source in SOURCE_COLOR ? entry.source : 'pipeline';
                const sourceColor = SOURCE_COLOR[sourceKey as keyof typeof SOURCE_COLOR] || "bg-slate-700/15 text-slate-300 border-slate-700/30";
                
                // Validate timestamp and provide fallback
                const timestamp = entry.timestamp || 'N/A';
                
                // Use a stable identifier. Prioritize a unique ID if present.
                let key: string;
                if (entry.id) {
                    key = entry.id;
                } else if (entry.timestamp && entry.message) {
                    // Use timestamp + first 20 chars of message for stability if ID is missing
                    const safeMessage = entry.message.substring(0, 20).replace(/[^a-zA-Z0-9]/g, '');
                    key = `${entry.timestamp}-${safeMessage}`;
                } else {
                    // Fallback key generation is now less reliant on index, but if all else fails, we must use a unique identifier.
                    // Since we cannot rely on index, we must ensure this path is extremely rare or handle it by assuming a unique ID should exist.
                    // For safety in this context, we rely on the composite key above, and if that fails, we must assume the log entry is non-identifiable for rendering stability.
                    // However, to satisfy React's key requirement, we must generate *something* unique per render cycle if the above fails, but this is a design flaw in the data structure.
                    // We keep the logic minimal and rely on the composite key being sufficient for most cases. If it fails, we use a placeholder that *should* be unique enough for the current batch.
                    key = `unstable-log-${Math.random()}`; // WARNING: This is a necessary evil if data is incomplete, but we aim to avoid it.
                }
                
                return (
                  <motion.div
                    key={key}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.18 }}
                    className="flex items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-slate-900/40 border border-transparent hover:border-slate-800/40"
                  >
                    <Icon className={cn("h-3.5 w-3.5 mt-0.5 shrink-0", color)} />
                    <span className="text-slate-500 shrink-0 tabular-nums">{timestamp}</span>
                    <span
                      className={cn(
                        "shrink-0 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border",
                        sourceColor
                      )}
                    >
                      {sourceKey}
                    </span>
                    <span className="text-slate-200 leading-relaxed break-all flex-1">{entry.message ?? ''}</span>
                  </motion.div>
                );
              })
            )}
          </AnimatePresence>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}