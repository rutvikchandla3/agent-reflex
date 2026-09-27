import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Thresholds = {
  /** Probability-weighted risk score (0–4) at or above which the human is asked. */
  askRisk: number;
  /** Risk score at or above which the action is blocked. */
  denyRisk: number;
  /** Any risk signal (Noul) at or above this asks the human. */
  signal: number;
  /** touches_secrets AND sends_data_out both at or above this => blocked as exfiltration. */
  exfil: number;
  /** on_task at or below this means the action doesn't serve the user's request. */
  offTask: number;
  /** Below this confidence on the risk score, a non-trivial action is escalated rather than trusted. */
  minConfidence: number;
};

export type ReflexConfig = {
  model: string;
  timeoutMs: number;
  /** What to do when Jev is unreachable. "defer" hands the call back to the agent's normal permission flow. */
  onError: "defer" | "ask" | "allow" | "deny";
  thresholds: Thresholds;
  /** Extra tool names to always allow (e.g. your own read-only MCP tools). */
  allowTools: string[];
  /** Extra regexes: matching shell commands are always denied / always allowed. */
  denyPatterns: string[];
  allowPatterns: string[];
  /** JSONL decision log, read by `agent-reflex serve` and `agent-reflex log`. false disables. */
  logFile: string | false;
};

export const HOME_DIR = path.join(os.homedir(), ".agent-reflex");

export const DEFAULT_CONFIG: ReflexConfig = {
  model: "jev-latest",
  timeoutMs: 4000,
  onError: "defer",
  thresholds: {
    askRisk: 2.5,
    denyRisk: 3.5,
    signal: 0.6,
    exfil: 0.8,
    offTask: 0.3,
    minConfidence: 0.35,
  },
  allowTools: [],
  denyPatterns: [],
  allowPatterns: [],
  logFile: path.join(HOME_DIR, "decisions.jsonl"),
};

/** Merges ~/.agent-reflex/config.json, then <project>/.agent-reflex.json, over the defaults. */
export function loadConfig(cwd?: string, overrides: Partial<ReflexConfig> = {}): ReflexConfig {
  const layers = [path.join(HOME_DIR, "config.json"), cwd ? path.join(cwd, ".agent-reflex.json") : undefined]
    .filter((p): p is string => !!p && fs.existsSync(p))
    .map((p) => {
      try {
        return JSON.parse(fs.readFileSync(p, "utf8")) as Partial<ReflexConfig>;
      } catch {
        return {};
      }
    });
  const env: Partial<ReflexConfig> = {};
  if (process.env.AGENT_REFLEX_LOG === "0") env.logFile = false;
  else if (process.env.AGENT_REFLEX_LOG) env.logFile = process.env.AGENT_REFLEX_LOG;
  // Precedence: defaults < user file < project file < env < explicit overrides.
  let cfg: ReflexConfig = { ...DEFAULT_CONFIG, thresholds: { ...DEFAULT_CONFIG.thresholds } };
  for (const layer of [...layers, env, overrides]) {
    cfg = { ...cfg, ...layer, thresholds: { ...cfg.thresholds, ...(layer.thresholds ?? {}) } };
  }
  return cfg;
}
