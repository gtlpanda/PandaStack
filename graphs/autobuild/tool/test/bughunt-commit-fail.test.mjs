// The bug hunt's progress entry (lib/bughunt.mjs): when the project's pre-commit hook rejects the
// `chore(bughunt)` commit, the run must not report success or record the hunt as done at this head.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { project, run } from "../test-fixtures/project.mjs";

const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

test("a rejected commit of the BUGHUNT progress entry is not reported as a passed hunt", () => {
  const root = project(["F-1"]);
  git(root, "branch", "main");
  // A lint-style hook that rejects any commit adding a BUGHUNT line to PROGRESS.md.
  const hook = path.join(root, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nif git diff --cached -- PROGRESS.md | grep -q '^+BUGHUNT'; then echo 'lint: rejected' >&2; exit 1; fi\n");
  chmodSync(hook, 0o755);

  const step = { hunt: "done", commits: [{ subject: "bughunt: fix F1", files: { "src/a.js": "fixed\n" } }], findings: [{ status: "reproduced", fix: "verified" }] };
  const r = run(root, [{ build: "F-1" }, step], { AUTOBUILD_BUGHUNT: "1" });

  assert.match(git(root, "status", "--porcelain"), /PROGRESS\.md/, "setup: the hook left the BUGHUNT entry uncommitted");
  assert.notEqual(r.code, 0, `BUGHUNT-F15 the hunt exits success although its progress entry was never committed\n${r.out}`);
  assert.doesNotMatch(r.loopLog, /verified fix\(es\) landed on autobuild; pass/, "BUGHUNT-F15 logs a pass although the entry commit failed");
});
