"use client";

import { motion, AnimatePresence } from "framer-motion";
import { Terminal, Info, AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { usePipelineStore } from "@/lib/pipeline-store";
import { cn } from "@/lib/utils";
import { memo, useMemo } from "react";

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

const MAX_LOG_ENTRIES = 100; // Prevent unbounded memory growth

const LogEntryComponent = memo(({ entry, key }: { entry: LogEntry; key: string }) => {
  // Use type directly if it exists in the map, otherwise default to 'info' for safety
  const typeKey = (entry.type in TYPE_ICON) ? entry.type : 'info';
  const Icon = TYPE_ICON[typeKey as keyof typeof TYPE_ICON] || Info;
  const color = TYPE_COLOR[typeKey as keyof typeof TYPE_COLOR] || "text-slate-400";
  
  // Use source directly if it exists in the map, otherwise default to 'pipeline'
  const sourceKey = (entry.source in SOURCE_COLOR) ? entry.source : 'pipeline';
  const sourceColor = SOURCE_COLOR[sourceKey as keyof typeof SOURCE_COLOR] || "bg-slate-700/15 text-slate-300 border-slate-700/30";
  
  // Validate timestamp and provide fallback
  const timestamp = entry.timestamp || 'N/A';
  
  return (
    <motion.div
      key={key}
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.18 }}
      // Increased padding/size for touch target (min 44px height/width) and added transitions
      className="flex items-start gap-3 rounded-lg px-3 py-2 transition-colors duration-150 hover:bg-slate-900/50 border border-transparent hover:border-slate-800/50 active:scale-[0.99]"
      role="log-entry"
      aria-label={`Log entry from ${entry.source} at ${timestamp}: ${entry.message ?? 'No message'}`}
    >
      <Icon className={cn("h-3.5 w-3.5 mt-0.5 shrink-0", color)} aria-hidden="true" />
      <span className="text-slate-500 shrink-0 tabular-nums text-xs hidden sm:block">{timestamp}</span>
      <span
        className={cn(
          "shrink-0 text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border",
          sourceColor
        )}
        aria-label={`Source: ${sourceKey}`}
      >
        {sourceKey}
      </span>
      <span className="text-slate-200 leading-snug break-all flex-1 text-sm">{entry.message ?? ''}</span>
    </motion.div>
  );
});

LogEntryComponent.displayName = 'LogEntryComponent';

// Stable empty-array reference — `loopState?.logs || []` inline would create a
// fresh array each render and defeat the useMemo dependency check below.
const EMPTY_LOGS: LogEntry[] = [];

export function LogStream() {
  const loopState = usePipelineStore((s) => s.loopState);
  const logs = loopState?.logs ?? EMPTY_LOGS;
  const wsConnected = usePipelineStore((s) => s.wsConnected);

  // Use memo to prevent unnecessary re-renders when logs array reference changes
  const processedLogs = useMemo(() => {
    // Only take the most recent MAX_LOG_ENTRIES to prevent unbounded memory growth
    return logs.slice(-MAX_LOG_ENTRIES);
  }, [logs]);

  return (
    <Card className="bg-slate-950/60 border-slate-800/60 backdrop-blur h-full flex flex-col">
      <CardHeader className="pb-4">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <CardTitle className="text-slate-100 flex items-center gap-2 text-lg font-semibold">
            <Terminal className="h-4 w-4 text-emerald-400" aria-hidden="true" />
            Live Loop Telemetry
          </CardTitle>
          <div className="flex items-center gap-3">
            <Badge
              variant="outline"
              className={cn(
                "text-[11px] uppercase tracking-widest px-3 py-1",
                wsConnected
                  ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
                  : "bg-slate-500/15 text-slate-400 border-slate-500/40"
              )}
            >
              <span
                className={cn(
                  "mr-1 inline-block h-2 w-2 rounded-full",
                  wsConnected ? "bg-emerald-400 animate-pulse" : "bg-slate-500"
                )}
                aria-hidden="true"
              />
              {wsConnected ? "ws live" : "ws idle"}
            </Badge>
            <span className="text-xs text-slate-500 font-mono hidden sm:inline">:3003</span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1 overflow-hidden p-0">
        {/* Responsive height: max-h-[80vh] ensures it doesn't overflow on large screens, but allows flexibility on mobile */}
        <ScrollArea className="h-[400px] sm:h-[70vh] px-4 md:px-6 pb-4">
          <AnimatePresence initial={false}>
            {processedLogs.length === 0 ? (
              <div className="text-slate-500 italic py-12 text-center text-sm">
                No telemetry yet. Start the loop or trigger a cycle to see live logs.
              </div>
            ) : (
              processedLogs.map((entry) => (
                <LogEntryComponent 
                  key={entry.id || `${entry.timestamp}-${entry.source}`} 
                  entry={entry} 
                />
              ))
            )}
          </AnimatePresence>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}