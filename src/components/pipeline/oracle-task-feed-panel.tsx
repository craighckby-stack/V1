"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { RefreshCw, Brain, AlertTriangle, CheckCircle, Clock, Loader2 } from "lucide-react";

interface SelfTask {
  id: string;
  kind: string;
  filePath: string;
  line: number;
  evidence: string;
  status: "pending" | "in_progress" | "done" | "failed" | "skipped";
  attempts: number;
  deferred: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

const STATUS_STYLES: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline"; icon: typeof Clock }> = {
  pending: { label: "Pending", variant: "outline", icon: Clock },
  in_progress: { label: "In Progress", variant: "default", icon: Loader2 },
  done: { label: "Done", variant: "default", icon: CheckCircle },
  failed: { label: "Failed", variant: "destructive", icon: AlertTriangle },
  skipped: { label: "Skipped", variant: "secondary", icon: CheckCircle },
};

export function OracleTaskFeedPanel() {
  const [tasks, setTasks] = useState<SelfTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchTasks = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const response = await fetch("/api/self-enhance/tasks?limit=50");
      if (!response.ok) {
        throw new Error(`Failed to fetch tasks: HTTP ${response.status} ${response.statusText || ''}`);
      }
      const data = await response.json();
      
      if (typeof data !== 'object' || data === null || !Array.isArray(data.tasks)) {
        throw new Error("Invalid API response structure: Expected { tasks: SelfTask[] }, but received malformed data.");
      }

      // The API returns { tasks: [...], queue: {...} } — filter for the
      // oracle-failed-prophecy kind (the audit-8 closure: failed
      // prophecies that queued SelfTasks on the same file).
      const allTasks: SelfTask[] = data.tasks;
      const oracleTasks = allTasks.filter((t) => t.kind === "oracle-failed-prophecy");
      setTasks(oracleTasks);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "An unknown error occurred during task fetching.";
      setError(`Task feed fetch failed: ${msg}`);
      // Keep existing tasks on error — don't wipe the list on a transient failure
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchTasks();
    // Poll every 30s — the oracle scheduler ticks every 5 min, so 30s
    // is fast enough to surface new failed-prophecy tasks without
    // hammering the API.
    const interval = setInterval(fetchTasks, 30_000);
    return () => clearInterval(interval);
  }, [fetchTasks]);

  if (loading && tasks.length === 0) {
    return (
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Brain className="h-4 w-4" />
            Oracle → Task Feed
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">Loading failed-prophecy tasks...</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Brain className="h-4 w-4" />
          Oracle → Task Feed
          {tasks.length > 0 && (
            <Badge variant="secondary" className="ml-1 text-[10px]">
              {tasks.length}
            </Badge>
          )}
        </CardTitle>
        <Button
          variant="ghost"
          size="sm"
          onClick={fetchTasks}
          disabled={refreshing}
          className="h-7 px-2"
          aria-label="Refresh oracle task feed"
        >
          <RefreshCw className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
        </Button>
      </CardHeader>
      <CardContent>
        {error && (
          <p className="text-xs text-amber-500 mb-2" role="alert">
            Last refresh failed: {error}. Showing cached data.
          </p>
        )}
        {tasks.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No failed prophecies feeding tasks. The oracle&apos;s predictions are
            either unjudged, fulfilled, or not yet past their deadline.
          </p>
        ) : (
          <ScrollArea className="max-h-72">
            <ul className="space-y-2 pr-2">
              {tasks.map((task) => {
                const style = STATUS_STYLES[task.status] ?? STATUS_STYLES.pending;
                const StatusIcon = style.icon;
                return (
                  <li
                    key={task.id}
                    className="border rounded p-2 space-y-1"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-mono text-muted-foreground truncate" title={task.filePath}>
                        {task.filePath}
                      </span>
                      <Badge variant={style.variant} className="text-[9px] uppercase tracking-wide flex items-center gap-1">
                        <StatusIcon className="h-2.5 w-2.5" />
                        {style.label}
                      </Badge>
                    </div>
                    <p className="text-[10px] text-muted-foreground line-clamp-2" title={task.evidence}>
                      {task.evidence}
                    </p>
                    {(task.attempts > 0 || task.lastError) && (
                      <div className="flex items-center gap-2 text-[9px] text-muted-foreground">
                        {task.attempts > 0 && <span>attempts: {task.attempts}</span>}
                        {task.deferred > 0 && <span>deferred: {task.deferred}</span>}
                        {task.lastError && (
                          <span className="text-amber-500 truncate" title={task.lastError}>
                            err: {task.lastError.slice(0, 60)}
                          </span>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}