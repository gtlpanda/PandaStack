// A failed login is a pause, not a stop: the loop probes until a session authenticates again
// (someone logs in, or the block clears) and retries the same work without counting it. Before
// this, a failed login during a build stopped the loop (exit 10), and during the final review it
// counted as a review attempt, so two failed logins ended an overnight run with exit 13.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { project, run } from "../test-fixtures/project.mjs";

const reviewCommits = (root) => execFileSync("git", ["-C", root, "log", "--format=%s", "--grep=^chore(review):"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);

test("a failed login during a build probes until it authenticates, then retries the feature uncounted", () => {
  const root = project(["F-1"]);
  const { code, calls, loopLog } = run(root, [{ auth: true }, { auth: true }, { ok: true }, { build: "F-1" }]);
  assert.equal(code, 0, loopLog);
  assert.equal(calls.length, 4); // session, probe (still failing), probe (works), session
  assert.ok(calls[1].args.includes("--tools") && calls[2].args.includes("--tools"), "the waits are tool-less probes");
  assert.match(loopLog, /iteration 1: authentication failed \(Failed to authenticate\. API Error: 403.*not counted/);
  assert.match(loopLog, /log in again \(run `claude`, then \/login\)/);
  assert.match(loopLog, /authentication: available again; resuming/);
  assert.match(loopLog, /iteration 1: F-1 PASSED/);
});

test("a failed login during the final review is waited out and is not a review attempt", () => {
  const root = project(["F-1"], { finalReview: true });
  // Two failed review sessions in a row used to end the run with exit 13.
  const { code, calls, loopLog } = run(root, [{ build: "F-1" }, { auth: true }, { ok: true }, { auth: true }, { ok: true }, { review: true }]);
  assert.equal(code, 0, loopLog);
  assert.equal(calls.length, 6);
  assert.equal(reviewCommits(root).length, 1, loopLog);
  assert.match(loopLog, /review: authentication failed .*not counted as a review attempt/);
  assert.doesNotMatch(loopLog, /ended twice without a chore\(review\) commit/);
});

test("a retried review keeps each attempt's log", () => {
  const root = project(["F-1"], { finalReview: true });
  const { code, loopLog } = run(root, [{ build: "F-1" }, { auth: true }, { ok: true }, { review: true }]);
  assert.equal(code, 0, loopLog);
  const logs = [...loopLog.matchAll(/review: done \([^)]*\); log (\S+)/g)].map((m) => m[1]);
  assert.equal(logs.length, 2, loopLog);
  assert.notEqual(logs[0], logs[1], "the retry overwrote the failed attempt's log");
});

test("a login that keeps failing past maxLimitWaitHours stops with exit 10", () => {
  // 0.0003 h is about 1.1 s of waiting; the harness caps every sleep at 300 ms.
  const root = project(["F-1"], { maxLimitWaitHours: 0.0003 });
  const { code, loopLog } = run(root, Array.from({ length: 40 }, () => ({ auth: true })));
  assert.equal(code, 10, loopLog);
  assert.match(loopLog, /authentication (still failing after|: .* h of waiting spent)/);
});

test("a login that keeps failing during the review stops with exit 10, not 13", () => {
  const root = project(["F-1"], { finalReview: true, maxLimitWaitHours: 0.0003 });
  const { code, loopLog } = run(root, [{ build: "F-1" }, ...Array.from({ length: 40 }, () => ({ auth: true }))]);
  assert.equal(code, 10, loopLog);
});
