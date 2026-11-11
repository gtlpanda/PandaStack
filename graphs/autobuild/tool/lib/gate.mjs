// The full gate (stop hook, loop verification, people). In order:
//   1. frozen files unchanged since the session's base commit
//   2. the current feature's test (non-browser; browser specs run in step 5)
//   3. the project's gate commands (typecheck, lint, regression suite, coverage…)
//   4. the tests of every feature already passing (non-browser)
//   5. browser suites: the regression command plus passing and current browser specs
// failFast stops at the first failing step. Explicit PR-first commit phase keeps
// frozen/current acceptance and commitGate; deferred regressions are not passes.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import path from "node:path";
import { featureById, readFeatures } from "./features.mjs";
import { git, sh, tail } from "./proc.mjs";
import { runFeatureTests } from "./tests.mjs";

/** The feature list with every `passes` flag removed: what must never change during a session. */
function featuresWithoutPasses(text) {
  try {
    const doc = JSON.parse(text);
    for (const feature of doc.features ?? []) delete feature.passes;
    return JSON.stringify(doc);
  } catch {
    return null;
  }
}

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

export function runGate(config, { featureId = null, baseSha = null, failFast = false, skipBrowser = false, phase = "full" } = {}) {
  if (!["full", "commit"].includes(phase)) throw new Error("Unknown gate phase");
  if (phase === "commit" && config.deliveryMode !== "pr-first") throw new Error("Commit gate requires pr-first deliveryMode");
  const doc = readFeatures(config);
  const current = featureId ? featureById(doc, featureId) : null;
  const browserKind = config.browser?.runner ?? null;
  const steps = [];
  const deferred = phase === "commit" ? [
    ...(config.gate ?? []).map(step => ({ kind: "gate", name: step.name, reason: "PR full gate pending" })),
    ...doc.features.filter(feature => feature.passes && feature.id !== featureId).map(feature => ({ kind: "acceptance", name: feature.id, reason: "PR prior-feature regression pending" })),
    ...(config.browser?.regressionCommand ? [{ kind: "browser-regression", name: "browser regression suite", reason: "PR browser regression pending" }] : []),
  ] : [];
  const record = (step) => {
    steps.push(step);
    return step.ok || !failFast;
  };
  const summary = () => ({
    ok: steps.every((step) => step.ok),
    feature: featureId,
    phase,
    deferred,
    steps: steps.map((step) => ({ name: step.name, ok: step.ok, seconds: Math.round((step.ms ?? 0) / 1000), tail: step.ok ? "" : failureExcerpt(step.output ?? "") })),
  });

  if (baseSha) {
    const started = Date.now();
    const frozen = frozenChanges(config, baseSha);
    const ok = frozen.ok && frozen.changed.length === 0;
    if (!record({ name: "frozen files unchanged", ok, ms: Date.now() - started, output: ok ? "" : `Changed or added frozen files:\n${frozen.changed.join("\n")}` })) return summary();
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

  if (current && current.testKind !== browserKind) {
    for (const step of runFeatureTests(config, [current])) if (!record({ ...step, name: `current feature ${current.id}: ${step.name}` })) return summary();
  }

  for (const gateStep of config.gate ?? []) {
    if (!record({ name: gateStep.name, ...sh(config, gateStep.command) })) return summary();
  }

  const passing = doc.features.filter((feature) => feature.passes && feature.id !== featureId);
  const passingNonBrowser = passing.filter((feature) => feature.testKind !== browserKind);
  if (passingNonBrowser.length > 0) {
    for (const step of runFeatureTests(config, passingNonBrowser)) if (!record({ ...step, name: `passing features: ${step.name}` })) return summary();
  }

  if (!skipBrowser && browserKind) {
    const specs = [...passing.filter((feature) => feature.testKind === browserKind), ...(current?.testKind === browserKind ? [current] : [])];
    for (const step of runFeatureTests(config, specs, { withRegressionBrowser: true })) if (!record({ ...step, name: `browser: ${step.name}` })) return summary();
  }
  return summary();
}
