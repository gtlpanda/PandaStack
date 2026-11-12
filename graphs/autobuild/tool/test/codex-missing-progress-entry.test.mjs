// A Codex builder that passes the host gate but commits no "## <ID> " progress entry must get
// retry feedback, not crash the loop with a TypeError from the synthetic gate summary.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { project, head } from "../test-fixtures/project.mjs";
import { loadConfig } from "../lib/config.mjs";
import { finishCodexBuilder } from "../lib/codex-gate.mjs";

test("Codex builder with no progress entry logs gate FAIL with feedback and returns for a retry", t => {
  const root = project(["current"]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = loadConfig(root, {});
  config.runners.unit.command = "bash -c 'exit 0' _";
  config.gate = [{ name: "full regression", command: "exit 0" }];
  mkdirSync(path.join(root, config.stateDir), { recursive: true });
  const docBefore = JSON.parse(readFileSync(path.join(root, "features.json"), "utf8"));
  const base = head(root), logs = [];
  writeFileSync(path.join(root, config.progressFile), "# progress\n");
  let returned, thrown;
  try {
    returned = finishCodexBuilder(config, { feature: docBefore.features[0], base, docBefore,
      exitCode: 0, result: { subtype: "success" }, log: message => logs.push(message) });
  } catch (error) { thrown = error; }
  assert.equal(thrown, undefined, `BUGHUNT-F9 finishCodexBuilder threw instead of returning feedback: ${thrown?.message}`);
  assert.equal(returned, undefined, "BUGHUNT-F9 a missing progress entry is a retry, not an accepted result");
  assert.match(logs.join("\n"), /Codex host gate: FAIL[\s\S]*Append a ## current/, "BUGHUNT-F9 failure is logged with the feedback text");
  assert.ok(existsSync(path.join(root, config.stateDir, "codex-feedback.txt")), "BUGHUNT-F9 feedback file written");
  assert.match(readFileSync(path.join(root, config.stateDir, "codex-feedback.txt"), "utf8"), /Append a ## current/, "BUGHUNT-F9 feedback names the missing entry");
  assert.equal(head(root), base, "BUGHUNT-F9 nothing is committed");
});
