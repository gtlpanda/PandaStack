// ci-optimizer CO-04 implementation tests: the edges the frozen acceptance file does not pin
// (the setup-step predicate's negatives, attempts with nothing measurable, null names and labels,
// rate lookups, tie order, gate records of the wrong shape, and the CLI's flag and file errors).
// Offline: throwaway git repos and a private AUTOBUILD_STATE_HOME per test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CLI } from "../test-fixtures/project.mjs";
import { writeHistory } from "../lib/ci/history.mjs";
import { attemptFacts, computeMetrics, gateMetrics, jobKey, seconds } from "../lib/ci/metrics.mjs";

const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LANG: "C",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const BASE = "2026-03-01T00:00:00Z";
const at = (offset) => (offset === null ? null : new Date(Date.parse(BASE) + offset * 1000).toISOString());

function tempDir(t, prefix = "ci-metrics-") {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function gitRepo(t, files = {}) {
  const dir = tempDir(t);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  const r = spawnSync("git", ["init", "-q"], { cwd: dir, env: { ...process.env, ...GIT_ENV }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return dir;
}

/** A job { name, created, started, completed, labels, steps: [[name, start, end]] }, offsets in seconds. */
const job = ({ name = "j", created = 0, started = 0, completed = 60, labels = ["x"], steps = [] } = {}) => ({
  name, conclusion: "success", createdAt: at(created), startedAt: at(started), completedAt: at(completed), labels,
  steps: steps.map(([stepName, start, end], i) => ({ number: i + 1, name: stepName, conclusion: "success", startedAt: at(start), completedAt: at(end) })),
});
const attempt = ({ runId = 1, attemptNo = 1, workflow = "w", start = 0, conclusion = "success", updated = 100, jobs = [job()] } = {}) => ({
  provider: "import", runId, attempt: attemptNo, workflow, workflowPath: null, event: "push", headSha: null, branch: "main",
  conclusion, createdAt: at(start), startedAt: at(start), updatedAt: at(updated), jobs,
});

// ---------- attemptFacts ----------

test("attemptFacts: only the four bookkeeping step names count as setup; look-alikes do not", () => {
  const steps = [
    ["Set up job", 0, 1], ["Complete job", 1, 2], ["Run actions/checkout@v4", 2, 3], ["Post Run actions/checkout@v4", 3, 4],
    ["Run actionsX/checkout", 4, 14], [" Set up job", 14, 24], ["set up job", 24, 34], ["Run actions", 34, 44],
    ["Post Run actions", 44, 54], ["Complete job ", 54, 64], ["My Run actions/x", 64, 74],
  ];
  const facts = attemptFacts(attempt({ jobs: [job({ completed: 80, steps })] }));
  assert.equal(facts.setup, 4);
});

test("attemptFacts: an attempt with no measurable job reports null facts, never zeros it cannot know", () => {
  const facts = attemptFacts(attempt({ jobs: [job({ started: null, completed: null }), job({ completed: null })] }));
  assert.deepEqual(facts, { wall: 100, queue: null, setup: null, criticalPath: { jobs: [], seconds: 0 }, efficiency: null, runnerMinutes: 0, jobs: [] });
});

test("attemptFacts: a job whose timestamps do not parse does not count", () => {
  const broken = { ...job({ name: "broken" }), startedAt: "yesterday" };
  const facts = attemptFacts(attempt({ jobs: [broken, job({ name: "ok", completed: 30 })] }));
  assert.deepEqual(facts.jobs.map((j) => j.key), ["ok"]);
  assert.equal(facts.runnerMinutes, 1);
});

test("attemptFacts: a missing createdAt or updatedAt is unknown, and ends the critical path walk", () => {
  const a = job({ name: "a", completed: 10 });
  const b = { ...job({ name: "b", started: 20, completed: 40 }), createdAt: null };
  const facts = attemptFacts({ ...attempt({ jobs: [a, b] }), updatedAt: null });
  assert.equal(facts.wall, null);
  assert.equal(facts.queue, 0, "only a's queue is measurable");
  assert.deepEqual(facts.criticalPath.jobs, ["b"]);
});

test("attemptFacts: ties on completedAt keep the earlier API position, for the last job and each earlier one", () => {
  const facts = attemptFacts(attempt({ jobs: [
    job({ name: "p1", completed: 10 }), job({ name: "p2", completed: 10 }),
    job({ name: "q1", created: 12, started: 12, completed: 50 }), job({ name: "q2", created: 12, started: 12, completed: 50 }),
  ] }));
  assert.deepEqual(facts.criticalPath.jobs, ["p1", "q1"]);
});

test("attemptFacts: a null job name or an empty label list keeps the job, with null key and label", () => {
  const facts = attemptFacts(attempt({ jobs: [job({ name: null, labels: [] })] }));
  assert.deepEqual(facts.jobs, [{ key: null, label: null, minutes: 1 }]);
  assert.equal(jobKey(undefined), null);
  assert.equal(jobKey(42), null);
});

test("seconds: rejects empty strings and non-date strings, accepts offsets", () => {
  assert.equal(seconds("", BASE), null);
  assert.equal(seconds(BASE, "2026-13-45"), null);
  assert.equal(seconds("2026-03-01T01:00:00+01:00", BASE), 0);
});

// ---------- computeMetrics ----------

test("computeMetrics: a workflow with only cancelled attempts has no timing figures but keeps its reliability", () => {
  const wf = computeMetrics([attempt({ conclusion: "cancelled" })], { rates: { x: 1 } }).workflows[0];
  assert.equal(wf.runs, 0);
  assert.deepEqual(wf.wallSeconds, { p50: null, p90: null, max: null });
  assert.deepEqual(wf.queueSeconds, { p50: null, p90: null });
  assert.deepEqual(wf.criticalPathJobs, []);
  assert.deepEqual(wf.parallelEfficiency, { p50: null });
  assert.deepEqual(wf.runnerMinutes, { total: 0, p50: null });
  assert.deepEqual(wf.costUsd, { total: 0, perSuccessfulRun: null });
  assert.deepEqual(wf.steps, []);
  assert.equal(wf.reliability.cancelled, 1);
  assert.equal(wf.reliability.flakeRate, 0);
});

test("computeMetrics: an attempt with an unknown wall is left out of the wall figures, not counted as zero", () => {
  const wf = computeMetrics([
    attempt({ runId: 1, start: 0, updated: 300 }),
    { ...attempt({ runId: 2, start: 10 }), updatedAt: null },
  ]).workflows[0];
  assert.equal(wf.runs, 2);
  assert.deepEqual(wf.wallSeconds, { p50: 300, p90: 300, max: 300 });
});

test("computeMetrics: a null label, a non-number rate and an inherited key are all RATE_MISSING", () => {
  const metrics = computeMetrics([attempt({ jobs: [job({ labels: [] }), job({ labels: ["constructor"] }), job({ labels: ["y"] })] })], { rates: { y: "0.5" } });
  assert.equal(metrics.workflows[0].costUsd, null);
  assert.deepEqual(metrics.unknowns, ["CI_CACHE_HIT_RATE", "RATE_MISSING:constructor", "RATE_MISSING:unlabeled", "RATE_MISSING:y", "RUNNER_UTILIZATION"]);
});

test("computeMetrics: a zero rate is a configured rate", () => {
  const wf = computeMetrics([attempt()], { rates: { x: 0 } }).workflows[0];
  assert.deepEqual(wf.costUsd, { total: 0, perSuccessfulRun: 0 });
});

test("computeMetrics: steps with the same p50 sort by job, then step", () => {
  const steps = [["b", 0, 5], ["a", 0, 5], ["slow", 0, 9]];
  const wf = computeMetrics([attempt({ jobs: [job({ name: "zeta", steps }), job({ name: "alpha", steps })] })]).workflows[0];
  assert.deepEqual(wf.steps.map((s) => `${s.job}/${s.step}`), ["alpha/slow", "zeta/slow", "alpha/a", "alpha/b", "zeta/a", "zeta/b"]);
});

test("computeMetrics: null workflow, job and step names group and sort without throwing (null last)", () => {
  const metrics = computeMetrics([
    attempt({ runId: 1, workflow: null, jobs: [job({ name: null, steps: [[null, 0, 5], ["s", 0, 5]] })] }),
    attempt({ runId: 2, workflow: "b" }),
  ]);
  assert.deepEqual(metrics.workflows.map((w) => w.workflow), ["b", null]);
  assert.deepEqual(metrics.workflows[1].steps.map((s) => [s.job, s.step]), [[null, "s"], [null, null]]);
});

test("computeMetrics: does not reorder the caller's attempts, and the window is per workflow", () => {
  const attempts = [attempt({ runId: 1, start: 0 }), attempt({ runId: 2, start: 50, workflow: "v" }), attempt({ runId: 3, start: 100 })];
  const ids = attempts.map((a) => a.runId);
  const metrics = computeMetrics(attempts, { window: 1 });
  assert.deepEqual(attempts.map((a) => a.runId), ids);
  assert.deepEqual(metrics.workflows.map((w) => [w.workflow, w.reliability.attempts]), [["v", 1], ["w", 1]]);
});

test("computeMetrics: an empty history gives no workflows and only the permanent unknowns", () => {
  assert.deepEqual(computeMetrics([]), { schemaVersion: 1, workflows: [], gate: null, unknowns: ["CI_CACHE_HIT_RATE", "RUNNER_UTILIZATION"] });
});

// ---------- gateMetrics ----------

test("gateMetrics: non-object lines, a missing steps list and non-number seconds are skipped, not thrown on", () => {
  const gate = gateMetrics([
    null, 7, "text", ["gate"],
    { type: "gate", phase: "full", ok: true, wallSeconds: 20 },
    { type: "gate", phase: "full", ok: true, wallSeconds: "40", steps: [null, { name: "u", seconds: "9" }, { name: "u", seconds: 3 }, { name: "c", cached: "yes", seconds: 1 }] },
  ]);
  assert.equal(gate.runs, 2);
  assert.deepEqual(gate.wallSeconds, { p50: 20, p90: 20 }, "a string wallSeconds is not a measurement");
  assert.equal(gate.cacheHitRate, 0, "only cached === true is a cache hit; three step objects, none cached");
  assert.deepEqual(gate.steps, [{ name: "u", samples: 1, seconds: { p50: 3, p90: 3 } }, { name: "c", samples: 1, seconds: { p50: 1, p90: 1 } }]);
});

test("gateMetrics: no successful full record gives null wall percentiles", () => {
  const gate = gateMetrics([{ type: "gate", phase: "full", ok: false, wallSeconds: 5, steps: [] }]);
  assert.deepEqual(gate.wallSeconds, { p50: null, p90: null });
});

// ---------- the CLI ----------

function metricsCli(cwd, args, env) {
  const r = spawnSync(process.execPath, [CLI, "ci", "metrics", ...args], { cwd, env: { ...process.env, ...GIT_ENV, ...env }, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json: () => JSON.parse(r.stdout) };
}

function storedRepo(t, attempts, files = {}) {
  const repo = gitRepo(t, files);
  const env = { AUTOBUILD_STATE_HOME: tempDir(t, "ci-metrics-state-") };
  writeHistory(repo, { source: { provider: "import", file: "a.json" }, attempts }, env);
  return { repo, env };
}

test("ci metrics: --window must be a whole number of at least 1", (t) => {
  const { repo, env } = storedRepo(t, [attempt()]);
  for (const value of ["0", "-1", "1e2", "2.5", " 3", "abc"]) {
    const r = metricsCli(repo, ["--window", value, "--json"], env);
    assert.equal(r.code, 2, `--window ${JSON.stringify(value)}`);
    assert.equal(r.json().error, "USAGE");
  }
  assert.equal(metricsCli(repo, ["--window"], env).code, 2, "a missing value");
  assert.equal(metricsCli(repo, ["--window", "1", "--window", "2"], env).code, 2, "given twice");
  assert.equal(metricsCli(repo, ["--window", "007", "--json"], env).json().workflows[0].runs, 1);
});

test("ci metrics: --workflow that matches nothing says so and exits 0", (t) => {
  const { repo, env } = storedRepo(t, [attempt()]);
  const r = metricsCli(repo, ["--workflow", "nope"], env);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'metrics: no attempts for workflow "nope"\n');
  assert.deepEqual(metricsCli(repo, ["--workflow", "nope", "--json"], env).json().workflows, []);
});

test("ci metrics: stored history with no attempts is not NO_HISTORY", (t) => {
  const { repo, env } = storedRepo(t, []);
  const r = metricsCli(repo, [], env);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "metrics: the stored history has no attempts\n");
});

test("ci metrics: human output prints unknown figures as unknown, the gate line and the unknowns", (t) => {
  const { repo, env } = storedRepo(t, [attempt({ conclusion: "cancelled" })], {
    ".gitignore": "logs/\n",
    "autobuild.json": JSON.stringify({ gate: [{ name: "unit", command: "true" }] }),
    "logs/gate-timings.jsonl": `${JSON.stringify({ type: "gate", phase: "full", ok: true, wallSeconds: 12, steps: [{ name: "unit", seconds: 12 }] })}\n`,
  });
  const r = metricsCli(repo, [], env);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, [
    "workflow w: 0 runs, wall p50 unknown p90 unknown, queue p50 unknown, critical path p50 unknown (none), efficiency unknown, runner minutes 0, flake rate 0",
    "gate: 1 full runs, wall p50 12s p90 12s, cache hit rate 0",
    "unknowns: CI_CACHE_HIT_RATE, RUNNER_UTILIZATION",
  ].join("\n") + "\n");
});

test("ci metrics: an unreadable gate timings file is TIMINGS_UNREADABLE (exit 3)", (t) => {
  const { repo, env } = storedRepo(t, [attempt()], { ".gitignore": "logs/\n", "autobuild.json": JSON.stringify({ gate: [{ name: "unit", command: "true" }] }) });
  mkdirSync(path.join(repo, "logs", "gate-timings.jsonl"), { recursive: true });
  const r = metricsCli(repo, ["--json"], env);
  assert.equal(r.code, 3);
  assert.equal(r.json().error, "TIMINGS_UNREADABLE");
});

test("ci metrics: an invalid autobuild.json is CONFIG_INVALID (exit 2)", (t) => {
  const { repo, env } = storedRepo(t, [attempt()], { "autobuild.json": JSON.stringify({ ciOptimizer: { ratesPerMinute: { x: -1 } } }) });
  const r = metricsCli(repo, ["--json"], env);
  assert.equal(r.code, 2);
  assert.equal(r.json().error, "CONFIG_INVALID");
});
