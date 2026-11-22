// CI analysis rules (spec/contracts/ci-optimizer-co-06.md): findings over the CO-01 profile, the
// CO-04 metrics, the CO-05 shard plan and autobuild.json. Pure: no I/O, and the inputs are never
// mutated. A rule that lacks the data it needs does not fire; nothing is guessed. Only
// `gate-shard-weights` is an `apply` finding (decision 4A); everything else is a proposal.

import { describeChange } from "./apply.mjs";
import { jobKey } from "./metrics.mjs";
import { INSTALL_COMMAND } from "./patterns.mjs";

const CONFIG_TARGET = "autobuild.json";
const PULL_REQUEST = "pull_request";
const PUSH = "push";
const PYTEST_XDIST = "pytest-xdist";

const list = (value) => (Array.isArray(value) ? value : []);
const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
/** One line of text: control characters (newlines included) become spaces, so a human line stays one line. */
const oneLine = (text) => String(text).replace(/[\x00-\x1f\x7f]+/g, " ").trim();
const firstLine = (text) => oneLine(String(text).split("\n").find((line) => line.trim() !== "") ?? "");

function finding({ rule, risk, action = "propose", target, job = null, summary, evidence = [], estimatedSavingSeconds = null }) {
  return { rule, risk, action, target, job, summary, evidence, estimatedSavingSeconds };
}

// ---------- serial test runners ----------

/**
 * Flags that make a test runner serial, checked one command line at a time. Digits are anchored
 * (`=1` never matches `=10`), and jest's `-i` counts only on a line that runs jest.
 */
const SERIAL_FLAGS = [
  ["--runInBand", (line) => /(^|\s)--runInBand(?=\s|$)/.test(line)],
  ["jest -i", (line) => /\bjest\b.*\s-i(?=\s|$)/.test(line)],
  ["--test-concurrency=1", (line) => /(^|\s)--test-concurrency(=|\s+)1(?=\s|$)/.test(line)],
  ["go test -p 1", (line) => /\bgo test\b.*\s-p(=|\s+)1(?=\s|$)/.test(line)],
];
const PYTEST = /\bpytest\b/;
const PYTEST_WORKERS = /(^|\s)(-n|--numprocesses)/;

/** The serial flags `command` uses, one entry per flag; `xdist` says whether pytest-xdist is declared. */
function serialFlags(command, xdist) {
  const found = new Set();
  for (const line of String(command).split("\n")) {
    for (const [flag, matches] of SERIAL_FLAGS) if (matches(line)) found.add(flag);
    if (xdist && PYTEST.test(line) && !PYTEST_WORKERS.test(line)) found.add("pytest without -n");
  }
  return [...found];
}

const SERIAL_ADVICE = "let the test runner use its parallel workers, or shard the tests";

function serialStepFindings(model, xdist) {
  const findings = [];
  for (const job of list(model.jobs)) {
    for (const step of list(job.steps)) {
      if (step?.kind !== "test" || typeof step.run !== "string") continue;
      const flags = serialFlags(step.run, xdist);
      if (!flags.length) continue;
      findings.push(finding({
        rule: "serial-test-runner", risk: "low", target: model.file, job: job.id,
        summary: `job ${job.id} runs its tests serially (${flags.join(", ")}); ${SERIAL_ADVICE}`,
        evidence: [`step ${step.index}: ${firstLine(step.run)}`],
      }));
    }
  }
  return findings;
}

/**
 * The manifest a framework command came from: its first evidence file in discovery's scan order
 * (the root before child directories, then by path), which is where discovery took the command.
 */
function manifestOf(framework) {
  const depth = (file) => file.split("/").length;
  const files = list(framework.evidence).filter((file) => typeof file === "string");
  return [...files].sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0))[0] ?? null;
}

/** One finding per (manifest, command): two frameworks reading one `scripts.test` give one finding. */
function serialFrameworkFindings(frameworks, xdist) {
  const seen = new Set();
  const findings = [];
  for (const framework of frameworks) {
    if (typeof framework?.command !== "string") continue;
    const target = manifestOf(framework);
    if (target === null) continue;
    const key = JSON.stringify([target, framework.command]);
    const flags = serialFlags(framework.command, xdist);
    if (!flags.length || seen.has(key)) continue;
    seen.add(key);
    findings.push(finding({
      rule: "serial-test-runner", risk: "low", target, job: null,
      summary: `the ${framework.name} test command in ${target} runs tests serially (${flags.join(", ")}); ${SERIAL_ADVICE}`,
      evidence: [`${target}: ${firstLine(framework.command)}`],
    }));
  }
  return findings;
}

// ---------- GitHub workflow rules (the profile alone) ----------

const hasKind = (job, kind) => list(job.steps).some((step) => step?.kind === kind);
const isAggregator = (job) => list(job.steps).every((step) => step?.kind === "other");

function needsWithoutArtifacts(model) {
  const jobs = list(model.jobs);
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const findings = [];
  for (const job of jobs) {
    if (isAggregator(job) || hasKind(job, "artifact-download")) continue;
    for (const need of new Set(list(job.needs))) {
      const needed = byId.get(need);
      if (!needed || hasKind(needed, "artifact-upload")) continue;   // an unknown job is not guessed at
      findings.push(finding({
        rule: "needs-without-artifacts", risk: "high", target: model.file, job: job.id,
        summary: `job ${job.id} waits for ${need} but no artifact passes between them; if it uses nothing ${need} produces, drop the need so both run in parallel`,
        evidence: [`${job.id} needs: ${need}`, `${job.id} downloads no artifact`, `${need} uploads no artifact`],
      }));
    }
  }
  return findings;
}

function missingWorkflowCache(model) {
  return list(model.jobs)
    .filter((job) => hasKind(job, "install") && !list(job.steps).some((step) => step?.cache === true))
    .map((job) => finding({
      rule: "missing-dependency-cache", risk: "low", target: model.file, job: job.id,
      summary: `job ${job.id} installs dependencies without a cache; enable the setup action's cache or add actions/cache keyed on the lockfile`,
      evidence: list(job.steps).filter((step) => step?.kind === "install").map((step) => `step ${step.index}: ${firstLine(step.run)}`),
    }));
}

const triggersOn = (model, event) => list(model.triggers).filter((trigger) => trigger?.event === event);

function missingPrConcurrency(model) {
  if (!triggersOn(model, PULL_REQUEST).length) return [];
  const { concurrency } = model;
  if (concurrency !== null && concurrency?.cancelInProgress !== false) return [];
  return [finding({
    rule: "missing-pr-concurrency", risk: "low", target: model.file,
    summary: "add a concurrency group that cancels only superseded pull_request runs (cancel-in-progress: ${{ github.event_name == 'pull_request' }}), so runs on the default branch are never cancelled",
    evidence: [concurrency === null ? "concurrency: none" : "cancel-in-progress: false", "triggers: pull_request"],
  })];
}

function duplicatePushAndPr(model) {
  if (!triggersOn(model, PULL_REQUEST).length) return [];
  if (!triggersOn(model, PUSH).some((trigger) => trigger.branches === null)) return [];
  return [finding({
    rule: "duplicate-push-and-pr", risk: "low", target: model.file,
    summary: "push has no branch filter, so every pull request commit runs this workflow twice; limit push to the default branch",
    evidence: ["triggers: push (no branches), pull_request"],
  })];
}

// ---------- GitHub workflow rules (metrics) ----------

/**
 * The single job model a metrics step's job key names: the model whose `name ?? id`, keyed the
 * way CO-04 keys job names (digit runs become `*`), equals it. No match, or more than one, is null.
 */
function jobOfStep(model, key) {
  const matches = list(model.jobs).filter((job) => jobKey(job.name ?? job.id) === key);
  return matches.length === 1 ? matches[0] : null;
}

function longSingleJob(model, figures, policy) {
  const target = policy.targets.fullSeconds;
  const criticalPath = figures.criticalPathSeconds?.p50;
  if (!isNumber(criticalPath) || criticalPath <= target) return [];
  const slowest = list(figures.steps)[0];
  const stepSeconds = slowest?.seconds?.p50;
  if (!isNumber(stepSeconds)) return [];
  const job = jobOfStep(model, slowest.job);
  if (job === null || !(job.matrixSize === null || job.matrixSize === 1)) return [];
  const shards = Math.ceil(stepSeconds / target);
  if (shards < 2) return [];
  const saving = stepSeconds - Math.ceil(stepSeconds / shards);
  return [finding({
    rule: "long-single-job", risk: "high", target: model.file, job: job.id,
    summary: `job ${job.id} is one unsharded job whose slowest step takes ${stepSeconds}s at p50 (critical path p50 ${criticalPath}s, target ${target}s); split it into ${shards} shards (estimate: ${saving}s faster, from recorded durations)`,
    evidence: [`critical path p50: ${criticalPath}s`, `slowest step: ${oneLine(slowest.step)} (${stepSeconds}s p50, ${slowest.samples} samples)`],
    estimatedSavingSeconds: saving,
  })];
}

const QUEUE_SHARE = 0.25;
const QUEUE_MIN_WALL_SECONDS = 60;

function queueDominant(model, figures) {
  const queue = figures.queueSeconds?.p50;
  const wall = figures.wallSeconds?.p50;
  if (!isNumber(queue) || !isNumber(wall) || wall < QUEUE_MIN_WALL_SECONDS || queue < QUEUE_SHARE * wall) return [];
  return [finding({
    rule: "queue-dominant", risk: "high", target: model.file,
    summary: `jobs wait ${queue}s at p50 for a runner, ${Math.round((queue / wall) * 100)}% of the ${wall}s wall time; check runner capacity and concurrency limits`,
    evidence: [`queue p50: ${queue}s`, `wall p50: ${wall}s`],
  })];
}

function flakyReruns(model, figures) {
  const reliability = figures.reliability;
  if (!isNumber(reliability?.flakyRuns) || reliability.flakyRuns <= 0) return [];
  return [finding({
    rule: "flaky-reruns", risk: "high", target: model.file,
    summary: `${reliability.flakyRuns} run(s) failed and then passed on a rerun; investigate the failing tests, and never skip or retry tests automatically`,
    evidence: list(reliability.flakyRunIds).map((id) => `run ${id}`),
  })];
}

function workflowFindings(model, metrics, policy) {
  const findings = [
    ...needsWithoutArtifacts(model),
    ...missingWorkflowCache(model),
    ...missingPrConcurrency(model),
    ...duplicatePushAndPr(model),
  ];
  // Metric rules use the CO-04 workflow named like the model; an unnamed model has none.
  const figures = model.name === null ? undefined : list(metrics?.workflows).find((w) => w?.workflow === model.name);
  if (figures) findings.push(...longSingleJob(model, figures, policy), ...queueDominant(model, figures), ...flakyReruns(model, figures));
  return findings;
}

// ---------- GitLab ----------

function gitlabFindings(pipeline) {
  if (!Array.isArray(pipeline?.jobs)) return [];   // an unparsed pipeline ({ file, error }) gives nothing
  return pipeline.jobs
    .filter((job) => job?.cache === false && list(job.script).some((line) => INSTALL_COMMAND.test(line)))
    .map((job) => finding({
      rule: "missing-dependency-cache", risk: "low", target: pipeline.file, job: job.id,
      summary: `job ${job.id} installs dependencies without a cache; add a cache keyed on the lockfile`,
      evidence: list(job.script).filter((line) => INSTALL_COMMAND.test(line)).map((line) => `script: ${firstLine(line)}`),
    }));
}

// ---------- the gate ----------

function gateFindings(gate, config) {
  const findings = [];
  const plan = gate?.plan;
  if (plan?.improves === true) {
    const { before, after } = plan;
    findings.push(finding({
      rule: "gate-shard-weights", risk: "low", action: "apply", target: CONFIG_TARGET,
      summary: `recalibrate shardWeight from measured gate durations: the slowest of ${plan.shardCount} shards goes from ${before.maxShardSeconds}s to ${after.maxShardSeconds}s (estimate); apply with autobuild ci apply`,
      evidence: [...list(plan.changes).map(describeChange), `slowest shard: ${before.maxShardSeconds}s -> ${after.maxShardSeconds}s`],
      // Whole seconds: an imported timings file may hold fractional p50s.
      estimatedSavingSeconds: Math.round(before.maxShardSeconds - after.maxShardSeconds),
    }));
  }
  if (!config) return findings;
  const entries = list(config.gate);
  const withResources = entries.filter((entry) => Array.isArray(entry?.resources) && entry.resources.length > 0);
  if (config.gateConcurrency === 1 && withResources.length >= 2) {
    findings.push(finding({
      rule: "gate-serial", risk: "low", target: CONFIG_TARGET,
      summary: `the gate runs one step at a time although ${withResources.length} steps declare the resources they use; raise gateConcurrency so steps without a shared resource run together`,
      evidence: ["gateConcurrency: 1", ...withResources.map((entry) => `${entry.name}: resources ${list(entry.resources).join(", ")}`)],
    }));
  }
  if (config.gateCache === false && entries.length >= 1) {
    findings.push(finding({
      rule: "gate-cache-off", risk: "low", target: CONFIG_TARGET,
      summary: "the gate cache is off, so unchanged steps rerun every time; set gateCache to true",
      evidence: ["gateCache: false", `gate entries: ${entries.length}`],
    }));
  }
  return findings;
}

// ---------- ordering ----------

/** Code-unit order: locale-independent, so the same findings sort the same everywhere. */
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byJob = (a, b) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a.localeCompare(b));

/** Saving descending (null last), then rule, then target, then job (null after any string). */
export function compareFindings(a, b) {
  const sa = a.estimatedSavingSeconds;
  const sb = b.estimatedSavingSeconds;
  if (sa !== sb) {
    if (sa === null) return 1;
    if (sb === null) return -1;
    return sb - sa;
  }
  return byCodeUnit(a.rule, b.rule) || byCodeUnit(a.target, b.target) || byJob(a.job, b.job);
}

/** The findings for one repository, sorted. `metrics` is CO-04's document; `gate` is `{ plan }` or null. */
export function analyze({ profile, metrics, gate = null, config = null, policy }) {
  const workflows = list(profile?.ci?.workflows);
  const xdist = list(profile?.testFrameworks).some((framework) => framework?.parallel === PYTEST_XDIST);
  const findings = [
    ...workflows.flatMap((model) => [...workflowFindings(model, metrics, policy), ...serialStepFindings(model, xdist)]),
    ...serialFrameworkFindings(list(profile?.testFrameworks), xdist),
    ...list(profile?.ci?.pipelines).flatMap(gitlabFindings),
    ...gateFindings(gate, config),
  ];
  return findings.sort(compareFindings);
}
