// Validation status for HEAD (spec/contracts/ci-optimizer-co-11.md): whether the stored local fast
// and full validations are still current, the stored CI result for HEAD, and what to do next. Pure:
// the caller reads validation.json and the stored history; nothing here touches disk, git or gh.
// `advice` never claims merge readiness; the repository's required CI check decides merges.

import { isPlainObject, newestFirst } from "./history.mjs";
import { TIERS } from "./validate.mjs";

/** A stored tier record the status can use: an object with a boolean `ok`; anything else counts as absent. */
const usableRecord = (record) => isPlainObject(record) && typeof record.ok === "boolean";

/**
 * `{ ok, at, current, staleReason }` for one stored tier record, or null when there is none.
 * Current only for the same head, recorded on a clean tree, with the tree clean now. A null head
 * (no commits) is never current.
 */
function localEntry(record, head, dirty) {
  if (!usableRecord(record)) return null;
  const sameHead = typeof head === "string" && record.head === head;
  const current = sameHead && record.dirty === false && dirty === false;
  let staleReason = null;
  if (!current) staleReason = sameHead ? "uncommitted-changes" : "head-changed";
  return { ok: record.ok, at: record.at ?? null, current, staleReason };
}

/** The newest attempt (newestFirst order) whose headSha is `head`, projected to the contract's fields; else null. */
function ciResult(attempts, head) {
  if (typeof head !== "string") return null;
  const newest = attempts.filter((attempt) => attempt?.headSha === head).sort(newestFirst)[0];
  if (!newest) return null;
  const { workflow, conclusion, runId, attempt, startedAt } = newest;
  return { workflow, conclusion, runId, attempt, startedAt };
}

/** The first matching rule of the contract's five, in order. */
function adviceFor(local, ci) {
  const current = [local.fast, local.full].filter((entry) => entry?.current === true);
  if (current.some((entry) => entry.ok === false) || ci?.conclusion === "failure") return "fix-failure";
  if (ci?.conclusion === "success") return "none";
  if (local.full?.current === true && local.full.ok === true) return "wait-for-ci";
  if (local.fast?.current === true && local.fast.ok === true) return "run-full";
  return "run-fast";
}

/**
 * `{ head, local: { fast, full }, ci, notes, advice }` for `head`. `validation` is the stored
 * validation.json document (or null), `attempts` the stored history's attempts. `dirty` is whether
 * the work tree has uncommitted changes now. The contract's `root` is accepted and not needed.
 * Inputs are never mutated.
 */
export function validationStatus({ head, dirty, validation, attempts }) {
  const stored = isPlainObject(validation) ? validation : {};
  const local = Object.fromEntries(TIERS.map((tier) => [tier, localEntry(stored[tier], head, dirty)]));
  const list = Array.isArray(attempts) ? attempts : [];
  const ci = ciResult(list, head);
  const notes = [];
  if (ci === null) notes.push("NO_CI_RESULT_FOR_HEAD");
  if (list.length === 0) notes.push("NO_HISTORY");
  return { head, local, ci, notes, advice: adviceFor(local, ci) };
}
