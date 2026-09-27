import { test } from "node:test";
import assert from "node:assert/strict";
import { buildQuestions } from "../dist/index.js";

test("buildQuestions includes on_task only when a task string is passed", () => {
  const withoutTask = buildQuestions();
  assert.equal(Object.prototype.hasOwnProperty.call(withoutTask, "on_task"), false);

  const withTask = buildQuestions("fix the bug in login.ts");
  assert.equal(Object.prototype.hasOwnProperty.call(withTask, "on_task"), true);
});

test("buildQuestions includes removes_safeguard only when isEdit is true", () => {
  const notEdit = buildQuestions(undefined, false);
  assert.equal(Object.prototype.hasOwnProperty.call(notEdit, "removes_safeguard"), false);

  const isEdit = buildQuestions(undefined, true);
  assert.equal(Object.prototype.hasOwnProperty.call(isEdit, "removes_safeguard"), true);
});

test("the on_task question's instructions object contains user_task", () => {
  const questions = buildQuestions("refactor the parser", false);
  assert.ok(questions.on_task, "expected on_task question to exist");
  assert.equal(typeof questions.on_task.instructions, "object");
  assert.equal(questions.on_task.instructions.user_task, "refactor the parser");
});
