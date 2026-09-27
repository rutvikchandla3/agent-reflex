import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentAction } from "../action.js";
import { evaluate } from "../reflex.js";

/**
 * Claude Code PreToolUse hook.
 * stdin:  { session_id, transcript_path, cwd, hook_event_name, tool_name, tool_input }
 * stdout: { hookSpecificOutput: { hookEventName, permissionDecision, permissionDecisionReason } }
 * "defer" prints nothing, so Claude Code falls back to its normal permission prompt.
 */
type HookInput = {
  transcript_path?: string;
  cwd?: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
};

export async function runClaudeCodeHook(stdin: string): Promise<string> {
  const input = JSON.parse(stdin) as HookInput;
  const action: AgentAction = {
    agent: "claude-code",
    tool: input.tool_name,
    input: input.tool_input ?? {},
    cwd: input.cwd,
    task: input.transcript_path ? lastUserPrompt(input.transcript_path) : undefined,
  };
  const v = await evaluate(action);
  if (v.decision === "defer") return "";

  const where = v.source === "jev" ? `Jev · ${v.latencyMs}ms` : v.source === "rule" ? "rule" : "fallback";
  const reason =
    v.decision === "deny"
      ? `agent-reflex blocked this (${where}): ${v.reason} If the user really wants this, ask them to run it themselves.`
      : `agent-reflex (${where}): ${v.reason}`;

  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: v.decision, permissionDecisionReason: reason },
  });
}

/** Reads the tail of the session transcript and returns the latest real user prompt (the task). */
export function lastUserPrompt(transcriptPath: string): string | undefined {
  try {
    const fd = fs.openSync(transcriptPath, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 1024 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString("utf8").split("\n").reverse();
    for (const line of lines) {
      if (!line.includes('"user"')) continue;
      let entry: { type?: string; isMeta?: boolean; message?: { role?: string; content?: unknown } };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type !== "user" || entry.isMeta || entry.message?.role !== "user") continue;
      const content = entry.message.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.filter((c) => c?.type === "text").map((c) => c.text as string).join("\n")
            : "";
      const cleaned = text.replace(/<(system-reminder|command-[\w-]+|local-command-[\w-]+)>[\s\S]*?<\/\1>/g, "").trim();
      if (cleaned) return cleaned;
    }
  } catch {
    // No transcript: the off-task check is skipped.
  }
  return undefined;
}

/** Adds the PreToolUse hook to Claude Code settings (user-level by default). */
export function installClaudeCodeHook(scope: "user" | "project", cliPath: string, cwd = process.cwd()): string {
  const file = scope === "user" ? path.join(os.homedir(), ".claude", "settings.json") : path.join(cwd, ".claude", "settings.json");
  const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const command = `node ${JSON.stringify(cliPath)} hook claude-code`;
  settings.hooks ??= {};
  settings.hooks.PreToolUse ??= [];
  const groups = settings.hooks.PreToolUse as Array<{ matcher?: string; hooks: Array<{ command?: string }> }>;
  const already = groups.some((g) => g.hooks?.some((h) => h.command?.includes("hook claude-code")));
  if (!already) groups.push({ matcher: "*", hooks: [{ type: "command", command, timeout: 15 } as { command: string }] });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  return file;
}
