// Gate feedback must show what failed, not only the end of the output. A multi-suite gate
// (scripts/test.sh) prints its failing suite first and a long passing suite last, so a plain
// tail of the output loses the failure the next builder session needs to fix.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CLI, project, head } from "../test-fixtures/project.mjs";
import { loadConfig } from "../lib/config.mjs";
import { failureExcerpt, runGate } from "../lib/gate.mjs";
import { finishCodexBuilder } from "../lib/codex-gate.mjs";
import { tail } from "../lib/proc.mjs";

const passingLines = (count) => Array.from({ length: count }, (_, i) => `  ok   passing check number ${i} stays quiet`).join("\n");
const bounded = (excerpt, chars = 6000) => assert.ok(excerpt.length <= Math.floor(chars * 1.5) + 100, `excerpt is bounded (${excerpt.length})`);
// The overnight shape: a failure early, then thousands of characters of passing output.
const buriedFailure = [
  "######## scripts/test-workflow.sh",
  "  ok   an earlier check",
  "  FAIL critic partitions keep every unit",
  "       expected 122 units, got 121",
  "  ok   a later check",
  passingLines(400),
  "TEST-AUTOBUILD: 400 passed, 0 failed",
  "TEST: FAIL",
].join("\n");

test("short output is returned whole", () => {
  assert.equal(failureExcerpt("  FAIL one\nTEST: FAIL"), "  FAIL one\nTEST: FAIL");
  assert.equal(failureExcerpt(""), "");
});

test("a failure buried before a long passing suite is kept, with its detail and the end of the output", () => {
  assert.ok(buriedFailure.length > 6000);
  const excerpt = failureExcerpt(buriedFailure);
  assert.match(excerpt, /FAIL critic partitions keep every unit\n {7}expected 122 units, got 121/);
  assert.match(excerpt, /TEST: FAIL$/);
  bounded(excerpt);
});

test("the excerpt always contains the plain tail, so it never shows less than before", () => {
  // Noisy passing output that matches the failure pattern must not push the real failure out of the end.
  const noisy = [
    ...Array.from({ length: 60 }, (_, i) => `Error: simulated network failure ${i} logged by retry helper`),
    "E       assert 121 == 122",
    "FAILED tests/test_units.py::test_partition - assert 121 == 122",
    "x".repeat(70).concat("\n").repeat(60),
  ].join("\n");
  for (const output of [buriedFailure, noisy, `${"  FAIL one long line ".repeat(3000)}\n${passingLines(300)}`, "y".repeat(50_000)]) {
    for (const chars of [6000, 12000, 40]) {
      const excerpt = failureExcerpt(output, chars);
      assert.ok(excerpt.endsWith(tail(output, chars)), `contains the plain tail (chars ${chars})`);
      bounded(excerpt, chars);
    }
  }
  assert.match(failureExcerpt(noisy), /FAILED tests\/test_units\.py::test_partition/);
});

test("each common runner's failure marker is recognised", () => {
  for (const marker of [
    "  FAIL harness check",              // workflow-harness, test-install, test-secrets, test-autobuild
    "FAIL  CLAUDE.md is over 200 lines", // validate.sh
    "VALIDATE: FAIL",
    "not ok 3 - tap test",
    "✖ spec reporter test (2.1ms)",
    "FAILED tests/x.py::test_y - assert 1 == 2", // pytest
    "--- FAIL: TestThing (0.00s)",               // go test
    "AssertionError [ERR_ASSERTION]: values differ",
    "TypeError: cannot read x of undefined",
    "Error: module not found",
  ]) {
    const excerpt = failureExcerpt(`${marker}\n${passingLines(300)}`);
    assert.ok(excerpt.includes(`Failure lines earlier in the output:\n${marker}`), `kept: ${marker}`);
  }
});

test("passing lines whose names mention FAIL or errors are not mistaken for failures", () => {
  const output = [
    "  ok   the loop prints TEST: FAIL when a suite fails",
    "  ok   spend and credit errors stop the loop",
    "ok 7 - not ok handling in TAP",
    "  ok   FAIL lines are counted",
    "✔ FAIL text is parsed (1ms)",
    passingLines(300),
  ].join("\n");
  const excerpt = failureExcerpt(output);
  assert.doesNotMatch(excerpt, /Failure lines/);
  assert.equal(excerpt, tail(output, 6000), "falls back to the plain tail");
});

test("detail stops at the next line that is not indented under the failure", () => {
  const output = ["✖ spec failure (1ms)", "  AssertionError: 1 !== 2", "✔ passing next (1ms)", "  FAIL harness", "  ok   next", passingLines(300)].join("\n");
  const excerpt = failureExcerpt(output);
  assert.match(excerpt, /✖ spec failure \(1ms\)\n {2}AssertionError: 1 !== 2\n…\n {2}FAIL harness\n\n/);
  assert.doesNotMatch(excerpt.split("End of output:")[0], /passing next|ok {3}next/);
});

test("a long line that only looks like a summary takes linear time, not quadratic", () => {
  // "A-A-A-…" gives the old unanchored summary pattern a fresh start at every letter: 80k chars took ~1.3 s, 1 MB minutes.
  const output = `${"A-".repeat(500_000)}\nTEST: FAIL\n${"x".repeat(7000)}`;
  const started = Date.now();
  const excerpt = failureExcerpt(output);
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  assert.match(excerpt, /Failure lines earlier in the output:\nTEST: FAIL/);
});

test("many failures stay within the size bound", () => {
  const output = Array.from({ length: 2000 }, (_, i) => `  FAIL failing check ${i}\n       detail ${i}`).join("\n");
  const excerpt = failureExcerpt(output);
  assert.match(excerpt, /FAIL failing check 0\b/);
  assert.match(excerpt, /more failure lines omitted/);
  bounded(excerpt);
});

test("real node --test TAP output keeps the failing assertion's message", t => {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-excerpt-tap-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "sample.test.mjs");
  writeFileSync(file, [
    'import assert from "node:assert/strict"; import { test } from "node:test";',
    'test("partitions keep every unit", () => assert.deepEqual({ units: 121 }, { units: 122 }));',
    'for (let i = 0; i < 300; i += 1) test(`passing ${i}`, () => {});',
  ].join("\n"));
  // Without NODE_TEST_CONTEXT the child prints its own TAP stream instead of reporting to this runner.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT"));
  const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", file], { encoding: "utf8", env });
  const output = `${run.stdout}${run.stderr}`;
  assert.ok(output.length > 6000 && /not ok \d+ - partitions keep every unit/.test(output), "fixture produced a buried TAP failure");
  const excerpt = failureExcerpt(output);
  assert.match(excerpt.split("End of output:")[0], /not ok \d+ - partitions keep every unit[\s\S]*units: 12[12]/);
});

function gateFixture(t) {
  const root = project(["current"]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = loadConfig(root, {});
  config.runners.unit.command = "bash -c 'exit 0' _";
  const output = path.join(root, "gate-output.txt");
  writeFileSync(output, buriedFailure);
  config.gate = [{ name: "baseline regression suite", command: `cat ${JSON.stringify(output)}; exit 1` }];
  return config;
}

test("runGate reports the buried failure for a failing gate step", t => {
  const config = gateFixture(t);
  const summary = runGate(config, { featureId: "current", failFast: true });
  assert.equal(summary.ok, false);
  const failed = summary.steps.find(step => !step.ok);
  assert.equal(failed.name, "baseline regression suite");
  assert.match(failed.tail, /FAIL critic partitions keep every unit/);
});

test("the Codex builder's retry feedback and the loop log carry the buried failure", t => {
  const config = gateFixture(t);
  mkdirSync(path.join(config.root, config.stateDir), { recursive: true });
  const docBefore = JSON.parse(readFileSync(path.join(config.root, "features.json"), "utf8"));
  const logs = [];
  finishCodexBuilder(config, { feature: docBefore.features[0], base: head(config.root), docBefore,
    exitCode: 0, result: { subtype: "success" }, log: message => logs.push(message) });
  const feedback = readFileSync(path.join(config.root, config.stateDir, "codex-feedback.txt"), "utf8");
  assert.match(feedback, /baseline regression suite/);
  assert.match(feedback, /FAIL critic partitions keep every unit/);
  assert.match(logs.join("\n"), /host gate: FAIL[\s\S]*FAIL critic partitions keep every unit/);
});

test("autobuild test, mark-passed and check print the buried failure", t => {
  const root = project(["current"]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, "buried-output.txt");
  writeFileSync(output, `${buriedFailure}\n${passingLines(400)}`); // past the CLI's 12000-char budget
  const file = path.join(root, "autobuild.json");
  const raw = JSON.parse(readFileSync(file, "utf8"));
  raw.runners.unit.command = `bash -c 'cat ${JSON.stringify(output)}; exit 1' _`;
  raw.gate = [{ name: "baseline regression suite", command: `cat ${JSON.stringify(output)}; exit 1` }];
  writeFileSync(file, JSON.stringify(raw));
  for (const args of [["test", "current"], ["mark-passed", "current"], ["check"]]) {
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8", timeout: 30000 });
    assert.equal(result.status, 1, `${args[0]} fails`);
    assert.match(result.stdout, /FAIL critic partitions keep every unit\n {7}expected 122 units, got 121/, `${args[0]} shows the failure`);
  }
});
