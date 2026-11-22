// ci-optimizer CI history (spec/contracts/ci-optimizer-co-03.md): GitHub Actions attempts read
// through a `gh` port, normalized, merged into the per-machine history.json, and imports of the
// same normalized shape from any other provider. Only fetchGithubHistory calls out, and only
// through the given gh binary; a failed fetch throws before anything is merged or written.

import { spawnSync } from "node:child_process";
import { SAFE_GIT } from "../proc.mjs";
import { CiError, readState, STATE_SCHEMA_VERSION, writeState } from "./state.mjs";

export const HISTORY_CAP = 200;
const HISTORY = "history";
// gh responses are unprojected in real use: per_page=100 runs or a large jobs page can pass
// spawnSync's 1 MiB default buffer, so the limit is explicit. The timeout bounds a hung call.
const GH_MAX_BUFFER = 256 * 1024 * 1024;
const GH_TIMEOUT_MS = 5 * 60 * 1000;

// GitHub owner and repository names. The value is interpolated into gh api paths, so it is
// checked against the full `owner/name` shape and never passed through otherwise.
const OWNER = "[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?";
const NAME = "[A-Za-z0-9._-]+";
const REPO_SHAPE = new RegExp(`^${OWNER}/${NAME}$`);
const GITHUB_REMOTES = [
  new RegExp(`^https://github\\.com/(${OWNER})/(${NAME}?)(?:\\.git)?$`),
  new RegExp(`^git@github\\.com:(${OWNER})/(${NAME}?)(?:\\.git)?$`),
];

/** True for an `owner/name` GitHub repository string. */
export function isGithubRepo(value) {
  if (typeof value !== "string" || !REPO_SHAPE.test(value)) return false;
  const name = value.slice(value.indexOf("/") + 1);
  return name !== "." && name !== "..";
}

/** `"owner/name"` from the `origin` remote of `root` when it is a GitHub URL, else null. */
export function githubRepo(root, env = process.env) {
  const result = spawnSync("git", [...SAFE_GIT, "remote", "get-url", "origin"], { cwd: root, env, encoding: "utf8" });
  if (result.status !== 0) return null;
  const url = result.stdout.replace(/\r?\n$/, "");   // only git's line end: any other whitespace is not a GitHub URL
  for (const pattern of GITHUB_REMOTES) {
    const match = pattern.exec(url);
    if (!match) continue;
    const repo = `${match[1]}/${match[2]}`;
    return isGithubRepo(repo) ? repo : null;
  }
  return null;
}

// ---------- the gh port ----------

const describeExit = (result) => {
  if (result.error) return result.error.message;
  if (result.signal) return `killed by signal ${result.signal}`;
  return `exit status ${result.status}`;
};

/** gh's last stderr line, control characters removed and bounded, for the failure message. */
function lastStderrLine(stderr) {
  const line = String(stderr ?? "").trim().split("\n").at(-1) ?? "";
  return line.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200);
}

/** Runs `ghBin args` and returns its parsed JSON stdout; any failure is GH_FAILED (exit 3). */
function callGh(ghBin, args, env) {
  const call = JSON.stringify(args);
  const result = spawnSync(ghBin, args, { env, encoding: "utf8", maxBuffer: GH_MAX_BUFFER, timeout: GH_TIMEOUT_MS });
  if (result.error || result.status !== 0) {
    const stderr = lastStderrLine(result.stderr);
    throw new CiError("GH_FAILED", `gh ${call} failed: ${describeExit(result)}${stderr ? ` (${stderr})` : ""}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new CiError("GH_FAILED", `gh ${call} printed invalid JSON (exit status 0)`);
  }
}

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isPositiveInteger = (value) => Number.isInteger(value) && value >= 1;

function listFrom(doc, key, args) {
  if (!isPlainObject(doc) || !Array.isArray(doc[key])) {
    throw new CiError("GH_FAILED", `gh ${JSON.stringify(args)} returned no ${key} list`);
  }
  return doc[key];
}

function checkedRun(run, args) {
  if (!isPlainObject(run) || !Number.isInteger(run.id) || !isPositiveInteger(run.run_attempt)) {
    throw new CiError("GH_FAILED", `gh ${JSON.stringify(args)} returned a run without an integer id and run_attempt`);
  }
  return run;
}

const runsArgs = (repo, limit) => ["api", `repos/${repo}/actions/runs?per_page=${limit}&status=completed`];
const attemptArgs = (repo, id, k) => ["api", `repos/${repo}/actions/runs/${id}/attempts/${k}`];
const jobsArgs = (repo, id, a) => ["api", `repos/${repo}/actions/runs/${id}/attempts/${a}/jobs?per_page=100`];

/**
 * Every attempt of the `limit` newest completed runs of `repo`, normalized. The calls are
 * phased: the runs list, then each earlier attempt's run object, then each attempt's jobs.
 * The first failing call throws GH_FAILED and nothing is returned.
 */
export function fetchGithubHistory({ repo, ghBin, limit, env = process.env }) {
  if (!isGithubRepo(repo)) throw new CiError("USAGE", `repository must be owner/name, got ${JSON.stringify(repo)}`, 2);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new CiError("USAGE", "limit must be a whole number from 1 to 100", 2);
  const listArgs = runsArgs(repo, limit);
  const runs = listFrom(callGh(ghBin, listArgs, env), "workflow_runs", listArgs).map((run) => checkedRun(run, listArgs));

  // runObjects.get(run.id)[a - 1] is attempt a's run object; the latest is the listed one.
  const runObjects = new Map(runs.map((run) => [run.id, []]));
  for (const run of runs) {
    for (let k = 1; k < run.run_attempt; k++) {
      const args = attemptArgs(repo, run.id, k);
      runObjects.get(run.id).push(checkedRun(callGh(ghBin, args, env), args));
    }
  }
  for (const run of runs) runObjects.get(run.id).push(run);

  const attempts = [];
  for (const run of runs) {
    for (let a = 1; a <= run.run_attempt; a++) {
      const args = jobsArgs(repo, run.id, a);
      const jobsDoc = callGh(ghBin, args, env);
      listFrom(jobsDoc, "jobs", args);
      // The attempt number is the one requested, whatever the response's run_attempt says.
      attempts.push(normalizeAttempt({ ...runObjects.get(run.id)[a - 1], run_attempt: a }, jobsDoc));
    }
  }
  return attempts;
}

// ---------- normalization ----------

const orNull = (value) => (value === undefined ? null : value);

function normalizeStep(step) {
  return {
    number: orNull(step?.number),
    name: orNull(step?.name),
    conclusion: orNull(step?.conclusion),
    startedAt: orNull(step?.started_at),
    completedAt: orNull(step?.completed_at),
  };
}

function normalizeJob(job) {
  return {
    name: orNull(job?.name),
    conclusion: orNull(job?.conclusion),
    createdAt: orNull(job?.created_at),
    startedAt: orNull(job?.started_at),
    completedAt: orNull(job?.completed_at),
    labels: Array.isArray(job?.labels) ? [...job.labels] : [],
    steps: Array.isArray(job?.steps) ? job.steps.map(normalizeStep) : [],
  };
}

/** One normalized attempt from a run object (its `run_attempt` is the attempt) and its jobs page. */
export function normalizeAttempt(run, jobsDoc) {
  return {
    provider: "github",
    runId: orNull(run?.id),
    attempt: orNull(run?.run_attempt),
    workflow: orNull(run?.name),
    workflowPath: orNull(run?.path),
    event: orNull(run?.event),
    headSha: orNull(run?.head_sha),
    branch: orNull(run?.head_branch),
    conclusion: orNull(run?.conclusion),
    createdAt: orNull(run?.created_at),
    startedAt: orNull(run?.run_started_at),
    updatedAt: orNull(run?.updated_at),
    jobs: Array.isArray(jobsDoc?.jobs) ? jobsDoc.jobs.map(normalizeJob) : [],
  };
}

// ---------- merging ----------

export const attemptKey = (attempt) => `${attempt.runId}#${attempt.attempt}`;

/** startedAt descending (ISO strings compare as text), runId descending, attempt descending; null startedAt last. */
function newestFirst(x, y) {
  const xNull = x.startedAt === null;
  const yNull = y.startedAt === null;
  if (xNull !== yNull) return xNull ? 1 : -1;
  if (x.startedAt !== y.startedAt) return x.startedAt < y.startedAt ? 1 : -1;
  if (x.runId !== y.runId) return y.runId - x.runId;
  return y.attempt - x.attempt;
}

/** `existing` and `incoming` merged by `runId#attempt` (incoming wins), sorted newest first, capped at 200. */
export function mergeHistory(existing, incoming) {
  const byKey = new Map();
  for (const attempt of [...existing, ...incoming]) byKey.set(attemptKey(attempt), attempt);
  return [...byKey.values()].sort(newestFirst).slice(0, HISTORY_CAP);
}

// ---------- the store ----------

/**
 * The stored `{ schemaVersion, source, attempts }`, or null when it is absent, not JSON, another
 * schema, or holds an attempt outside the normalized shape (treated as absent, like junk, and
 * replaced on the next write).
 */
export function readHistory(root, env = process.env) {
  const doc = readState(root, HISTORY, env);
  if (!doc) return null;
  try {
    importedAttempts(doc);
  } catch {
    return null;
  }
  return doc;
}

/** Stores `{ schemaVersion: 1, source, attempts }` as history.json (0600, atomic). */
export function writeHistory(root, doc, env = process.env) {
  writeState(root, HISTORY, { schemaVersion: STATE_SCHEMA_VERSION, source: doc.source, attempts: doc.attempts }, env);
}

// ---------- import validation ----------

const isStringOrNull = (value) => value === null || typeof value === "string";
const isIntegerOrNull = (value) => value === null || Number.isInteger(value);

const RUN_FIELDS = ["workflow", "workflowPath", "event", "headSha", "branch", "conclusion", "createdAt", "startedAt", "updatedAt"];
const JOB_FIELDS = ["name", "conclusion", "createdAt", "startedAt", "completedAt"];
const STEP_FIELDS = ["name", "conclusion", "startedAt", "completedAt"];

function requireKeys(value, keys, where) {
  const missing = keys.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) throw new Error(`${where}: missing key ${missing}`);
}

function validStep(step, where) {
  if (!isPlainObject(step)) throw new Error(`${where}: not an object`);
  requireKeys(step, ["number", ...STEP_FIELDS], where);
  if (!isIntegerOrNull(step.number)) throw new Error(`${where}: number must be an integer or null`);
  for (const key of STEP_FIELDS) if (!isStringOrNull(step[key])) throw new Error(`${where}: ${key} must be a string or null`);
  return { number: step.number, name: step.name, conclusion: step.conclusion, startedAt: step.startedAt, completedAt: step.completedAt };
}

function validJob(job, where) {
  if (!isPlainObject(job)) throw new Error(`${where}: not an object`);
  requireKeys(job, [...JOB_FIELDS, "labels", "steps"], where);
  for (const key of JOB_FIELDS) if (!isStringOrNull(job[key])) throw new Error(`${where}: ${key} must be a string or null`);
  if (!Array.isArray(job.labels) || job.labels.some((label) => typeof label !== "string")) throw new Error(`${where}: labels must be a list of strings`);
  if (!Array.isArray(job.steps)) throw new Error(`${where}: steps must be a list`);
  return {
    name: job.name, conclusion: job.conclusion, createdAt: job.createdAt, startedAt: job.startedAt, completedAt: job.completedAt,
    labels: [...job.labels],
    steps: job.steps.map((step, i) => validStep(step, `${where} step ${i}`)),
  };
}

/** The record in the normalized shape (unknown keys dropped), or throws naming what is wrong. */
function validRecord(record) {
  if (!isPlainObject(record)) throw new Error("not an object");
  requireKeys(record, ["provider", "runId", "attempt", ...RUN_FIELDS, "jobs"], "record");
  if (typeof record.provider !== "string" || record.provider === "") throw new Error("provider must be a non-empty string");
  if (!Number.isInteger(record.runId)) throw new Error("runId must be an integer");
  if (!Number.isInteger(record.attempt)) throw new Error("attempt must be an integer");
  for (const key of RUN_FIELDS) if (!isStringOrNull(record[key])) throw new Error(`${key} must be a string or null`);
  if (!Array.isArray(record.jobs)) throw new Error("jobs must be a list");
  const normalized = { provider: record.provider, runId: record.runId, attempt: record.attempt };
  for (const key of RUN_FIELDS) normalized[key] = record[key];
  normalized.jobs = record.jobs.map((job, i) => validJob(job, `job ${i}`));
  return normalized;
}

/**
 * The attempts of an import document `{ attempts: [...] }`, each validated and reduced to the
 * normalized keys. One bad record refuses the whole document: IMPORT_INVALID (exit 2) naming its
 * 0-based index.
 */
export function importedAttempts(doc) {
  if (!isPlainObject(doc) || !Array.isArray(doc.attempts)) throw new CiError("IMPORT_INVALID", "the file must hold { \"attempts\": [...] }", 2);
  return doc.attempts.map((record, index) => {
    try {
      return validRecord(record);
    } catch (error) {
      throw new CiError("IMPORT_INVALID", `record ${index}: ${error.message}`, 2);
    }
  });
}
