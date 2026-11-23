"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
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
  const [isLoadingInitial, setIsLoadingInitial] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const lastFetchTimeRef = useRef<number>(0);

  const fetchTasks = useCallback(async (isInitialLoad: boolean = false) => {
    // Implement backpressure: prevent rapid successive calls
    const now = Date.now();
    if (!isInitialLoad && now - lastFetchTimeRef.current < 1000) {
      return;
    }
    lastFetchTimeRef.current = now;

    if (isRefreshing) return;
    
    if (isInitialLoad) {
        setIsLoadingInitial(true);
        setError(null);
    } else {
        setIsRefreshing(true);
        setError(null);
    }

    try {
      const response = await fetch("/api/self-enhance/tasks?limit=50");
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: Failed to fetch tasks from /api/self-enhance/tasks. ${response.statusText}`);
      }
      
      const data = await response.json();
      
      // Validate API response structure
      if (!data || typeof data !== 'object' || !Array.isArray((data as { tasks?: unknown }).tasks)) {
        throw new Error("API response validation failed: Expected an object containing a 'tasks' array.");
      }
      
      // Validate and filter tasks in parallel
      const validatedTasks: SelfTask[] = (data.tasks as unknown[]).filter(t =>
        t && 
        typeof t === 'object' && 
        'id' in t && typeof t.id === 'string' &&
        'kind' in t && typeof t.kind === 'string' &&
        'filePath' in t && typeof t.filePath === 'string' &&
        'evidence' in t && typeof t.evidence === 'string' &&
        'status' in t && (t.status === "pending" || t.status === "in_progress" || t.status === "done" || t.status === "failed" || t.status === "skipped")
      ) as SelfTask[];
      
      // Filter oracle tasks
      const oracleTasks = validatedTasks.filter((t) => t.kind === "oracle-failed-prophecy");
      setTasks(oracleTasks);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error during task fetch.";
      setError(`Last refresh failed for /api/self-enhance/tasks: ${msg}. Showing cached data.`);
    } finally {
      setIsRefreshing(false);
      if (isInitialLoad) {
        setIsLoadingInitial(false);
      }
    }
  }, [isRefreshing]);

  useEffect(() => {
    fetchTasks(true);
    
    // Set up polling with bounded interval
    intervalRef.current = setInterval(() => {
        fetchTasks(false);
    }, 30_000);
    
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [fetchTasks]);

  const statusStyles = useMemo(() => STATUS_STYLES, []);

  if (isLoadingInitial) {
    return (
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Brain className="h-5 w-5" />
            Oracle → Task Feed
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-gray-400">Loading failed-prophecy tasks...</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full">
      <CardHeader className="flex flex-col sm:flex-row items-start sm:items-center justify-between space-y-2 sm:space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Brain className="h-5 w-5" />
          Oracle → Task Feed
          {tasks.length > 0 && (
            <Badge variant="secondary" className="ml-2 text-xs h-6 px-2">
              {tasks.length}
            </Badge>
          )}
        </CardTitle>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => fetchTasks(false)}
          disabled={isRefreshing}
          className="h-10 w-10 p-0 transition-colors duration-150 hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-indigo-500"
          aria-label="Refresh oracle task feed"
        >
          <RefreshCw className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
        </Button>
      </CardHeader>
      <CardContent>
        {error && (
          <p className="text-sm text-amber-600 mb-3 p-2 bg-amber-50 border border-amber-200 rounded" role="alert">
            {error}
          </p>
        )}
        {tasks.length === 0 && !error && !isRefreshing ? (
          <p className="text-sm text-gray-500 p-4 bg-gray-50 rounded-lg">
            No failed prophecies feeding tasks. The oracle&apos;s predictions are
            either unjudged, fulfilled, or not yet past their deadline.
          </p>
        ) : (
          <ScrollArea className="max-h-[400px]">
            <ul className="space-y-3 pr-2 sm:space-y-4">
              {tasks.map((task) => {
                const style = statusStyles[task.status] ?? statusStyles.pending;
                const StatusIcon = style.icon;
                return (
                  <li
                    key={task.id}
                    className="border border-gray-200 rounded-xl p-3 space-y-2 transition-all duration-150 hover:shadow-sm hover:border-indigo-300 focus-within:ring-2 focus-within:ring-indigo-500"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-mono text-gray-700 truncate" title={task.filePath}>
                        {task.filePath}
                      </span>
                      <Badge variant={style.variant} className="text-xs uppercase tracking-wider flex items-center gap-1 h-7 px-2">
                        <StatusIcon className="h-3 w-3" />
                        <span className="sr-only">{style.label} status</span>
                        {style.label}
                      </Badge>
                    </div>
                    <p className="text-sm text-gray-700 line-clamp-2" title={task.evidence}>
                      {task.evidence}
                    </p>
                    {(task.attempts > 0 || task.deferred > 0 || task.lastError) && (
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
                        {task.attempts > 0 && <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> Attempts: {task.attempts}</span>}
                        {task.deferred > 0 && <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> Deferred: {task.deferred}</span>}
                        {task.lastError && (
                          <span className="text-amber-600 truncate" title={task.lastError}>
                            Error: {task.lastError.slice(0, 60)}
                          </span>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul >
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}