// The bug hunt at the end of an autobuild run (lib/bughunt.mjs): /bughunt --fix over the branch,
// landed only through the hunt's own landing checks (graphs/hunt/skills/bughunt/land.mjs). The hunt
// session is /build-app's fake, reached through test-fixtures/fake-claude.mjs's "hunt" step.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { project, run } from "../test-fixtures/project.mjs";

const ON = { AUTOBUILD_BUGHUNT: "1" };
const REVIEW_STATUS = path.resolve(import.meta.dirname, "..", "..", "..", "hunt", "skills", "bughunt", "review-status.mjs");
const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const progress = (root) => readFileSync(path.join(root, "PROGRESS.md"), "utf8");
const fix = (files) => ({ subject: "bughunt: fix F1", files });
const huntCalls = (root) => {
  const file = path.join(root, ".harness-script.json.hunt.calls");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
};
/** A project whose build branch has a base (main) for the hunt to compare it against. */
function withBase() {
  const root = project(["F-1"]);
  git(root, "branch", "main");
  return root;
}

test("a verified fix lands on the build branch (a new regression test under a frozen dir is allowed) and the run passes", () => {
  const root = withBase();
  const step = { hunt: "done", commits: [fix({ "src/a.js": "fixed\n", "tests/regress-F1.test": "new\n" })], findings: [{ status: "reproduced", fix: "verified" }] };
  const r = run(root, [{ build: "F-1" }, step], ON);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(git(root, "log", "--format=%s", "-3").split("\n"), ["chore(bughunt): pass", "bughunt: fix F1", "feat(F-1): built"]);
  assert.match(progress(root), /\nBUGHUNT \d{4}-\d\d-\d\d: pass; fixed F1; open none; report \S+\/report\.md\n/);
  assert.equal(git(root, "branch", "--list", "bughunt/*"), "", "the fix branch is gone once it landed");
  assert.match(r.loopLog, /bug hunt: 1 verified fix\(es\) landed on autobuild; pass/);
  assert.match(r.loopLog, /every feature passes\. Done\./);
  // What PandaStack's review gate reads before `gh pr create` and `gh pr merge` from this branch.
  const status = JSON.parse(execFileSync(process.execPath, [REVIEW_STATUS, "status", "--repo", root, "--head", git(root, "rev-parse", "HEAD"), "--base", "main"], { encoding: "utf8" }));
  assert.equal(status.hunted, true, JSON.stringify(status));
  assert.equal(status.disposition, "pass", JSON.stringify(status));

  const calls = huntCalls(root);
  assert.equal(calls.length, 1);
  const args = calls[0].args;
  const arg = (name) => args[args.indexOf(name) + 1];
  assert.match(arg("-p"), /"mode": "fix", "fixBranch": "bughunt\/autobuild-[0-9a-f]{6}"/);
  assert.equal(arg("--permission-mode"), "bypassPermissions", "the hunt runs with /build-app's session settings, not the review's");
  assert.equal(arg("--max-budget-usd"), "30");
  assert.equal(calls[0].env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, "0", "a headless hunt keeps its background Workflow alive");
  assert.equal(calls[0].guard.writableDirs.length, 1);
  assert.match(calls[0].guard.writableDirs[0], /\/\.git\/bughunt\/autobuild-[0-9a-f]{6}$/, "the guard opens only the hunt's state dir");
  assert.ok(calls[0].guard.frozen.includes("tests/F-1.test"), "existing frozen files are guarded");
  assert.ok(!calls[0].guard.frozen.includes("PROGRESS.md"), "writable files are not");
});

test("fix commits the ledger does not call verified, or that change an existing frozen file, never land", () => {
  for (const [step, why] of [
    [{ hunt: "done", commits: [fix({ "src/a.js": "x\n" })], findings: [{ status: "reproduced", fix: "unresolved" }] }, /fix commits the hunt's ledger does not call verified/],
    [{ hunt: "done", commits: [fix({ "tests/F-1.test": "weakened\n" })], findings: [{ status: "reproduced", fix: "verified" }] }, /frozen tests from earlier slices changed: tests\/F-1\.test/],
  ]) {
    const root = withBase();
    const r = run(root, [{ build: "F-1" }, step], ON);
    assert.equal(r.code, 12, r.out);
    assert.match(r.loopLog, why);
    assert.match(r.loopLog, /nothing landed.*its branch is kept as attempt\/bughunt-/s);
    assert.equal(git(root, "log", "-1", "--format=%s"), "feat(F-1): built", "the build branch is unchanged");
    assert.match(git(root, "branch", "--list", "attempt/bughunt-*"), /attempt\/bughunt-/);
    assert.doesNotMatch(progress(root), /BUGHUNT/);
  }
});

test("a hunt that ends in manual review lands nothing, records why, exits 12, and is not repeated at the same head", () => {
  const root = withBase();
  const r = run(root, [{ build: "F-1" }, { hunt: "done", coverage: [{ lens: "security", status: "not_covered" }] }], ON);
  assert.equal(r.code, 12, r.out);
  assert.deepEqual(git(root, "log", "--format=%s", "-2").split("\n"), ["chore(bughunt): manual_review", "feat(F-1): built"]);
  assert.match(progress(root), /BUGHUNT \S+: manual_review; fixed none; open none \(security not covered\)/);
  assert.match(r.loopLog, /every feature passes, but the bug hunt needs attention \(exit 12\)/);
  const again = run(root, [], ON);
  assert.equal(again.code, 12);
  assert.match(again.loopLog, /bug hunt: already ran at [0-9a-f]{8} \(manual_review\); not repeated/);
  assert.equal(huntCalls(root).length, 1, "no second hunt session");
});

test("a hunt session that saves no finished run keeps its branch and exits 12", () => {
  const root = withBase();
  const r = run(root, [{ build: "F-1" }, { hunt: "none", commits: [fix({ "src/a.js": "x\n" })] }], ON);
  assert.equal(r.code, 12, r.out);
  assert.match(r.loopLog, /bug hunt: did not finish \(exit 0; it saved no run\); rerun `autobuild run` to retry it; its branch is kept as attempt\/bughunt-/);
  assert.equal(git(root, "log", "-1", "--format=%s"), "feat(F-1): built");
});

test("with no base branch the hunt says how to set one; AUTOBUILD_BUGHUNT=0 and \"bughunt\": false skip it", () => {
  const noBase = project(["F-1"]);
  const r = run(noBase, [{ build: "F-1" }], ON);
  assert.equal(r.code, 12, r.out);
  assert.match(r.loopLog, /no base branch master to compare autobuild against; set "bughuntBase" in autobuild\.json/);

  const killed = withBase();
  const k = run(killed, [{ build: "F-1" }], { AUTOBUILD_BUGHUNT: "0" });
  assert.equal(k.code, 0, k.out);
  assert.doesNotMatch(k.loopLog, /bug hunt/);

  const off = withBase();
  const file = path.join(off, "autobuild.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), bughunt: false }, null, 2));
  git(off, "commit", "-qam", "hunt off");
  const o = run(off, [{ build: "F-1" }], ON);
  assert.equal(o.code, 0, o.out);
  assert.equal(huntCalls(off).length, 0);
});
