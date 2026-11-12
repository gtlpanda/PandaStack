// Two gate steps that share a name each report their own result: a failing one is never
// replaced by a later passing one (default scheduling keys, no fail-fast).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.AUTOBUILD_STATE_HOME = mkdtempSync(path.join(tmpdir(), "autobuild-state-"));

const { project, head } = await import("../test-fixtures/project.mjs");
const { loadConfig } = await import("../lib/config.mjs");
const { runGate } = await import("../lib/gate.mjs");

test("a failing gate step is not masked by a later passing step with the same name", (t) => {
  const root = project(["current", "prior"]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = loadConfig(root, {});
  config.gate = [{ name: "lint", command: "exit 1" }, { name: "lint", command: "true" }];
  const summary = runGate(config, { featureId: "current", baseSha: head(root), failFast: false });
  const lint = summary.steps.filter((step) => step.name === "lint").map((step) => step.ok);
  assert.deepEqual(lint, [false, true], `BUGHUNT-F1 each same-named gate step keeps its own result, got ${JSON.stringify(lint)}`);
  assert.equal(summary.ok, false, "BUGHUNT-F1 the gate must fail when a gate command failed");
});
