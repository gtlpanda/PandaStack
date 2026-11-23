// CI metrics (spec/contracts/ci-optimizer-co-04.md): per-attempt facts, per-workflow figures and the
// local gate figures, all computed from recorded timestamps. Pure functions: the caller reads the
// stored history and the gate timings. A value that cannot be measured is null, never a guess.

import { isPlainObject, newestFirst } from "./history.mjs";

/** Permanent unknowns: the GitHub Actions REST API reports neither (ci-optimizer-priority.md, "Deferred"). */
const PERMANENT_UNKNOWNS = ["CI_CACHE_HIT_RATE", "RUNNER_UTILIZATION"];
/** How late a job may complete after the next job was created and still be on its critical path. */
const CRITICAL_PATH_TOLERANCE_MS = 5000;
/** The RATE_MISSING label of a job that has no runner label at all. */
const UNLABELED = "unlabeled";

const round2 = (x) => Math.round(x * 100) / 100;
const round4 = (x) => Math.round(x * 10000) / 10000;
const sum = (values) => values.reduce((total, value) => total + value, 0);
const maxOrNull = (values) => (values.length ? Math.max(...values) : null);
const notNull = (values) => values.filter((value) => value !== null);
/** Text order with null last, for names an import may leave null. */
export const byText = (a, b) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : String(a).localeCompare(String(b)));

/** Whole seconds from `a` to `b`, or null when either is missing or unparseable. */
export function seconds(a, b) {
  if (!a || !b) return null;
  const start = Date.parse(a);
  const end = Date.parse(b);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.round((end - start) / 1000);
}

/** The nearest-rank percentile of `values` (not reordered), or null for an empty list. */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.ceil((p / 100) * sorted.length) - 1];
}

/** `name` with every maximal run of digits replaced by `*`; a non-string name stays null. */
export function jobKey(name) {
  return typeof name === "string" ? name.replace(/\d+/g, "*") : null;
}

/** Runner bookkeeping steps: everything a job spends before and after its own work. */
function isSetupStep(name) {
  if (typeof name !== "string") return false;
  return name === "Set up job" || name === "Complete job" || name.startsWith("Run actions/") || name.startsWith("Post Run actions/");
}

/** Execution seconds of a job or step with both timestamps, else null (such a record does not count). */
const execution = (record) => seconds(record.startedAt, record.completedAt);
const runnerMinutesOf = (executionSeconds) => Math.max(1, Math.ceil(executionSeconds / 60));

function setupSeconds(job) {
  return sum(job.steps.filter((step) => isSetupStep(step.name)).map(execution).filter((value) => value !== null));
}

/** The chain of jobs, oldest first, that ends with the job that completed last (see the contract). */
function criticalPath(jobs) {
  if (!jobs.length) return { jobs: [], seconds: 0 };
  const completed = (job) => Date.parse(job.completedAt);
  // A strict `>` keeps the earlier API position on ties, for the first job and each later one.
  const latest = (candidates) => candidates.reduce((best, job) => (completed(job) > completed(best) ? job : best));
  const chosen = [latest(jobs)];
  for (;;) {
    const deadline = Date.parse(chosen[0].createdAt) + CRITICAL_PATH_TOLERANCE_MS;   // NaN (no createdAt) ends the walk
    const candidates = jobs.filter((job) => !chosen.includes(job) && completed(job) <= deadline);
    if (!candidates.length) break;
    chosen.unshift(latest(candidates));
  }
  return { jobs: chosen.map((job) => job.name), seconds: sum(chosen.map(execution)) };
}

function efficiency(jobs) {
  if (!jobs.length) return null;
  const span = Math.round((Math.max(...jobs.map((job) => Date.parse(job.completedAt))) - Math.min(...jobs.map((job) => Date.parse(job.startedAt)))) / 1000);
  return round2(sum(jobs.map(execution)) / (jobs.length * Math.max(1, span)));
}

/** The facts of one attempt; only jobs with both startedAt and completedAt count. */
export function attemptFacts(attempt) {
  const jobs = attempt.jobs.filter((job) => execution(job) !== null);
  const minutes = jobs.map((job) => runnerMinutesOf(execution(job)));
  return {
    wall: seconds(attempt.startedAt, attempt.updatedAt),
    queue: maxOrNull(notNull(jobs.map((job) => seconds(job.createdAt, job.startedAt)))),
    setup: maxOrNull(jobs.map(setupSeconds)),
    criticalPath: criticalPath(jobs),
    efficiency: efficiency(jobs),
    runnerMinutes: sum(minutes),
    jobs: jobs.map((job, i) => ({ key: jobKey(job.name), label: job.labels?.[0] ?? null, minutes: minutes[i] })),
  };
}

// ---------- per workflow ----------

const isTiming = (attempt) => attempt.conclusion === "success" || attempt.conclusion === "failure";

/** p50 and p90 of the measured values; null facts are not measurements and are left out. */
function spread(values) {
  const measured = notNull(values);
  return { p50: percentile(measured, 50), p90: percentile(measured, 90) };
}

function stepFigures(timing) {
  const groups = new Map();
  for (const attempt of timing) {
    for (const job of attempt.jobs) {
      for (const step of job.steps) {
        const duration = execution(step);
        if (duration === null) continue;
        const group = JSON.stringify([jobKey(job.name), step.name]);
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push(duration);
      }
    }
  }
  const steps = [...groups].map(([group, durations]) => {
    const [job, step] = JSON.parse(group);
    return { job, step, samples: durations.length, seconds: spread(durations) };
  });
  return steps.sort((a, b) => b.seconds.p50 - a.seconds.p50 || byText(a.job, b.job) || byText(a.step, b.step));
}

/** Cost over the timing attempts' counted jobs, or null with the labels that have no rate. */
function costOf(timingFacts, successes, rates) {
  const minutesByLabel = new Map();
  for (const facts of timingFacts) {
    for (const job of facts.jobs) minutesByLabel.set(job.label, (minutesByLabel.get(job.label) ?? 0) + job.minutes);
  }
  const hasRate = (label) => label !== null && Object.hasOwn(rates, label) && typeof rates[label] === "number";
  const missing = [...minutesByLabel.keys()].filter((label) => !hasRate(label)).map((label) => `RATE_MISSING:${label ?? UNLABELED}`);
  if (missing.length) return { costUsd: null, missing };
  // Whole minutes per label times its rate once, so float accumulation cannot move the rounding.
  const total = sum([...minutesByLabel].map(([label, minutes]) => minutes * rates[label]));
  return { costUsd: { total: round4(total), perSuccessfulRun: successes ? round4(total / successes) : null }, missing };
}

function reliabilityOf(attempts) {
  const count = (conclusion) => attempts.filter((attempt) => attempt.conclusion === conclusion).length;
  const byRun = new Map();
  for (const attempt of attempts) byRun.set(attempt.runId, [...(byRun.get(attempt.runId) ?? []), attempt]);
  const flaky = (list) => list.some((failed) => failed.conclusion === "failure" && list.some((ok) => ok.conclusion === "success" && ok.attempt > failed.attempt));
  const flakyRunIds = [...byRun].filter(([, list]) => flaky(list)).map(([runId]) => runId).sort((x, y) => x - y);
  const success = count("success");
  const failure = count("failure");
  const cancelled = count("cancelled");
  return {
    attempts: attempts.length, success, failure, cancelled, other: attempts.length - success - failure - cancelled,
    rerunAttempts: attempts.filter((attempt) => attempt.attempt > 1).length,
    flakyRuns: flakyRunIds.length,
    flakeRate: byRun.size ? round2(flakyRunIds.length / byRun.size) : null,
    flakyRunIds,
  };
}

/** One workflow's figures over `attempts` (already windowed); also returns its RATE_MISSING codes. */
function workflowFigures(workflow, attempts, rates) {
  const timing = attempts.filter(isTiming);   // newest first, as `attempts` is
  const facts = timing.map(attemptFacts);
  const pick = (fact) => facts.map(fact);
  const walls = notNull(pick((f) => f.wall));
  const { costUsd, missing } = costOf(facts, timing.filter((attempt) => attempt.conclusion === "success").length, rates);
  const figures = {
    workflow,
    runs: timing.length,
    wallSeconds: { ...spread(walls), max: maxOrNull(walls) },
    queueSeconds: spread(pick((f) => f.queue)),
    setupSeconds: spread(pick((f) => f.setup)),
    criticalPathSeconds: spread(pick((f) => f.criticalPath.seconds)),
    criticalPathJobs: facts.length ? facts[0].criticalPath.jobs : [],
    parallelEfficiency: { p50: percentile(notNull(pick((f) => f.efficiency)), 50) },
    runnerMinutes: { total: sum(pick((f) => f.runnerMinutes)), p50: percentile(pick((f) => f.runnerMinutes), 50) },
    costUsd,
    steps: stepFigures(timing),
    reliability: reliabilityOf(attempts),
  };
  return { figures, missing };
}

/** The workflow metrics document; `window` keeps each workflow's N most recent attempts. `gate` stays null. */
export function computeMetrics(attempts, { rates = {}, window = null } = {}) {
  const byWorkflow = new Map();
  for (const attempt of [...attempts].sort(newestFirst)) {
    if (!byWorkflow.has(attempt.workflow)) byWorkflow.set(attempt.workflow, []);
    byWorkflow.get(attempt.workflow).push(attempt);
  }
  const unknowns = new Set(PERMANENT_UNKNOWNS);
  const workflows = [];
  for (const workflow of [...byWorkflow.keys()].sort(byText)) {
    const all = byWorkflow.get(workflow);
    const { figures, missing } = workflowFigures(workflow, window === null ? all : all.slice(0, window), rates ?? {});
    for (const code of missing) unknowns.add(code);
    workflows.push(figures);
  }
  return { schemaVersion: 1, workflows, gate: null, unknowns: [...unknowns].sort() };
}

/** The metrics stand-in when there is no stored history (spec/contracts/ci-optimizer-co-06.md). */
export function noHistoryMetrics() {
  return { workflows: [], gate: null, unknowns: [...PERMANENT_UNKNOWNS, "NO_HISTORY"].sort() };
}

// ---------- the local gate ----------

const stepsOf = (record) => (Array.isArray(record.steps) ? record.steps.filter(isPlainObject) : []);

/** Full-phase gate metrics from gate-timings.jsonl records (readTimings), or null when there are none. */
export function gateMetrics(timingRecords) {
  const records = timingRecords.filter((record) => isPlainObject(record) && record.type === "gate" && record.phase === "full");
  if (!records.length) return null;
  const walls = records.filter((record) => record.ok === true && Number.isFinite(record.wallSeconds)).map((record) => record.wallSeconds);
  const steps = records.flatMap(stepsOf);
  const durations = new Map();
  for (const step of steps) {
    if (step.cached === true || !Number.isFinite(step.seconds)) continue;
    if (!durations.has(step.name)) durations.set(step.name, []);
    durations.get(step.name).push(step.seconds);
  }
  const stepFigures = [...durations].map(([name, values]) => ({ name, samples: values.length, seconds: spread(values) }));
  return {
    runs: records.length,
    wallSeconds: spread(walls),
    cacheHitRate: steps.length ? round2(steps.filter((step) => step.cached === true).length / steps.length) : null,
    steps: stepFigures.sort((a, b) => b.seconds.p50 - a.seconds.p50 || byText(a.name, b.name)),
  };
}
