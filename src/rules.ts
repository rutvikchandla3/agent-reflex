import { type AgentAction, commandOf, filePathOf, kindOf } from "./action.js";

/**
 * Deterministic fast path. Code stays in control of the obvious cases:
 *  - catastrophic commands are denied without asking a model,
 *  - provably read-only calls are allowed without a network round trip.
 * Everything else goes to Jev.
 */
export type RuleHit = { decision: "allow" | "deny"; rule: string; reason: string };

const CATASTROPHIC: Array<[string, RegExp, string]> = [
  ["rm-root-or-home", /\brm\s+(?:-{1,2}[\w-]+\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(?:-{1,2}[\w-]+\s+)*(?:\/|\/\*|~|~\/|~\/\*|\$HOME|\$\{HOME\}|\$HOME\/\*)(?=\s|$|;|&|\|)/, "recursively deletes the filesystem root or home directory"],
  ["fork-bomb", /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, "is a fork bomb"],
  ["mkfs", /\bmkfs(?:\.\w+)?\b/, "formats a disk"],
  ["dd-to-device", /\bdd\b[^\n]*\bof=\/dev\/(?:r?disk|sd|nvme|hd|mmcblk)/, "overwrites a raw disk device"],
  ["redirect-to-device", />\s*\/dev\/(?:r?disk\d|sd[a-z]|nvme\d|hd[a-z])/, "overwrites a raw disk device"],
  ["chmod-root", /\bchmod\s+-R\s+0?777\s+\/(?:\s|$)/, "makes the whole filesystem world-writable"],
];

const SECRET_PATH = /(?:^|[\/\s"'=])(?:\.env(?!\.(?:example|sample|template|dist)\b)(?:\.[\w-]+)?|\.aws\/credentials|\.ssh\/|id_rsa|id_ed25519|id_ecdsa|\.netrc|\.pgpass|\.npmrc|\.pypirc|[\w-]*\.pem|[\w-]*\.key|credentials\.json|secrets?\.(?:ya?ml|json|toml))(?=$|[\s"'\/;|&)])/i;

const READ_ONLY_TOOLS = new Set([
  "read", "glob", "grep", "ls", "notebookread", "todowrite", "todoread", "websearch",
  "exitplanmode", "task", "view", "list_files", "search", "read_file",
]);

// Commands that only inspect state. Checked per invocation; any shell metacharacter disqualifies the fast path.
const READ_ONLY_CMD = /^(?:ls|ll|pwd|whoami|date|uname|tree|which|type|file|stat|wc|du|df|echo|cat|head|tail|less|grep|rg|ag|fd|find|jq|diff|sort|uniq|cut)\b/;
const GIT_READ_ONLY = /^git\s+(?:status|diff|log|show|blame|rev-parse|ls-files|remote\s+-v|branch(?:\s+(?:-a|-r|--list|-vv?|--show-current))*\s*$)/;
const VERSION_CHECK = /^[\w.-]+\s+(?:-v|-V|--version|version)\s*$/;
const SHELL_META = /[;&|<>`$(){}\\\n]|\bxargs\b/;
const FIND_WRITES = /\s-(?:delete|exec|execdir|ok|fprint)\b/;

export function checkRules(action: AgentAction, extraAllowTools: string[] = []): RuleHit | undefined {
  const kind = kindOf(action);

  if (kind === "shell") {
    const cmd = (commandOf(action) ?? "").trim();
    for (const [rule, re, why] of CATASTROPHIC) {
      if (re.test(cmd)) return { decision: "deny", rule, reason: `Command ${why}.` };
    }
    if (!SHELL_META.test(cmd) && !SECRET_PATH.test(cmd) && !FIND_WRITES.test(cmd)) {
      if (READ_ONLY_CMD.test(cmd) || GIT_READ_ONLY.test(cmd) || VERSION_CHECK.test(cmd)) {
        return { decision: "allow", rule: "read-only-command", reason: "Read-only command." };
      }
    }
    return undefined;
  }

  const tool = action.tool.toLowerCase();
  if (READ_ONLY_TOOLS.has(tool) || extraAllowTools.map((t) => t.toLowerCase()).includes(tool)) {
    const file = filePathOf(action) ?? "";
    // Reading a secret is not "read-only" in the sense that matters: let Jev weigh it against the task.
    if (SECRET_PATH.test(` ${file}`)) return undefined;
    return { decision: "allow", rule: "read-only-tool", reason: `${action.tool} is read-only.` };
  }
  return undefined;
}
