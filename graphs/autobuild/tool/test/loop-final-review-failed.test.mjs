// A final review that leaves no chore(review) commit must not let the loop report Done with exit 0.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { project, run } from "../test-fixtures/project.mjs";

test("a final review that commits nothing does not end the run as Done (exit 0)", () => {
  const root = project(["F-1"], { maxIterations: 3, reviewEvery: 99, finalReview: true });

  // F-1 passes; the final review session ends without a chore(review) commit ({ ok: true });
  // a retry would get the committing review as the next step.
  const { code, loopLog } = run(root, [{ build: "F-1" }, { ok: true }, { review: true }]);

  const reviews = execFileSync("git", ["-C", root, "log", "--format=%s", "--grep=^chore(review):"], { encoding: "utf8" }).trim();
  const reportedDone = /every feature passes\. Done\./.test(loopLog);
  assert.ok(
    code !== 0 || reviews !== "",
    `BUGHUNT-F22 the final review left no chore(review) commit, yet the loop exited ${code} (Done reported: ${reportedDone})\n${loopLog}`,
  );
});
