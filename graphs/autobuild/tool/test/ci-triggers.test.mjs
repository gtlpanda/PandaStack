// ci-optimizer CO-09 implementation tests: the edges the frozen acceptance file does not pin
// (a cancelled attempt holding a window place, a null startedAt or workflow, several failing
// workflows, a non-baseline baseline file, ages before generatedAt, one-line error messages, an
// unparsable generatedAt) and the `ci triggers` refusals (linked state, no autobuild.json,
// outside git, unknown flag). Offline: throwaway git repos and a private AUTOBUILD_STATE_HOME.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CLI } from "../test-fixtures/project.mjs";
import { inputsDigest } from "../lib/ci/discover.mjs";
import { ciStateDir, writeState } from "../lib/ci/state.mjs";
import { ciStartupCheck, evaluateTriggers, formatAge, statusLine } from "../lib/ci/triggers.mjs";

const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LANG: "C",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const WORKFLOW = "name: test\non: push\njobs:\n  unit:\n    runs-on: ubuntu-22.04\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm test\n";

// ---------- fixtures ----------

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const T0 = Date.parse("2026-11-01T00:00:00Z");

/** A one-job attempt on day `n` (null `n` gives a null startedAt). */
function attempt({ n, conclusion = "success", workflow = "test", jobConclusion = conclusion }) {
  const start = n === null ? null : iso(T0 + n * 86_400_000);
  return {
    provider: "github", runId: 9000 + (n ?? 500), attempt: 1, workflow, workflowPath: null, event: "push",
    headSha: "f".repeat(40), branch: "main", conclusion, createdAt: start, startedAt: start, updatedAt: start,
    jobs: [{ name: "build", conclusion: jobConclusion, createdAt: start, startedAt: start, completedAt: start, labels: [], steps: [] }],
  };
}
/** Attempts oldest to newest for `conclusions`, starting on day `from`. */
const series = (conclusions, { from = 0, workflow = "test" } = {}) => conclusions.map((conclusion, i) => attempt({ n: from + i, conclusion, workflow }));
const evaluate = (over) => evaluateTriggers({ storedProfile: { inputsDigest: "d", generatedAt: "x" }, currentDigest: "d", regression: null, attempts: [], ...over });
const ids = (result) => result.triggers.map((t) => t.id);

function tempDir(t, prefix = "ci-triggers-") {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd, ...args) {
  const r = spawnSync("git", ["-c", "init.defaultBranch=main", ...args], { cwd, env: { ...process.env, ...GIT_ENV }, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
}

function repoWith(t, files) {
  const repo = tempDir(t);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    writeFileSync(path.join(repo, rel), typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  git(repo, "init", "-q");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "fixture");
  return repo;
}

function ci(cwd, home, ...args) {
  const r = spawnSync(process.execPath, [CLI, "ci", ...args], { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV, AUTOBUILD_STATE_HOME: home }, timeout: 120_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function listTree(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      out.push(path.relative(dir, p));
      if (entry.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

// ---------- evaluateTriggers ----------

test("repeated-failures: a cancelled attempt takes a window place, pushing older failures out", () => {
  // Oldest to newest: 2 failures, then 2 cancelled, then 1 failure, then 2 failures.
  const attempts = series(["failure", "failure", "cancelled", "cancelled", "failure", "success", "failure"]);
  assert.equal(evaluate({ attempts }).fire, false, "the newest 5 hold 2 failures; the 2 older ones are outside the window");
  const control = series(["success", "success", "cancelled", "failure", "failure", "success", "failure"]);
  assert.deepEqual(evaluate({ attempts: control }).triggers, [{ id: "repeated-failures", detail: "test: 3 of last 5 attempts failed or timed out" }]);
});

test("repeated-failures: attempts without startedAt sort last and fall out of a full window", () => {
  const attempts = [...series(["success", "success", "success", "success", "success"], { from: 10 }), ...[0, 1, 2].map(() => attempt({ n: null, conclusion: "failure" }))];
  assert.equal(evaluate({ attempts }).fire, false, "three undated failures behind five dated successes are not among the newest five");
  const short = [attempt({ n: 1 }), ...[0, 1, 2].map(() => attempt({ n: null, conclusion: "failure" }))];
  assert.deepEqual(evaluate({ attempts: short }).triggers[0].detail, "test: 3 of last 4 attempts failed or timed out", "a short history keeps its undated attempts");
});

test("repeated-failures: an unnamed workflow is labeled, and several workflows join in name order", () => {
  const unnamed = series(["failure", "failure", "failure"], { workflow: null });
  assert.equal(evaluate({ attempts: unnamed }).triggers[0].detail, "(unnamed): 3 of last 3 attempts failed or timed out");
  const both = [...series(["failure", "timed_out", "failure"], { workflow: "web" }), ...series(["failure", "failure", "failure", "success"], { from: 5, workflow: "api" })];
  const result = evaluate({ attempts: both });
  assert.deepEqual(ids(result), ["repeated-failures"], "one trigger, whatever the number of workflows");
  assert.equal(result.triggers[0].detail, "api: 3 of last 4 attempts failed or timed out, web: 3 of last 3 attempts failed or timed out");
});

test("repeated-failures: the input array is not reordered, and non-array or junk entries are tolerated", () => {
  const attempts = series(["failure", "success", "failure", "failure"]).reverse();
  const before = attempts.map((a) => a.runId);
  evaluate({ attempts });
  assert.deepEqual(attempts.map((a) => a.runId), before, "evaluateTriggers does not sort the caller's array");
  for (const bad of [undefined, null, {}, "x"]) assert.equal(evaluate({ attempts: bad }).fire, false, `attempts ${JSON.stringify(bad)}`);
  const noJobs = series(["success", "success", "success"]).map(({ jobs, ...rest }) => rest);
  assert.equal(evaluate({ attempts: noJobs }).fire, false, "attempts without jobs are not failures");
});

test("runtime-regression: an unnamed workflow is labeled; regressed must be exactly true", () => {
  const result = evaluate({ regression: { regressed: true, workflows: [{ workflow: null, status: "regressed" }, { workflow: "b", status: "ok", overTarget: true }] } });
  assert.equal(result.triggers[0].detail, "(unnamed), b");
  assert.equal(evaluate({ regression: { regressed: "yes", workflows: [{ workflow: "a", status: "regressed" }] } }).fire, false, "a truthy non-boolean is not a regression");
});

test("formatAge: floors each unit, and a time before generatedAt reads as 0m", () => {
  const MIN = 60_000;
  assert.equal(formatAge(-5 * MIN), "0m");
  assert.equal(formatAge(59_999), "0m");
  assert.equal(formatAge(59 * MIN), "59m");
  assert.equal(formatAge(60 * MIN), "1h");
  assert.equal(formatAge(24 * 60 * MIN - 1), "23h");
  assert.equal(formatAge(24 * 60 * MIN), "1d");
  assert.equal(formatAge(400 * 24 * 60 * MIN), "400d");
});

// ---------- ciStartupCheck and statusLine ----------

test("ciStartupCheck: any failure is one log line and the same one-line message, never a throw", async () => {
  const lines = [];
  const config = { get root() { throw new Error("first line\nsecond line"); }, ciOptimizer: undefined };
  const result = await ciStartupCheck(config, (m) => lines.push(m));
  assert.deepEqual(result, { skipped: "first line second line" });
  assert.deepEqual(lines, ["ci-optimizer: skipped (first line second line)"]);

  const invalid = await ciStartupCheck({ root: tmpdir(), ciOptimizer: { enabled: "yes" } }, (m) => lines.push(m));
  assert.match(invalid.skipped, /ciOptimizer\.enabled/, "an invalid policy is skipped and named");
});

test("ciStartupCheck: a current profile is reused without rewriting it", async (t) => {
  const home = tempDir(t, "ci-triggers-state-");
  const repo = repoWith(t, { ".github/workflows/test.yml": WORKFLOW, "autobuild.json": {} });
  const env = { ...process.env, AUTOBUILD_STATE_HOME: home };
  const config = { root: repo };
  assert.equal((await ciStartupCheck(config, () => {}, { env })).profile, "written");
  const file = path.join(ciStateDir(repo, env), "profile.json");
  const bytes = readFileSync(file);
  assert.equal((await ciStartupCheck(config, () => {}, { env })).profile, "reused");
  assert.deepEqual(readFileSync(file), bytes, "profile.json is not rewritten on reuse");
});

test("statusLine: an unparsable generatedAt, a linked state directory and a non-baseline file", async (t) => {
  const home = tempDir(t, "ci-triggers-state-");
  const repo = repoWith(t, { ".github/workflows/test.yml": WORKFLOW });
  const env = { ...process.env, AUTOBUILD_STATE_HOME: home };
  const { digest } = await inputsDigest(repo);
  writeState(repo, "profile", { schemaVersion: 1, inputsDigest: digest, generatedAt: "not a time" }, env);
  assert.equal(await statusLine({ root: repo }, new Date(), { env }), "ci-optimizer: unavailable (the stored profile has no valid generatedAt)");

  writeState(repo, "profile", { schemaVersion: 1, inputsDigest: digest, generatedAt: "2026-11-20T00:00:00Z" }, env);
  writeState(repo, "baseline", { schemaVersion: 1, note: "not a baseline" }, env);
  const before = listTree(home);
  assert.equal(await statusLine({ root: repo }, new Date("2026-11-22T00:00:00Z"), { env }), "ci-optimizer: profile 2d old, triggers: none", "a non-baseline file is no regression");
  assert.deepEqual(listTree(home), before, "statusLine writes nothing");

  const linkedHome = tempDir(t, "ci-triggers-linked-");
  const dir = ciStateDir(repo, { AUTOBUILD_STATE_HOME: linkedHome });
  mkdirSync(path.dirname(dir), { recursive: true });
  symlinkSync(tempDir(t), dir);
  assert.match(await statusLine({ root: repo }, new Date(), { env: { ...process.env, AUTOBUILD_STATE_HOME: linkedHome } }), /^ci-optimizer: unavailable \(STATE_UNSAFE: .+\)$/);
});

// ---------- autobuild ci triggers ----------

test("ci triggers: works without autobuild.json, refuses a linked state dir, outside git and an unknown flag", async (t) => {
  const home = tempDir(t, "ci-triggers-state-");
  const repo = repoWith(t, { ".github/workflows/test.yml": WORKFLOW });
  const plain = ci(repo, home, "triggers", "--json");
  assert.equal(plain.code, 0, plain.stderr);
  assert.deepEqual(JSON.parse(plain.stdout).triggers.map((x) => x.id), ["onboarding"], "default policy without autobuild.json");
  assert.deepEqual(listTree(home), [], "nothing written");

  const linkedHome = tempDir(t, "ci-triggers-linked-");
  const dir = ciStateDir(repo, { AUTOBUILD_STATE_HOME: linkedHome });
  mkdirSync(path.dirname(dir), { recursive: true });
  const elsewhere = tempDir(t);
  symlinkSync(elsewhere, dir);
  const linked = ci(repo, linkedHome, "triggers", "--json");
  assert.equal(linked.code, 3, "STATE_UNSAFE exits 3");
  assert.equal(JSON.parse(linked.stdout).error, "STATE_UNSAFE");
  assert.deepEqual(readdirSync(elsewhere), [], "nothing written through the link");

  const outside = ci(tempDir(t), home, "triggers");
  assert.equal(outside.code, 2);
  assert.equal(outside.stderr.trim(), "autobuild ci: not in a git repository");

  const unknown = ci(repo, home, "triggers", "--refresh");
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /^autobuild ci: USAGE: unknown flag --refresh for ci triggers/);
});
