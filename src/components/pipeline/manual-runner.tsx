"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import {
  Play,
  Loader2,
  Download,
  Github,
  FileCode,
  Search,
  Sparkles,
  Eye,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { usePipelineStore, PipelineReport } from "@/lib/pipeline-store";
import { cn } from "@/lib/utils";

export function ManualPipelineRunner() {
  const { toast } = useToast();
  const setPipelineReport = usePipelineStore((s) => s.setPipelineReport);
  const setPipelineRunning = usePipelineStore((s) => s.setPipelineRunning);
  const pipelineRunning = usePipelineStore((s) => s.pipelineRunning);
  const setRepoFiles = usePipelineStore((s) => s.setRepoFiles);
  const repoFiles = usePipelineStore((s) => s.repoFiles);
  const setGithubUser = usePipelineStore((s) => s.setGithubUser);
  const githubUser = usePipelineStore((s) => s.githubUser);
  const setInspectorFile = usePipelineStore((s) => s.setInspectorFile);

  const [form, setForm] = useState({
    repo: "craighckby-stack/66",
    branch: "main",
    token: "",
    prompt: "Apply 5-pillar modular refactoring with AST retention and Shannon entropy sanitization.",
    siphonSourceId: "pattern-optimizer-helper",
  });
  const [selectedPath, setSelectedPath] = useState<string>("");
  const [code, setCode] = useState<string>("");
  const [fetchingFiles, setFetchingFiles] = useState(false);
  const [validatingToken, setValidatingToken] = useState(false);

  async function validateToken() {
    setValidatingToken(true);
    try {
      const res = await fetch("/api/github/validate-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: form.token || undefined }),
      });
      const data = await res.json();
      if (res.ok && data.valid) {
        setGithubUser({ username: data.username, avatarUrl: data.avatarUrl, name: data.name });
        toast({
          title: "Token valid",
          description: `Authenticated as ${data.username} (${data.scopes})`,
        });
      } else {
        setGithubUser(null);
        toast({
          title: "Token invalid",
          description: data?.error ?? "Validation failed",
          variant: "destructive",
        });
      }
    } catch (e) {
      toast({ title: "Validate failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setValidatingToken(false);
    }
  }

  async function fetchFiles() {
    setFetchingFiles(true);
    try {
      const res = await fetch("/api/github/repo-tree", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: form.repo, branch: form.branch, token: form.token || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed to fetch repo tree");
      setRepoFiles(data.files ?? []);
      toast({
        title: "Repository scanned",
        description: `${data.totalCount} files found on ${data.resolvedBranch}`,
      });
    } catch (e) {
      toast({ title: "Scan failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setFetchingFiles(false);
    }
  }

  async function fetchFile(path: string) {
    setSelectedPath(path);
    try {
      const res = await fetch("/api/github/fetch-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: form.repo, path, branch: form.branch, token: form.token || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed to fetch file");
      setCode(data.content ?? "");
      toast({ title: "File loaded", description: `${path} (${(data.content ?? "").length} bytes)` });
    } catch (e) {
      toast({ title: "Fetch failed", description: (e as Error).message, variant: "destructive" });
    }
  }

  async function runPipeline() {
    if (!code) {
      toast({ title: "No code", description: "Fetch a file first or paste code to run the pipeline.", variant: "destructive" });
      return;
    }
    setPipelineRunning(true);
    setPipelineReport(null);
    try {
      const res = await fetch("/api/pipeline/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetRepo: form.repo,
          targetBranch: form.branch,
          evolutionBranch: `${form.branch}-evolution`,
          filePath: selectedPath || "manual-snippet.ts",
          userPrompt: form.prompt,
          siphonSourceId: form.siphonSourceId,
          code,
          githubToken: form.token || undefined,
          triggeredBy: "manual",
        }),
      });
      const data = (await res.json()) as PipelineReport;
      if (!res.ok) throw new Error((data as unknown as { error?: string }).error ?? "Pipeline failed");
      setPipelineReport(data);
      toast({
        title: `Pipeline ${data.status}`,
        description: `AST ${data.astScore} · ${data.consensus} · proof ${data.proofCommitHash}`,
      });
    } catch (e) {
      toast({ title: "Pipeline failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setPipelineRunning(false);
    }
  }

  return (
    <Card className="bg-slate-950/60 border-slate-800/60 backdrop-blur">
      <CardHeader className="pb-3">
        <CardTitle className="text-slate-100 flex items-center gap-2 text-base">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br from-cyan-500/30 to-emerald-500/30 ring-1 ring-cyan-500/40">
            <Github className="h-4 w-4 text-cyan-300" />
          </span>
          Manual Pipeline Run
          <span className="text-xs text-slate-500 font-normal">(single-file, test the 6-stage flow)</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Repo + Branch + Token */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="repo" className="text-xs text-slate-400">Repository</Label>
            <Input
              id="repo"
              value={form.repo}
              onChange={(e) => setForm({ ...form, repo: e.target.value })}
              placeholder="owner/repo"
              className="bg-slate-900/60 border-slate-700/60 text-slate-100 font-mono text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="branch" className="text-xs text-slate-400">Branch</Label>
            <Input
              id="branch"
              value={form.branch}
              onChange={(e) => setForm({ ...form, branch: e.target.value })}
              placeholder="main"
              className="bg-slate-900/60 border-slate-700/60 text-slate-100 font-mono text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="token" className="text-xs text-slate-400">GitHub Token (optional)</Label>
            <div className="flex gap-2">
              <Input
                id="token"
                type="password"
                value={form.token}
                onChange={(e) => setForm({ ...form, token: e.target.value })}
                placeholder="ghp_... or env"
                className="bg-slate-900/60 border-slate-700/60 text-slate-100 font-mono text-sm"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={validateToken}
                disabled={validatingToken}
                className="bg-slate-900/60 border-slate-700 hover:bg-slate-800 text-slate-200"
              >
                {validatingToken ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        </div>

        {/* Token status */}
        {githubUser && (
          <div className="flex items-center gap-2 text-xs text-emerald-300">
            {/* eslint-disable-next-line @next/next/no-img-element -- inline avatar glyph, intentional raw img to avoid next/image sizing/optimization side effects */}
            <img
              src={githubUser.avatarUrl}
              alt=""
              className="h-5 w-5 rounded-full ring-1 ring-emerald-500/40"
            />
            <span>
              Authenticated as <span className="font-mono">@{githubUser.username}</span> ({githubUser.name ?? "—"})
            </span>
          </div>
        )}

        {/* Prompt */}
        <div className="space-y-1.5">
          <Label htmlFor="prompt" className="text-xs text-slate-400">Refactoring Prompt</Label>
          <Textarea
            id="prompt"
            value={form.prompt}
            onChange={(e) => setForm({ ...form, prompt: e.target.value })}
            className="bg-slate-900/60 border-slate-700/60 text-slate-100 text-sm min-h-[60px]"
          />
        </div>

        <Button
          onClick={fetchFiles}
          disabled={fetchingFiles}
          variant="outline"
          className="bg-slate-900/60 border-slate-700 hover:bg-slate-800 text-slate-200"
        >
          {fetchingFiles ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Search className="h-4 w-4 mr-2" />}
          Scan Repository Files
        </Button>

        {/* File list */}
        {repoFiles.length > 0 && (
          <div className="rounded-md border border-slate-800/60 bg-slate-900/40">
            <div className="px-3 py-2 border-b border-slate-800/60 text-xs text-slate-400 flex items-center justify-between">
              <span>{repoFiles.length} files found · click to load</span>
              <Badge variant="outline" className="text-[9px] bg-slate-700/40 text-slate-300 border-slate-600/40">
                code files only
              </Badge>
            </div>
            <ScrollArea className="h-[160px] px-2 py-1">
              {repoFiles
                .filter((f) => f.isCodeFile)
                .map((f) => (
                  <button
                    key={f.path}
                    type="button"
                    onClick={() => fetchFile(f.path)}
                    className={cn(
                      "w-full text-left px-2 py-1.5 rounded text-xs font-mono hover:bg-slate-800/60 transition-colors flex items-center gap-2",
                      selectedPath === f.path && "bg-cyan-900/40 text-cyan-200"
                    )}
                  >
                    <FileCode className="h-3 w-3 text-slate-500 shrink-0" />
                    <span className="truncate flex-1" title={f.path}>
                      {f.path}
                    </span>
                    <span className="text-[10px] text-slate-500 shrink-0">{(f.size / 1024).toFixed(1)}k</span>
                  </button>
                ))}
            </ScrollArea>
          </div>
        )}

        {/* Code editor */}
        <div className="space-y-1.5">
          <Label htmlFor="code" className="text-xs text-slate-400">
            Code to refactor {selectedPath && <span className="text-cyan-400 font-mono">· {selectedPath}</span>}
          </Label>
          <Textarea
            id="code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="// Paste code here, or fetch a file from a repo above"
            className="bg-slate-950/80 border-slate-700/60 text-slate-100 font-mono text-xs min-h-[180px] max-h-[360px]"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={runPipeline}
            disabled={pipelineRunning || !code}
            className="bg-cyan-600 hover:bg-cyan-500 text-white"
          >
            {pipelineRunning ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Play className="h-4 w-4 mr-2" />}
            Run 6-Stage Pipeline
          </Button>
          {usePipelineStore.getState().pipelineReport && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const r = usePipelineStore.getState().pipelineReport!;
                setInspectorFile({
                  path: r.config.filePath,
                  original: r.originalCode,
                  evolved: r.evolvedCode,
                  report: r,
                });
              }}
              className="bg-slate-900/60 border-slate-700 hover:bg-slate-800 text-slate-200"
            >
              <Eye className="h-3.5 w-3.5 mr-1.5" />
              View AST Diff
            </Button>
          )}
          {code && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const blob = new Blob([code], { type: "text/plain" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = selectedPath.split("/").pop() || "snippet.txt";
                a.click();
                URL.revokeObjectURL(url);
              }}
              className="bg-slate-900/60 border-slate-700 hover:bg-slate-800 text-slate-300"
            >
              <Download className="h-3.5 w-3.5 mr-1.5" />
              Download
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// motion is imported but unused here — keep for future transitions.
void motion;
