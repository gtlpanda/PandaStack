// The full gate (stop hook, loop verification, people). In order:
//   1. frozen files unchanged since the session's base commit
//   2. the current feature's test (non-browser; browser specs run in step 5)
//   3. the project's gate commands (typecheck, lint, regression suite, coverage…)
//   4. the tests of every feature already passing (non-browser)
//   5. browser suites: the regression command plus passing and current browser specs
// failFast stops at the first failing step.

import { existsSync, readFileSync } from "node:fs";
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
  const changed = `${diff.output}\n${untracked.output}`
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const before = git(config, ["show", `${baseSha}:${config.featuresFile}`]);
  const now = existsSync(path.join(config.root, config.featuresFile)) ? readFileSync(path.join(config.root, config.featuresFile), "utf8") : "";
  if (before.ok && featuresWithoutPasses(before.output) !== featuresWithoutPasses(now)) changed.push(`${config.featuresFile} (changed beyond passes flags)`);
  return { ok: diff.ok && untracked.ok, changed: [...new Set(changed)] };
}

export function runGate(config, { featureId = null, baseSha = null, failFast = false, skipBrowser = false } = {}) {
  const doc = readFeatures(config);
  const current = featureId ? featureById(doc, featureId) : null;
  const browserKind = config.browser?.runner ?? null;
  const steps = [];
  const record = (step) => {
    steps.push(step);
    return step.ok || !failFast;
  };
  const summary = () => ({
    ok: steps.every((step) => step.ok),
    feature: featureId,
    steps: steps.map((step) => ({ name: step.name, ok: step.ok, seconds: Math.round((step.ms ?? 0) / 1000), tail: step.ok ? "" : tail(step.output ?? "", 6000) })),
  });

  if (baseSha) {
    const started = Date.now();
    const frozen = frozenChanges(config, baseSha);
    const ok = frozen.ok && frozen.changed.length === 0;
    if (!record({ name: "frozen files unchanged", ok, ms: Date.now() - started, output: ok ? "" : `Changed or added frozen files:\n${frozen.changed.join("\n")}` })) return summary();
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
