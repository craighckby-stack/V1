/**
 * 5-Pillar Modular Agent Runtime Helper (server-safe, LLM-driven)
 *
 *   1. Lifecycle Kernel
 *   2. ReAct Loop Engine — calls the real LLM at each step (z-ai-web-dev-sdk)
 *   3. Unified Model Stream Adapter
 *   4. Tool Sandbox VFS Engine
 *   5. Non-Linear Session Tree & Token Budget Engine
 *
 * The ReAct loop now asks the LLM to (a) inspect the target file in the VFS
 * sandbox, (b) propose a refactoring plan, (c) produce the refactored code.
 * The final answer is the LLM-proposed evolved code, which is then verified
 * by the AST diff gate.
 *
 * If the LLM is unavailable, the loop degrades to a deterministic stub so
 * the pipeline still completes (and downstream gates will catch any drift).
 */

import { llmComplete, extractCodeBlock } from "../llm/agent-llm";

export type LifecycleState =
  | "uninitialized"
  | "booting"
  | "ready"
  | "running"
  | "degraded"
  | "disposed";

export class LifecycleKernel {
  private state: LifecycleState = "uninitialized";
  private abortController: AbortController | null = null;
  private readonly listeners = new Set<(state: LifecycleState) => void>();

  public boot(): void {
    if (this.state === "ready" || this.state === "running") return;
    this.transition("booting");
    this.abortController = new AbortController();
    this.transition("ready");
  }

  public getSignal(): AbortSignal | undefined {
    return this.abortController?.signal;
  }

  public transition(next: LifecycleState): void {
    this.state = next;
    for (const l of this.listeners) {
      try {
        l(next);
      } catch {
        /* ignore */
      }
    }
  }

  public getState(): LifecycleState {
    return this.state;
  }

  public onStateChange(listener: (state: LifecycleState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public dispose(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.transition("disposed");
    this.listeners.clear();
  }
}

export interface ReactStep {
  stepNumber: number;
  thought: string;
  actionName?: string;
  actionPayload?: unknown;
  observation?: string;
  isTerminal: boolean;
  llmUsed?: boolean;
  llmLatencyMs?: number;
}

export class ReactLoopEngine {
  private readonly maxSteps: number;

  constructor(maxSteps = 8) {
    this.maxSteps = maxSteps;
  }

  public async runLoop(
    goal: string,
    executeStep: (stepNumber: number, previousSteps: ReactStep[]) => Promise<ReactStep>
  ): Promise<ReactStep[]> {
    const history: ReactStep[] = [];
    const seenActions = new Set<string>();

    for (let step = 1; step <= this.maxSteps; step++) {
      const current = await executeStep(step, history);
      history.push(current);
      if (current.isTerminal) break;
      if (current.actionName) {
        const actionSig = `${current.actionName}:${JSON.stringify(current.actionPayload)}`;
        if (seenActions.has(actionSig)) {
          history.push({
            stepNumber: step + 1,
            thought: `CYCLE DETECTED: Action ${current.actionName} previously executed with identical arguments. Tripping loop circuit breaker.`,
            isTerminal: true,
            observation: "Loop terminated by defensive invariant.",
          });
          break;
        }
        seenActions.add(actionSig);
      }
    }
    return history;
  }
}

export interface StreamChunk {
  type: "delta" | "thought" | "tool_call" | "finish";
  content: string;
}

export class UnifiedModelStreamAdapter {
  public async *decodeStream(chunks: string[]): AsyncGenerator<StreamChunk> {
    for (const chunk of chunks) {
      yield { type: "delta", content: chunk };
    }
    yield { type: "finish", content: "" };
  }
}

export class ToolSandboxVFSEngine {
  private readonly memoryFs = new Map<string, string>();

  private sanitizePath(path: string): string {
    const normalized = path.replace(/\\/g, "/");
    if (normalized.includes("../") || normalized.startsWith("../") || normalized === "..") {
      throw new Error(`SECURITY ALERT: Path traversal barrier breached (${path}). Sandbox access denied.`);
    }
    return normalized.startsWith("/") ? normalized.slice(1) : normalized;
  }

  public writeFile(path: string, content: string): void {
    const safePath = this.sanitizePath(path);
    this.memoryFs.set(safePath, content);
  }

  public readFile(path: string): string {
    const safePath = this.sanitizePath(path);
    const content = this.memoryFs.get(safePath);
    if (content === undefined) {
      throw new Error(`Virtual file not found: ${path}`);
    }
    return content;
  }

  public listFiles(): string[] {
    return Array.from(this.memoryFs.keys());
  }

  public hasFile(path: string): boolean {
    try {
      const safe = this.sanitizePath(path);
      return this.memoryFs.has(safe);
    } catch {
      return false;
    }
  }

  public clear(): void {
    this.memoryFs.clear();
  }
}

export interface SessionTreeNode {
  id: string;
  parentId: string | null;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tokensEstimate: number;
  timestamp: number;
}

export class SessionTreeTokenBudgetEngine {
  private readonly nodes = new Map<string, SessionTreeNode>();
  private activeLeafId: string | null = null;
  private readonly tokenCap: number;

  constructor(tokenCap = 8192) {
    const DEFAULT_TOKEN_CAP = 8192;
    this.tokenCap = tokenCap;
  }

  public addMessage(
    role: SessionTreeNode["role"],
    content: string,
    parentId?: string
  ): SessionTreeNode {
    const NODE_ID_SUFFIX_RANGE = 1000;
    const TOKENS_PER_CHAR_ESTIMATE = 4;
    const node: SessionTreeNode = {
      id: `node-${Date.now()}-${Math.floor(Math.random() * NODE_ID_SUFFIX_RANGE)}`,
      parentId: parentId ?? this.activeLeafId,
      role,
      content,
      tokensEstimate: Math.ceil(content.length / TOKENS_PER_CHAR_ESTIMATE),
      timestamp: Date.now(),
    };
    this.nodes.set(node.id, node);
    this.activeLeafId = node.id;
    return node;
  }

  public getActivePath(): SessionTreeNode[] {
    const path: SessionTreeNode[] = [];
    let currentId = this.activeLeafId;
    while (currentId) {
      const node = this.nodes.get(currentId);
      if (!node) break;
      path.unshift(node);
      currentId = node.parentId;
    }
    return path;
  }

  public getTotalBudget(): { used: number; cap: number; percentage: number } {
    const path = this.getActivePath();
    const used = path.reduce((sum, n) => sum + n.tokensEstimate, 0);
    const MAX_PERCENTAGE = 100;
    const PERCENTAGE_MULTIPLIER = 100;
    return {
      used,
      cap: this.tokenCap,
      percentage: Math.min(MAX_PERCENTAGE, Math.round((used / this.tokenCap) * PERCENTAGE_MULTIPLIER)),
    };
  }

  public compactHistory(): number {
    const path = this.getActivePath();
    const totalTokens = path.reduce((sum, n) => sum + n.tokensEstimate, 0);
    let pruned = 0;
    if (totalTokens > this.tokenCap * 0.8 && path.length > 4) {
      const toPrune = path.slice(1, path.length - 3);
      for (const node of toPrune) {
        this.nodes.delete(node.id);
        pruned++;
      }
    }
    return pruned;
  }
}

export interface EngineExecutionResult {
  engineId: string;
  goal: string;
  status: "COMPLETED" | "DEGRADED" | "HALTED";
  lifecycleState: LifecycleState;
  tokenBudget: { used: number; cap: number; percentage: number };
  vfsFiles: string[];
  steps: ReactStep[];
  finalAnswer: string;
  /** LLM-proposed evolved code, or empty string when LLM was unavailable. */
  proposedEvolvedCode: string;
  /** Whether the LLM was actually called and returned a usable answer. */
  llmUsed: boolean;
  /** Aggregate LLM latency in ms. */
  llmTotalLatencyMs: number;
  /** Error message when the LLM was unavailable. */
  llmError?: string;
}

const PLAN_SYSTEM = `You are the planning step inside a bounded ReAct agent loop. Given a code refactor goal and the current file contents, output a concise refactor plan in 3-5 bullet points. Do NOT output the refactored code — only the plan. Keep it under 200 words.`;

const REFACTOR_SYSTEM = `You are the execution step inside a bounded ReAct agent loop. You receive a refactor plan and the original code. Output ONLY the refactored code in a single fenced code block. Preserve every public symbol name exactly. Apply the plan faithfully without changing public API.`;

/**
 * Real LLM-driven clean-room engine. Step 1 plans, step 2 produces the
 * refactored code, step 3 is terminal. The refactored code is returned as
 * `proposedEvolvedCode` so the AST gate can verify it.
 *
 * On LLM failure, `proposedEvolvedCode` is empty and `llmUsed=false`. The
 * unified pipeline falls back to a deterministic transformation in that case.
 */
export async function executeCleanRoomEngine(
  engineId: string,
  goal: string,
  options?: { originalCode?: string; filePath?: string; postmortemConstraints?: string }
): Promise<EngineExecutionResult> {
  const lifecycle = new LifecycleKernel();
  lifecycle.boot();
  lifecycle.transition("running");

  const vfs = new ToolSandboxVFSEngine();
  const session = new SessionTreeTokenBudgetEngine();
  const MAX_DEFAULT_STEPS = 8;
  const reactLoop = new ReactLoopEngine(MAX_DEFAULT_STEPS);

  const originalCode = options?.originalCode ?? "";
  const filePath = options?.filePath ?? "workspace/target.ts";
  const postmortemConstraints = options?.postmortemConstraints ?? "";
  vfs.writeFile(filePath, originalCode || `// Target code for engine ${engineId}`);
  session.addMessage("user", goal);

  let proposedEvolvedCode = "";
  let llmUsed = false;
  let llmTotalLatencyMs = 0;
  let llmError: string | undefined;

  const steps = await reactLoop.runLoop(goal, async (stepNumber) => {
    if (stepNumber === 1) {
      // Plan step — call LLM with a planning prompt
      const planUser = `Goal: ${goal}

File contents:
\`\`\`
${originalCode.slice(0, 6000)}${originalCode.length > 6000 ? "\n// ... (truncated)" : ""}
\`\`\`

Output a 3-5 bullet refactor plan only.`;
      const planRes = await llmComplete({
        systemPrompt: PLAN_SYSTEM,
        userPrompt: planUser,
        temperature: 0.2,
      });
      llmTotalLatencyMs += planRes.latencyMs;
      if (planRes.ok) {
        llmUsed = true;
        session.addMessage("assistant", planRes.content);
        return {
          stepNumber,
          thought: `[Pillar 1/2] Inspected ${filePath} in VFS sandbox (${originalCode.length} bytes). Asked LLM for a refactor plan.`,
          actionName: "plan",
          actionPayload: { filePath },
          observation: planRes.content.slice(0, 240),
          isTerminal: false,
          llmUsed: true,
          llmLatencyMs: planRes.latencyMs,
        };
      }
      llmError = planRes.error;
      // Deterministic fallback plan
      const fallbackPlan = `1. Add explicit type annotations to inferred parameters.\n2. Extract magic numbers into named constants.\n3. Add JSDoc to undocumented public functions.\n4. Preserve every public symbol exactly.`;
      session.addMessage("assistant", fallbackPlan);
      return {
        stepNumber,
        thought: `[Pillar 1/2] LLM unavailable (${planRes.error}). Using deterministic fallback plan.`,
        actionName: "plan_fallback",
        actionPayload: { filePath },
        observation: fallbackPlan,
        isTerminal: false,
        llmUsed: false,
        llmLatencyMs: planRes.latencyMs,
      };
    }

    if (stepNumber === 2) {
      // Execute step — produce refactored code
      const lang = filePath.toLowerCase().split(".").pop() || "ts";
      const planContext = session.getActivePath().slice(-2).map((n) => n.content).join("\n\n");
      const postmortemBlock = postmortemConstraints
        ? `${postmortemConstraints}\n\nThe constraints above are from previous failed attempts on this file. You MUST follow them.`
        : "";
      const refactorUser = `Refactor plan:
${planContext}
${postmortemBlock}

Original code (\`${lang}\`):
\`\`\`${lang}
${originalCode.slice(0, 6000)}${originalCode.length > 6000 ? "\n// ... (truncated)" : ""}
\`\`\`

Output ONLY the refactored code in a single \`\`\`${lang} fenced block. Preserve every public symbol name exactly.`;
      const refactorRes = await llmComplete({
        systemPrompt: REFACTOR_SYSTEM,
        userPrompt: refactorUser,
        temperature: 0.2,
      });
      llmTotalLatencyMs += refactorRes.latencyMs;
      if (refactorRes.ok) {
        const code = extractCodeBlock(refactorRes.content);
        if (code) {
          proposedEvolvedCode = code;
          llmUsed = true;
          session.addMessage("assistant", code);
          return {
            stepNumber,
            thought: `[Pillar 4/5] LLM produced refactored code (${code.length} bytes). VFS sandbox remains isolated.`,
            actionName: "refactor",
            actionPayload: { engine: engineId, bytes: code.length },
            observation: `Refactored code emitted (${code.length} bytes).`,
            isTerminal: false,
            llmUsed: true,
            llmLatencyMs: refactorRes.latencyMs,
          };
        }
      }
      // Fallback — no LLM
      llmError = llmError ?? refactorRes.error;
      return {
        stepNumber,
        thought: `[Pillar 4/5] LLM unavailable for refactor step (${refactorRes.error}). Falling back to downstream deterministic transform.`,
        actionName: "refactor_fallback",
        actionPayload: { engine: engineId },
        observation: "No LLM code produced; pipeline will apply deterministic transform.",
        isTerminal: false,
        llmUsed: false,
        llmLatencyMs: refactorRes.latencyMs,
      };
    }

    // Terminal step
    return {
      stepNumber,
      thought: `[Pillar 3] Engine '${engineId}' synthesized clean-room solution${
        llmUsed ? " via LLM" : " via deterministic fallback"
      }.`,
      isTerminal: true,
      observation: `Execution concluded within step budget. LLM used: ${llmUsed}.`,
    };
  });

  const status: EngineExecutionResult["status"] = llmUsed ? "COMPLETED" : "DEGRADED";
  const finalAnswer = llmUsed
    ? `Clean-Room Engine [${engineId}] produced ${proposedEvolvedCode.length} bytes of refactored code via LLM. Token budget at ${session.getTotalBudget().percentage}%.`
    : `Clean-Room Engine [${engineId}] degraded: LLM unavailable (${llmError}). No refactored code produced; downstream pipeline will apply deterministic transform.`;

  session.addMessage("assistant", finalAnswer);
  lifecycle.transition("ready");

  return {
    engineId,
    goal,
    status,
    lifecycleState: lifecycle.getState(),
    tokenBudget: session.getTotalBudget(),
    vfsFiles: vfs.listFiles(),
    steps,
    finalAnswer,
    proposedEvolvedCode,
    llmUsed,
    llmTotalLatencyMs,
    llmError,
  };
}