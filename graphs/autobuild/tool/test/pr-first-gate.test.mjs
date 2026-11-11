import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { project, head } from "../test-fixtures/project.mjs";
import { loadConfig } from "../lib/config.mjs";
import { buildEnv, sessionConfigEnv } from "../lib/proc.mjs";
import { runCodex, codexArgs } from "../lib/codex.mjs";
import { runGate } from "../lib/gate.mjs";
import { finishCodexBuilder, finishCodexReview } from "../lib/codex-gate.mjs";

function fixture(t) {
  const root = project(["current", "prior"]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = loadConfig(root, {});
  config.runners.unit.command = "bash -c 'printf \"%s\\n\" \"$@\" >> calls' _";
  config.gate = [{ name: "full regression", command: "printf 'full\\n' >> calls" }];
  config.commitGate = [{ name: "secrets", command: "printf 'secrets\\n' >> calls" }];
  const doc = JSON.parse(readFileSync(path.join(root, "features.json"), "utf8"));
  doc.features[1].passes = true;
  writeFileSync(path.join(root, "features.json"), JSON.stringify(doc));
  return { config, doc, calls: () => existsSync(path.join(root, "calls")) ? readFileSync(path.join(root, "calls"), "utf8").trim().split("\n") : [] };
}

test("delivery mode defaults full, accepts explicit override and rejects malformed configuration", t => {
  const { config } = fixture(t);
  assert.equal(config.deliveryMode, "full");
  assert.deepEqual(loadConfig(config.root, {}).commitGate, []);
  assert.equal(loadConfig(config.root, {}, { deliveryMode: "pr-first" }).deliveryMode, "pr-first");
  assert.throws(() => loadConfig(config.root, {}, { deliveryMode: "typo" }), /deliveryMode/);
  assert.equal(loadConfig(config.root, { AUTOBUILD_DELIVERY_MODE: "pr-first" }).deliveryMode, "pr-first");
  assert.equal(loadConfig(config.root, { AUTOBUILD_DELIVERY_MODE: "pr-first" }, { deliveryMode: "full" }).deliveryMode, "full");
  assert.throws(() => loadConfig(config.root, { AUTOBUILD_DELIVERY_MODE: "typo" }), /deliveryMode/);
  const file = path.join(config.root, "autobuild.json");
  const raw = JSON.parse(readFileSync(file, "utf8"));
  raw.commitGate = [{ name: "bad", command: "" }];
  writeFileSync(file, JSON.stringify(raw));
  assert.throws(() => loadConfig(config.root, {}), /commitGate/);
});

test("commit phase runs frozen integrity, current acceptance and commit checks only", t => {
  const { config, calls } = fixture(t);
  config.deliveryMode = "pr-first";
  config.browser = { runner: "browser", regressionCommand: "printf 'browser-regression\\n' >> calls" };
  const result = runGate(config, { phase: "commit", featureId: "current", baseSha: head(config.root), failFast: true });
  assert.equal(result.ok, true); assert.equal(result.phase, "commit");
  assert.deepEqual(calls(), ["tests/current.test", "secrets"]);
  assert.equal(result.steps[0].name, "frozen files unchanged");
  assert.deepEqual(result.deferred.map(d => d.kind), ["gate", "acceptance", "browser-regression"]);
  assert.ok(result.deferred.every(d => !Object.hasOwn(d, "ok") && !Object.hasOwn(d, "passes")));
});

test("commit phase keeps current browser acceptance even when skipBrowser is requested", t => {
  const { config, doc, calls } = fixture(t);
  config.deliveryMode = "pr-first";
  config.browser = { runner: "browser", regressionCommand: "printf 'browser-regression\\n' >> calls" };
  config.runners.browser = { group: "browser", command: "bash -c 'printf \"browser:%s\\n\" \"$@\" >> calls' _" };
  doc.features[0].testKind = "browser";
  writeFileSync(path.join(config.root, "features.json"), JSON.stringify(doc));
  const result = runGate(config, { phase: "commit", featureId: "current", skipBrowser: true });
  assert.equal(result.ok, true);
  assert.deepEqual(calls(), ["browser:tests/current.test", "secrets"]);
});

test("full phase remains default even with pr-first config and runs prior regressions", t => {
  const { config, calls } = fixture(t);
  config.deliveryMode = "pr-first";
  const result = runGate(config, { featureId: "current" });
  assert.equal(result.phase, "full"); assert.deepEqual(result.deferred, []);
  assert.equal(result.ok, true);
  assert.deepEqual(calls(), ["tests/current.test", "full", "tests/prior.test"]);
  config.deliveryMode = "full";
  assert.throws(() => runGate(config, { phase: "commit" }), /requires pr-first/);
  assert.throws(() => runGate(config, { phase: "typo" }), /Unknown gate phase/);
});

test("current acceptance and secret-check failures block commit phase without running full gates", t => {
  const { config, calls } = fixture(t);
  config.deliveryMode = "pr-first";
  config.runners.unit.command = "bash -c 'exit 9' _";
  const failed = runGate(config, { featureId: "current", phase: "commit", failFast: true });
  assert.equal(failed.ok, false); assert.equal(failed.steps.length, 1);
  assert.deepEqual(calls(), []);
  config.runners.unit.command = "bash -c 'exit 0' _";
  config.commitGate = [{ name: "secrets", command: "exit 8" }];
  const secretFailure = runGate(config, { featureId: "current", phase: "commit", failFast: true });
  assert.equal(secretFailure.ok, false); assert.equal(secretFailure.steps.at(-1).name, "secrets");
  assert.deepEqual(calls(), []);
});

test("frozen input changes still block before any focused command", t => {
  const { config, calls } = fixture(t);
  config.deliveryMode = "pr-first";
  const baseSha = head(config.root);
  writeFileSync(path.join(config.root, "tests/current.test"), "changed frozen input\n");
  const result = runGate(config, { featureId: "current", phase: "commit", baseSha, failFast: true });
  assert.equal(result.ok, false); assert.equal(result.steps.length, 1);
  assert.match(result.steps[0].tail, /tests\/current.test/);
  assert.deepEqual(calls(), []);
});


test("Codex builder reports commit-only success without claiming broad review passed", t => {
  const { config } = fixture(t);
  config.deliveryMode = "pr-first";
  mkdirSync(path.join(config.root, config.stateDir), { recursive: true });
  const docBefore = JSON.parse(readFileSync(path.join(config.root, "features.json"), "utf8"));
  const base = head(config.root), logs = [];
  writeFileSync(path.join(config.root, "PROGRESS.md"), "# progress\n## current — focused implementation\n");
  finishCodexBuilder(config, { feature: docBefore.features[0], base, docBefore,
    exitCode: 0, result: { subtype: "success" }, log: message => logs.push(message) });
  assert.notEqual(head(config.root), base);
  assert.equal(JSON.parse(readFileSync(path.join(config.root, "features.json"), "utf8")).features[0].passes, true);
  assert.match(logs.join("\n"), /commit gate: PASS.*full regressions and broad review remain pending/);
  assert.doesNotMatch(logs.join("\n"), /host gate: PASS|review: PASS/);
});

test("Codex review still uses full gate and cannot commit a fabricated review pass", t => {
  const { config } = fixture(t);
  config.deliveryMode = "pr-first";
  // Existing passes-only fixture edit is excluded from this review-only case.
  const doc = JSON.parse(readFileSync(path.join(config.root, "features.json"), "utf8"));
  doc.features[1].passes = false;
  writeFileSync(path.join(config.root, "features.json"), JSON.stringify(doc, null, 2));
  mkdirSync(path.join(config.root, config.stateDir), { recursive: true });
  config.gate = [{ name: "full review regression", command: "printf 'ordinary regression failure\\n'; exit 9" }];
  config.commitGate = [{ name: "focused", command: "exit 0" }];
  const base = head(config.root), logs = [];
  writeFileSync(path.join(config.root, "PROGRESS.md"), "# progress\nreview notes\n");
  finishCodexReview(config, { base, exitCode: 0, result: { subtype: "success" }, log: message => logs.push(message) });
  assert.equal(head(config.root), base);
  assert.match(logs.join("\n"), /host gate: FAIL[\s\S]*full review regression/);
  assert.doesNotMatch(logs.join("\n"), /PASS/);
});


test("Claude child config reload preserves selected delivery mode over project environment", t => {
  const { config } = fixture(t);
  config.deliveryMode = "pr-first";
  config.env.vars.AUTOBUILD_DELIVERY_MODE = "full";
  const childEnv = buildEnv(config, sessionConfigEnv(config));
  assert.equal(childEnv.AUTOBUILD_DELIVERY_MODE, "pr-first");
  assert.equal(loadConfig(config.root, childEnv).deliveryMode, "pr-first");
});

test("Codex child receives selected delivery mode and honest commit-phase instructions", async t => {
  const { config } = fixture(t);
  config.deliveryMode = "pr-first";
  config.env.vars.AUTOBUILD_DELIVERY_MODE = "full";
  config.codexBin = path.join(config.root, "ordinary-env-fixture.sh");
  writeFileSync(config.codexBin, '#!/bin/sh\nprintf "%s\\n" "$AUTOBUILD_DELIVERY_MODE"\n', { mode: 0o700 });
  const logFile = path.join(config.root, "ordinary-child.log");
  const code = await runCodex(config, { role: "probe", prompt: "inert fixture", logFile });
  assert.equal(code, 0);
  assert.equal(readFileSync(logFile, "utf8"), "pr-first\n");
  const { input } = codexArgs(config, { role: "builder", prompt: "ordinary task" });
  assert.match(input, /full regressions and broad review remain pending/);
  assert.doesNotMatch(input, /reruns the full gate/);
});
