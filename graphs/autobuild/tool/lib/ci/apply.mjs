// Shard-weight planner and its apply step (spec/contracts/ci-optimizer-co-05.md, decision 4A).
// The planner simulates the gate's shard placement with the real `shardPlan`, once with the
// current `shardWeight` values and once with weights recalibrated from measured step durations.
// `applyShardWeights` is the only ci-optimizer code that writes autobuild.json.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CONFIG_FILE } from "../config.mjs";
import { shardPlan } from "../gate.mjs";
import { SAFE_GIT } from "../proc.mjs";
import { gateMetrics } from "./metrics.mjs";
import { CiError } from "./state.mjs";

/** Gate steps that are bookkeeping, not work a shard carries (never simulated). */
const NOT_SIMULATED = new Set(["frozen files unchanged", "run evidence kept out of git", "CI parity configuration"]);
const CURRENT_FEATURE_PREFIX = "current feature";

/**
 * `{ [stepName]: p50 seconds }` over the uncached steps of full-phase gate records. The local
 * gate metrics (CO-04) already compute exactly these p50 figures, so they are reused here.
 */
export function measuredSeconds(timingRecords) {
  const figures = gateMetrics(timingRecords);
  if (!figures) return {};
  return Object.fromEntries(figures.steps.filter((step) => typeof step.name === "string").map((step) => [step.name, step.seconds.p50]));
}

const runsShardedTests = (step) => step?.kind === "test" && typeof step.run === "string" && step.run.includes("--shard");

/** The `matrixSize` of the first GitHub job with a `--shard` test step and a matrix, else null. */
export function shardCountFromProfile(profile) {
  const workflows = Array.isArray(profile?.ci?.workflows) ? profile.ci.workflows : [];
  for (const workflow of workflows) {
    for (const job of Array.isArray(workflow?.jobs) ? workflow.jobs : []) {
      const steps = Array.isArray(job?.steps) ? job.steps : [];
      if (Number.isInteger(job?.matrixSize) && job.matrixSize >= 1 && steps.some(runsShardedTests)) return job.matrixSize;
    }
  }
  return null;
}

const isMeasured = (measured, name) => Object.hasOwn(measured, name);

/**
 * The recalibrated weight of one gate entry: a measured, non-shardable entry gets its measured
 * seconds (at least 1); every other entry keeps its weight. Rounded because autobuild.json only
 * accepts a whole-number shardWeight (the gate itself records whole seconds, so this is a no-op
 * on its own timings).
 */
function recalibrated(entry, measured) {
  if (entry.shardable === true || !isMeasured(measured, entry.name)) return entry.shardWeight;
  return Math.max(1, Math.round(measured[entry.name]));
}

/** Measured step names that are not gate entries and are real work, sorted by name. */
function extraStepNames(gateEntries, measured) {
  const entryNames = new Set(gateEntries.map((entry) => entry.name));
  return Object.keys(measured)
    .filter((name) => !entryNames.has(name) && !NOT_SIMULATED.has(name) && !name.startsWith(CURRENT_FEATURE_PREFIX))
    .sort();
}

/** One simulated placement: `{ maxShardSeconds, shards: [[non-shardable ids in placement order]] }`. */
function simulate(jobs, measured, shardCount) {
  const placement = shardPlan(jobs, shardCount);
  const secondsOf = (job) => (isMeasured(measured, job.id) ? measured[job.id] : job.shardWeight ?? 1);
  // A shardable step runs a part of itself in every shard; an unmeasured one adds nothing.
  const everyShard = jobs.filter((job) => job.shardable).reduce((total, job) => total + (isMeasured(measured, job.id) ? measured[job.id] : 0), 0);
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const shards = Array.from({ length: shardCount }, () => []);
  const loads = new Array(shardCount).fill(everyShard);
  // shardPlan's map holds the shardable jobs (shard 0) first, then the rest in placement order.
  for (const [id, shard] of placement) {
    if (shard === 0) continue;
    shards[shard - 1].push(id);
    loads[shard - 1] += secondsOf(byId.get(id));
  }
  return { maxShardSeconds: Math.max(...loads), shards };
}

/** The before/after shard plan for `gateEntries` (autobuild.json `gate`, config order). */
export function planShardWeights(gateEntries, measured, shardCount) {
  if (!Number.isInteger(shardCount) || shardCount < 1) throw new TypeError(`shardCount must be a whole number of at least 1, got ${shardCount}`);
  const entries = Array.isArray(gateEntries) ? gateEntries : [];
  const extras = extraStepNames(entries, measured).map((id) => ({ id, shardWeight: 1 }));
  const jobsWith = (weightOf) => [
    ...entries.map((entry) => ({ id: entry.name, shardable: entry.shardable === true, shardWeight: weightOf(entry) })),
    ...extras,
  ];
  const before = simulate(jobsWith((entry) => entry.shardWeight), measured, shardCount);
  const after = simulate(jobsWith((entry) => recalibrated(entry, measured)), measured, shardCount);
  const changes = entries
    .filter((entry) => recalibrated(entry, measured) !== entry.shardWeight)
    .map((entry) => ({ step: entry.name, from: entry.shardWeight ?? null, to: recalibrated(entry, measured) }));
  return {
    shardCount,
    before,
    after,
    changes,
    improves: after.maxShardSeconds < before.maxShardSeconds,
    unmeasured: entries.filter((entry) => !isMeasured(measured, entry.name)).map((entry) => entry.name),
  };
}

/**
 * True when autobuild.json is tracked and both the working tree and the index match HEAD, so the
 * printed `git checkout -- autobuild.json` restores the pre-apply bytes. (A staged edit reverted in
 * the working tree passes `git diff --quiet HEAD`, but the checkout would restore the staged copy.)
 * Anything git cannot confirm (no HEAD, a git error) counts as not clean.
 */
export function configIsCommitted(root, env = process.env) {
  const run = (args) => spawnSync("git", [...SAFE_GIT, ...args], { cwd: root, env, encoding: "utf8" });
  if (run(["ls-files", "--error-unmatch", "--", CONFIG_FILE]).status !== 0) return false;
  if (run(["diff", "--quiet", "HEAD", "--", CONFIG_FILE]).status !== 0) return false;
  return run(["diff", "--cached", "--quiet", "HEAD", "--", CONFIG_FILE]).status === 0;
}

/** Sets each change's shardWeight in the parsed document; refuses a plan the document no longer matches. */
function withNewWeights(doc, changes) {
  const gate = Array.isArray(doc?.gate) ? doc.gate : [];
  for (const change of changes) {
    const entry = gate.find((candidate) => candidate?.name === change.step);
    if (!entry) throw new CiError("PLAN_STALE", `${CONFIG_FILE} has no gate entry named ${JSON.stringify(change.step)}`);
    if ((entry.shardWeight ?? null) !== change.from) throw new CiError("PLAN_STALE", `${CONFIG_FILE}: ${change.step} has shardWeight ${entry.shardWeight ?? "unset"}, the plan expected ${change.from ?? "unset"}`);
    if (entry.shardable === true) throw new CiError("PLAN_STALE", `${CONFIG_FILE}: ${change.step} is shardable and takes no shardWeight`);
    // Assigning an existing key keeps its position; a new key is appended after the others.
    entry.shardWeight = change.to;
  }
  return doc;
}

/**
 * Rewrites `<root>/autobuild.json` with the plan's new shardWeight values, as
 * `JSON.stringify(doc, null, 2) + "\n"`, through a temporary file and a rename. Key order is kept.
 * Callers apply only an improving plan; anything else is refused.
 */
export function applyShardWeights(root, plan) {
  if (plan?.improves !== true) throw new CiError("NO_IMPROVEMENT", "the plan does not make the slowest shard faster; nothing written", 1);
  const file = path.join(root, CONFIG_FILE);
  let stat;
  let text;
  try {
    stat = lstatSync(file);
    if (!stat.isFile()) throw new CiError("CONFIG_UNSAFE", `${CONFIG_FILE} is not a regular file; refusing to rewrite it`);
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof CiError) throw error;
    throw new CiError("CONFIG_IO", `cannot read ${CONFIG_FILE}: ${error.code ?? error.message}`);
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new CiError("CONFIG_IO", `${CONFIG_FILE} is not valid JSON`);
  }
  const next = `${JSON.stringify(withNewWeights(doc, plan.changes), null, 2)}\n`;
  const draft = path.join(root, `.${CONFIG_FILE}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    // "wx": the draft is always a new file. It keeps the original's permission bits.
    writeFileSync(draft, next, { mode: stat.mode & 0o777, flag: "wx" });
    renameSync(draft, file);
  } catch (error) {
    rmSync(draft, { force: true });
    throw new CiError("CONFIG_IO", `cannot write ${CONFIG_FILE}: ${error.code ?? error.message}`);
  }
}
