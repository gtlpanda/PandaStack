// ci-optimizer CO-08 implementation tests: the edges the frozen acceptance file does not pin
// (step identity, GitLab jobs, unparsed pipelines, counted removals, one-sided workflows, -0,
// a missing recent workflow or wall, the baseline document shape) and the CLI's refusals
// (flag combinations, a capture that writes nothing, a corrupt or linked baseline, a repo
// without autobuild.json, the insufficient-data line). Offline: throwaway git repos and a
// private AUTOBUILD_STATE_HOME per test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CLI } from "../test-fixtures/project.mjs";
import { captureBaseline, compareBaselines, detectRegression, isBaselineDocument, round1, stepIdentity } from "../lib/ci/baseline.mjs";
import { ciPolicy } from "../lib/ci/policy.mjs";
import { ciStateDir } from "../lib/ci/state.mjs";

const POLICY = ciPolicy(null);
const HEAD = "a".repeat(40);
const AT = "2026-11-22T12:00:00Z";
const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LANG: "C",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
};

// ---------- fixtures ----------

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const T0 = Date.parse("2026-11-01T00:00:00Z");

/** A one-job attempt on day `n`; `steps` maps step name to seconds, the wall is their sum. */
function attempt({ n, steps = { Work: 100 }, workflow = "test", conclusion = "success", updatedAt }) {
  const start = T0 + n * 86_400_000;
  let cursor = start;
  const stepRecords = Object.entries(steps).map(([name, seconds], i) => {
    const from = cursor;
    cursor += seconds * 1000;
    return { number: i + 1, name, conclusion: "success", startedAt: iso(from), completedAt: iso(cursor) };
  });
  return {
    provider: "github", runId: 9000 + n, attempt: 1, workflow, workflowPath: `.github/workflows/${workflow}.yml`, event: "push",
    headSha: "f".repeat(40), branch: "main", conclusion, createdAt: iso(start), startedAt: iso(start),
    updatedAt: updatedAt === undefined ? iso(cursor) : updatedAt,
    jobs: [{ name: "build", conclusion, createdAt: iso(start), startedAt: iso(start), completedAt: iso(cursor), labels: ["ubuntu-22.04"], steps: stepRecords }],
  };
}
const days = (from, count, opts = {}) => Array.from({ length: count }, (_, i) => attempt({ n: from + i, ...opts }));

const step = (fields) => ({ index: 1, name: null, uses: null, run: null, kind: "other", cache: false, ...fields });
const profileOf = ({ workflows = [], pipelines = [], gate = null } = {}) => ({ ci: { providers: [], workflows, pipelines }, gate, unknowns: [] });
const capture = (input) => captureBaseline({ attempts: [], profile: profileOf(), timings: [], policy: POLICY, head: HEAD, at: AT, ...input });

function tempDir(t) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "ci-baseline-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd, ...args) {
  const r = spawnSync("git", ["-c", "init.defaultBranch=main", ...args], { cwd, env: { ...process.env, ...GIT_ENV }, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A committed git repo with the given files (objects are written as JSON). */
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

const WORKFLOW = "name: test\non: push\njobs:\n  unit:\n    runs-on: ubuntu-22.04\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm test\n";

// ---------- module ----------

test("stepIdentity: name, else uses, else the first non-blank line of run, else null", () => {
  assert.equal(stepIdentity(step({ name: "Unit", uses: "x/y@v1", run: "npm test" })), "Unit");
  assert.equal(stepIdentity(step({ name: "", uses: "x/y@v1" })), "x/y@v1", "an empty name is no name");
  assert.equal(stepIdentity(step({ run: "\n  npm test -- --shard 1\nnpm run lint" })), "npm test -- --shard 1");
  assert.equal(stepIdentity(step({})), null);
  assert.equal(stepIdentity(step({ run: "\n  \n" })), null, "a blank run has no identity");
  for (const bad of [null, undefined, 0, "npm test", []]) assert.equal(stepIdentity(bad), null, `${JSON.stringify(bad)} has no identity`);
});

test("inserting a step before a test step does not change the test step identities", () => {
  const job = (steps) => ({ id: "unit", steps });
  const wf = (steps) => ({ file: ".github/workflows/ci.yml", jobs: [job(steps)] });
  const before = capture({ profile: profileOf({ workflows: [wf([step({ uses: "actions/checkout@v4", kind: "checkout" }), step({ index: 2, run: "npm test", kind: "test" })])] }) });
  const after = capture({ profile: profileOf({ workflows: [wf([step({ uses: "actions/checkout@v4", kind: "checkout" }), step({ index: 2, uses: "actions/cache@v4", kind: "cache" }), step({ index: 3, run: "npm test", kind: "test" })])] }) });
  assert.deepEqual(before.testSteps, [".github/workflows/ci.yml#unit#npm test"]);
  const cmp = compareBaselines(before, after);
  assert.equal(cmp.preserved, true);
  assert.deepEqual(cmp.removed.testSteps, []);
});

test("GitLab jobs are checks, test jobs are `#script` test steps, and an unparsed pipeline adds nothing", () => {
  const pipeline = { file: ".gitlab-ci.yml", stages: ["build", "test"], jobs: [{ id: "build", test: false }, { id: "pytest", test: true }] };
  const doc = capture({ profile: profileOf({ pipelines: [pipeline] }) });
  assert.deepEqual(doc.checks, [".gitlab-ci.yml#build", ".gitlab-ci.yml#pytest"]);
  assert.deepEqual(doc.testSteps, [".gitlab-ci.yml#pytest#script"]);
  const unparsed = capture({ profile: profileOf({ pipelines: [{ file: ".gitlab-ci.yml", error: ".gitlab-ci.yml: anchors" }] }) });
  assert.deepEqual([unparsed.checks, unparsed.testSteps, unparsed.gateSteps], [[], [], []]);
  assert.deepEqual(capture({ profile: null }).checks, [], "a missing profile gives empty identity lists");
});

test("compareBaselines counts duplicates: dropping one of two identical test steps is a removal", () => {
  const doc = (testSteps) => ({ ...capture({}), testSteps });
  const same = "ci.yml#unit#npm test";
  const cmp = compareBaselines(doc([same, same]), doc([same]));
  assert.deepEqual(cmp.removed.testSteps, [same]);
  assert.equal(cmp.preserved, false);
  assert.deepEqual(compareBaselines(doc([same]), doc([same, same])).added.testSteps, [same]);
});

test("compareBaselines: a workflow on one side only, or with a zero before wall, has null deltas", () => {
  const doc = (workflows) => ({ ...capture({}), workflows: workflows.map(([workflow, wallP50]) => ({ workflow, runs: 1, wallP50, criticalPathP50: null, steps: [] })) });
  const cmp = compareBaselines(doc([["a", 100], ["gone", 50], ["zero", 0]]), doc([["a", 80], ["new", 30], ["zero", 10]]));
  assert.deepEqual(cmp.workflows, [
    { workflow: "a", before: 100, after: 80, deltaSeconds: -20, deltaPercent: -20 },
    { workflow: "gone", before: 50, after: null, deltaSeconds: null, deltaPercent: null },
    { workflow: "new", before: null, after: 30, deltaSeconds: null, deltaPercent: null },
    { workflow: "zero", before: 0, after: 10, deltaSeconds: 10, deltaPercent: null },
  ]);
});

test("round1 rounds to one decimal and never returns -0", () => {
  assert.equal(round1(4.333), 4.3);
  assert.equal(round1(-4.333), -4.3);
  assert.ok(Object.is(round1(-0.04), 0), "-0.04 rounds to 0, not -0");
});

test("detectRegression: a workflow missing from recent history, or with no recent wall, is insufficient data", () => {
  const baseline = capture({ attempts: days(0, 3), policy: { ...POLICY, baselineRuns: 3 } });
  const other = detectRegression({ baseline, attempts: days(10, 3, { workflow: "lint" }), policy: { ...POLICY, recentRuns: 3 } });
  assert.equal(other.workflows[0].status, "insufficient-data");
  assert.equal(other.regressed, false);
  const noWall = detectRegression({ baseline, attempts: days(10, 3, { updatedAt: null }), policy: { ...POLICY, recentRuns: 3 } });
  assert.equal(noWall.workflows[0].status, "insufficient-data", "attempts without updatedAt have no wall");
  assert.deepEqual(detectRegression({ baseline: { workflows: [] }, attempts: days(10, 3), policy: POLICY }), { workflows: [], regressed: false });
});

test("isBaselineDocument accepts a captured document and refuses look-alikes", () => {
  const doc = capture({ attempts: days(0, 3) });
  assert.equal(isBaselineDocument(doc), true);
  assert.equal(isBaselineDocument(JSON.parse(JSON.stringify(doc))), true, "survives a JSON round trip");
  for (const bad of [null, [], "x", 0, { ...doc, schemaVersion: 2 }, { ...doc, workflows: null }, { ...doc, checks: [1] }, { ...doc, gateSteps: undefined }, { ...doc, workflows: [{ workflow: 1, steps: [] }] }]) {
    assert.equal(isBaselineDocument(bad), false, `${JSON.stringify(bad)?.slice(0, 60)} is refused`);
  }
});

// ---------- CLI ----------

test("ci baseline: flag combinations and a missing --after are usage errors", (t) => {
  const repo = repoWith(t, { ".github/workflows/test.yml": WORKFLOW });
  const home = tempDir(t);
  const both = ci(repo, home, "baseline", "--capture", "--fail-on-regression");
  assert.equal(both.code, 2);
  assert.match(both.stderr, /^autobuild ci: USAGE: /m);
  const half = ci(repo, home, "compare", "--before", "x.json");
  assert.equal(half.code, 2);
  assert.match(half.stderr, /^autobuild ci: USAGE: .*--after/m);
});

test("ci baseline --capture without history writes nothing at all", (t) => {
  const repo = repoWith(t, { ".github/workflows/test.yml": WORKFLOW });
  const home = tempDir(t);
  const r = ci(repo, home, "baseline", "--capture");
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^autobuild ci: NO_HISTORY: /m);
  assert.equal(existsSync(ciStateDir(repo, { AUTOBUILD_STATE_HOME: home })), false, "not even the profile is written");
});

test("ci baseline works without autobuild.json and prints the insufficient-data line", (t) => {
  const repo = repoWith(t, { ".github/workflows/test.yml": WORKFLOW });
  const home = tempDir(t);
  const file = path.join(tempDir(t), "attempts.json");
  writeFileSync(file, JSON.stringify({ attempts: days(0, 3) }));
  assert.equal(ci(repo, home, "history", "--import", file).code, 0);
  const captured = ci(repo, home, "baseline", "--capture");
  assert.equal(captured.code, 0, captured.stderr);
  assert.match(captured.stdout, new RegExp(`^baseline: captured at ${git(repo, "rev-parse", "HEAD").slice(0, 12)}, 1 workflows$`, "m"));
  const json = ci(repo, home, "baseline", "--capture", "--json");
  assert.deepEqual(JSON.parse(json.stdout).checks, [".github/workflows/test.yml#unit"]);
  assert.deepEqual(JSON.parse(json.stdout).testSteps, [".github/workflows/test.yml#unit#npm test"]);
  assert.deepEqual(JSON.parse(json.stdout).gate, null);

  // Replace the history with two attempts: under the default recentRuns 5 that is too few.
  rmSync(path.join(ciStateDir(repo, { AUTOBUILD_STATE_HOME: home }), "history.json"));
  writeFileSync(file, JSON.stringify({ attempts: days(10, 2) }));
  assert.equal(ci(repo, home, "history", "--import", file).code, 0);
  const shown = ci(repo, home, "baseline", "--fail-on-regression");
  assert.equal(shown.code, 0, shown.stderr);
  // insufficient-data sets every figure to null (CO-08 clarification), so none is printed.
  assert.equal(shown.stdout, "test: baseline p50 unknown, recent p50 unknown (unknown) insufficient data\n");
});

test("ci baseline: a corrupt baseline.json is NO_BASELINE; a linked state directory is STATE_UNSAFE", (t) => {
  const repo = repoWith(t, { ".github/workflows/test.yml": WORKFLOW });
  const home = tempDir(t);
  const dir = ciStateDir(repo, { AUTOBUILD_STATE_HOME: home });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, "baseline.json"), JSON.stringify({ schemaVersion: 1, workflows: "no" }));
  const corrupt = ci(repo, home, "baseline", "--json");
  assert.equal(corrupt.code, 2);
  assert.equal(JSON.parse(corrupt.stdout).error, "NO_BASELINE");

  const linkedHome = tempDir(t);
  const linked = ciStateDir(repo, { AUTOBUILD_STATE_HOME: linkedHome });
  mkdirSync(path.dirname(linked), { recursive: true });
  symlinkSync(dir, linked);
  const refused = ci(repo, linkedHome, "baseline");
  assert.equal(refused.code, 3);
  assert.match(refused.stderr, /^autobuild ci: STATE_UNSAFE: /m);
});

test("ci compare prints deltas and additions, and refuses a document that is not a baseline", (t) => {
  const repo = repoWith(t, { ".github/workflows/test.yml": WORKFLOW });
  const home = tempDir(t);
  const dir = tempDir(t);
  const write = (name, doc) => { const file = path.join(dir, name); writeFileSync(file, JSON.stringify(doc)); return file; };
  const before = capture({ attempts: days(0, 3, { steps: { Work: 200 } }), profile: profileOf({ gate: { steps: [{ name: "lint" }] } }) });
  const after = capture({ attempts: days(0, 3, { steps: { Work: 150 } }), profile: profileOf({ gate: { steps: [{ name: "lint" }, { name: "unit" }] } }) });
  const r = ci(repo, home, "compare", "--before", write("b.json", before), "--after", write("a.json", after));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "test: before p50 200s, after p50 150s (-50s, -25%)\nadded: unit\nchecks preserved: yes\n");
  const notBaseline = ci(repo, home, "compare", "--before", write("h.json", { schemaVersion: 1, attempts: [] }), "--after", path.join(dir, "a.json"));
  assert.equal(notBaseline.code, 2);
  assert.match(notBaseline.stderr, /^autobuild ci: BASELINE_INVALID: .*h\.json is not a baseline document$/m);
});
