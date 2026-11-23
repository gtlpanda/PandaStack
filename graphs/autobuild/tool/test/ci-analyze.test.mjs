// ci-optimizer CO-06 implementation tests: the edges the frozen acceptance file does not pin
// (anchored serial flags, multi-line runs, framework de-duplication and manifest choice, unknown
// or repeated needs, keyed job mapping, malformed or unparsed inputs, single-line summaries, a
// fractional shard saving, and the human summary line's apply count).
// Pure profiles and metrics are hand-built; the one CLI test uses a throwaway git repo and a
// private AUTOBUILD_STATE_HOME. Offline.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CLI } from "../test-fixtures/project.mjs";
import { analyze, compareFindings } from "../lib/ci/analyze.mjs";
import { describeChange } from "../lib/ci/apply.mjs";
import { noHistoryMetrics } from "../lib/ci/metrics.mjs";
import { ciPolicy } from "../lib/ci/policy.mjs";

const POLICY = ciPolicy(null);
const WORKFLOW_FILE = ".github/workflows/ci.yml";

const step = (kind, fields = {}) => ({ index: 1, name: null, uses: null, run: null, kind, cache: false, ...fields });
const job = (id, steps, fields = {}) => ({ id, name: null, runsOn: "ubuntu-22.04", needs: [], matrixSize: null, timeoutMinutes: null, steps, ...fields });
const workflow = (jobs, fields = {}) => ({
  file: WORKFLOW_FILE, name: "ci", triggers: [{ event: "push", branches: ["main"] }],
  concurrency: { group: "g", cancelInProgress: true }, jobs, ...fields,
});
const profileOf = ({ workflows = [], frameworks = [], pipelines = [] } = {}) => ({
  schemaVersion: 1, root: "/x", inputsDigest: "x", generatedAt: "2026-11-22T00:00:00.000Z", languages: [], buildTools: [],
  testFrameworks: frameworks, ci: { providers: [], workflows, pipelines }, gate: null, unknowns: [],
});
const run = (input) => analyze({ profile: profileOf(), metrics: noHistoryMetrics(), policy: POLICY, ...input });
const testJob = (runText) => workflow([job("test", [step("checkout", { uses: "actions/checkout@v4" }), step("test", { run: runText })])]);
const serialHits = (runText, frameworks = []) => run({ profile: profileOf({ workflows: [testJob(runText)], frameworks }) }).filter((f) => f.rule === "serial-test-runner");

test("serial flags are anchored: larger digits and look-alike flags do not fire", () => {
  for (const text of ["node --test --test-concurrency=10", "go test -p 16 ./...", "go test -p=12 ./...", "npx jest --runInBandX", "npx jest --ignore x", "npx vitest -i"]) {
    assert.deepEqual(serialHits(text), [], `${text} is not serial`);
  }
  for (const text of ["npx jest -i", "node --test --test-concurrency 1", "go test -p=1 ./..."]) {
    assert.equal(serialHits(text).length, 1, `${text} is serial`);
  }
});

test("a multi-line run fires once per step, names every flag, and keeps evidence on one line", () => {
  const hits = serialHits("echo start\nnpx jest --runInBand\ngo test -p 1 ./...");
  assert.equal(hits.length, 1);
  assert.match(hits[0].summary, /--runInBand, go test -p 1/);
  assert.deepEqual(hits[0].evidence, ["step 1: npx jest --runInBand"], "the evidence quotes the first line that matched");
  assert.ok(!hits[0].summary.includes("\n"));
});

test("missing-dependency-cache evidence quotes the install line, not the step's first line", () => {
  const build = job("build", [step("install", { index: 2, run: "echo deps\nnpm ci --no-audit" })]);
  const [hit] = run({ profile: profileOf({ workflows: [workflow([build])] }) });
  assert.equal(hit.rule, "missing-dependency-cache");
  assert.deepEqual(hit.evidence, ["step 2: npm ci --no-audit"]);
});

test("pytest workers: -n, --numprocesses and -nauto count; --no-header does not", () => {
  const xdist = [{ name: "pytest", command: null, parallel: "pytest-xdist", evidence: ["requirements.txt"] }];
  assert.deepEqual(serialHits("pytest --numprocesses 4", xdist), []);
  assert.deepEqual(serialHits("pytest -nauto", xdist), []);
  assert.equal(serialHits("pytest --no-header -q", xdist).length, 1);
});

test("two frameworks reading one test script give one finding; the evidence names flags, not the manifest's text", () => {
  const frameworks = [
    { name: "jest", command: "jest --runInBand --silent", parallel: "workers", evidence: ["package.json"] },
    { name: "vitest", command: "jest --runInBand --silent", parallel: "threads", evidence: ["package.json"] },
  ];
  const hits = run({ profile: profileOf({ frameworks }) });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].target, "package.json");
  assert.equal(hits[0].job, null);
  assert.deepEqual(hits[0].evidence, ["package.json test command: --runInBand"]);
});

test("a framework declared in several manifests is not attributed to any of them", () => {
  const frameworks = [{ name: "jest", command: "jest --runInBand", parallel: "workers", evidence: ["a/package.json", "package.json"] }];
  assert.deepEqual(run({ profile: profileOf({ frameworks }) }), [], "the profile does not say which manifest gave the command");
});

test("a framework without a command or evidence gives nothing", () => {
  const frameworks = [{ name: "jest", command: null, parallel: "workers", evidence: ["package.json"] }, { name: "x", command: "jest -i", parallel: null, evidence: [] }];
  assert.deepEqual(run({ profile: profileOf({ frameworks }) }), []);
});

test("needs: an unknown job is not guessed at, and a repeated need fires once", () => {
  const lint = (needs) => job("lint", [step("other", { run: "npx eslint ." }), step("checkout")], { needs });
  const build = job("build", [step("other", { run: "make" })]);
  assert.deepEqual(run({ profile: profileOf({ workflows: [workflow([build, lint(["ghost"])])] }) }), []);
  const hits = run({ profile: profileOf({ workflows: [workflow([build, lint(["build", "build"])])] }) });
  assert.deepEqual(hits.map((f) => `${f.rule}#${f.job}`), ["needs-without-artifacts#lint"]);
});

// One workflow's metrics with a slow single step in job key `key`.
const slowMetrics = (key, { stepName = "Run tests", stepP50 = 1400, criticalPath = 1500 } = {}) => ({
  workflows: [{
    workflow: "ci", criticalPathSeconds: { p50: criticalPath }, queueSeconds: { p50: null }, wallSeconds: { p50: null },
    steps: [{ job: key, step: stepName, samples: 5, seconds: { p50: stepP50 } }], reliability: { flakyRuns: 0, flakyRunIds: [] },
  }],
  gate: null, unknowns: [],
});
const longHits = (jobs, metrics) => run({ profile: profileOf({ workflows: [workflow(jobs)] }), metrics }).filter((f) => f.rule === "long-single-job");

test("long-single-job maps the CO-04 job key (digits as *) to exactly one job model", () => {
  const hits = longHits([job("e2e", [step("test", { run: "npm test" })])], slowMetrics("e*e"));
  assert.equal(hits.length, 1, "job e2e is keyed e*e by CO-04");
  assert.equal(hits[0].job, "e2e");
  assert.equal(hits[0].estimatedSavingSeconds, 933);
  const named = longHits([job("t", [], { name: "unit 1" })], slowMetrics("unit *"));
  assert.equal(named[0]?.job, "t", "the name wins over the id, and the finding names the id");
  assert.deepEqual(longHits([job("a1", []), job("a2", [])], slowMetrics("a*")), [], "two matching models are ambiguous");
});

test("long-single-job keeps a multi-line step name on one line and needs numeric figures", () => {
  const [hit] = longHits([job("build", [])], slowMetrics("build", { stepName: "Run npx jest\n--runInBand" }));
  assert.ok(!hit.summary.includes("\n") && hit.evidence.every((line) => !line.includes("\n")));
  assert.deepEqual(longHits([job("build", [])], slowMetrics("build", { criticalPath: null })), []);
  assert.deepEqual(longHits([job("build", [])], slowMetrics("build", { stepP50: null })), []);
});

test("metric rules skip a model without a name; malformed and unparsed inputs give nothing", () => {
  const flaky = { workflows: [{ workflow: "ci", reliability: { flakyRuns: 1, flakyRunIds: [7] } }], gate: null, unknowns: [] };
  assert.deepEqual(run({ profile: profileOf({ workflows: [workflow([], { name: null })] }), metrics: flaky }), []);
  assert.deepEqual(run({ profile: profileOf({ workflows: [workflow([])] }), metrics: flaky }).map((f) => f.evidence), [["run 7"]]);
  assert.deepEqual(run({ profile: {}, metrics: {} }), []);
  assert.deepEqual(run({ profile: profileOf({ pipelines: [{ file: ".gitlab-ci.yml", error: ".gitlab-ci.yml: bad" }] }) }), []);
});

test("a fractional shard saving is whole seconds, and the evidence uses the apply wording", () => {
  const change = { step: "A", from: null, to: 7 };
  const plan = { shardCount: 2, before: { maxShardSeconds: 10.6, shards: [] }, after: { maxShardSeconds: 7.2, shards: [] }, changes: [change], improves: true, unmeasured: [] };
  const [hit] = run({ gate: { plan } });
  assert.equal(hit.estimatedSavingSeconds, 3);
  assert.equal(describeChange(change), "A: shardWeight unset -> 7");
  assert.ok(hit.evidence.includes("A: shardWeight unset -> 7"));
});

test("sort: a null job follows a string job within one rule and target", () => {
  const f = (job) => ({ rule: "r", target: "t", job, estimatedSavingSeconds: null });
  assert.deepEqual([f(null), f("b"), f("a")].sort(compareFindings).map((x) => x.job), ["a", "b", null]);
});

test("noHistoryMetrics is the contract's no-history document, fresh each call", () => {
  const doc = noHistoryMetrics();
  assert.deepEqual(doc, { workflows: [], gate: null, unknowns: ["CI_CACHE_HIT_RATE", "NO_HISTORY", "RUNNER_UTILIZATION"] });
  doc.workflows.push(1);
  assert.deepEqual(noHistoryMetrics().workflows, []);
});

// ---------- CLI ----------

const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LANG: "C",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
};

function tempDir(t, prefix) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const SHARDED_WORKFLOW = `name: test
on:
  push:
    branches: [main]
jobs:
  shard:
    runs-on: ubuntu-22.04
    strategy:
      matrix:
        shard: [1, 2, 3]
    steps:
      - run: node cli.mjs check --shard "\${{ matrix.shard }}/3"
`;

const GATE = [{ name: "a", command: "true", shardWeight: 10 }, { name: "b", command: "true", shardWeight: 1 }, { name: "c", command: "true", shardWeight: 1 }, { name: "d", command: "true", shardWeight: 1 }];

/** A git repo holding `files` (strings written as given). */
function gitRepo(t, files) {
  const repo = tempDir(t, "ci-analyze-");
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    writeFileSync(path.join(repo, rel), text);
  }
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: repo, env: { ...process.env, ...GIT_ENV } }).status, 0);
  return repo;
}

const analyzeCli = (t, repo, args = []) => spawnSync(process.execPath, [CLI, "ci", "analyze", ...args], { cwd: repo, encoding: "utf8", env: { ...process.env, ...GIT_ENV, AUTOBUILD_STATE_HOME: tempDir(t, "ci-analyze-state-") }, timeout: 120_000 });

test("ci analyze reads gate timings only when a shard count is known", (t) => {
  const base = { ".gitignore": "logs/\n", "autobuild.json": `${JSON.stringify({ gate: GATE })}\n` };
  // A directory where the timings file belongs cannot be read.
  const unsharded = gitRepo(t, base);
  mkdirSync(path.join(unsharded, "logs", "gate-timings.jsonl"), { recursive: true });
  const quiet = analyzeCli(t, unsharded, ["--json"]);
  assert.equal(quiet.status, 0, `no shard count, so the unreadable timings are never read: ${quiet.stderr}`);
  const sharded = gitRepo(t, { ...base, ".github/workflows/test.yml": SHARDED_WORKFLOW });
  mkdirSync(path.join(sharded, "logs", "gate-timings.jsonl"), { recursive: true });
  const failed = analyzeCli(t, sharded, ["--json"]);
  assert.equal(failed.status, 3, "with a shard count the plan needs the timings");
  assert.equal(JSON.parse(failed.stdout).error, "TIMINGS_UNREADABLE");
});

test("ci analyze human output counts the apply finding in its summary line", (t) => {
  const record = { at: "2026-11-22T10:00:00.000Z", type: "gate", phase: "full", ok: true, wallSeconds: 200, steps: [{ name: "a", seconds: 5 }, { name: "b", seconds: 60 }, { name: "c", seconds: 50 }, { name: "d", seconds: 40 }] };
  const repo = gitRepo(t, { ".gitignore": "logs/\n", "autobuild.json": `${JSON.stringify({ gate: GATE })}\n`, ".github/workflows/test.yml": SHARDED_WORKFLOW, "logs/gate-timings.jsonl": `${JSON.stringify(record)}\n` });
  const r = analyzeCli(t, repo);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.match(lines[0], /^\[low\/apply\] gate-shard-weights autobuild\.json: /);
  assert.equal(lines.at(-1), `findings: ${lines.length - 1} (1 to apply, ${lines.length - 2} to propose)`);
});
