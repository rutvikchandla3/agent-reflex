import path from "node:path";

/** One tool call an agent wants to make. Agent-agnostic: adapters map their payloads into this. */
export type AgentAction = {
  /** Tool name as the agent calls it: "Bash", "Write", "Edit", "Read", "WebFetch", "shell", ... */
  tool: string;
  /** Raw tool input. For shell tools use { command }, for file tools { file_path, content? }. */
  input: Record<string, unknown>;
  /** The user's latest request to the agent. Enables the off-task (prompt-injection) check. */
  task?: string;
  /** Working directory / project root of the agent session. */
  cwd?: string;
  /** Which agent produced the action, for logs. */
  agent?: string;
};

export type ActionKind = "shell" | "write" | "edit" | "read" | "fetch" | "other";

const SHELL_TOOLS = new Set(["bash", "shell", "exec", "run_command", "terminal", "local_shell"]);
const WRITE_TOOLS = new Set(["write", "create_file", "write_file"]);
const EDIT_TOOLS = new Set(["edit", "multiedit", "str_replace", "apply_patch", "notebookedit"]);
const READ_TOOLS = new Set(["read", "read_file", "view", "notebookread"]);
const FETCH_TOOLS = new Set(["webfetch", "fetch", "http_request"]);

export function kindOf(action: AgentAction): ActionKind {
  const t = action.tool.toLowerCase();
  if (SHELL_TOOLS.has(t) || typeof action.input.command === "string") return "shell";
  if (WRITE_TOOLS.has(t)) return "write";
  if (EDIT_TOOLS.has(t)) return "edit";
  if (READ_TOOLS.has(t)) return "read";
  if (FETCH_TOOLS.has(t)) return "fetch";
  return "other";
}

export function commandOf(action: AgentAction): string | undefined {
  const c = action.input.command;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.join(" ");
  return undefined;
}

export function filePathOf(action: AgentAction): string | undefined {
  const p = action.input.file_path ?? action.input.path ?? action.input.notebook_path;
  return typeof p === "string" ? p : undefined;
}

/** Path facts are computed in code: Jev reads semantics, not path arithmetic. */
export function isInsideProject(file: string, cwd?: string): boolean | undefined {
  if (!cwd) return undefined;
  const rel = path.relative(path.resolve(cwd), path.resolve(cwd, file));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const clip = (v: unknown, n: number): string => {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
  return s.length > n ? `${s.slice(0, n)}… [${s.length - n} more chars]` : s;
};

/** Builds the compact state Jev evaluates: the action only. Only what the decision needs (Jev suffers from context rot). */
export function toState(action: AgentAction): Record<string, unknown> {
  const kind = kindOf(action);
  const file = filePathOf(action);
  let described: Record<string, unknown>;

  switch (kind) {
    case "shell":
      described = {
        type: "run shell command",
        command: clip(commandOf(action), 2000),
        ...(action.input.description ? { agent_says_it_is: clip(action.input.description, 200) } : {}),
      };
      break;
    case "write":
      described = { type: "write file", file_path: file, content: clip(action.input.content, 2500) };
      break;
    case "edit": {
      const edits = Array.isArray(action.input.edits) ? action.input.edits : [action.input];
      described = {
        type: "edit file",
        file_path: file,
        changes: edits.slice(0, 5).map((e: Record<string, unknown>) => lineDiff(String(e.old_string ?? e.old_str ?? ""), String(e.new_string ?? e.new_str ?? e.new_source ?? ""))),
        ...(typeof action.input.patch === "string" ? { patch: clip(action.input.patch, 2500) } : {}),
      };
      break;
    }
    case "read":
      described = { type: "read file", file_path: file };
      break;
    case "fetch":
      described = { type: "fetch url", url: clip(action.input.url, 600), ...(action.input.prompt ? { purpose: clip(action.input.prompt, 200) } : {}) };
      break;
    default:
      described = { type: `call tool ${action.tool}`, input: clip(action.input, 2000) };
  }

  if (file !== undefined) {
    const inside = isInsideProject(file, action.cwd);
    if (inside !== undefined) described.file_is_inside_project = inside;
  }

  // The task is deliberately absent: it lives in the on_task question (see questions.ts).
  return {
    action: described,
    ...(action.cwd ? { project_dir: action.cwd } : {}),
  };
}

/** Line-level diff computed in code, so Jev judges what was removed/added instead of diffing two blobs itself. */
function lineDiff(before: string, after: string) {
  const norm = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
  const a = norm(before);
  const b = norm(after);
  const removed = a.filter((l) => !b.includes(l));
  const added = b.filter((l) => !a.includes(l));
  const cap = (ls: string[]) => ls.slice(0, 40).map((l) => clip(l, 200));
  return { removed_lines: cap(removed), added_lines: cap(added) };
}

/** One-line human summary of an action, for logs and the dashboard. */
export function summarize(action: AgentAction): string {
  const kind = kindOf(action);
  if (kind === "shell") return `$ ${commandOf(action) ?? ""}`;
  if (kind === "fetch") return `fetch ${String(action.input.url ?? "")}`;
  const file = filePathOf(action);
  if (file) return `${action.tool} ${file}`;
  return `${action.tool} ${clip(action.input, 120)}`;
}
