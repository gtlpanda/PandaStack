// The bug hunt's progress entry (lib/bughunt.mjs): when the `chore(bughunt)` commit fails, the run
// must not report success or record the hunt as done at this head. (Found as a rejecting
// pre-commit hook; the loop's own git no longer runs hooks, so the failure here is a git index
// lock the hunt session left behind, which fails `git add` the same way.)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { project, run } from "../test-fixtures/project.mjs";

const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

test("a failed commit of the BUGHUNT progress entry is not reported as a passed hunt", () => {
  const root = project(["F-1"]);
  git(root, "branch", "main");
  // The hunt writes relative to its fix worktree (<git dir>/bughunt/<key>/fix): three levels up is the git dir.
  const step = { hunt: "done", dirty: { "../../../index.lock": "" } };
  const r = run(root, [{ build: "F-1" }, step], { AUTOBUILD_BUGHUNT: "1" });
  assert.notEqual(r.code, 0, `BUGHUNT-F15 the hunt exits success although its progress entry was never committed\n${r.out}`);
  assert.match(r.loopLog, /committing its PROGRESS\.md line failed/, r.loopLog);
  assert.doesNotMatch(r.loopLog, /landed on autobuild; pass/, "BUGHUNT-F15 logs a pass although the entry commit failed");
});
