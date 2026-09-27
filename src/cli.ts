#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentAction, summarize } from "./action.js";
import { installClaudeCodeHook, runClaudeCodeHook } from "./adapters/claude-code.js";
import { runBench } from "./bench.js";
import { loadConfig } from "./config.js";
import { runDemo } from "./demo.js";
import { resolveApiKey } from "./jev.js";
import { evaluate, type LogEntry } from "./reflex.js";
import { serve } from "./server.js";
import { c, renderVerdict } from "./ui.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = fileURLToPath(import.meta.url);

const HELP = `${c.bold("agent-reflex")} — a ~300ms System-One safety reflex for AI coding agents, powered by Jev.

${c.bold("Usage")}
  agent-reflex check <command…> [--task "…"] [--explain] [--json]   Judge one shell command
  agent-reflex check --stdin                                        Judge an AgentAction JSON from stdin
  agent-reflex install claude-code [--project]                     Add the PreToolUse hook to Claude Code
  agent-reflex hook claude-code                                     (called by Claude Code) hook entrypoint
  agent-reflex serve [--port 7373]                                  Live dashboard + HTTP API (POST /v1/check)
  agent-reflex log [-n 20]                                          Recent decisions
  agent-reflex bench [cases.jsonl] [--verbose] [--log]             Accuracy + latency on labeled actions
  agent-reflex demo                                                 Replay a scripted agent session

${c.bold("Environment")}
  TYPESAFE_API_KEY (or JEV_API_KEY)   API key from https://console.typesafe.ai/keys
  AGENT_REFLEX_LOG                    Decision log path ("0" disables). Default ~/.agent-reflex/decisions.jsonl

Exit codes for ${c.bold("check")}: 0 allow · 1 deny · 2 ask · 3 defer (Jev unavailable)`;

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) flags[k] = v;
      else if (["task", "tool", "cwd", "port", "n", "concurrency", "json-out"].includes(k)) flags[k] = argv[++i];
      else flags[k] = true;
    } else if (a === "-n") flags.n = argv[++i];
    else if (a === "-e") flags.explain = true;
    else positional.push(a);
  }
  return { flags, positional };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function requireKey() {
  if (!resolveApiKey()) {
    console.error(c.red("No Jev API key. Set TYPESAFE_API_KEY (get one at https://console.typesafe.ai/keys)."));
    process.exit(3);
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseArgs(rest);

  switch (cmd) {
    case "check": {
      requireKey();
      let action: AgentAction;
      if (flags.stdin) action = JSON.parse(await readStdin()) as AgentAction;
      else {
        if (!positional.length) throw new Error("Usage: agent-reflex check <command…>");
        action = {
          agent: "cli",
          tool: (flags.tool as string) ?? "Bash",
          input: { command: positional.join(" ") },
          task: flags.task as string | undefined,
          cwd: (flags.cwd as string) ?? process.cwd(),
        };
      }
      const v = await evaluate(action);
      if (flags.json) console.log(JSON.stringify(v, null, 2));
      else console.log(renderVerdict(summarize(action), v, { explain: !!flags.explain }));
      process.exitCode = { allow: 0, deny: 1, ask: 2, defer: 3 }[v.decision];
      return;
    }
    case "hook": {
      if (positional[0] !== "claude-code") throw new Error("Supported hooks: claude-code");
      const out = await runClaudeCodeHook(await readStdin());
      if (out) process.stdout.write(out);
      return;
    }
    case "install": {
      if (positional[0] !== "claude-code") throw new Error("Supported targets: claude-code");
      const file = installClaudeCodeHook(flags.project ? "project" : "user", CLI_PATH);
      console.log(`${c.green("✔")} PreToolUse hook installed in ${c.bold(file)}`);
      if (!resolveApiKey()) console.log(c.yellow("  ! Export TYPESAFE_API_KEY in the shell that launches Claude Code."));
      console.log(c.gray("  Watch decisions live: agent-reflex serve"));
      return;
    }
    case "serve":
      requireKey();
      serve(Number(flags.port ?? 7373), ROOT);
      return;
    case "log": {
      const cfg = loadConfig();
      if (!cfg.logFile || !fs.existsSync(cfg.logFile)) return console.log(c.gray("No decisions logged yet."));
      const lines = fs.readFileSync(cfg.logFile, "utf8").trim().split("\n").slice(-Number(flags.n ?? 20));
      for (const l of lines) {
        const e = JSON.parse(l) as LogEntry;
        console.log(c.gray(`${new Date(e.ts).toLocaleTimeString()} ${e.agent ?? ""}`));
        console.log(renderVerdict(e.summary, e.verdict));
      }
      return;
    }
    case "bench": {
      requireKey();
      const file = positional[0] ?? path.join(ROOT, "bench", "cases.jsonl");
      const r = await runBench(file, {
        verbose: !!flags.verbose,
        log: !!flags.log,
        concurrency: flags.concurrency ? Number(flags.concurrency) : undefined,
        json: flags["json-out"] as string | undefined,
      });
      process.exitCode = r.unsafe ? 1 : 0;
      return;
    }
    case "demo":
      requireKey();
      await runDemo({ fast: !!flags.fast });
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    default:
      console.error(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exitCode = 64;
  }
}

main().catch((err) => {
  console.error(c.red(String(err?.message ?? err)));
  process.exitCode = 70;
});
