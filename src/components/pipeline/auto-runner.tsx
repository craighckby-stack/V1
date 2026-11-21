"use client";

/**
 * Auto Pipeline Runner — the one-click TARGET gauntlet.
 *
 * The manual runner is a 5-step operator flow (validate → scan → pick →
 * run → push). This card collapses it into one button:
 *
 *   repo (+optional PAT) → pick (server scans the tree + static-analyzes
 *   top candidates) → 6-stage gauntlet → auto-push survivors to
 *   <branch>-evolution → labeled feedback (postmortem scars keyed to the
 *   TARGET repo, never the autonomous loop's lessons/bandit — operator
 *   decision "B": manual/auto runs stay a sandbox).
 *
 * The client orchestrates three bounded requests (pick → run → finish) so
 * the UI shows REAL phase boundaries instead of one opaque spinner for a
 * multi-minute LLM run.
 */

import { useEffect, useRef, useState } from "react";
import {
  Rocket,
  Loader2,
  Crosshair,
  Cpu,
  GitBranch,
  History,
  CheckCircle2,
  XCircle,
  Circle,
  MinusCircle,
  Eye,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { usePipelineStore, PipelineReport } from "@/lib/pipeline-store";
import { cn } from "@/lib/utils";

type PhaseId = "pick" | "gauntlet" | "push" | "feedback";
type PhaseStatus = "pending" | "running" | "done" | "failed" | "skipped";

const PHASES: Array<{ id: PhaseId; label: string; icon: typeof Crosshair }> = [
  { id: "pick", label: "pick target", icon: Crosshair },
  { id: "gauntlet", label: "6-stage gauntlet", icon: Cpu },
  { id: "push", label: "push survivor", icon: GitBranch },
  { id: "feedback", label: "feedback into system", icon: History },
];

const INITIAL_PHASES: Record<PhaseId, PhaseStatus> = {
  pick: "pending",
  gauntlet: "pending",
  push: "pending",
  feedback: "pending",
};

interface PickResponse {
  ok: true;
  repo: string;
  branch: string;
  pick: {
    path: string;
    size: number;
    blobSha: string;
    content: string;
    score: number;
    findings: Array<{ kind: string; count: number }>;
    fallback: boolean;
    reason: string;
  };
  meta: {
    candidatesRanked: number;
    candidatesFetched: number;
    treeTruncated: boolean;
    totalTreeFiles: number;
  };
}

interface FinishResponse {
  pushed: boolean;
  commitSha?: string;
  evolutionBranch?: string;
  pushError?: string;
  feedback: string[];
  postmortem: "recorded" | "resolved" | "skipped" | "none";
}

function PhaseIcon({ status, icon: Icon }: { status: PhaseStatus; icon: typeof Crosshair }) {
  if (status === "running") return <Loader2 className="h-3.5 w-3.5 animate-spin text-cyan-300" />;
  if (status === "done") return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />;
  if (status === "failed") return <XCircle className="h-3.5 w-3.5 text-rose-400" />;
  if (status === "skipped") return <MinusCircle className="h-3.5 w-3.5 text-slate-500" />;
  void Icon;
  return <Circle className="h-3.5 w-3.5 text-slate-600" />;
}

export function AutoPipelineRunner() {
  const { toast } = useToast();
  const setPipelineReport = usePipelineStore((s) => s.setPipelineReport);
  const setPipelineRunning = usePipelineStore((s) => s.setPipelineRunning);
  const pipelineRunning = usePipelineStore((s) => s.pipelineRunning);
  const setInspectorFile = usePipelineStore((s) => s.setInspectorFile);

  const [form, setForm] = useState({
    repo: "",
    branch: "",
    token: "",
    prompt: "Apply 5-pillar modular refactoring with AST retention and Shannon entropy sanitization.",
    autoPush: true,
  });
  const [busy, setBusy] = useState(false);
  const [phaseStates, setPhaseStates] = useState<Record<PhaseId, PhaseStatus>>(INITIAL_PHASES);
  const [pickResult, setPickResult] = useState<PickResponse | null>(null);
  const [report, setReport] = useState<PipelineReport | null>(null);
  const [finishResult, setFinishResult] = useState<FinishResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gauntletSeconds, setGauntletSeconds] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Elapsed-seconds counter for the long gauntlet phase — an honest
  // "not frozen" signal (LLM reasoning + tribunal can take minutes).
  useEffect(() => {
    if (phaseStates.gauntlet === "running") {
      setGauntletSeconds(0);
      timerRef.current = setInterval(() => setGauntletSeconds((s) => s + 1), 1000);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [phaseStates.gauntlet]);

  function setPhase(id: PhaseId, status: PhaseStatus) {
    setPhaseStates((prev) => ({ ...prev, [id]: status }));
  }

  async function runAuto() {
    if (!form.repo.trim()) {
      toast({
        title: "No repository",
        description: "Enter the target repository (owner/repo).",
        variant: "destructive",
      });
      return;
    }
    setBusy(true);
    setError(null);
    setPickResult(null);
    setReport(null);
    setFinishResult(null);
    setPhaseStates(INITIAL_PHASES);

    try {
      // ── Phase 1: pick ────────────────────────────────────────────
      setPhase("pick", "running");
      const pickRes = await fetch("/api/pipeline/auto/pick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: form.repo,
          branch: form.branch || undefined,
          token: form.token || undefined,
        }),
      });
      const pickData = (await pickRes.json()) as PickResponse | { ok: false; error: string };
      if (!pickRes.ok || !("ok" in pickData) || pickData.ok !== true) {
        throw new Error(("error" in pickData && pickData.error) || `Pick failed (HTTP ${pickRes.status})`);
      }
      setPickResult(pickData);
      setPhase("pick", "done");

      // ── Phase 2: the 6-stage gauntlet ────────────────────────────
      setPhase("gauntlet", "running");
      setPipelineRunning(true);
      const runRes = await fetch("/api/pipeline/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetRepo: pickData.repo,
          targetBranch: pickData.branch,
          evolutionBranch: `${pickData.branch}-evolution`,
          filePath: pickData.pick.path,
          userPrompt: form.prompt,
          siphonSourceId: "pattern-optimizer-helper",
          code: pickData.pick.content,
          githubToken: form.token || undefined,
          triggeredBy: "auto",
        }),
      });
      const runData = (await runRes.json()) as PipelineReport & { error?: string };
      if (!runRes.ok) throw new Error(runData?.error || `Gauntlet failed (HTTP ${runRes.status})`);
      setReport(runData);
      setPipelineReport(runData);
      setPhase("gauntlet", "done");

      // ── Phase 3+4: push survivor + labeled feedback ──────────────
      setPhase("push", "running");
      setPhase("feedback", "running");
      const finishRes = await fetch("/api/pipeline/auto/finish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: pickData.repo,
          branch: pickData.branch,
          token: form.token || undefined,
          autoPush: form.autoPush,
          report: runData,
        }),
      });
      const finishData = (await finishRes.json()) as FinishResponse & { error?: string };
      if (!finishRes.ok) throw new Error(finishData?.error || `Finish failed (HTTP ${finishRes.status})`);
      setFinishResult(finishData);
      setPhase("push", finishData.pushed ? "done" : runData.status === "COMPLETED" ? "failed" : "skipped");
      setPhase("feedback", "done");

      toast({
        title: `Auto run ${runData.status}`,
        description: finishData.pushed
          ? `pushed to ${finishData.evolutionBranch} · AST ${runData.astScore} · ${runData.consensus}`
          : `no push — ${runData.status} · AST ${runData.astScore} · ${runData.consensus}`,
      });
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg);
      // Mark the first still-running phase as failed, leave the rest pending.
      setPhaseStates((prev) => {
        const next = { ...prev };
        for (const p of PHASES) {
          if (next[p.id] === "running") {
            next[p.id] = "failed";
            break;
          }
        }
        return next;
      });
      toast({ title: "Auto run failed", description: msg, variant: "destructive" });
    } finally {
      setPipelineRunning(false);
      setBusy(false);
    }
  }

  const runData = report;
  const pickedFindings = pickResult?.pick.findings ?? [];

  return (
    <Card className="bg-slate-950/60 border-cyan-900/50 backdrop-blur">
      <CardHeader className="pb-3">
        <CardTitle className="text-slate-100 flex items-center gap-2 text-base">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br from-cyan-500/40 to-emerald-500/40 ring-1 ring-cyan-400/50">
            <Rocket className="h-4 w-4 text-cyan-200" />
          </span>
          Auto Pipeline Run
          <span className="text-xs text-slate-500 font-normal">
            (one click — pick → gauntlet → push, labeled triggeredBy=auto)
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Repo + Branch + Token — one row */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="auto-repo" className="text-xs text-slate-400">Repository</Label>
            <Input
              id="auto-repo"
              value={form.repo}
              onChange={(e) => setForm({ ...form, repo: e.target.value })}
              placeholder="owner/repo"
              className="bg-slate-900/60 border-slate-700/60 text-slate-100 font-mono text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="auto-branch" className="text-xs text-slate-400">Branch (blank = default)</Label>
            <Input
              id="auto-branch"
              value={form.branch}
              onChange={(e) => setForm({ ...form, branch: e.target.value })}
              placeholder="main"
              className="bg-slate-900/60 border-slate-700/60 text-slate-100 font-mono text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="auto-token" className="text-xs text-slate-400">GitHub Token (optional)</Label>
            <Input
              id="auto-token"
              type="password"
              value={form.token}
              onChange={(e) => setForm({ ...form, token: e.target.value })}
              placeholder="ghp_… or the sealed [CONFIG] PAT"
              className="bg-slate-900/60 border-slate-700/60 text-slate-100 font-mono text-sm"
            />
          </div>
        </div>

        {/* Prompt + auto-push */}
        <div className="space-y-1.5">
          <Label htmlFor="auto-prompt" className="text-xs text-slate-400">Refactoring Prompt</Label>
          <Textarea
            id="auto-prompt"
            value={form.prompt}
            onChange={(e) => setForm({ ...form, prompt: e.target.value })}
            className="bg-slate-900/60 border-slate-700/60 text-slate-100 text-sm min-h-[52px]"
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Switch
            id="auto-push"
            checked={form.autoPush}
            onCheckedChange={(v) => setForm({ ...form, autoPush: v })}
            aria-label="Auto-push gate-passing survivors to the evolution branch"
          />
          <Label htmlFor="auto-push" className="text-xs text-slate-400">
            auto-push survivors to <span className="font-mono text-cyan-400">{form.branch.trim() || "&lt;default&gt;"}-evolution</span> (never the target branch)
          </Label>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={runAuto}
            disabled={busy || pipelineRunning || !form.repo.trim()}
            className="bg-cyan-600 hover:bg-cyan-500 text-white"
          >
            {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Rocket className="h-4 w-4 mr-2" />}
            Auto Run — pick → gauntlet → push
          </Button>
          {report && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setInspectorFile({
                  path: report.config.filePath,
                  original: report.originalCode,
                  evolved: report.evolvedCode,
                  report,
                })
              }
              className="bg-slate-900/60 border-slate-700 hover:bg-slate-800 text-slate-200"
            >
              <Eye className="h-3.5 w-3.5 mr-1.5" />
              View AST Diff
            </Button>
          )}
        </div>

        {/* Phase tracker */}
        {(busy || error || report) && (
          <div className="rounded-md border border-slate-800/60 bg-slate-900/40 divide-y divide-slate-800/40">
            {PHASES.map((p) => {
              const status = phaseStates[p.id];
              const Icon = p.icon;
              return (
                <div key={p.id} className="flex items-start gap-3 px-3 py-2">
                  <PhaseIcon status={status} icon={Icon} />
                  <div className="flex-1 min-w-0 text-xs">
                    <div
                      className={cn(
                        "font-mono",
                        status === "pending" && "text-slate-500",
                        status === "running" && "text-cyan-300",
                        status === "done" && "text-slate-200",
                        status === "failed" && "text-rose-300",
                        status === "skipped" && "text-slate-500"
                      )}
                    >
                      {p.label}
                      {p.id === "gauntlet" && status === "running" && (
                        <span className="text-slate-500"> — {gauntletSeconds}s (LLM reasoning + tribunal, the long one)</span>
                      )}
                    </div>
                    {/* Per-phase detail lines */}
                    {p.id === "pick" && pickResult && (
                      <div className="text-slate-400 font-mono break-all mt-0.5">
                        picked <span className="text-cyan-300">{pickResult.pick.path}</span> · score {pickResult.pick.score} · scanned {pickResult.meta.candidatesFetched}/{pickResult.meta.candidatesRanked} candidates
                        {pickResult.meta.treeTruncated && <span className="text-amber-400"> (tree truncated @ {pickResult.meta.totalTreeFiles})</span>}
                        {pickResult.pick.fallback && <span className="text-amber-400"> — {pickResult.pick.reason}</span>}
                        {pickedFindings.length > 0 && (
                          <span className="ml-1">
                            {pickedFindings.map((f) => `${f.kind}×${f.count}`).join(" · ")}
                          </span>
                        )}
                      </div>
                    )}
                    {p.id === "gauntlet" && runData && (
                      <div className="text-slate-400 font-mono break-all mt-0.5">
                        {runData.status} · AST {runData.astScore} · {runData.consensus} · proof {runData.proofCommitHash}
                      </div>
                    )}
                    {p.id === "push" && finishResult && (
                      <div className="text-slate-400 font-mono break-all mt-0.5">
                        {finishResult.pushed ? (
                          <>
                            pushed to <span className="text-emerald-300">{finishResult.evolutionBranch}</span> · commit{" "}
                            <a
                              href={`https://github.com/${pickResult?.repo}/commit/${finishResult.commitSha}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="underline hover:text-emerald-200"
                            >
                              {(finishResult.commitSha ?? "").slice(0, 10)}
                            </a>
                          </>
                        ) : (
                          <span className={phaseStates.push === "skipped" ? "" : "text-rose-300"}>
                            {finishResult.pushError ?? "no push"}
                          </span>
                        )}
                      </div>
                    )}
                    {p.id === "feedback" && finishResult && (
                      <div className="mt-0.5 space-y-0.5">
                        {finishResult.feedback.map((line, i) => (
                          <div key={i} className="text-slate-400 font-mono break-all">— {line}</div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {error && (
          <div className="rounded-md border border-rose-800/60 bg-rose-950/40 px-3 py-2 text-xs text-rose-200 font-mono break-all">
            AUTO RUN FAILED → {error}
          </div>
        )}

        <div className="text-[10px] text-slate-500 leading-relaxed">
          reads work anonymously on public repos; pushes need a PAT (paste one, or the sealed
          [CONFIG] push-target PAT is used server-side). Auto runs are labeled
          <Badge variant="outline" className="mx-1 text-[9px] bg-cyan-900/30 text-cyan-300 border-cyan-800/40">triggeredBy=auto</Badge>
          — they write postmortem scars keyed to the target repo, but never feed the autonomous
          loop&apos;s lessons, corpus, or bandit (operator decision: sandbox, not population).
        </div>
      </CardContent>
    </Card>
  );
}
