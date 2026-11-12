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

/** The invocations that test `features`, grouped by runner: [{ name, command, runner, browser }]. */
export function featureTestCommands(config, features, options = {}) {
  const groups = new Map();
  for (const feature of features) {
    if (!existsSync(path.join(config.root, feature.test))) throw new Error(`${feature.id}: test file ${feature.test} is missing`);
    const runner = runnerFor(config, feature);
    const key = runner.group ?? feature.testKind;
    if (!groups.has(key)) groups.set(key, { runner, files: [], kind: feature.testKind });
    groups.get(key).files.push(feature.test);
  }
  const browserKind = config.browser?.runner;
  const commands = [];
  for (const [key, group] of groups) {
    const isBrowser = Boolean(browserKind && group.kind === browserKind);
    const command = isBrowser && options.withRegressionBrowser && config.browser?.regressionCommand ? config.browser.regressionCommand : group.runner.command;
    commands.push({ name: `${key} (${group.files.length} file${group.files.length === 1 ? "" : "s"})`, command: `${command} ${group.files.map(quote).join(" ")}`, runner: group.runner, browser: isBrowser });
  }
  if (options.withRegressionBrowser && config.browser?.regressionCommand && !features.some((feature) => feature.testKind === browserKind)) {
    commands.push({ name: "browser regression suite", command: config.browser.regressionCommand, runner: null, browser: true });
  }
  return commands;
}

/** Runs the tests of `features`, grouped by runner. Returns one step per invocation. */
export function runFeatureTests(config, features, options = {}) {
  return featureTestCommands(config, features, options).map(({ name, command }) => ({ name, ...sh(config, command) }));
}
