// Runs features' acceptance tests through the project's configured runners.
// autobuild.json "runners" maps a feature's testKind to { group, command }; features whose
// runners share a group run in one invocation (command + their test files).
// "browser" names the runner for browser specs and an optional regressionCommand that
// also runs the project's existing browser suite in the same invocation (one build).

import { existsSync } from "node:fs";
import path from "node:path";
import { quote, sh } from "./proc.mjs";

function runnerFor(config, feature) {
  const runner = config.runners?.[feature.testKind];
  if (!runner?.command) throw new Error(`autobuild.json: no runner for testKind "${feature.testKind}" (feature ${feature.id})`);
  return runner;
}

/** Runs the tests of `features`, grouped by runner. Returns one step per invocation. */
export function runFeatureTests(config, features, options = {}) {
  const groups = new Map();
  for (const feature of features) {
    if (!existsSync(path.join(config.root, feature.test))) throw new Error(`${feature.id}: test file ${feature.test} is missing`);
    const runner = runnerFor(config, feature);
    const key = runner.group ?? feature.testKind;
    if (!groups.has(key)) groups.set(key, { runner, files: [], kind: feature.testKind });
    groups.get(key).files.push(feature.test);
  }
  const browserKind = config.browser?.runner;
  const steps = [];
  for (const [key, group] of groups) {
    const isBrowser = browserKind && group.kind === browserKind;
    const command = isBrowser && options.withRegressionBrowser && config.browser?.regressionCommand ? config.browser.regressionCommand : group.runner.command;
    steps.push({ name: `${key} (${group.files.length} file${group.files.length === 1 ? "" : "s"})`, ...sh(config, `${command} ${group.files.map(quote).join(" ")}`) });
  }
  if (options.withRegressionBrowser && config.browser?.regressionCommand && !features.some((feature) => feature.testKind === browserKind)) {
    steps.push({ name: "browser regression suite", ...sh(config, config.browser.regressionCommand) });
  }
  return steps;
}
