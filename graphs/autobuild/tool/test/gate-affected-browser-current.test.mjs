// Under scope "affected" the current feature's own test always runs, whatever its kind: a
// browser-kind feature whose change does not touch browser.paths must not have its test skipped.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.AUTOBUILD_STATE_HOME = mkdtempSync(path.join(tmpdir(), "autobuild-state-"));

const { project, head } = await import("../test-fixtures/project.mjs");
const { loadConfig } = await import("../lib/config.mjs");
const { runGate } = await import("../lib/gate.mjs");

test("scope affected still runs a browser-kind current feature's test when the change misses browser.paths", (t) => {
  const root = project(["current"]);
  const outside = mkdtempSync(path.join(tmpdir(), "autobuild-calls-"));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  const callsFile = path.join(outside, "calls");
  // A web/ area, so the browser glob names something that exists (a dead glob would run instead of skip).
  execFileSync("mkdir", ["-p", path.join(root, "web")]);
  writeFileSync(path.join(root, "web", "index.js"), "1\n");
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "web"]);

  const doc = JSON.parse(readFileSync(path.join(root, "features.json"), "utf8"));
  doc.features[0].testKind = "e2e";
  writeFileSync(path.join(root, "features.json"), JSON.stringify(doc, null, 2));

  const config = loadConfig(root, {});
  config.runners.e2e = { command: `bash -c 'printf "e2e:%s\\n" "$@" >> ${callsFile}' _` };
  config.browser = { runner: "e2e", paths: ["web/**"] };
  config.gate = [];

  const base = head(root);
  // The feature is built by changing only server/.
  execFileSync("mkdir", ["-p", path.join(root, "server")]);
  writeFileSync(path.join(root, "server", "x.js"), "1\n");

  const summary = runGate(config, { featureId: "current", baseSha: base, scope: "affected" });
  const calls = existsSync(callsFile) ? readFileSync(callsFile, "utf8").trim().split("\n") : [];
  assert.deepEqual(calls, ["e2e:tests/current.test"], `BUGHUNT-F7 the current browser feature's own test was skipped under scope affected (skipped: ${JSON.stringify(summary.skipped)})`);
});
