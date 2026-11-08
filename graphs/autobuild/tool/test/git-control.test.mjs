// The loop never runs what a session could plant in .git, and a session that changes git's control
// files (hooks, config, info) stops the loop for a human: the guard is a tripwire, this is the backstop.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { huntControlDir } from "../lib/bughunt.mjs";
import { git } from "../lib/proc.mjs";
import { project, run } from "../test-fixtures/project.mjs";

test("the loop's own git runs no planted hook and no planted fsmonitor", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autobuild-safe-git-"));
  const sentinel = path.join(root, "..", `${path.basename(root)}-ran`);
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", root, "config", "user.name", "T"]);
  const hook = path.join(root, ".git", "hooks", "pre-commit");
  writeFileSync(hook, `#!/bin/sh\ntouch "${sentinel}"\n`);
  chmodSync(hook, 0o755);
  execFileSync("git", ["-C", root, "config", "core.fsmonitor", `sh -c 'touch "${sentinel}"'`]);
  const config = { root, env: { pathPrepend: [], ldLibraryPath: [], vars: {} } };
  writeFileSync(path.join(root, "a.txt"), "a\n");
  assert.ok(git(config, ["add", "a.txt"]).ok);
  assert.ok(git(config, ["commit", "-q", "-m", "x"]).ok);
  assert.ok(git(config, ["status", "--porcelain"]).ok);
  assert.equal(existsSync(sentinel), false, "a hook or fsmonitor ran on the loop's git");
});

test("a session that plants a git hook stops the loop with exit 4 before anything else runs", () => {
  const root = project(["F-1"]);
  const r = run(root, [{ plant: ".git/hooks/post-commit" }]);
  assert.equal(r.code, 4, r.loopLog);
  assert.match(r.loopLog, /GIT CONTROL FILES CHANGED[^\n]*\n.*hooks\/post-commit/, r.loopLog);
  assert.equal(existsSync(path.join(root, "planted-ran")), false, "the planted hook never ran");
});

test("the hunt's control files are per worktree, so two linked worktrees never share them", () => {
  const root = project(["F-1"]);
  const second = `${root}-wt`;
  execFileSync("git", ["-C", root, "worktree", "add", "-q", "-b", "other", second]);
  const env = { pathPrepend: [], ldLibraryPath: [], vars: {} };
  const one = huntControlDir({ root, env });
  const two = huntControlDir({ root: second, env });
  assert.notEqual(one, two);
  for (const dir of [one, two]) assert.match(dir, /\.git\//, "inside the git dir, where no session may write");
});
