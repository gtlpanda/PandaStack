import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { project, run, KIT, CLI } from "../test-fixtures/project.mjs";
import { loadConfig } from "../lib/config.mjs";
import { codexArgs, readCodexResult } from "../lib/codex.mjs";
import { npmCodex } from "../test-fixtures/codex-installs.mjs";
const env = { AUTOBUILD_BACKEND: "codex", AUTOBUILD_CODEX_BIN: path.join(KIT, "test-fixtures", "fake-codex.mjs"), AUTOBUILD_CLAUDE_BIN: "/no/claude" };
const REVIEW_STATUS = path.resolve(KIT, "../../hunt/skills/bughunt/review-status.mjs");
const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const huntBuild = { build: "F-1", files: { "src/feature.js": "export function feature() { return -1; }\n" } };
function huntProject(limits = {}, patch = {}) {
  const root = project(["F-1"], limits);
  git(root, "branch", "main");
  configure(root, { bughuntBase: "main", ...patch });
  return root;
}
function repairProject() {
  const root = project(["F-1"]);
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src/feature.js"), "export function feature() { return 0; }\n");
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "hunt-repair-fixture", type: "module", scripts: { test: "node --test tests/*.test.mjs" } }));
  writeFileSync(path.join(root, "tests/existing.test.mjs"), "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('baseline', () => assert.equal(1, 1));\n");
  git(root, "add", "."); git(root, "commit", "-qm", "baseline suite"); git(root, "branch", "main");
  configure(root, { bughuntBase: "main" });
  return root;
}
function huntCalls(root) {
  const file = path.join(root, ".harness-script.json.hunt-calls");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
}
function reviewStatus(root) {
  return JSON.parse(execFileSync(process.execPath, [REVIEW_STATUS, "status", "--repo", root, "--head", "HEAD", "--base", "main"], { encoding: "utf8" }));
}
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
  assert.equal(loadConfig(root, env, { backend: "claude" }).model, "opus");
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
test("Codex final review and full hunt produce the shared PR ledger without Claude", () => {
  const root = huntProject({ finalReview: true });
  const result = run(root, [huntBuild, { review: true }], { ...env, AUTOBUILD_BUGHUNT: "1" });
  assert.equal(result.code, 0, result.out);
  assert.equal(result.calls.length, 2, "only builder and periodic review consume the sequential queue");
  const calls = huntCalls(root);
  assert.ok(calls.some(c => c.role === "impact-mapper"));
  assert.ok(calls.some(c => c.label === "hunt: logic"));
  assert.ok(calls.some(c => c.label === "hunt: regression"));
  assert.ok(calls.every(c => c.args.includes("read-only")), "analysis-only leaves are read-only");
  assert.ok(calls.every(c => c.args.includes("gpt-6.1-sol")), "specialists use the configured subagent tier");
  assert.match(result.out, /bug hunt:.*pass/);
  const status = reviewStatus(root);
  assert.equal(status.hunted, true, JSON.stringify(status));
  assert.equal(status.disposition, "pass", JSON.stringify(status));
  assert.match(git(root, "log", "-1", "--format=%s"), /^chore\(bughunt\): pass$/);
  assert.equal(git(root, "status", "--porcelain"), "");
  const again = run(root, [], { ...env, AUTOBUILD_BUGHUNT: "1" });
  assert.equal(again.code, 0, again.out);
  assert.equal(huntCalls(root).length, calls.length, "same-head resume reuses the verified ledger");
});
test("Codex hunt keeps confirmed unreproduced findings open instead of claiming done", () => {
  const root = huntProject();
  const result = run(root, [huntBuild], { ...env, AUTOBUILD_BUGHUNT: "1", FAKE_HUNT_MODE: "unresolved" });
  assert.equal(result.code, 12, result.out);
  const calls = huntCalls(root);
  assert.ok(calls.some(c => c.role === "skeptic"));
  assert.ok(calls.some(c => c.role === "reproducer"));
  const status = reviewStatus(root);
  assert.equal(status.hunted, true, "finished review is recorded even though it requires changes");
  assert.notEqual(status.disposition, "pass", JSON.stringify(status));
  assert.doesNotMatch(result.out, /every feature passes\. Done/);
});
test("Codex hunt reproduces, repairs, independently verifies and lands only the verified fix", () => {
  const root = repairProject();
  const result = run(root, [huntBuild], { ...env, AUTOBUILD_BUGHUNT: "1", FAKE_HUNT_MODE: "repair" });
  assert.equal(result.code, 0, result.out);
  assert.equal(readFileSync(path.join(root, "src/feature.js"), "utf8"), "export function feature() { return 0; }\n");
  assert.ok(existsSync(path.join(root, "tests/bughunt-f1.test.mjs")), "reproduction test is retained with the fix");
  const roles = huntCalls(root).map(c => c.role);
  for (const role of ["skeptic", "reproducer", "repairer", "fix-verifier"]) assert.ok(roles.includes(role), role);
  assert.ok(!roles.includes("runner"), "host executes evidence instead of trusting a model transcription");
  const status = reviewStatus(root);
  assert.equal(status.hunted, true, JSON.stringify(status));
  assert.equal(status.disposition, "pass", JSON.stringify(status));
  assert.match(git(root, "log", "-3", "--format=%s"), /bughunt: fix F1/);
  assert.equal(git(root, "status", "--porcelain"), "");
});
test("Codex rejected fix is not landed even when the reproduction and suite pass", () => {
  const root = repairProject();
  const result = run(root, [huntBuild], { ...env, AUTOBUILD_BUGHUNT: "1", FAKE_HUNT_MODE: "reject-fix" });
  assert.equal(result.code, 12, result.out);
  assert.equal(readFileSync(path.join(root, "src/feature.js"), "utf8"), huntBuild.files["src/feature.js"]);
  assert.doesNotMatch(git(root, "log", "--format=%s"), /^bughunt: fix F1$/m);
  assert.notEqual(reviewStatus(root).disposition, "pass");
});
test("Codex incomplete coverage remains manual review", () => {
  const root = huntProject();
  const result = run(root, [huntBuild], { ...env, AUTOBUILD_BUGHUNT: "1", FAKE_HUNT_MODE: "partial" });
  assert.equal(result.code, 12, result.out);
  assert.equal(reviewStatus(root).disposition, "manual_review");
});
test("Codex zero-exit missing result and malformed hunt output never unlock the PR gate", () => {
  for (const mode of ["no-result", "malformed"]) {
    const root = huntProject();
    const result = run(root, [huntBuild], { ...env, AUTOBUILD_BUGHUNT: "1", FAKE_HUNT_MODE: mode });
    assert.equal(result.code, 12, result.out);
    assert.equal(reviewStatus(root).hunted, false, `invalid leaf output must not create finished review: ${mode}`);
    assert.doesNotMatch(result.out, /every feature passes\. Done/);
  }
});
test("Codex hunt usage failure returns usage-limit exit and no finished review", () => {
  const root = huntProject();
  const result = run(root, [huntBuild], { ...env, AUTOBUILD_BUGHUNT: "1", FAKE_HUNT_MODE: "usage-limit" });
  assert.equal(result.code, 8, result.out);
  assert.equal(reviewStatus(root).hunted, false);
});
test("Codex usage failures probe with Luna, then resume; a failed login probes too, then stops at the wait cap", () => {
  const root = project(["F-1"]);
  const result = run(root, [{ error: "You've hit your usage limit" }, { ok: true }, { build: "F-1" }], env);
  assert.equal(result.code, 0, result.out);
  assert.ok(result.calls[1].args.includes("gpt-6-luna"));
  assert.ok(result.calls[1].args.includes("read-only"));
  const back = run(project(["F-1"]), [{ error: "401 Unauthorized" }, { ok: true }, { build: "F-1" }], env);
  assert.equal(back.code, 0, back.out);
  assert.ok(back.calls[1].args.includes("gpt-6-luna"), "the login wait probes with Luna");
  // 0.0003 h is about 1.1 s of waiting; the harness caps every sleep at 300 ms.
  const stuck = run(project(["F-1"], { maxLimitWaitHours: 0.0003 }), Array.from({ length: 40 }, () => ({ error: "401 Unauthorized" })), env);
  assert.equal(stuck.code, 10, stuck.out);
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
test("cached Codex hunt refuses dirty code and rechecks the full host gate", () => {
  const root = huntProject({}, { gate: [{ name: "regression", command: "test ! -f bad-code && test ! -f .harness/fail-gate" }] });
  const enabled = { ...env, AUTOBUILD_BUGHUNT: "1" };
  const first = run(root, [huntBuild], enabled);
  assert.equal(first.code, 0, first.out);
  writeFileSync(path.join(root, "bad-code"), "bad\n");
  const dirty = run(root, [], enabled);
  assert.equal(dirty.code, 12, dirty.out);
  execFileSync("rm", [path.join(root, "bad-code")]);
  writeFileSync(path.join(root, ".harness/fail-gate"), "fail\n");
  const failed = run(root, [], enabled);
  assert.equal(failed.code, 12, failed.out);
  assert.match(failed.out, /gate.*FAIL|FAIL.*gate/i);
});

test("a missing backend value fails instead of silently launching Claude", () => {
  const root = project(["F-1"]);
  const result = spawnSync(process.execPath, [CLI, "run", "--backend"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--backend requires a value/);
});
test("preflight refuses a Codex that is older than another install on PATH, before any session", () => {
  const prefixes = mkdtempSync(path.join(tmpdir(), "codex-path-"));
  const fake = path.join(KIT, "test-fixtures", "fake-codex.mjs");
  const old = npmCodex(path.join(prefixes, "usr"), "0.154.0", { target: fake });
  // 999.0.0 outranks any real Codex the inherited PATH may hold, so the result is machine-independent.
  const fresh = npmCodex(path.join(prefixes, "npm-global"), "999.0.0", { target: fake });
  const shadowed = { ...env, AUTOBUILD_CODEX_BIN: "codex", PATH: [old, fresh, process.env.PATH].join(path.delimiter) };
  const refused = run(project(["F-1"]), [{ build: "F-1" }], shadowed);
  assert.equal(refused.code, 5, refused.out);
  assert.equal(refused.calls.length, 0, "no Codex session starts");
  assert.match(refused.loopLog, /preflight: Codex in use: .*usr\/bin\/codex \(0\.154\.0\)\. Warning: \d+ more on PATH: .*npm-global\/bin\/codex \(999\.0\.0\).* The one in use is older than .*npm-global\/bin\/codex;/);
  assert.match(refused.loopLog, /preflight FAILED/);

  const ordered = { ...shadowed, PATH: [fresh, old, process.env.PATH].join(path.delimiter) };
  const passed = run(project(["F-1"]), [{ build: "F-1" }], ordered);
  assert.equal(passed.code, 0, passed.out);
  assert.match(passed.loopLog, /preflight: Codex in use: .*npm-global\/bin\/codex \(999\.0\.0\)\. Warning: \d+ more on PATH: .*usr\/bin\/codex \(0\.154\.0\)/);
  assert.match(passed.loopLog, /preflight OK/);
});
