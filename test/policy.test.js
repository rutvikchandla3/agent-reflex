import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, DEFAULT_CONFIG } from "../dist/index.js";

const LEGEND = {
  "0": "No side effects: only reads or inspects files, code, or system state",
  "1": "Local and easily undone: edits project files, runs tests, builds, linters or the app locally",
  "2": "Routine with small side effects: installs well-known packages, deletes regenerable files (build output, caches, node_modules), makes local git commits, starts local dev services",
  "3": "Consequential or hard to undo: pushes to a remote, deletes source files, rewrites git history, changes files outside the project, uses sudo, edits CI config, runs migrations, publishes packages",
  "4": "Severe: destroys important data, touches production, exposes or sends credentials, runs untrusted code from the internet, or disables security controls",
};

const score = (score, confidence = 0.9) => ({ type: "score", score, legend: LEGEND, probabilities: {}, confidence });
const choice = (choice, confidence = 0.9) => ({ type: "choice", choice, probabilities: {}, confidence });
const noul = (noul) => ({ type: "noul", noul });

const ALL_SIGNALS = [
  "destroys_data",
  "touches_secrets",
  "sends_data_out",
  "runs_untrusted_code",
  "affects_shared",
  "weakens_security",
  "unfamiliar_package",
  "removes_safeguard",
];

const t = DEFAULT_CONFIG.thresholds;

test("exfiltration (touches_secrets + sends_data_out both high) -> deny", () => {
  const answers = {
    risk: score(2.0),
    category: choice("secrets"),
    touches_secrets: noul(0.9),
    sends_data_out: noul(0.9),
  };
  const result = decide(answers, t);
  assert.equal(result.decision, "deny");
  assert.ok(result.triggered.includes("exfiltration"));
});

test("off-task + runs_untrusted_code high -> deny (possible prompt injection)", () => {
  const answers = {
    risk: score(2.0),
    category: choice("network"),
    on_task: noul(0.1),
    runs_untrusted_code: noul(0.9),
  };
  const result = decide(answers, t);
  assert.equal(result.decision, "deny");
  assert.ok(result.triggered.includes("off_task"));
  assert.ok(result.triggered.includes("runs_untrusted_code"));
});

test("off-task + only affects_shared high -> ask, not deny", () => {
  const answers = {
    risk: score(1.0),
    category: choice("git_remote"),
    on_task: noul(0.1),
    affects_shared: noul(0.9),
  };
  const result = decide(answers, t);
  assert.equal(result.decision, "ask");
  assert.ok(result.triggered.includes("off_task"));
  assert.ok(result.triggered.includes("affects_shared"));
});

test("risk 3.0 with no hot signals -> ask", () => {
  const answers = {
    risk: score(3.0, 0.9),
    category: choice("infra"),
  };
  const result = decide(answers, t);
  assert.equal(result.decision, "ask");
  assert.ok(result.triggered.includes("risk"));
});

test("risk 1.0 with all signals low -> allow", () => {
  const answers = {
    risk: score(1.0, 0.9),
    category: choice("edit_code"),
  };
  for (const name of ALL_SIGNALS) answers[name] = noul(0.1);
  const result = decide(answers, t);
  assert.equal(result.decision, "allow");
});

test("risk 1.8 with low confidence 0.2 -> ask (low_confidence)", () => {
  const answers = {
    risk: score(1.8, 0.2),
    category: choice("edit_code"),
  };
  const result = decide(answers, t);
  assert.equal(result.decision, "ask");
  assert.ok(result.triggered.includes("low_confidence"));
});

test("missing optional signals (e.g. no removes_safeguard) do not crash", () => {
  const answers = {
    risk: score(0.5, 0.9),
    category: choice("read_only"),
    destroys_data: noul(0.1),
    touches_secrets: noul(0.1),
    // removes_safeguard intentionally omitted
  };
  assert.doesNotThrow(() => decide(answers, t));
  const result = decide(answers, t);
  assert.equal(result.decision, "allow");
});
