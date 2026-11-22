// CI baseline, regression and compare (spec/contracts/ci-optimizer-co-08.md). A baseline records
// each workflow's wall, critical path and step medians, the local gate's medians, and the identity
// of every CI check, CI test step and gate step, so a later change can be checked two ways: did CI
// get slower (detectRegression), and did anything that verifies the code disappear
// (compareBaselines). Pure functions: the caller reads history, the profile and gate timings.

import { isPlainObject } from "./history.mjs";
import { computeMetrics, gateMetrics } from "./metrics.mjs";
import { STATE_SCHEMA_VERSION } from "./state.mjs";

export const INSUFFICIENT_DATA = "insufficient-data";
/** The fewest recent timing attempts a comparison needs (capped by policy.recentRuns). */
const MIN_RECENT_ATTEMPTS = 3;
/** How many slower steps a regressed workflow lists. */
const TOP_STEPS = 3;
/** A GitLab test job has no steps of its own; its script is its one test step. */
const GITLAB_SCRIPT_STEP = "script";

const list = (value) => (Array.isArray(value) ? value : []);
const isText = (value) => typeof value === "string" && value !== "";
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Rounds to 1 decimal; -0 becomes 0, so a tiny drop never prints as "-0". */
export function round1(x) {
  return Math.round(x * 10) / 10 || 0;
}

/**
 * A step's identity: its name, else its `uses`, else the first non-blank line of its `run`; never
 * its position, so inserting a step does not read as removing the ones after it. Null without any.
 */
export function stepIdentity(step) {
  if (isText(step?.name)) return step.name;
  if (isText(step?.uses)) return step.uses;
  if (!isText(step?.run)) return null;
  return step.run.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? null;
}

// ---------- identities from the CO-01 profile ----------

/** `<file>#<job id>` for every GitHub workflow job and every parsed GitLab job, sorted. */
function checksOf(profile) {
  const github = list(profile?.ci?.workflows).flatMap((workflow) => list(workflow.jobs).map((job) => `${workflow.file}#${job.id}`));
  const gitlab = list(profile?.ci?.pipelines).flatMap((pipeline) => list(pipeline.jobs).map((job) => `${pipeline.file}#${job.id}`));
  return [...github, ...gitlab].sort(byText);
}

/** `<file>#<job id>#<step identity>` for GitHub steps of kind test and GitLab jobs with test: true, sorted. */
function testStepsOf(profile) {
  const github = list(profile?.ci?.workflows).flatMap((workflow) => list(workflow.jobs).flatMap((job) => list(job.steps)
    .filter((step) => step.kind === "test")
    .map(stepIdentity)
    .filter((identity) => identity !== null)
    .map((identity) => `${workflow.file}#${job.id}#${identity}`)));
  const gitlab = list(profile?.ci?.pipelines).flatMap((pipeline) => list(pipeline.jobs)
    .filter((job) => job.test === true)
    .map((job) => `${pipeline.file}#${job.id}#${GITLAB_SCRIPT_STEP}`));
  return [...github, ...gitlab].sort(byText);
}

/** Gate entry names in config order. */
function gateStepsOf(profile) {
  return list(profile?.gate?.steps).map((step) => step.name);
}

// ---------- capture ----------

function workflowBaseline(figures) {
  return {
    workflow: figures.workflow,
    runs: figures.runs,
    wallP50: figures.wallSeconds.p50,
    criticalPathP50: figures.criticalPathSeconds.p50,
    steps: figures.steps.map((step) => ({ job: step.job, step: step.step, p50: step.seconds.p50 })),
  };
}

function gateBaseline(timings) {
  const gate = gateMetrics(timings);
  if (gate === null) return null;
  return { wallP50: gate.wallSeconds.p50, steps: gate.steps.map((step) => ({ name: step.name, p50: step.seconds.p50 })) };
}

/** The baseline document: CO-04 figures over each workflow's newest `policy.baselineRuns` attempts, plus identities. */
export function captureBaseline({ attempts, profile, timings, policy, head, at }) {
  const metrics = computeMetrics(attempts, { window: policy.baselineRuns });
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    capturedAt: at,
    head,
    workflows: metrics.workflows.map(workflowBaseline),
    gate: gateBaseline(timings),
    checks: checksOf(profile),
    testSteps: testStepsOf(profile),
    gateSteps: gateStepsOf(profile),
  };
}

// ---------- regression ----------

const usableWall = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;
const percentChange = (from, to) => round1(((to - from) / from) * 100);
const stepKey = (job, step) => JSON.stringify([job, step]);

function insufficient(workflow) {
  return { workflow, status: INSUFFICIENT_DATA, baselineP50: null, recentP50: null, deltaPercent: null, overTarget: null, topSteps: [] };
}

/** Up to TOP_STEPS steps present on both sides that got slower, slowest-growing first (ties: job, then step). */
function topSteps(baselineSteps, recentSteps) {
  const recent = new Map(list(recentSteps).map((step) => [stepKey(step.job, step.step), step.seconds.p50]));
  return list(baselineSteps)
    .filter((step) => recent.has(stepKey(step.job, step.step)) && typeof step.p50 === "number")
    .map((step) => {
      const recentP50 = recent.get(stepKey(step.job, step.step));
      return { job: step.job, step: step.step, baselineP50: step.p50, recentP50, deltaSeconds: recentP50 - step.p50 };
    })
    .filter((step) => step.deltaSeconds > 0)
    .sort((a, b) => b.deltaSeconds - a.deltaSeconds || byText(String(a.job), String(b.job)) || byText(String(a.step), String(b.step)))
    .slice(0, TOP_STEPS);
}

function workflowRegression(base, recent, policy) {
  const enough = Math.min(MIN_RECENT_ATTEMPTS, policy.recentRuns);
  // A comparison needs a usable baseline wall, enough recent timing attempts, and a recent wall.
  if (!usableWall(base.wallP50) || !recent || recent.runs < enough || recent.wallSeconds.p50 === null) return insufficient(base.workflow);
  const baselineP50 = base.wallP50;
  const recentP50 = recent.wallSeconds.p50;
  const deltaPercent = percentChange(baselineP50, recentP50);
  return {
    workflow: base.workflow,
    status: deltaPercent > policy.regressionPercent ? "regressed" : "ok",
    baselineP50,
    recentP50,
    deltaPercent,
    overTarget: recentP50 > policy.targets.fullSeconds,
    topSteps: topSteps(base.steps, recent.steps),
  };
}

/** Each baseline workflow against its newest `policy.recentRuns` attempts. */
export function detectRegression({ baseline, attempts, policy }) {
  const recent = new Map(computeMetrics(attempts, { window: policy.recentRuns }).workflows.map((figures) => [figures.workflow, figures]));
  const workflows = list(baseline?.workflows).map((base) => workflowRegression(base, recent.get(base.workflow), policy));
  return { workflows, regressed: workflows.some((w) => w.status === "regressed" || w.overTarget === true) };
}

// ---------- compare ----------

/** Items of `from` missing in `to`, counted: two equal identities with one dropped report one removal. */
function missingFrom(from, to) {
  const remaining = new Map();
  for (const item of to) remaining.set(item, (remaining.get(item) ?? 0) + 1);
  const missing = [];
  for (const item of from) {
    const left = remaining.get(item) ?? 0;
    if (left > 0) remaining.set(item, left - 1);
    else missing.push(item);
  }
  return missing;
}

function workflowDelta(workflow, before, after) {
  const comparable = typeof before === "number" && typeof after === "number";
  return {
    workflow,
    before,
    after,
    deltaSeconds: comparable ? after - before : null,
    deltaPercent: comparable && before > 0 ? percentChange(before, after) : null,
  };
}

const IDENTITY_LISTS = ["checks", "testSteps", "gateSteps"];

/** Wall deltas per workflow and the checks, test steps and gate steps removed or added from `before` to `after`. */
export function compareBaselines(before, after) {
  const walls = (doc) => new Map(list(doc?.workflows).map((w) => [w.workflow, w.wallP50 ?? null]));
  const beforeWalls = walls(before);
  const afterWalls = walls(after);
  const names = [...new Set([...beforeWalls.keys(), ...afterWalls.keys()])].sort(byText);
  const workflows = names.map((name) => workflowDelta(name, beforeWalls.get(name) ?? null, afterWalls.get(name) ?? null));
  const removed = {};
  const added = {};
  for (const key of IDENTITY_LISTS) {
    removed[key] = missingFrom(list(before?.[key]), list(after?.[key]));
    added[key] = missingFrom(list(after?.[key]), list(before?.[key]));
  }
  return { workflows, removed, added, preserved: IDENTITY_LISTS.every((key) => removed[key].length === 0) };
}

// ---------- document shape ----------

const isTextList = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");

/** True when `doc` has the baseline document's shape (schema version, workflow list, identity lists). */
export function isBaselineDocument(doc) {
  return isPlainObject(doc)
    && doc.schemaVersion === STATE_SCHEMA_VERSION
    && Array.isArray(doc.workflows)
    && doc.workflows.every((w) => isPlainObject(w) && typeof w.workflow === "string" && Array.isArray(w.steps))
    && IDENTITY_LISTS.every((key) => isTextList(doc[key]));
}
