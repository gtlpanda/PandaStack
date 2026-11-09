import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { project, run, KIT, CLI } from "../test-fixtures/project.mjs";
import { loadConfig } from "../lib/config.mjs";
import { codexArgs, readCodexResult } from "../lib/codex.mjs";
const env = { AUTOBUILD_BACKEND: "codex", AUTOBUILD_CODEX_BIN: path.join(KIT, "test-fixtures", "fake-codex.mjs"), AUTOBUILD_CLAUDE_BIN: "/no/claude" };
function configure(root, patch) {
  const file = path.join(root, "autobuild.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...patch }));
  execFileSync("git", ["-C", root, "commit", "-qam", "config"]);
}
test("Codex maps all Claude tiers; explicit OpenAI model and backend overrides win", () => {
  const root = project(["F-1"]);
  const config = loadConfig(root, env);
  assert.deepEqual([config.model, config.subagentModel, config.probeModel], ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"]);
  assert.equal(loadConfig(root, { ...env, AUTOBUILD_MODEL: "gpt-6.1-terra" }).model, "gpt-6.1-terra");
  assert.equal(loadConfig(root, env, { backend: "claude" }).model, "claude-opus-5-5");
  const { args } = codexArgs(config, { prompt: "build" });
  assert.ok(args.includes('agents.default_subagent_model="gpt-6.1-sol"'));
  assert.ok(!args.includes("--max-budget-usd"));
  configure(root, { limits: { totalBudgetUsd: 10 } });
  assert.throws(() => loadConfig(root, env), /does not report dollar cost/);
});
test("Codex builds and the host gates/commits, without any Claude binary", () => {
  const root = project(["F-1"]);
  const result = run(root, [{ build: "F-1" }], env);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /host gate: PASS/);
  assert.equal(JSON.parse(readFileSync(path.join(root, "features.json"))).features[0].passes, true);
  assert.match(execFileSync("git", ["-C", root, "log", "-1", "--format=%s"], { encoding: "utf8" }), /^feat\(F-1\)/);
});
test("a failing full gate is retried with feedback even when feature tests pass", () => {
  const root = project(["F-1"]);
  configure(root, { gate: [{ name: "regression", command: "test ! -f bad-code" }] });
  const result = run(root, [{ build: "F-1", gateFail: true }, { fixGate: true }], env);
  assert.equal(result.code, 0, result.out);
  assert.match(result.calls[1].input, /Previous gate feedback:[\s\S]*regression/);
});
test("frozen edits and passing-flag manipulation stop Codex", () => {
  for (const bad of [{ tamper: true }, { flags: true }]) {
    const result = run(project(["F-1"]), [bad], env);
    assert.equal(result.code, 4, result.out);
  }
});
test("Codex reviews and the native final audit finish without Claude", () => {
  const root = project(["F-1"], { finalReview: true });
  execFileSync("git", ["-C", root, "branch", "main"]);
  configure(root, { bughuntBase: "main" });
  const result = run(root, [{ build: "F-1" }, { review: true }, { audit: { verdict: "pass", summary: "Reviewed branch; no defects", unresolved: [] } }], { ...env, AUTOBUILD_BUGHUNT: "1" });
  assert.equal(result.code, 0, result.out);
  assert.equal(result.calls.length, 3);
  assert.match(result.out, /branch audit and full gate: PASS/);
});
test("Codex audit with unresolved findings does not report done", () => {
  const root = project(["F-1"]);
  execFileSync("git", ["-C", root, "branch", "main"]);
  configure(root, { bughuntBase: "main" });
  const result = run(root, [{ build: "F-1" }, { audit: { verdict: "needs_human", summary: "problem", unresolved: ["file:1 bug"] } }], { ...env, AUTOBUILD_BUGHUNT: "1" });
  assert.equal(result.code, 12, result.out);
});
test("Codex usage failures probe with Luna, then resume; auth fails immediately", () => {
  const root = project(["F-1"]);
  const result = run(root, [{ error: "You've hit your usage limit" }, { ok: true }, { build: "F-1" }], env);
  assert.equal(result.code, 0, result.out);
  assert.ok(result.calls[1].args.includes("gpt-6-luna"));
  assert.ok(result.calls[1].args.includes("read-only"));
  assert.equal(run(project(["F-1"]), [{ error: "401 Unauthorized" }], env).code, 10);
});
test("exit zero without completion event never marks a feature passing", () => {
  const result = run(project(["F-1"]), [{ build: "F-1", noResult: true }, { noResult: true }], env);
  assert.equal(result.code, 2, result.out);
});
test("JSONL parser ignores limit text in tool results and malformed lines", () => {
  const root = project(["F-1"]);
  const file = path.join(root, "events");
  writeFileSync(file, 'garbage\n{"type":"item.completed","item":{"text":"usage limit reached"}}\n{"type":"turn.completed","usage":{"input_tokens":4}}\n');
  assert.equal(readCodexResult(file).subtype, "success");
});
test("init --backend codex appends AGENTS rules and creates mapped config", () => {
  const root = project(["F-1"]);
  // Existing configs must not be overwritten by init.
  const before = readFileSync(path.join(root, "autobuild.json"), "utf8");
  const result = spawnSync(process.execPath, [CLI, "init", "--backend", "codex"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path.join(root, "autobuild.json"), "utf8"), before);
  assert.match(readFileSync(path.join(root, "AGENTS.md"), "utf8"), /outer harness/);
});

test("Codex session timeout stops stalled children and preserves no-progress limits", () => {
  const root = project(["F-1"]);
  configure(root, { codex: { sessionTimeoutMinutes: 0.002 } });
  const result = run(root, [{ hang: true }, { hang: true }], env);
  assert.equal(result.code, 2, result.out);
  assert.match(result.out, /exit 124/);
});
test("Codex fresh init writes mapped models and preserves existing AGENTS content", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autobuild-init-codex-"));
  writeFileSync(path.join(root, "AGENTS.md"), "# Existing rules\n");
  const result = spawnSync(process.execPath, [CLI, "init", "--backend", "codex"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const config = loadConfig(root, {});
  assert.equal(config.backend, "codex");
  assert.equal(config.model, "gpt-6-astra");
  assert.match(readFileSync(path.join(root, "AGENTS.md"), "utf8"), /^# Existing rules/);
});
test("periodic Codex review failure is retried before done", () => {
  const root = project(["F-1"], { reviewEvery: 1, finalReview: true });
  const result = run(root, [{ build: "F-1" }, { ok: true }, { review: true }], env);
  assert.equal(result.code, 0, result.out);
  assert.equal(result.calls.length, 3);
});
test("a Codex review cannot edit implementation files", () => {
  const root = project(["F-1"], { finalReview: true });
  const result = run(root, [{ build: "F-1" }, { review: true, gateFail: true }], env);
  assert.notEqual(result.code, 0, result.out);
  assert.match(result.out, /review changed files beyond/);
});

test("gate commands cannot modify frozen tests before the host commits", () => {
  const root = project(["F-1"]);
  configure(root, { gate: [{ name: "mutating test runner", command: "printf modified > tests/F-1.test" }] });
  const result = run(root, [{ build: "F-1" }], env);
  assert.equal(result.code, 4, result.out);
  assert.equal(JSON.parse(readFileSync(path.join(root, "features.json"))).features[0].passes, false);
});
test("cached Codex audit refuses later dirty code and reruns clean-tree gates", () => {
  const root = project(["F-1"]);
  execFileSync("git", ["-C", root, "branch", "main"]);
  configure(root, { bughuntBase: "main", gate: [{ name: "regression", command: "test ! -f bad-code && test ! -f .harness/fail-gate" }] });
  const enabled = { ...env, AUTOBUILD_BUGHUNT: "1" };
  assert.equal(run(root, [{ build: "F-1" }, { audit: { verdict: "pass", summary: "clean", unresolved: [] } }], enabled).code, 0);
  writeFileSync(path.join(root, "bad-code"), "bad\n");
  const dirty = run(root, [], enabled);
  assert.equal(dirty.code, 12, dirty.out);
  execFileSync("rm", [path.join(root, "bad-code")]);
  writeFileSync(path.join(root, ".harness/fail-gate"), "fail\n");
  const failed = run(root, [], enabled);
  assert.equal(failed.code, 12, failed.out);
  assert.match(failed.out, /host gate: FAIL/);
});

test("a missing backend value fails instead of silently launching Claude", () => {
  const root = project(["F-1"]);
  const result = spawnSync(process.execPath, [CLI, "run", "--backend"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--backend requires a value/);
});
