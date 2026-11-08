// The default spend caps (raised 2026-11-08: a real review cost $10.85 against the old $5 cap, and
// every project on the owner's machine overrode the builder and review caps). A project's own
// "limits" and the env overrides still win.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../lib/config.mjs";

function projectWith(config) {
  const root = mkdtempSync(path.join(tmpdir(), "autobuild-config-"));
  writeFileSync(path.join(root, "autobuild.json"), JSON.stringify(config));
  return root;
}

test("default caps: $50 per builder session, $25 per review, $100 for the bug hunt", () => {
  const { limits } = loadConfig(projectWith({}), {});
  assert.equal(limits.maxBudgetUsd, 50);
  assert.equal(limits.reviewBudgetUsd, 25);
  assert.equal(limits.bughuntBudgetUsd, 100);
});

test("a project's own limits and the env override still beat the defaults", () => {
  const root = projectWith({ limits: { reviewBudgetUsd: 7, bughuntBudgetUsd: 12 } });
  const { limits } = loadConfig(root, { AUTOBUILD_MAX_BUDGET_USD: "9" });
  assert.deepEqual([limits.maxBudgetUsd, limits.reviewBudgetUsd, limits.bughuntBudgetUsd], [9, 7, 12]);
});

test("the new-project template writes the same builder cap as the default", () => {
  const template = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "..", "templates", "autobuild.json"), "utf8"));
  assert.equal(template.limits.maxBudgetUsd, loadConfig(projectWith({}), {}).limits.maxBudgetUsd);
});
