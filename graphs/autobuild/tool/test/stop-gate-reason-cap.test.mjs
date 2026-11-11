// The stop hook caps its block reason. Over the cap it must drop from the middle: the start holds
// the instructions and the end holds the end of the failing gate output (bughunt F1 on PR #47).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { KIT, project } from "../test-fixtures/project.mjs";

const HOOK = path.join(KIT, "hooks", "stop-gate.mjs");
const LAST_LINE = "FINAL-SUMMARY-LINE: 400 passed, 12 failed";

// Many failure lines (each with a detail line) first, then a long passing suite, then a summary.
function failingOutput() {
  const lines = ["######## scripts/test-first-suite.sh"];
  for (let i = 0; i < 60; i += 1) {
    lines.push(`  FAIL critic partitions keep every unit, case number ${i}`);
    lines.push(`       expected ${100 + i} units, got ${99 + i}`);
  }
  for (let i = 0; i < 200; i += 1) lines.push(`  ok   passing check number ${i} stays quiet here`);
  lines.push(LAST_LINE);
  return lines.join("\n");
}

test("the stop hook's capped block reason keeps its instructions and the end of a long failing gate output", (t) => {
  const root = project(["f1"]);
  const scratch = mkdtempSync(path.join(tmpdir(), "stop-gate-cap-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });
  const outputFile = path.join(scratch, "output.txt");
  writeFileSync(outputFile, `${failingOutput()}\n`);
  const configFile = path.join(root, "autobuild.json");
  const raw = JSON.parse(readFileSync(configFile, "utf8"));
  raw.runners.unit.command = `bash -c 'cat "$0"; exit 1' ${outputFile} #`;
  writeFileSync(configFile, JSON.stringify(raw));
  const stateDir = path.join(root, raw.stateDir ?? ".harness");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, "session.json"), JSON.stringify({ role: "builder", featureId: "f1", progressAtStart: "" }));

  const result = spawnSync(process.execPath, [HOOK], {
    cwd: root,
    input: "{}",
    encoding: "utf8",
    env: { ...process.env, AUTOBUILD_ACTIVE: "1", CLAUDE_PROJECT_DIR: root },
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.decision, "block");
  assert.ok(decision.reason.length <= 9000, `reason stays within the cap (${decision.reason.length})`);
  assert.match(decision.reason, /^Stop gate for f1: FAILED/);
  assert.match(decision.reason, /BLOCKER f1: <the exact failing assertion/);
  assert.match(decision.reason, /FAIL critic partitions keep every unit, case number 0\b/);
  assert.ok(decision.reason.trimEnd().endsWith(LAST_LINE), `the end of the gate output is kept (${decision.reason.length} chars), ends: ${JSON.stringify(decision.reason.slice(-120))}`);
});
