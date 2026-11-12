// A failed host gate leaves gate-feedback.txt for the next builder session. Once a later session on
// the feature is PASSED through the Stop hook's own gate, that feedback is stale and must not
// be injected into the builder prompts of later features.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { project, run } from "../test-fixtures/project.mjs";

test("host-gate feedback is cleared when a later session passes through the Stop hook's gate", (t) => {
  const root = project(["F-1"], { maxIterations: 3 });
  const outside = mkdtempSync(path.join(tmpdir(), "autobuild-stale-"));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  const counter = path.join(outside, "n");
  // Gate call 1 (iteration 1's Stop hook) fails, so the hook's gate does not cover the commit and
  // the host runs it: call 2 fails too. Every later call (iteration 2's hook, the final gate) passes.
  const command = `n=$(cat ${counter} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${counter}; case $n in 1|2) echo old-failure-output; exit 1;; esac`;
  const file = path.join(root, "autobuild.json");
  const doc = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...doc, bughunt: false, gate: [{ name: "regression", command }] }, null, 2));
  execFileSync("git", ["-C", root, "commit", "-q", "-am", "config"]);

  const { code, loopLog } = run(root, [{ build: "F-1", stopHook: true }, { build: "F-1", stopHook: true }]);

  // The scenario happened: the host gate failed once, then the hook's gate covered the commit.
  assert.match(loopLog, /iteration 1: F-1 FLAG_REVERTED/);
  assert.match(loopLog, /iteration 2: F-1 PASSED/);
  assert.doesNotMatch(loopLog, /iteration 2: running the gate host-side/);
  assert.equal(code, 0, loopLog);

  const feedback = path.join(root, ".harness", "gate-feedback.txt");
  assert.ok(
    !existsSync(feedback),
    `BUGHUNT-F5 F-1 passed via the Stop hook's gate, but gate-feedback.txt still holds its old failure and is appended to later builder prompts: ${existsSync(feedback) ? readFileSync(feedback, "utf8") : ""}`,
  );
});
