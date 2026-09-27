import fs from "node:fs";
import path from "node:path";
import { type AgentAction, commandOf, filePathOf, isInsideProject, kindOf, summarize, toState } from "./action.js";
import { loadConfig, type ReflexConfig } from "./config.js";
import { systemOne } from "./jev.js";
import { type Decision, decide, type PolicyResult } from "./policy.js";
import { buildQuestions } from "./questions.js";
import { checkRules } from "./rules.js";

export type Verdict = {
  decision: Decision | "defer";
  reason: string;
  source: "rule" | "jev" | "error";
  rule?: string;
  latencyMs: number;
  model?: string;
  inputTokens?: number;
} & Partial<Omit<PolicyResult, "decision" | "reason">>;

export type LogEntry = {
  ts: string;
  agent?: string;
  tool: string;
  summary: string;
  task?: string;
  cwd?: string;
  verdict: Verdict;
};

/** Evaluates one agent action: deterministic rules first, then one Jev request, then policy in code. */
export async function evaluate(action: AgentAction, config?: ReflexConfig): Promise<Verdict> {
  const cfg = config ?? loadConfig(action.cwd);
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);

  const verdict = await (async (): Promise<Verdict> => {
    const custom = customPatterns(action, cfg);
    if (custom) return { ...custom, source: "rule", latencyMs: elapsed() };

    const hit = checkRules(action, cfg.allowTools);
    if (hit) return { decision: hit.decision, reason: hit.reason, rule: hit.rule, source: "rule", latencyMs: elapsed() };

    try {
      const res = await systemOne(toState(action), buildQuestions(action.task, kindOf(action) === "edit"), {
        model: cfg.model,
        timeoutMs: cfg.timeoutMs,
      });
      const policy = decide(res.answers, cfg.thresholds);
      // Invariant enforced in code, not by the model: writes outside the project always get a human look.
      if (policy.decision === "allow" && writesOutsideProject(action)) {
        policy.decision = "ask";
        policy.reason = `Needs a human: modifies a file outside the project (${filePathOf(action)}).`;
        policy.triggered.push("outside_project");
      }
      return { ...policy, source: "jev", latencyMs: elapsed(), model: res.model, inputTokens: res.usage?.input_tokens };
    } catch (err) {
      return { decision: cfg.onError, reason: `Jev unavailable (${(err as Error).message}); falling back to "${cfg.onError}".`, source: "error", latencyMs: elapsed() };
    }
  })();

  if (cfg.logFile) appendLog(cfg.logFile, action, verdict);
  return verdict;
}

function writesOutsideProject(action: AgentAction): boolean {
  const kind = kindOf(action);
  const file = filePathOf(action);
  return (kind === "write" || kind === "edit") && !!file && isInsideProject(file, action.cwd) === false;
}

function customPatterns(action: AgentAction, cfg: ReflexConfig): Pick<Verdict, "decision" | "reason" | "rule"> | undefined {
  if (kindOf(action) !== "shell") return undefined;
  const cmd = commandOf(action) ?? "";
  for (const p of cfg.denyPatterns) if (new RegExp(p).test(cmd)) return { decision: "deny", reason: `Matches deny pattern /${p}/.`, rule: "config-deny" };
  for (const p of cfg.allowPatterns) if (new RegExp(p).test(cmd)) return { decision: "allow", reason: `Matches allow pattern /${p}/.`, rule: "config-allow" };
  return undefined;
}

function appendLog(file: string, action: AgentAction, verdict: Verdict) {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    agent: action.agent,
    tool: action.tool,
    summary: summarize(action).slice(0, 400),
    task: action.task?.slice(0, 300),
    cwd: action.cwd,
    verdict,
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + "\n");
  } catch {
    // Logging must never break the agent.
  }
}
