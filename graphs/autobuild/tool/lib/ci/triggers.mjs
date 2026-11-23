// ci-optimizer lifecycle triggers, the loop-start check and the status line
// (spec/contracts/ci-optimizer-co-09.md). Everything here is offline: it reads the stored
// profile, history and baseline and the repository's own files, and never calls gh. Only
// ciStartupCheck writes, and only the profile, through loadProfile's offline discovery.

import { detectRegression, isBaselineDocument } from "./baseline.mjs";
import { inputsDigest, loadProfile } from "./discover.mjs";
import { newestFirst, readHistory } from "./history.mjs";
import { byText } from "./metrics.mjs";
import { ciPolicy } from "./policy.mjs";
import { readState } from "./state.mjs";

const PREFIX = "ci-optimizer:";
const FAILURE_WINDOW = 5;
const FAILURE_THRESHOLD = 3;
const FAILED_CONCLUSIONS = new Set(["failure", "timed_out"]);
// Triggers that mean the stored profile no longer describes the repository.
const PROFILE_TRIGGERS = new Set(["onboarding", "ci-config-changed"]);
// An imported attempt or a baseline workflow may have no name (history.mjs allows it).
const UNNAMED = "(unnamed)";

/** A workflow name for human text: `(unnamed)` for a null or missing name. */
export const workflowLabel = (name) => (name === null || name === undefined ? UNNAMED : String(name));

/** True when the attempt concluded failure or timed_out, or holds a job that timed out. */
function failedOrTimedOut(attempt) {
  if (FAILED_CONCLUSIONS.has(attempt?.conclusion)) return true;
  return Array.isArray(attempt?.jobs) && attempt.jobs.some((job) => job?.conclusion === "timed_out");
}

/** The repeated-failures detail, or null: per workflow, at least 3 of its 5 newest attempts (by startedAt) failed or timed out. */
function repeatedFailures(attempts) {
  const byWorkflow = new Map();
  for (const attempt of Array.isArray(attempts) ? attempts : []) {
    const name = attempt?.workflow ?? null;
    if (!byWorkflow.has(name)) byWorkflow.set(name, []);
    byWorkflow.get(name).push(attempt);
  }
  const hits = [];
  for (const name of [...byWorkflow.keys()].sort(byText)) {
    const window = byWorkflow.get(name).sort(newestFirst).slice(0, FAILURE_WINDOW);
    const failed = window.filter(failedOrTimedOut).length;
    if (failed >= FAILURE_THRESHOLD) hits.push(`${workflowLabel(name)}: ${failed} of last ${window.length} attempts failed or timed out`);
  }
  return hits.length ? hits.join(", ") : null;
}

/** The regressed or over-target workflow names, in the regression's order, joined with ", ". */
function regressedWorkflows(regression) {
  const workflows = Array.isArray(regression?.workflows) ? regression.workflows : [];
  return workflows
    .filter((w) => w?.status === "regressed" || w?.overTarget === true)
    .map((w) => workflowLabel(w.workflow))
    .join(", ");
}

/** `{ fire, triggers: [{ id, detail }] }`, in the contract's fixed id order. Pure. */
export function evaluateTriggers({ storedProfile, currentDigest, regression, attempts, explicit = false }) {
  const triggers = [];
  if (storedProfile === null || storedProfile === undefined) {
    triggers.push({ id: "onboarding", detail: "no CI profile for this repository" });
  } else if (storedProfile.inputsDigest !== currentDigest) {
    triggers.push({ id: "ci-config-changed", detail: `CI, manifest or autobuild.json changed since ${storedProfile.generatedAt}` });
  }
  if (regression?.regressed === true) triggers.push({ id: "runtime-regression", detail: regressedWorkflows(regression) });
  const failures = repeatedFailures(attempts);
  if (failures !== null) triggers.push({ id: "repeated-failures", detail: failures });
  if (explicit === true) triggers.push({ id: "explicit", detail: "requested" });
  return { fire: triggers.length > 0, triggers };
}

/**
 * The stored profile, the current inputs digest and the evaluated triggers for `root`. Reads only:
 * the regression comes from a stored baseline when one exists. A linked state directory or file
 * throws STATE_UNSAFE.
 */
export async function currentTriggers(root, { policy, env = process.env, explicit = false }) {
  const storedProfile = readState(root, "profile", env);
  const attempts = readHistory(root, env)?.attempts ?? [];
  const baseline = readState(root, "baseline", env);
  const regression = isBaselineDocument(baseline) ? detectRegression({ baseline, attempts, policy }) : null;
  const { digest } = await inputsDigest(root);
  const result = evaluateTriggers({ storedProfile, currentDigest: digest, regression, attempts, explicit });
  return { ...result, storedProfile, currentDigest: digest };
}

/** An error as one line of text: log lines and `skipped` must never span lines. */
function oneLine(error) {
  const text = String(error?.message ?? error).replace(/\s+/g, " ").trim();
  return text || "unknown error";
}

const idList = (triggers) => (triggers.length ? triggers.map((t) => t.id).join(", ") : "none");

/**
 * The loop's start-of-run check: refreshes the profile when it is missing or stale and logs one
 * line. Offline; never throws; its result never decides the run's outcome.
 */
export async function ciStartupCheck(config, log, { env = process.env } = {}) {
  let outcome;
  try {
    const policy = ciPolicy(config);
    if (!policy.enabled) return { skipped: "disabled" };
    const evaluated = await currentTriggers(config.root, { policy, env });
    const refresh = evaluated.triggers.some((t) => PROFILE_TRIGGERS.has(t.id));
    if (refresh) await loadProfile(config.root, { env, refresh: true, config });
    const triggers = evaluated.triggers.map((t) => t.id);
    outcome = { result: { profile: refresh ? "written" : "reused", triggers }, line: `${PREFIX} profile ${refresh ? "written" : "reused"}; triggers: ${idList(evaluated.triggers)}` };
  } catch (error) {
    const message = oneLine(error);
    outcome = { result: { skipped: message }, line: `${PREFIX} skipped (${message})` };
  }
  log(outcome.line);
  return outcome.result;
}

const MINUTE = 60_000;

/** Whole minutes, hours or days, floored; each unit only while the count is under the next unit's size. */
export function formatAge(ms) {
  const minutes = Math.max(0, Math.floor(ms / MINUTE));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** The profile's age at `now`, or "missing"; a stored profile without a parsable generatedAt is an error. */
function profileAge(storedProfile, now) {
  if (!storedProfile) return "missing";
  const at = Date.parse(storedProfile.generatedAt);
  if (!Number.isFinite(at)) throw new Error("the stored profile has no valid generatedAt");
  return `${formatAge(now.getTime() - at)} old`;
}

/** One `autobuild status` line. Offline, writes nothing, never throws. */
export async function statusLine(config, now = new Date(), { env = process.env } = {}) {
  try {
    const policy = ciPolicy(config);
    if (!policy.enabled) return `${PREFIX} disabled`;
    const { storedProfile, triggers } = await currentTriggers(config.root, { policy, env });
    return `${PREFIX} profile ${profileAge(storedProfile, now)}, triggers: ${idList(triggers)}`;
  } catch (error) {
    return `${PREFIX} unavailable (${oneLine(error)})`;
  }
}
