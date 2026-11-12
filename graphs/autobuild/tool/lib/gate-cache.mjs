// What the gate remembers between runs, per project:
//   - passes: a PASS per (step, working-tree content), reused only when gateCache is on;
//   - durations and lastFailed: how long each step took and which failed last, for gateOrder "fastest".
// The file lives outside the project (the state home), where a builder session cannot write:
// the guard hook refuses writes outside the project, and the Codex sandbox is limited to it.
// The loop also drops the file when it changes during a Codex session (cacheDigest).

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { featuresWithoutPasses } from "./features.mjs";
import { git } from "./proc.mjs";

const VERSION = 1;
const MAX_PASSES = 4000;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const nul = (text) => text.split("\0").filter(Boolean);

function stateHome(env = process.env) {
  return path.join(env.AUTOBUILD_STATE_HOME || env.XDG_STATE_HOME || path.join(homedir(), ".local", "state"), "autobuild", "gate");
}

export function cacheFile(config, env = process.env) {
  let root = config.root;
  try { root = realpathSync(root); } catch { /* a missing root has no cache to share */ }
  return path.join(stateHome(env), `${sha256(root).slice(0, 24)}.json`);
}

const empty = (config) => ({ version: VERSION, root: config.root, passes: {}, durations: {}, lastFailed: [] });

export function readCache(config) {
  try {
    const doc = JSON.parse(readFileSync(cacheFile(config), "utf8"));
    if (doc?.version !== VERSION || typeof doc.passes !== "object" || !doc.passes) return empty(config);
    return { ...empty(config), ...doc };
  } catch {
    return empty(config);
  }
}

/** Never throws: a gate result must not depend on whether its bookkeeping could be written. */
export function writeCache(config, doc) {
  try {
    const file = cacheFile(config);
    mkdirSync(path.dirname(file), { recursive: true });
    const keys = Object.keys(doc.passes);
    if (keys.length > MAX_PASSES) for (const key of keys.slice(0, keys.length - MAX_PASSES)) delete doc.passes[key];
    const draft = `${file}.${process.pid}.tmp`;
    writeFileSync(draft, JSON.stringify(doc), { mode: 0o600 });
    renameSync(draft, file);
    pruneGone(path.dirname(file));
  } catch { /* the next run measures again */ }
}

// Files of projects that no longer exist (throwaway test projects, removed worktrees).
function pruneGone(dir) {
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const root = JSON.parse(readFileSync(path.join(dir, name), "utf8")).root;
      if (typeof root === "string" && !existsSync(root)) rmSync(path.join(dir, name), { force: true });
    } catch { /* unreadable: leave it */ }
  }
}

/** A digest of the cache file, so the loop can tell when something other than a gate wrote it. */
export function cacheDigest(config) {
  try { return sha256(readFileSync(cacheFile(config))); } catch { return null; }
}

export function dropCache(config) {
  rmSync(cacheFile(config), { force: true });
}

/** Paths the tree digest leaves out: the loop's journal and the decision files a review may append to. */
export function cacheIgnore(config) {
  return config.gateCacheIgnore ?? [...new Set([config.progressFile, ...(config.writable ?? [])])];
}

/**
 * A digest of the working tree's content as a gate sees it: every tracked file plus every
 * untracked file git does not ignore, committed or not. Left out: the ignore list (cacheIgnore)
 * and the `passes` flags of the feature list, which the loop itself flips after a gate.
 * Null when git cannot list the tree; callers then neither read nor write the cache.
 */
export function treeDigest(config) {
  const tracked = git(config, ["-c", "core.quotepath=off", "ls-files", "-s", "-z"]);
  const loose = git(config, ["-c", "core.quotepath=off", "ls-files", "-m", "-d", "-o", "--exclude-standard", "-z"]);
  if (!tracked.ok || !loose.ok) return null;
  const ignore = cacheIgnore(config);
  const ignored = (file) => ignore.some((entry) => file === entry || file.startsWith(`${entry.replace(/\/$/, "")}/`));
  const entries = new Map();
  for (const line of nul(tracked.output)) {
    const tab = line.indexOf("\t");
    const file = line.slice(tab + 1);
    if (!ignored(file)) entries.set(file, line.slice(0, tab));
  }
  // The index says what was staged; the gate runs on what is on disk.
  for (const file of new Set([...nul(loose.output), config.featuresFile])) {
    if (ignored(file)) continue;
    const full = path.join(config.root, file);
    let stat;
    try { stat = lstatSync(full); } catch { entries.delete(file); continue; }
    if (stat.isDirectory()) continue;
    // The same form `git ls-files -s` prints (mode, blob id, stage), so a file reads the same
    // before and after it is committed. (In a SHA-256 repository the ids differ: a miss, never a false hit.)
    const link = stat.isSymbolicLink();
    const content = link ? Buffer.from(readlinkSync(full)) : readFileSync(full);
    if (file === config.featuresFile) { entries.set(file, `features ${sha256(featuresWithoutPasses(content) ?? content)}`); continue; }
    const blob = createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
    entries.set(file, `${link ? "120000" : (stat.mode & 0o111) ? "100755" : "100644"} ${blob} 0`);
  }
  const hash = createHash("sha256");
  for (const file of [...entries.keys()].sort()) hash.update(`${file}\0${entries.get(file)}\n`);
  return hash.digest("hex");
}

/** The cache key of one step on one tree: what it runs, where, with which configured env. */
export function passKey(job, tree) {
  return sha256(JSON.stringify([VERSION, job.id, job.spec.argv, job.spec.cwdRel ?? ".", job.keyEnv ?? null, tree]));
}
