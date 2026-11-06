// End-to-end loop scenarios against a throwaway git project and a fake `claude`.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const KIT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(KIT, "lib", "cli.mjs");
const FAKE = path.join(KIT, "test-fixtures", "fake-claude.mjs");

function project(featureIds, limits = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "autobuild-loop-"));
  const git = (...args) => execFileSync("git", args, { cwd: root });
  git("init", "-q", "-b", "autobuild");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(path.join(root, "autobuild.json"), JSON.stringify({
    branch: "autobuild",
    hooks: "inject",
    limits: { maxIterations: 5, noProgressLimit: 2, reviewEvery: 99, finalReview: false, probeEveryMinutes: 1, transientWaitMinutes: 1, maxTransientRetries: 1, ...limits },
    runners: { unit: { group: "unit", command: "bash -c 'for f in \"$@\"; do id=$(basename \"$f\" .test); test -f \"$id.done\" || exit 1; done' _" } },
    frozen: ["tests"],
    allowedTools: ["Read"],
  }, null, 2));
  writeFileSync(path.join(root, "features.json"), JSON.stringify({ features: featureIds.map((id, i) => ({ id, title: `feature ${id}`, dependencies: i ? [featureIds[i - 1]] : [], test: `tests/${id}.test`, testKind: "unit", passes: false })) }, null, 2));
  writeFileSync(path.join(root, "PROGRESS.md"), "# progress\n");
  execFileSync("mkdir", ["-p", path.join(root, "tests")]);
  for (const id of featureIds) writeFileSync(path.join(root, "tests", `${id}.test`), "frozen\n");
  writeFileSync(path.join(root, ".gitignore"), "/logs/\n/.harness/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return root;
}

function run(root, script) {
  const scriptFile = path.join(root, ".harness-script.json");
  writeFileSync(scriptFile, JSON.stringify(script));
  execFileSync("git", ["-C", root, "update-index", "--assume-unchanged", "features.json"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "update-index", "--no-assume-unchanged", "features.json"], { stdio: "ignore" });
  const result = spawnSync(process.execPath, [CLI, "run"], { cwd: root, encoding: "utf8", env: loopEnv(scriptFile), timeout: 120_000 });
  const calls = existsSync(`${scriptFile}.calls`) ? readFileSync(`${scriptFile}.calls`, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  const logDir = path.join(root, "logs");
  const loopLog = existsSync(logDir) ? readdirSync(logDir).filter((name) => name.startsWith("loop-")).map((name) => readFileSync(path.join(logDir, name), "utf8")).join("\n") : "";
  return { code: result.status, out: `${result.stdout}${result.stderr}`, calls, loopLog };
}

function loopEnv(scriptFile) {
  return { ...process.env, AUTOBUILD_CLAUDE_BIN: FAKE, FAKE_CLAUDE_SCRIPT: scriptFile, AUTOBUILD_CLI: CLI, AUTOBUILD_MAX_SLEEP_MS: "300" };
}

function head(root) {
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The fake project lives in /tmp; keep the script file out of git and out of the frozen check.
function ignoreScript(root) {
  writeFileSync(path.join(root, ".gitignore"), "/logs/\n/.harness/\n/.harness-script.json*\n");
  execFileSync("git", ["-C", root, "commit", "-q", "-am", "ignore fake script"]);
}

test("a usage limit with a reset time waits, retries the same feature and does not count it", () => {
  const root = project(["F-1"]);
  ignoreScript(root);
  const reset = new Date(Date.now() + 60 * 60_000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(" ", "").toLowerCase();
  const { code, calls, loopLog } = run(root, [{ limit: `You've hit your session limit · resets ${reset}` }, { build: "F-1" }]);
  assert.equal(code, 0, loopLog);
  assert.equal(calls.length, 2);
  assert.match(loopLog, /usage limit .*not counted/);
  assert.match(loopLog, /waiting until .*then retrying F-1/);
  assert.match(loopLog, /iteration 1: F-1 PASSED/);
  assert.match(loopLog, /every feature passes/);
});

test("an unreadable reset time probes until usage is back", () => {
  const root = project(["F-1"]);
  ignoreScript(root);
  const { code, calls, loopLog } = run(root, [{ limit: "You've hit your session limit" }, { ok: true }, { build: "F-1" }]);
  assert.equal(code, 0, loopLog);
  assert.equal(calls.length, 3); // session, probe, session
  assert.ok(calls[1].args.includes("--tools"), "the probe is a tool-less one-turn session");
  assert.match(loopLog, /probing again/);
  assert.match(loopLog, /available again; resuming/);
});

test("a weekly limit days away stops cleanly with exit 8", () => {
  const root = project(["F-1"]);
  ignoreScript(root);
  const far = new Date(Date.now() + 4 * 24 * 3_600_000);
  const reset = `${far.toLocaleDateString("en-US", { month: "short" })} ${far.getDate()}, 9:00am`;
  const { code, loopLog } = run(root, [{ limit: `You've hit your weekly limit · resets ${reset}` }]);
  assert.equal(code, 8, loopLog);
  assert.match(loopLog, /beyond the 26 h wait cap/);
});

test("a spend or credit limit stops the loop without retrying", () => {
  const root = project(["F-1"]);
  ignoreScript(root);
  const { code, calls, loopLog } = run(root, [{ billing: true }, { build: "F-1" }]);
  assert.equal(code, 9, loopLog);
  assert.equal(calls.length, 1);
});

test("an overloaded API waits and retries once without counting, then counts", () => {
  const root = project(["F-1"]);
  ignoreScript(root);
  const ok = run(root, [{ overloaded: true }, { build: "F-1" }]);
  assert.equal(ok.code, 0, ok.loopLog);
  assert.match(ok.loopLog, /overloaded or server error .*retry 1\/1, not counted/);

  const root2 = project(["F-1"]);
  ignoreScript(root2);
  const stuck = run(root2, [{ overloaded: true }, { overloaded: true }, { overloaded: true }]);
  assert.equal(stuck.code, 2, stuck.loopLog); // second overload counts, third too → noProgressLimit 2
});

test("a normal session that makes no progress still counts toward the stop", () => {
  const root = project(["F-1"]);
  ignoreScript(root);
  const { code, calls } = run(root, [{ ok: true }, { ok: true }, { ok: true }]);
  assert.equal(code, 2);
  assert.equal(calls.length, 2);
});

test("frozen-file changes stop the loop for a human", () => {
  const root = project(["F-1"]);
  ignoreScript(root);
  writeFileSync(path.join(root, "tests", "F-1.test"), "tampered\n");
  const { code, loopLog } = run(root, [{ build: "F-1" }]);
  assert.equal(code, 5, loopLog); // preflight refuses uncommitted frozen changes
  assert.match(loopLog, /frozen files have uncommitted changes/);
});

test("a session that edits the feature list beyond passes flags stops the loop for a human", () => {
  const root = project(["F-1"]);
  ignoreScript(root);
  const { code, loopLog } = run(root, [{ tamper: true }]);
  assert.equal(code, 4, loopLog);
  assert.match(loopLog, /features\.json \(changed beyond passes flags\)/);
});

test("an empty feature list fails preflight instead of reporting done", () => {
  const root = project([]);
  const result = run(root, []);
  assert.equal(result.code, 5, result.out);
  assert.match(result.loopLog, /lists no features/);
  assert.equal(result.calls.length, 0);
});

test("a review that commits nothing leaves its range for the next review", () => {
  const root = project(["F-1", "F-2", "F-3", "F-4"], { reviewEvery: 2 });
  ignoreScript(root);
  const start = head(root).slice(0, 8);
  const { code, loopLog } = run(root, [{ build: "F-1" }, { build: "F-2" }, { ok: true }, { build: "F-3" }, { build: "F-4" }, { review: true }]);
  assert.equal(code, 0, loopLog);
  const ranges = [...loopLog.matchAll(/review: comparing (\w+)\.\./g)].map((match) => match[1]);
  assert.deepEqual(ranges, [start, start], loopLog);
  assert.match(loopLog, /review: no chore\(review\) commit/);
});

test("the last features of a run get a final review before the loop reports done", () => {
  const root = project(["F-1", "F-2", "F-3"], { reviewEvery: 2, finalReview: true });
  ignoreScript(root);
  const { code, loopLog, calls } = run(root, [{ build: "F-1" }, { build: "F-2" }, { review: true }, { build: "F-3" }, { review: true }]);
  assert.equal(code, 0, loopLog);
  const ranges = [...loopLog.matchAll(/review: comparing (\w+)\.\./g)];
  assert.equal(ranges.length, 2, loopLog);
  assert.match(loopLog, /review: final review, 1 features passed since/);
  assert.ok(loopLog.lastIndexOf("review: comparing") < loopLog.indexOf("every feature passes. Done."), loopLog);
  assert.equal(calls.filter((call) => call.step.review).length, 2);
});

test("finalReview: false ends the run without reviewing the last features", () => {
  const root = project(["F-1", "F-2", "F-3"], { reviewEvery: 2, finalReview: false });
  ignoreScript(root);
  const { code, loopLog } = run(root, [{ build: "F-1" }, { build: "F-2" }, { review: true }, { build: "F-3" }]);
  assert.equal(code, 0, loopLog);
  assert.equal([...loopLog.matchAll(/review: comparing/g)].length, 1, loopLog);
  assert.doesNotMatch(loopLog, /final review/);
});

test("no final review when the last review already covered every passed feature", () => {
  const root = project(["F-1", "F-2"], { reviewEvery: 2, finalReview: true });
  ignoreScript(root);
  const { code, loopLog } = run(root, [{ build: "F-1" }, { build: "F-2" }, { review: true }]);
  assert.equal(code, 0, loopLog);
  assert.equal([...loopLog.matchAll(/review: comparing/g)].length, 1, loopLog);
  assert.doesNotMatch(loopLog, /final review/);
});

test("a review that is due when the loop starts runs before the next feature", () => {
  const root = project(["F-1", "F-2", "F-3"], { maxIterations: 2 });
  ignoreScript(root);
  writeFileSync(path.join(root, "PROGRESS.md"), "# progress\n\nREVIEW 2026-10-11: no drift found\n");
  execFileSync("git", ["-C", root, "commit", "-q", "-am", "chore(review): earlier review"]);
  const reviewed = head(root).slice(0, 8);
  assert.equal(run(root, [{ build: "F-1" }, { build: "F-2" }]).code, 7);

  const config = JSON.parse(readFileSync(path.join(root, "autobuild.json"), "utf8"));
  config.limits.reviewEvery = 2;
  writeFileSync(path.join(root, "autobuild.json"), JSON.stringify(config, null, 2));
  execFileSync("git", ["-C", root, "commit", "-q", "-am", "review every 2"]);
  const { code, loopLog } = run(root, [{ review: true }, { build: "F-3" }]);
  assert.equal(code, 0, loopLog);
  const review = loopLog.indexOf(`review: comparing ${reviewed}..`);
  assert.ok(review >= 0 && review < loopLog.indexOf("iteration 1: F-3"), loopLog);
});

test("stopping the loop also stops the session it is running", async () => {
  const root = project(["F-1"]);
  ignoreScript(root);
  const scriptFile = path.join(root, ".harness-script.json");
  writeFileSync(scriptFile, JSON.stringify([{ hang: true }]));
  const loop = spawn(process.execPath, [CLI, "run"], { cwd: root, env: loopEnv(scriptFile), stdio: "ignore" });
  const exited = new Promise((resolve) => loop.on("close", (code) => resolve(code)));
  const deadline = Date.now() + 30_000;
  while (!existsSync(`${scriptFile}.pid`) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  const sessionPid = Number(readFileSync(`${scriptFile}.pid`, "utf8"));
  loop.kill("SIGTERM");
  const code = await exited;
  const orphaned = isAlive(sessionPid);
  if (orphaned) process.kill(sessionPid, "SIGKILL");
  assert.equal(code, 130);
  assert.equal(orphaned, false, "the session outlived the loop");
});
