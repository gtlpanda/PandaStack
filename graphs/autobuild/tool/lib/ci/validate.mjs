// The fast validation tier (spec/contracts/ci-optimizer-co-07.md). A fast request runs the gate
// steps whose `paths` the change since the merge-base touches, plus every step without `paths`,
// and escalates to the full gate whenever that selection could miss something: no base, no
// `paths` anywhere, a CI, manifest, lockfile or autobuild.json change, or a change no `paths`
// pattern covers. The fast tier is never merge validation; the required CI check decides merges.

import path from "node:path";
import { CONFIG_FILE } from "../config.mjs";
import { ciFiles, ciProviderOf } from "../ci-parity.mjs";
import { changedSince, gateHasPaths, gateJobs, pathEntries, pathPattern, selectByPaths } from "../gate.mjs";
import { git } from "../proc.mjs";
import { readState, STATE_SCHEMA_VERSION, writeState } from "./state.mjs";

export const TIERS = ["fast", "full"];
// Refs tried in order when no --base is given.
const DEFAULT_BASE_REFS = ["origin/HEAD", "origin/main", "origin/master", "main", "master"];
const MANIFESTS = new Set(["package.json", "pyproject.toml", "setup.py", "setup.cfg", "go.mod", "Cargo.toml", "Gemfile", "pom.xml", "build.gradle", "build.gradle.kts"]);
const REQUIREMENTS = /^requirements.*\.txt$/;
const LOCKFILES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "poetry.lock", "Pipfile.lock", "go.sum", "Cargo.lock", "Gemfile.lock"]);

/** The merge-base of `ref` and HEAD, or null when either does not resolve or they share no history. */
function mergeBase(config, ref) {
  // A ref name never starts with "-" (git check-ref-format), and such a value would be read as an option.
  if (typeof ref !== "string" || ref === "" || ref.startsWith("-")) return null;
  const result = git(config, ["merge-base", ref, "HEAD"]);
  const sha = result.ok ? result.output.trim() : "";
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

/**
 * `{ ref, sha }`: the merge-base of `ref` and HEAD; without a ref, of the first default ref that
 * has one. null when nothing resolves.
 */
export function resolveBase(config, ref = null) {
  for (const candidate of ref === null ? DEFAULT_BASE_REFS : [ref]) {
    const sha = mergeBase(config, candidate);
    if (sha) return { ref: candidate, sha };
  }
  return null;
}

/** The files changed since `baseSha`, committed or not, plus untracked ones: changedSince's list (null when git cannot say). */
export function changedFiles(config, baseSha) {
  return changedSince(config, baseSha);
}

const normalized = (file) => (typeof file === "string" && file !== "" ? path.posix.normalize(file) : null);

/** The escalation reasons one changed path gives (see the contract's table). */
function pathReasons(file, { ciConfig, patterns, exempt }) {
  const reasons = [];
  const base = path.posix.basename(file);
  if (ciConfig.has(file) || file.startsWith(".github/") || ciProviderOf(file) !== null) reasons.push(`CI_CONFIG_CHANGED:${file}`);
  if (MANIFESTS.has(base) || REQUIREMENTS.test(base)) reasons.push(`MANIFEST_CHANGED:${file}`);
  if (LOCKFILES.has(base)) reasons.push(`LOCKFILE_CHANGED:${file}`);
  if (file === CONFIG_FILE) reasons.push("AUTOBUILD_CONFIG_CHANGED");
  if (!exempt.has(file) && !patterns.some((pattern) => pattern.test(file))) reasons.push(`UNMAPPED_CHANGE:${file}`);
  return reasons;
}

/** Every reason a fast request escalates for, sorted and listed once; `changed` null means no base. */
function escalationReasons({ config, root, changed, gitlabFile }) {
  const reasons = [];
  if (changed === null) reasons.push("NO_BASE");
  if (!gateHasPaths(config)) reasons.push("NO_PATHS_DECLARED");
  const context = {
    // ciFiles lists the CI files that exist; ciProviderOf (in pathReasons) also catches a deleted one.
    ciConfig: new Set([...ciFiles(root), ...(normalized(gitlabFile) ? [normalized(gitlabFile)] : [])]),
    patterns: pathEntries(config).flatMap((entry) => entry.paths.map(pathPattern)),
    exempt: new Set([normalized(config.progressFile), normalized(config.featuresFile)].filter(Boolean)),
  };
  for (const file of changed ?? []) reasons.push(...pathReasons(file, context));
  return [...new Set(reasons)].sort();
}

/**
 * The validation plan: `{ tier, requested, escalated, reasons, steps: { run, skip } }`. Steps are
 * the gate's own jobs (gateJobs) under the gate's own path selection (selectByPaths); a full
 * tier runs them all, CI parity included. `gitlabFile` names one more CI configuration path (a
 * custom GitLab CI file location).
 */
export function planValidation({ config, root, changed, tier, gitlabFile = null }) {
  if (!TIERS.includes(tier)) throw new Error(`unknown validation tier ${JSON.stringify(tier)}`);
  const reasons = tier === "fast" ? escalationReasons({ config, root, changed, gitlabFile }) : [];
  const escalated = reasons.length > 0;
  const actual = tier === "fast" && !escalated ? "fast" : "full";
  const jobs = gateJobs(config, { ciParity: actual === "full" });
  const selection = actual === "fast" ? selectByPaths(config, jobs, changed) : { selected: jobs, skipped: [] };
  return {
    tier: actual,
    requested: tier,
    escalated,
    reasons,
    steps: { run: selection.selected.map((job) => job.name), skip: selection.skipped.map(({ name, reason }) => ({ name, reason })) },
  };
}

/** Stores `record` under its tier in validation.json, keeping the other tier's record. */
export function recordValidation(root, record, env = process.env) {
  if (!TIERS.includes(record?.tier)) throw new Error(`validation record has unknown tier ${JSON.stringify(record?.tier)}`);
  const stored = readState(root, "validation", env);
  const doc = {
    schemaVersion: STATE_SCHEMA_VERSION,
    fast: stored?.fast ?? null,
    full: stored?.full ?? null,
  };
  doc[record.tier] = record;
  writeState(root, "validation", doc, env);
  return doc;
}

/** `{ head, dirty }` of the work tree: HEAD's sha (null without one) and whether `git status --porcelain` lists anything. */
export function treeState(config) {
  const head = git(config, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const status = git(config, ["status", "--porcelain"]);
  const sha = head.ok ? head.output.trim() : "";
  // Anything git cannot report counts as dirty: a record must never look cleaner than the tree.
  return { head: /^[0-9a-f]{40,64}$/.test(sha) ? sha : null, dirty: !status.ok || status.output.trim() !== "" };
}
