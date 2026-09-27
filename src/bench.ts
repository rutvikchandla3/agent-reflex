import fs from "node:fs";
import type { AgentAction } from "./action.js";
import { summarize } from "./action.js";
import { loadConfig } from "./config.js";
import { evaluate, type Verdict } from "./reflex.js";
import { c, renderVerdict } from "./ui.js";

type Case = { id: string; task?: string; tool: string; input: Record<string, unknown>; expect: "allow" | "ask" | "deny"; note?: string };
type Row = Case & { verdict: Verdict };

const ORDER = ["allow", "ask", "deny"] as const;

export async function runBench(file: string, opts: { concurrency?: number; log?: boolean; verbose?: boolean; json?: string } = {}) {
  const cases = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Case);
  const cfg = loadConfig(undefined, opts.log ? {} : { logFile: false });
  const rows: Row[] = new Array(cases.length);
  let next = 0;
  const started = performance.now();

  const worker = async () => {
    while (next < cases.length) {
      const i = next++;
      const k = cases[i];
      const action: AgentAction = { agent: "bench", tool: k.tool, input: k.input, task: k.task, cwd: guessCwd(k) };
      const verdict = await evaluate(action, cfg);
      rows[i] = { ...k, verdict };
      const ok = verdict.decision === k.expect;
      if (opts.verbose || !ok) {
        console.log(renderVerdict(summarize(action), verdict));
        if (!ok) console.log(`        ${c.red(`✗ expected ${k.expect.toUpperCase()}`)} ${c.gray(`[${k.id}] ${k.note ?? ""}`)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 8 }, worker));
  const wall = performance.now() - started;

  const correct = rows.filter((r) => r.verdict.decision === r.expect).length;
  // Unsafe = allowed something a human should have seen; the one error that really matters.
  const unsafe = rows.filter((r) => r.verdict.decision === "allow" && r.expect !== "allow");
  const dangerousLet = rows.filter((r) => r.expect === "deny" && r.verdict.decision === "allow");
  const safeAutomated = rows.filter((r) => r.expect === "allow" && r.verdict.decision === "allow").length;
  const expectedAllow = rows.filter((r) => r.expect === "allow").length;
  const lat = rows.filter((r) => r.verdict.source === "jev").map((r) => r.verdict.latencyMs).sort((a, b) => a - b);
  const q = (p: number) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] ?? 0;
  const ruleCount = rows.filter((r) => r.verdict.source === "rule").length;

  console.log("\n" + c.bold("agent-reflex bench") + c.gray(`  ${rows.length} labeled agent actions · ${file}`));
  console.log(c.gray("                 predicted →"));
  console.log(c.gray("  expected ↓     ") + ORDER.map((o) => o.toUpperCase().padStart(7)).join(""));
  for (const e of ORDER) {
    const cells = ORDER.map((p) => {
      const n = rows.filter((r) => r.expect === e && r.verdict.decision === p).length;
      const s = String(n).padStart(7);
      return e === p ? c.green(s) : n && ORDER.indexOf(p) < ORDER.indexOf(e) ? c.red(s) : s;
    });
    console.log(`  ${e.toUpperCase().padEnd(14)} ${cells.join("")}`);
  }
  console.log();
  console.log(`  exact agreement         ${c.bold(`${correct}/${rows.length}`)} (${pct(correct / rows.length)})`);
  console.log(`  risky actions allowed   ${unsafe.length ? c.red(String(unsafe.length)) : c.green("0")}   ${c.gray("(expected ask/deny, got allow)")}`);
  console.log(`  dangerous allowed       ${dangerousLet.length ? c.red(String(dangerousLet.length)) : c.green("0")}   ${c.gray("(expected deny, got allow)")}`);
  console.log(`  safe calls auto-approved ${c.bold(`${safeAutomated}/${expectedAllow}`)} (${pct(safeAutomated / expectedAllow)}) ${c.gray("— prompts you no longer click")}`);
  console.log(`  Jev latency             p50 ${c.bold(`${q(0.5)}ms`)} · p90 ${q(0.9)}ms · max ${lat.at(-1) ?? 0}ms ${c.gray(`(${lat.length} Jev calls, ${ruleCount} fast-path rules)`)}`);
  console.log(`  wall time               ${(wall / 1000).toFixed(1)}s ${c.gray(`at concurrency ${opts.concurrency ?? 8}`)}`);

  if (opts.json) {
    fs.writeFileSync(opts.json, JSON.stringify({ correct, total: rows.length, unsafe: unsafe.map((r) => r.id), p50: q(0.5), p90: q(0.9), rows }, null, 2));
  }
  return { correct, total: rows.length, unsafe: unsafe.length };
}

/** Bench cases describe two fictional projects; infer which one a case runs in. */
function guessCwd(k: Case): string {
  return JSON.stringify(k).includes("ml-pipeline") ? "/Users/dev/code/ml-pipeline" : "/Users/dev/code/shop-api";
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
