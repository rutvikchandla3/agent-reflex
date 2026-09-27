import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lastUserPrompt } from "../dist/adapters/claude-code.js";

function writeTranscript(lines) {
  const file = path.join(os.tmpdir(), `agent-reflex-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

test("lastUserPrompt returns the real user prompt, skipping tool_result and isMeta entries", () => {
  const lines = [
    // oldest: the real prompt the user typed, including a system-reminder block to be stripped
    {
      type: "user",
      message: {
        role: "user",
        content: "Please fix the failing test\n<system-reminder>Internal note, ignore</system-reminder>",
      },
    },
    // an assistant reply
    {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Sure, looking into it." }] },
    },
    // a user message that is only a tool_result (no text) - should be skipped
    {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "abc123", content: "some tool output" }],
      },
    },
    // most recent: an isMeta user message - should be skipped explicitly
    {
      type: "user",
      isMeta: true,
      message: { role: "user", content: "meta bookkeeping message" },
    },
  ];
  const file = writeTranscript(lines);
  try {
    const result = lastUserPrompt(file);
    assert.equal(result, "Please fix the failing test");
  } finally {
    fs.unlinkSync(file);
  }
});

test("lastUserPrompt returns undefined for a missing file", () => {
  const result = lastUserPrompt("/nonexistent/path/that/does/not/exist-agent-reflex.jsonl");
  assert.equal(result, undefined);
});
