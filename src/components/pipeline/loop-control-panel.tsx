"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import {
  Play,
  Square,
  Zap,
  Eye,
  RefreshCw,
  Clock,
  GitBranch,
  Save,
  Loader2,
  Power,
  ChevronRight,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { usePipelineStore, LoopMode } from "@/lib/pipeline-store";
import { cn } from "@/lib/utils";

const MODE_META: Record<
  LoopMode,
  { label: string; icon: typeof Clock; desc: string; color: string }
> = {
  scheduled: {
    label: "Scheduled",
    icon: Clock,
    desc: "Interval-based cron-like timer. Re-runs the pipeline every N minutes.",
    color: "text-amber-500",
  },
  watch: {
    label: "Watch",
    icon: Eye,
    desc: "Watcher over the target repo. Re-runs when the remote tree fingerprint changes.",
    color: "text-cyan-500",
  },
  continuous: {
    label: "Continuous",
    icon: Zap,
    desc: "True continuous agent loop. Back-to-back cycles with saturation-driven self-stop.",
    color: "text-rose-500",
  },
  manual: {
    label: "Manual",
    icon: Power,
    desc: "One-shot invocation. Triggered explicitly via the button below.",
    color: "text-emerald-500",
  },
};

export function LoopControlPanel() {
  const { toast } = useToast();
  const loopState = usePipelineStore((s) => s.loopState);
  const setLoopState = usePipelineStore((s) => s.setLoopState);

  const [form, setForm] = useState({
    mode: (loopState?.config.mode ?? "scheduled") as LoopMode,
    intervalMinutes: loopState?.config.intervalMinutes ?? 10,
    targetRepo: loopState?.config.targetRepo ?? "craighckby-stack/66",
    branch: loopState?.config.branch ?? "main",
    evolutionBranch: loopState?.config.evolutionBranch ?? "helper-evolution",
    maxFilesPerCycle: loopState?.config.maxFilesPerCycle ?? 5,
    autoPush: loopState?.config.autoPush ?? true,
    siphonSourceId: loopState?.config.siphonSourceId ?? "pattern-optimizer-helper",
    userPrompt:
      loopState?.config.userPrompt ??
      "Apply 5-pillar modular refactoring with AST retention and Shannon entropy sanitization.",
    githubToken: "",
  });
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [triggering, setTriggering] = useState(false);

  const status = loopState?.status ?? "idle";
  const enabled = loopState?.config.enabled ?? false;
  const stats = loopState?.stats;

  async function persistConfig() {
    setSaving(true);
    try {
      const patch: Record<string, unknown> = {
        mode: form.mode,
        intervalMinutes: form.intervalMinutes,
        targetRepo: form.targetRepo,
        branch: form.branch,
        evolutionBranch: form.evolutionBranch,
        maxFilesPerCycle: form.maxFilesPerCycle,
        autoPush: form.autoPush,
        siphonSourceId: form.siphonSourceId,
        userPrompt: form.userPrompt,
      };
      if (form.githubToken && form.githubToken !== "[REDACTED]") {
        patch.githubToken = form.githubToken;
      }
      const res = await fetch("/api/autonomous/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed to save config");
      if (data?.config && loopState) {
        setLoopState({ ...loopState, config: data.config });
      }
      toast({
        title: "Configuration saved",
        description: `Mode: ${form.mode.toUpperCase()} · Interval: ${form.intervalMinutes}m · Repo: ${form.targetRepo}`,
      });
    } catch (e) {
      toast({ title: "Save failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function startLoop() {
    setToggling(true);
    try {
      const res = await fetch("/api/autonomous/start", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed to start loop");
      setLoopState(data);
      toast({
        title: "Autonomous loop started",
        description: `Running in ${data.config.mode.toUpperCase()} mode. Next cycle: ${data.stats.nextRunAt ?? "immediate"}`,
      });
    } catch (e) {
      toast({ title: "Start failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setToggling(false);
    }
  }

  async function stopLoop() {
    setToggling(true);
    try {
      const res = await fetch("/api/autonomous/stop", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed to stop loop");
      setLoopState(data);
      toast({ title: "Autonomous loop stopped", description: "No further cycles will run until re-enabled." });
    } catch (e) {
      toast({ title: "Stop failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setToggling(false);
    }
  }

  async function triggerOnce() {
    setTriggering(true);
    try {
      const res = await fetch("/api/autonomous/trigger", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed to trigger cycle");
      toast({
        title: "Cycle triggered",
        description: `One-shot run started. Cycle ID: ${data.cycleId ?? "—"}`,
      });
    } catch (e) {
      toast({ title: "Trigger failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setTriggering(false);
    }
  }

  const statusBadgeColor: Record<string, string> = {
    idle: "bg-slate-500/15 text-slate-300 border-slate-500/40",
    running: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
    paused: "bg-amber-500/15 text-amber-300 border-amber-500/40",
    error: "bg-rose-500/15 text-rose-300 border-rose-500/40",
  };

  return (
    <Card className="bg-slate-950/60 border-slate-800/60 backdrop-blur">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-slate-100 flex items-center gap-2">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br from-amber-500/30 to-rose-500/30 ring-1 ring-amber-500/40">
                <RefreshCw className="h-4 w-4 text-amber-300" />
              </span>
              Autonomous Self-Enhancement Loop
            </CardTitle>
            <p className="text-xs text-slate-400 mt-1.5">
              Pipeline runs without manual triggering. Choose a trigger mode and let the
              system refactor the repo on its own.
            </p>
          </div>
          <Badge
            variant="outline"
            className={cn("uppercase text-[10px] tracking-widest whitespace-nowrap", statusBadgeColor[status])}
          >
            <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
            {status}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Mode cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {(Object.keys(MODE_META) as LoopMode[]).map((mode) => {
            const meta = MODE_META[mode];
            const Icon = meta.icon;
            const active = form.mode === mode;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => setForm({ ...form, mode })}
                className={cn(
                  "group relative text-left rounded-lg border p-3 transition-all",
                  active
                    ? "border-amber-500/60 bg-amber-500/10 shadow-[0_0_30px_-12px] shadow-amber-500/50"
                    : "border-slate-800/60 bg-slate-900/40 hover:border-slate-700 hover:bg-slate-900/70"
                )}
              >
                <div className="flex items-center gap-2 mb-1.5">
                  <Icon className={cn("h-4 w-4 shrink-0", active ? meta.color : "text-slate-400")} />
                  <span className={cn("text-sm font-semibold", active ? "text-amber-200" : "text-slate-200")}>
                    {meta.label}
                  </span>
                  {active && <ChevronRight className="ml-auto h-3.5 w-3.5 text-amber-400" />}
                </div>
                <p className="text-[11px] leading-snug text-slate-400 line-clamp-3">{meta.desc}</p>
              </button>
            );
          })}
        </div>

        {/* Repo + Branch */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="targetRepo" className="text-xs text-slate-400">
              Target Repository
            </Label>
            <Input
              id="targetRepo"
              value={form.targetRepo}
              onChange={(e) => setForm({ ...form, targetRepo: e.target.value })}
              placeholder="owner/repo"
              className="bg-slate-900/60 border-slate-700/60 text-slate-100 font-mono text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="branch" className="text-xs text-slate-400">
              Source Branch
            </Label>
            <Input
              id="branch"
              value={form.branch}
              onChange={(e) => setForm({ ...form, branch: e.target.value })}
              placeholder="main"
              className="bg-slate-900/60 border-slate-700/60 text-slate-100 font-mono text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="evolutionBranch" className="text-xs text-slate-400">
              Evolution Branch
            </Label>
            <div className="relative">
              <GitBranch className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
              <Input
                id="evolutionBranch"
                value={form.evolutionBranch}
                onChange={(e) => setForm({ ...form, evolutionBranch: e.target.value })}
                placeholder="helper-evolution"
                className="bg-slate-900/60 border-slate-700/60 text-slate-100 font-mono text-sm pl-8"
              />
            </div>
          </div>
        </div>

        {/* Interval + Max files + Siphon */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="interval" className="text-xs text-slate-400">
              Interval (minutes) <span className="text-slate-600">· scheduled/watch</span>
            </Label>
            <Input
              id="interval"
              type="number"
              min={1}
              value={form.intervalMinutes}
              onChange={(e) => setForm({ ...form, intervalMinutes: Number(e.target.value) || 1 })}
              className="bg-slate-900/60 border-slate-700/60 text-slate-100 font-mono text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="maxFiles" className="text-xs text-slate-400">
              Max Files / Cycle
            </Label>
            <Input
              id="maxFiles"
              type="number"
              min={1}
              max={50}
              value={form.maxFilesPerCycle}
              onChange={(e) => setForm({ ...form, maxFilesPerCycle: Number(e.target.value) || 1 })}
              className="bg-slate-900/60 border-slate-700/60 text-slate-100 font-mono text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="siphon" className="text-xs text-slate-400">
              Pattern Source <span className="text-slate-600">· report label</span>
            </Label>
            <Select value={form.siphonSourceId} onValueChange={(v) => setForm({ ...form, siphonSourceId: v })}>
              <SelectTrigger
                id="siphon"
                className="bg-slate-900/60 border-slate-700/60 text-slate-100 font-mono text-sm"
              >
                <SelectValue placeholder="Select pattern source" />
              </SelectTrigger>
              <SelectContent className="bg-slate-900 border-slate-700 text-slate-100">
                <SelectItem value="pattern-optimizer-helper">Pattern Optimization Helper</SelectItem>
                <SelectItem value="verification-governance-helper">Security & Verification Helper</SelectItem>
                <SelectItem value="clean-room-agents-helper">Modular Agent Engines Helper</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* User prompt */}
        <div className="space-y-1.5">
          <Label htmlFor="userPrompt" className="text-xs text-slate-400">
            Refactoring Prompt (passed to agent loop)
          </Label>
          <Input
            id="userPrompt"
            value={form.userPrompt}
            onChange={(e) => setForm({ ...form, userPrompt: e.target.value })}
            className="bg-slate-900/60 border-slate-700/60 text-slate-100 text-sm"
          />
        </div>

        {/* GitHub token + autoPush */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="ghToken" className="text-xs text-slate-400">
              GitHub Token <span className="text-slate-600">(stored server-side, never shown)</span>
            </Label>
            <Input
              id="ghToken"
              type="password"
              value={form.githubToken}
              onChange={(e) => setForm({ ...form, githubToken: e.target.value })}
              placeholder={
                loopState?.config.githubToken
                  ? "[REDACTED] — leave blank to keep"
                  : "ghp_... or env GITHUB_TOKEN"
              }
              className="bg-slate-900/60 border-slate-700/60 text-slate-100 font-mono text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-slate-400">Auto-Push to Evolution Branch</Label>
            <div className="flex items-center gap-3 h-9 rounded-md border border-slate-700/60 bg-slate-900/60 px-3">
              <Switch
                checked={form.autoPush}
                onCheckedChange={(v) => setForm({ ...form, autoPush: v })}
                aria-label="Auto-push commits"
              />
              <span className="text-xs text-slate-400">
                {form.autoPush
                  ? "Push commits when gates pass (AST + review)"
                  : "Dry-run only — no commits dispatched"}
              </span>
            </div>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button
            onClick={persistConfig}
            disabled={saving}
            variant="outline"
            className="bg-slate-900/60 border-slate-700 hover:bg-slate-800 text-slate-100"
          >
            {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
            Save Configuration
          </Button>
          {enabled ? (
            <Button
              onClick={stopLoop}
              disabled={toggling}
              variant="destructive"
              className="bg-rose-600 hover:bg-rose-500 text-white"
            >
              {toggling ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Square className="h-4 w-4 mr-2" />}
              Stop Loop
            </Button>
          ) : (
            <Button
              onClick={startLoop}
              disabled={toggling}
              className="bg-emerald-600 hover:bg-emerald-500 text-white"
            >
              {toggling ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Play className="h-4 w-4 mr-2" />}
              Start Loop
            </Button>
          )}
          <Button
            onClick={triggerOnce}
            disabled={triggering}
            variant="secondary"
            className="bg-amber-600/90 hover:bg-amber-500 text-white border-0"
          >
            {triggering ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Zap className="h-4 w-4 mr-2" />}
            Trigger One Cycle
          </Button>
          {stats?.nextRunAt && enabled && (
            <span className="ml-auto text-xs text-slate-400 font-mono">
              Next run:{" "}
              <span className="text-amber-300">{new Date(stats.nextRunAt).toLocaleString()}</span>
            </span>
          )}
        </div>

        {/* Stats strip */}
        {stats && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
            className="grid grid-cols-2 md:grid-cols-4 gap-2 pt-3 border-t border-slate-800/60"
          >
            <StatBlock label="Total Cycles" value={stats.totalRuns} accent="text-amber-300" />
            <StatBlock label="Files Scanned" value={stats.totalFilesScanned} accent="text-cyan-300" />
            <StatBlock
              label="Files Committed"
              value={stats.totalFilesCommitted}
              accent="text-emerald-300"
            />
            <StatBlock
              label="Last Run"
              value={stats.lastRunTime ? new Date(stats.lastRunTime).toLocaleTimeString() : "—"}
              accent="text-slate-200"
              mono
            />
          </motion.div>
        )}
      </CardContent>
    </Card>
  );
}

function StatBlock({
  label,
  value,
  accent,
  mono,
}: {
  label: string;
  value: number | string;
  accent: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-md bg-slate-900/40 border border-slate-800/50 px-3 py-2">
      <div className="text-[10px] uppercase tracking-widest text-slate-500">{label}</div>
      <div className={cn("text-lg font-semibold mt-0.5", accent, mono && "font-mono text-sm")}>
        {value}
      </div>
    </div>
  );
}
