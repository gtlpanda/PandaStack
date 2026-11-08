// A restart before any chore(review) commit exists must still review the features the first run passed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { head, project, run } from "../test-fixtures/project.mjs";

test("a restart with no review commit still reviews the features passed before the restart", () => {
  const root = project(["F-1", "F-2", "F-3", "F-4", "F-5"], { maxIterations: 3, reviewEvery: 5, finalReview: true });
  const start = head(root).slice(0, 8);

  // Run 1 passes F-1..F-3 and stops at the iteration cap (exit 7) before any review is due.
  assert.equal(run(root, [{ build: "F-1" }, { build: "F-2" }, { build: "F-3" }]).code, 7);
  const afterRun1 = head(root).slice(0, 8);
  assert.notEqual(afterRun1, start, "test setup: run 1 must have committed work");

  // Restart with room to finish the remaining two features.
  const config = JSON.parse(readFileSync(path.join(root, "autobuild.json"), "utf8"));
  config.limits.maxIterations = 5;
  writeFileSync(path.join(root, "autobuild.json"), JSON.stringify(config, null, 2));
  execFileSync("git", ["-C", root, "commit", "-q", "-am", "raise the iteration cap"]);

  const { code, loopLog } = run(root, [{ build: "F-4" }, { build: "F-5" }, { review: true }]);
  assert.equal(code, 0, loopLog);

  const ranges = [...loopLog.matchAll(/review: comparing (\w+)\.\./g)].map((match) => match[1]);
  assert.equal(ranges.length, 1, `test setup: expected exactly one review\n${loopLog}`);
  assert.equal(ranges[0], start, `BUGHUNT-F17 the review range starts at ${ranges[0]} (after F-1..F-3) instead of the start of the build ${start}, so F-1..F-3 are never reviewed\n${loopLog}`);
});
