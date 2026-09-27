import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { toState, summarize } from "../dist/index.js";

test("toState for Bash includes action.command and never leaks the task", () => {
  const action = {
    tool: "Bash",
    input: { command: "echo hi" },
    task: "do the super secret task thing",
    cwd: process.cwd(),
  };
  const state = toState(action);
  assert.equal(state.action.type, "run shell command");
  assert.equal(state.action.command, "echo hi");
  const serialized = JSON.stringify(state);
  assert.ok(!serialized.includes("do the super secret task thing"), "task text must not appear anywhere in state");
});

test("Edit produces changes[0].removed_lines/added_lines from old/new strings", () => {
  const action = {
    tool: "Edit",
    input: { old_string: "foo\nbar", new_string: "foo\nbaz" },
  };
  const state = toState(action);
  assert.equal(state.action.type, "edit file");
  assert.deepEqual(state.action.changes[0].removed_lines, ["bar"]);
  assert.deepEqual(state.action.changes[0].added_lines, ["baz"]);
});

test("file_is_inside_project is true for a file under cwd", () => {
  const cwd = process.cwd();
  const action = { tool: "Read", input: { file_path: path.join(cwd, "somefile.js") }, cwd };
  const state = toState(action);
  assert.equal(state.action.file_is_inside_project, true);
});

test("file_is_inside_project is false for ~/.zshrc", () => {
  const cwd = process.cwd();
  const zshrc = path.join(os.homedir(), ".zshrc");
  const action = { tool: "Read", input: { file_path: zshrc }, cwd };
  const state = toState(action);
  assert.equal(state.action.file_is_inside_project, false);
});

test("summarize() for Bash starts with '$ '", () => {
  const action = { tool: "Bash", input: { command: "ls -la" } };
  const summary = summarize(action);
  assert.ok(summary.startsWith("$ "), `expected summary to start with "$ ", got: ${summary}`);
  assert.equal(summary, "$ ls -la");
});
