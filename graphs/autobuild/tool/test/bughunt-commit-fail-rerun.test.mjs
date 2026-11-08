// The bug hunt's progress entry (lib/bughunt.mjs): when the hunt has finished and landed but the
// `chore(bughunt)` commit fails, recovering (clear the failure, commit the entry, rerun) must not
// start a second paid hunt over the same branch. The failure is a git index lock the hunt session
// left behind, as in bughunt-commit-fail.test.mjs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { project, run } from "../test-fixtures/project.mjs";

const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

test("after a finished hunt whose progress commit failed, committing the entry and rerunning does not hunt again", () => {
  const root = project(["F-1"]);
  git(root, "branch", "main");
  const step = {
    hunt: "done",
    dirty: { "../../../index.lock": "" },
  };
  const first = run(root, [{ build: "F-1" }, step], { AUTOBUILD_BUGHUNT: "1" });
  assert.match(first.loopLog, /fix\(es\) landed, but committing its PROGRESS\.md line failed/, first.loopLog);

  // Recovery, as the message tells the user: clear the failure and commit the entry.
  rmSync(path.join(root, ".git", "index.lock"), { force: true });
  git(root, "add", "PROGRESS.md");
  git(root, "commit", "-q", "-m", "chore(bughunt): pass");

  const again = run(root, [], { AUTOBUILD_BUGHUNT: "1" });
  assert.equal(again.calls.length, first.calls.length, `BUGHUNT-F19 the rerun starts a second hunt session although the first one had already finished\n${again.loopLog}`);
});
