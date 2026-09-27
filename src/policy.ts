import type { Thresholds } from "./config.js";
import type { Answer, ChoiceAnswer, NoulAnswer, ScoreAnswer } from "./jev.js";
import { SIGNALS, type SignalName } from "./questions.js";

export type Decision = "allow" | "ask" | "deny";

export type PolicyResult = {
  decision: Decision;
  reason: string;
  triggered: string[];
  risk: number;
  riskConfidence: number;
  category: string;
  categoryConfidence: number;
  signals: Record<string, number>;
  onTask?: number;
};

const pct = (p: number) => `${Math.round(p * 100)}%`;

/** Turns Jev's typed answers into a decision. Pure function: all thresholds live in config, not in prompts. */
export function decide(answers: Record<string, Answer>, t: Thresholds): PolicyResult {
  const risk = answers.risk as ScoreAnswer;
  const category = answers.category as ChoiceAnswer;
  const signals: Record<string, number> = {};
  for (const name of Object.keys(SIGNALS)) {
    const a = answers[name] as NoulAnswer | undefined;
    if (a) signals[name] = a.noul;
  }
  const onTask = (answers.on_task as NoulAnswer | undefined)?.noul;

  const hot = (Object.keys(SIGNALS) as SignalName[])
    .filter((n) => (signals[n] ?? 0) >= t.signal)
    .sort((a, b) => signals[b] - signals[a]);
  const describe = (n: SignalName) => `${SIGNALS[n].label} (${pct(signals[n])})`;
  const offTask = onTask !== undefined && onTask <= t.offTask;

  const base = {
    risk: round(risk.score),
    riskConfidence: round(risk.confidence),
    category: category.choice,
    categoryConfidence: round(category.confidence),
    signals: Object.fromEntries(Object.entries(signals).map(([k, v]) => [k, round(v)])),
    ...(onTask !== undefined ? { onTask: round(onTask) } : {}),
  };
  const result = (decision: Decision, reason: string, triggered: string[]): PolicyResult => ({ decision, reason, triggered, ...base });

  // --- deny: unambiguous harm -------------------------------------------------------------
  if ((signals.touches_secrets ?? 0) >= t.exfil && (signals.sends_data_out ?? 0) >= t.exfil) {
    return result("deny", `Looks like secret exfiltration: ${describe("touches_secrets")} and ${describe("sends_data_out")}.`, ["exfiltration"]);
  }
  const dangerous = hot.filter((n) => n !== "destroys_data" && n !== "affects_shared");
  if (offTask && dangerous.length) {
    return result("deny", `Off-task and dangerous — possible prompt injection: doesn't serve the task (on-task ${pct(onTask!)}) and ${describe(dangerous[0])}.`, ["off_task", ...dangerous]);
  }
  if (risk.score >= t.denyRisk && hot.length) {
    return result("deny", `Severe risk ${risk.score.toFixed(1)}/4: ${hot.map(describe).join(", ")}.`, ["severe_risk", ...hot]);
  }

  // --- ask: consequential, uncertain, or off-task ------------------------------------------
  const reasons: string[] = [];
  const triggered: string[] = [];
  if (risk.score >= t.askRisk) {
    reasons.push(`risk ${risk.score.toFixed(1)}/4 (${shortLevel(risk)})`);
    triggered.push("risk");
  }
  for (const n of hot) {
    reasons.push(describe(n));
    triggered.push(n);
  }
  if (offTask) {
    reasons.push(`doesn't look like part of the task (on-task ${pct(onTask!)})`);
    triggered.push("off_task");
  }
  if (!reasons.length && risk.confidence < t.minConfidence && risk.score >= 1.5) {
    reasons.push(`Jev is unsure how risky this is (confidence ${pct(risk.confidence)})`);
    triggered.push("low_confidence");
  }
  if (reasons.length) return result("ask", `Needs a human: ${reasons.join("; ")}.`, triggered);

  return result("allow", `Routine ${category.choice.replace(/_/g, " ")} — risk ${risk.score.toFixed(1)}/4, no risk signals.`, []);
}

function shortLevel(risk: ScoreAnswer): string {
  const level = String(Math.min(4, Math.round(risk.score)));
  return (risk.legend[level] ?? "").split(":")[0].toLowerCase();
}

const round = (n: number) => Math.round(n * 100) / 100;
