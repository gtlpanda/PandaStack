// The full gate (stop hook, loop verification, people). In order:
//   1. frozen files unchanged since the session's base commit
//   2. the current feature's test (non-browser; browser specs run in step 5)
//   3. the project's gate commands (typecheck, lint, regression suite, coverage…)
//   4. the tests of every feature already passing (non-browser)
//   5. browser suites: the regression command plus passing and current browser specs
// failFast stops at the first failing step. Explicit PR-first commit phase keeps
// frozen/current acceptance and commitGate; deferred regressions are not passes.
//
// Steps 2-5 are a list of jobs. With no scheduling keys they run one at a time in that order,
// every time. The keys change the schedule, never the checks:
//   gateOrder "fastest"   failed-last-time first, then shortest recorded duration first
//   gateCache             a PASS is reused while the working tree's content is unchanged
//   gateConcurrency > 1   jobs run side by side (gate-pool.mjs); `resources` keep rivals apart
//   paths (scope "affected")  a job whose paths the change does not touch is skipped, and said so

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { globRegex } from "../../../../scripts/evidence-paths.mjs";
import { passKey, readCache, treeDigest, writeCache } from "./gate-cache.mjs";
import { appendTiming, timingsDir } from "./gate-timings.mjs";
import { parityLabel, resolveCiParity, paritySpec } from "./ci-parity.mjs";
import { checkEvidence } from "./evidence.mjs";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import path from "node:path";
import { featureById, featuresWithoutPasses, readFeatures } from "./features.mjs";
import { buildEnv, git, runSpec, sh, shSpec, specOutput, tail } from "./proc.mjs";
import { featureTestCommands, runFeatureTests } from "./tests.mjs";

const POOL = path.join(import.meta.dirname, "gate-pool.mjs");
const KEPT_POOL_RUNS = 10;

/**
 * Frozen paths changed or added since `baseSha` (committed or not). The feature list may
 * change only in its `passes` flags (written by `autobuild mark-passed`).
 */
export function frozenChanges(config, baseSha) {
  const paths = config.frozen.filter((entry) => entry !== config.featuresFile);
  const diff = git(config, ["diff", "--name-only", baseSha, "--", ...paths]);
  const untracked = git(config, ["ls-files", "--others", "--exclude-standard", "--", ...paths]);
  // A writable entry is an exception inside a frozen path (frozen: spec, writable: spec/DECISIONS.md).
  const writable = config.writable ?? [];
  const changed = `${diff.output}\n${untracked.output}`
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => !writable.some((entry) => file === entry || file.startsWith(`${entry}/`)));
  const before = git(config, ["show", `${baseSha}:${config.featuresFile}`]);
  const now = existsSync(path.join(config.root, config.featuresFile)) ? readFileSync(path.join(config.root, config.featuresFile), "utf8") : "";
  if (before.ok && featuresWithoutPasses(before.output) !== featuresWithoutPasses(now)) changed.push(`${config.featuresFile} (changed beyond passes flags)`);
  return { ok: diff.ok && untracked.ok, changed: [...new Set(changed)] };
}

/**
 * A digest of the git files that make git run code: config, hooks/, info/ (and a worktree's
 * config.worktree). Compared before and after each session: frozenChanges sees only tracked
 * files, so a hook or an fsmonitor written into .git would otherwise go unnoticed.
 */
export function gitControlDigest(config) {
  const dir = (flag) => git(config, ["rev-parse", "--path-format=absolute", flag]).output.trim();
  const common = dir("--git-common-dir");
  const own = dir("--git-dir");
  const roots = [path.join(common, "config"), path.join(common, "hooks"), path.join(common, "info"), path.join(own, "config.worktree")];
  const digest = {};
  const walk = (file) => {
    let stat;
    try {
      stat = lstatSync(file);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      for (const entry of readdirSync(file)) walk(path.join(file, entry));
      return;
    }
    const content = stat.isSymbolicLink() ? `link:${readlinkSync(file)}` : readFileSync(file);
    digest[file] = `${stat.mode.toString(8)}:${createHash("sha1").update(content).digest("hex")}`;
  };
  for (const root of [...new Set(roots)]) walk(root);
  return digest;
}

/** The git control files added, removed or changed since `before` (a gitControlDigest). */
export function gitControlChanges(config, before) {
  const after = gitControlDigest(config);
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((file) => before[file] !== after[file]).sort();
}

const EXCERPT_CHARS = 6000;
const DETAIL_LINES = 12; // at most this many detail lines kept under one failure line
// "  FAIL x" (this repo's harnesses), "FAIL  x" (validate.sh), "FAILED x" (pytest), "--- FAIL:" (go),
// "not ok" (TAP), "✖" (node's spec reporter), "TEST: FAIL"-style summaries, and thrown errors.
// Every alternative is anchored or fixed-width so a long line costs linear time: an unanchored
// `[A-Z][A-Z-]*: FAIL` restarted at each letter of "A-A-A-…" and took minutes on a 1 MB line.
const FAILURE_LINE = /^\s*(FAIL(ED)?\b|--- FAIL:|not ok\b|✖|\w*Error\b)|[A-Z]: FAIL\b/;
// A passing line can name a failure ("ok   prints TEST: FAIL when…"); it is never one.
const PASSING_LINE = /^\s*(ok\b|✔)/;
const indentOf = (line) => line.length - line.trimStart().length;

/** Failure lines, each with the more-indented (or blank) lines under it: the message, diff or TAP block. */
function failureLines(lines) {
  const kept = new Set();
  lines.forEach((line, index) => {
    if (PASSING_LINE.test(line) || !FAILURE_LINE.test(line)) return;
    kept.add(index);
    for (let next = index + 1; next < lines.length && next <= index + DETAIL_LINES; next += 1) {
      const detail = lines[next];
      if (PASSING_LINE.test(detail) || (detail.trim() !== "" && indentOf(detail) <= indentOf(line))) break;
      kept.add(next);
    }
  });
  const ordered = [...kept].sort((a, b) => a - b);
  return ordered.map((index, i) => (i > 0 && index !== ordered[i - 1] + 1 ? `…\n${lines[index]}` : lines[index])).join("\n");
}

/**
 * What a failed gate step shows the next session and the loop log: the end of the output (exactly
 * what a plain tail showed), preceded by the failure lines that came before that end. A multi-suite
 * gate prints its failing suite first and a long passing suite last, so the end alone loses the
 * failure. The result always contains the plain tail, so it never shows less than before.
 */
export function failureExcerpt(output, chars = EXCERPT_CHARS) {
  if (output.length <= chars) return output;
  const end = tail(output, chars);
  const earlier = failureLines(output.slice(0, output.length - chars).split("\n"));
  if (earlier === "") return end;
  const budget = Math.floor(chars / 2);
  const shown = earlier.length > budget ? `${earlier.slice(0, budget)}\n… (more failure lines omitted)` : earlier;
  return `Failure lines earlier in the output:\n${shown}\n\nEnd of output:\n${end}`;
}

/** One line for a log: how long the gate took and what each step cost, slowest first. */
export function gateLine(summary) {
  const ran = summary.steps.filter((step) => !step.cached);
  const cached = summary.steps.length - ran.length;
  const slowest = [...ran].sort((a, b) => b.seconds - a.seconds).slice(0, 5).filter((step) => step.seconds > 0).map((step) => `${step.name} ${step.seconds}s`);
  return `${summary.wallSeconds}s; ${ran.length} run, ${cached} cached, ${summary.skipped.length} skipped${summary.notRun.length ? `, ${summary.notRun.length} not run` : ""}${slowest.length ? `; slowest: ${slowest.join(", ")}` : ""}`;
}

/** One line per commit a reused PASS came from, and one per step skipped by path selection. */
export function reuseLines(summary) {
  const from = new Map();
  for (const step of summary.steps) if (step.cached) from.set(step.cachedFrom, [...(from.get(step.cachedFrom) ?? []), step.name]);
  return [
    ...[...from].map(([commit, names]) => `reused ${names.length} PASS result(s) from ${commit} (tree content unchanged): ${names.join(", ")}`),
    ...summary.skipped.map((entry) => `${entry.name}: ${entry.reason}`),
  ];
}

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "step";

/** Files changed since `baseSha` (committed or not) plus untracked ones; null when git cannot say. */
export function changedSince(config, baseSha) {
  const diff = git(config, ["-c", "core.quotepath=off", "diff", "--name-only", "-z", baseSha]);
  const untracked = git(config, ["-c", "core.quotepath=off", "ls-files", "--others", "--exclude-standard", "-z"]);
  if (!diff.ok || !untracked.ok) return null;
  return [...new Set(`${diff.output}\0${untracked.output}`.split("\0").filter(Boolean))];
}

/** True when any step of this project's gate declares `paths`, so a per-feature gate can be narrower than the full one. */
export function gateHasPaths(config) {
  return [...(config.gate ?? []), ...Object.values(config.runners ?? {}), config.browser, config.ciParity].some((entry) => Array.isArray(entry?.paths));
}

// Scheduling fields a gate entry, a runner, `browser` or `ciParity` may carry.
const schedule = (entry) => ({ resources: entry?.resources ?? null, memoryMb: entry?.memoryMb ?? 0, paths: entry?.paths ?? null });

function commandJob(config, { id, name, command, entry }) {
  return { id, name, spec: shSpec(config, command), keyEnv: config.env, ...schedule(entry) };
}

/** The jobs of the full phase in the gate's fixed order (see the file header). */
function fullJobs(config, { doc, current, featureId, browserKind, skipBrowser, ciParity, focused, warnings, deferred }) {
  const jobs = [];
  const featureJobs = (features, prefix, options = {}) => featureTestCommands(config, features, options).map(({ name, command, runner, browser }) => commandJob(config, {
    id: `${prefix}: ${name.replace(/ \(\d+ files?\)$/, "")}`, name: `${prefix}: ${name}`, command, entry: browser ? config.browser : runner,
  }));
  if (focused) {
    // The Stop hook's part when the full gate runs host-side: the feature's own test, whatever its kind.
    if (current) jobs.push(...featureJobs([current], `current feature ${current.id}`).map((job) => ({ ...job, pinned: true })));
    deferred.push({ kind: "host-gate", name: "full gate", reason: "runs host-side after the session" });
    return jobs;
  }
  if (current && current.testKind !== browserKind) jobs.push(...featureJobs([current], `current feature ${current.id}`).map((job) => ({ ...job, pinned: true })));
  for (const entry of config.gate ?? []) jobs.push(commandJob(config, { id: `gate: ${entry.name}`, name: entry.name, command: entry.command, entry }));

  // CI's own test steps, exactly as CI runs them (ci-parity.mjs). The Stop hook skips them: its
  // time budget covers the gate commands, not a CI suite plus a lock wait. The loop's final gate,
  // the host gates and `autobuild check` run them.
  if (!ciParity) {
    deferred.push({ kind: "ci-parity", name: "CI parity", reason: "runs in the loop's final full gate and autobuild check" });
  } else {
    const started = Date.now();
    const parity = resolveCiParity(config);
    warnings.push(...parity.warnings);
    jobs.push({ id: "CI parity configuration", name: "CI parity configuration", result: { ok: parity.errors.length === 0, ms: Date.now() - started, output: parity.errors.join("\n") } });
    if (parity.errors.length === 0) {
      const pathValue = buildEnv(config).PATH;
      for (const step of parity.steps) {
        const name = `CI parity: ${parityLabel(step)}`;
        jobs.push({ id: name, name, spec: paritySpec(config, step, { pathValue }), keyEnv: step.env, early: true, ...schedule(config.ciParity) });
      }
    }
  }

  const passing = doc.features.filter((feature) => feature.passes && feature.id !== featureId);
  const passingNonBrowser = passing.filter((feature) => feature.testKind !== browserKind);
  if (passingNonBrowser.length > 0) jobs.push(...featureJobs(passingNonBrowser, "passing features").map((job) => ({ ...job, early: true })));
  if (!skipBrowser && browserKind) {
    const specs = [...passing.filter((feature) => feature.testKind === browserKind), ...(current?.testKind === browserKind ? [current] : [])];
    jobs.push(...featureJobs(specs, "browser", { withRegressionBrowser: true }));
  }
  return jobs;
}

/** Execution order: the feature's own test first; then as configured, or failed-last-time and fastest first. */
function ordered(config, jobs, memory) {
  if (config.gateOrder !== "fastest") return jobs;
  const failedLast = new Set(memory.lastFailed ?? []);
  // A step with no recorded duration goes first (it is new, so the likeliest to fail); among those,
  // CI's own steps and the passing features' tests go before the project's gate entries.
  const rank = (job) => [job.pinned ? 0 : 1, failedLast.has(job.id) ? 0 : 1, memory.durations?.[job.id] ?? -1, job.early || job.result ? 0 : 1];
  return jobs.map((job, index) => ({ job, index, rank: rank(job) }))
    .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2] || a.rank[3] - b.rank[3] || a.index - b.index)
    .map(({ job }) => job);
}

// Where each step's own log goes when steps run side by side: the logs dir when git ignores it, else a temp dir.
function poolLogDir(config) {
  const stamp = `${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${process.pid}`;
  const base = timingsDir(config);
  if (!base) return mkdtempSync(path.join(tmpdir(), "autobuild-gate-"));
  const parent = path.join(base, "gate");
  mkdirSync(parent, { recursive: true });
  for (const old of readdirSync(parent).sort().slice(0, -KEPT_POOL_RUNS)) rmSync(path.join(parent, old), { recursive: true, force: true });
  const dir = path.join(parent, stamp);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Runs `jobs` through gate-pool.mjs; returns Map id -> {ok, status, output, ms}. Jobs it never started are absent. */
function runInPool(config, jobs, { failFast }) {
  const dir = poolLogDir(config);
  const payload = {
    jobs: jobs.map((job, index) => ({ id: job.id, spec: job.spec, logFile: path.join(dir, `${String(index + 1).padStart(2, "0")}-${slug(job.name)}.log`), resources: job.resources, memoryMb: job.memoryMb })),
    options: { concurrency: config.gateConcurrency, failFast, minFreeMb: config.gateMinFreeMb },
  };
  const child = spawnSync(process.execPath, [POOL], { input: JSON.stringify(payload), encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "inherit"] });
  let parsed = null;
  try { parsed = JSON.parse(child.stdout); } catch { /* reported below */ }
  const results = new Map();
  if (!parsed) {
    // The scheduler died: no step is known to have passed.
    for (const job of jobs) results.set(job.id, { ok: false, status: child.status, ms: 0, output: `the gate's scheduler stopped (exit ${child.status ?? child.signal}) before reporting this step` });
    return results;
  }
  for (const job of payload.jobs) {
    const result = parsed.results[job.id];
    if (!result) continue;
    let output = "";
    try { output = readFileSync(job.logFile, "utf8"); } catch { /* an unstartable step has no log */ }
    const spec = jobs.find((candidate) => candidate.id === job.id).spec;
    const timeout = result.timedOut ? `\nstopped after ${Math.round(spec.timeoutMs / 1000)}s (the step's time limit); its process group was killed.` : "";
    results.set(job.id, { ok: result.ok, status: result.status, ms: result.ms, output: `${specOutput(spec, result.status, output, result.error)}${timeout}\n(step log: ${job.logFile})` });
  }
  return results;
}

/**
 * Options beyond today's: `scope: "affected"` skips jobs whose `paths` the change since baseSha
 * does not touch (never the feature's own test, never a job without paths); `focused` keeps only
 * the prelude and the feature's own test (the Stop hook, when the full gate runs host-side).
 * The summary adds: steps[].cached / cachedFrom, skipped [{name, reason}], notRun [names], wallSeconds.
 */
export function runGate(config, { featureId = null, baseSha = null, failFast = false, skipBrowser = false, phase = "full", ciParity = true, scope = "full", focused = false, caller = "check" } = {}) {
  if (!["full", "commit"].includes(phase)) throw new Error("Unknown gate phase");
  if (!["full", "affected"].includes(scope)) throw new Error("Unknown gate scope");
  if (phase === "commit" && config.deliveryMode !== "pr-first") throw new Error("Commit gate requires pr-first deliveryMode");
  const gateStarted = Date.now();
  const doc = readFeatures(config);
  const current = featureId ? featureById(doc, featureId) : null;
  const browserKind = config.browser?.runner ?? null;
  const steps = [];
  const warnings = [];
  const skipped = [];
  const notRun = [];
  const deferred = phase === "commit" ? [
    ...(config.gate ?? []).map(step => ({ kind: "gate", name: step.name, reason: "PR full gate pending" })),
    ...doc.features.filter(feature => feature.passes && feature.id !== featureId).map(feature => ({ kind: "acceptance", name: feature.id, reason: "PR prior-feature regression pending" })),
    ...(config.browser?.regressionCommand ? [{ kind: "browser-regression", name: "browser regression suite", reason: "PR browser regression pending" }] : []),
  ] : [];
  const record = (step) => {
    steps.push(step);
    return step.ok || !failFast;
  };
  const summary = () => {
    const result = {
      ok: steps.every((step) => step.ok),
      feature: featureId,
      phase,
      scope,
      deferred,
      warnings,
      skipped,
      notRun,
      wallSeconds: Math.round((Date.now() - gateStarted) / 1000),
      steps: steps.map((step) => ({ name: step.name, ok: step.ok, seconds: Math.round((step.ms ?? 0) / 1000), tail: step.ok ? "" : failureExcerpt(step.output ?? ""), ...(step.cachedFrom ? { cached: true, cachedFrom: step.cachedFrom } : {}) })),
    };
    appendTiming(config, { type: "gate", caller, feature: featureId, phase, scope, focused, ok: result.ok, wallSeconds: result.wallSeconds, steps: result.steps.map(({ name, ok, seconds, cached }) => ({ name, ok, seconds, ...(cached ? { cached: true } : {}) })), skipped: skipped.map((entry) => entry.name), notRun });
    return result;
  };

  if (baseSha) {
    const started = Date.now();
    const frozen = frozenChanges(config, baseSha);
    const ok = frozen.ok && frozen.changed.length === 0;
    if (!record({ name: "frozen files unchanged", ok, ms: Date.now() - started, output: ok ? "" : `Changed or added frozen files:\n${frozen.changed.join("\n")}` })) return summary();
    const evidenceStarted = Date.now();
    const evidence = checkEvidence(config, baseSha);
    warnings.push(...evidence.warnings);
    if (!record({ name: "run evidence kept out of git", ok: evidence.ok, ms: Date.now() - evidenceStarted, output: evidence.output })) return summary();
  }

  if (phase === "commit") {
    // Current acceptance is mandatory, including browser tests. skipBrowser only
    // applies to the ordinary full gate's browser regression policy.
    if (current) {
      for (const step of runFeatureTests(config, [current])) if (!record({ ...step, name: `current feature ${current.id}: ${step.name}` })) return summary();
    }
    for (const step of config.commitGate ?? []) if (!record({ name: step.name, ...sh(config, step.command) })) return summary();
    return summary();
  }

  const all = fullJobs(config, { doc, current, featureId, browserKind, skipBrowser, ciParity, focused, warnings, deferred });

  // Path selection: only with a base to diff against; when the change cannot be listed, everything runs.
  const changed = scope === "affected" && baseSha ? changedSince(config, baseSha) : null;
  const selected = all.filter((job) => {
    if (!changed || job.pinned || !job.paths || !job.spec) return true;
    const patterns = job.paths.map(globRegex);
    if (changed.some((file) => patterns.some((pattern) => pattern.test(file)))) return true;
    skipped.push({ name: job.name, reason: "skipped (no path match)" });
    return false;
  });

  const memory = readCache(config);
  const tree = config.gateCache ? treeDigest(config) : null;
  const outcome = new Map();
  const plan = ordered(config, selected, memory);
  const toRun = [];
  for (const job of plan) {
    const hit = !job.result && tree ? memory.passes[passKey(job, tree)] : null;
    if (hit) job.result = { ok: true, ms: 0, output: "", cachedFrom: hit.commit };
    if (!job.result) toRun.push(job);
  }
  if (config.gateConcurrency > 1 && toRun.length > 1) {
    // Settled steps first (a config check, reused passes), then the rest side by side.
    for (const job of plan) if (job.result) outcome.set(job.id, job.result);
    if (!(failFast && [...outcome.values()].some((result) => !result.ok))) {
      for (const [id, result] of runInPool(config, toRun, { failFast })) outcome.set(id, result);
    }
  } else {
    for (const job of plan) {
      const result = job.result ?? runSpec(job.spec);
      outcome.set(job.id, result);
      if (!result.ok && failFast) break;
    }
  }

  // Remember: durations and failures always; a PASS only when the tree is still the one it ran on.
  const ran = toRun.filter((job) => outcome.has(job.id));
  for (const job of ran) memory.durations[job.id] = outcome.get(job.id).ms;
  memory.lastFailed = [...new Set([...(memory.lastFailed ?? []).filter((id) => outcome.get(id)?.ok !== true), ...ran.filter((job) => !outcome.get(job.id).ok).map((job) => job.id)])];
  if (tree && ran.some((job) => outcome.get(job.id).ok) && treeDigest(config) === tree) {
    const head = git(config, ["rev-parse", "HEAD"]);
    const dirty = git(config, ["status", "--porcelain"]);
    const commit = `${head.ok ? head.output.trim().slice(0, 12) : "unknown"}${dirty.ok && dirty.output.trim() ? "+uncommitted" : ""}`;
    for (const job of ran) if (outcome.get(job.id).ok) memory.passes[passKey(job, tree)] = { name: job.name, at: new Date().toISOString(), commit };
  }
  if (ran.length) writeCache(config, memory);

  // Report in the gate's fixed order, whatever order the steps ran or finished in.
  for (const job of selected) {
    const result = outcome.get(job.id);
    if (result) steps.push({ name: job.name, ...result });
    else notRun.push(job.name);
  }
  return summary();
}
