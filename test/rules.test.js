import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { checkRules } from "../dist/rules.js";

const bash = (command) => ({ tool: "Bash", input: { command } });
const tool = (toolName, input = {}) => ({ tool: toolName, input });

describe("checkRules: catastrophic commands are denied", () => {
  const cases = [
    ["rm -rf ~/", bash("rm -rf ~/")],
    ["rm -rf /", bash("rm -rf /")],
    ["sudo rm -rf --no-preserve-root /", bash("sudo rm -rf --no-preserve-root /")],
    ["fork bomb", bash(":(){ :|:& };:")],
    ["mkfs.ext4 /dev/sda1", bash("mkfs.ext4 /dev/sda1")],
    ["dd if=/dev/zero of=/dev/disk2", bash("dd if=/dev/zero of=/dev/disk2")],
  ];
  for (const [name, action] of cases) {
    test(name, () => {
      const hit = checkRules(action);
      assert.ok(hit, `expected a rule hit for: ${name}`);
      assert.equal(hit.decision, "deny");
    });
  }
});

describe("checkRules: safe things are allowed", () => {
  const cases = [
    ["ls -la", bash("ls -la")],
    ["git status", bash("git status")],
    ["git diff HEAD~1", bash("git diff HEAD~1")],
    ["node --version", bash("node --version")],
    ["Read tool on src/index.ts", tool("Read", { file_path: "src/index.ts" })],
    ["Grep tool", tool("Grep", { pattern: "foo" })],
    [".env.example Read is allowed", tool("Read", { file_path: ".env.example" })],
  ];
  for (const [name, action] of cases) {
    test(name, () => {
      const hit = checkRules(action);
      assert.ok(hit, `expected a rule hit (allow) for: ${name}`);
      assert.equal(hit.decision, "allow");
    });
  }
});

describe("checkRules: ambiguous cases do not fast-path (undefined)", () => {
  const cases = [
    ["rm -rf node_modules", bash("rm -rf node_modules")],
    ["cat .env", bash("cat .env")],
    ["git push", bash("git push")],
    ["ls | xargs rm", bash("ls | xargs rm")],
    ["find . -name '*.pyc' -delete", bash("find . -name '*.pyc' -delete")],
    ["Read of /proj/.env", tool("Read", { file_path: "/proj/.env" })],
    ["Read of ~/.ssh/id_rsa", tool("Read", { file_path: "~/.ssh/id_rsa" })],
  ];
  for (const [name, action] of cases) {
    test(name, () => {
      const hit = checkRules(action);
      assert.equal(hit, undefined, `expected no fast-path decision for: ${name}`);
    });
  }
});
