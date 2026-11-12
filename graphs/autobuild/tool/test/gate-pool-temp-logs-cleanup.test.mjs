// A pooled gate run whose logs dir is not gitignored writes its step logs to a temp dir. That dir
// must not be left behind: one per gate run would fill the disk.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.AUTOBUILD_STATE_HOME = mkdtempSync(path.join(tmpdir(), "autobuild-state-"));

const { project } = await import("../test-fixtures/project.mjs");
const { loadConfig } = await import("../lib/config.mjs");
// Loading the pool first: where it does not exist there is nothing to test, and that is not this bug.
await import("../lib/gate-pool.mjs");
const { runGate } = await import("../lib/gate.mjs");

test("a pooled gate run does not leave its step-log temp directory behind", (t) => {
  const root = project(["current", "prior"]);
  const tempHome = mkdtempSync(path.join(tmpdir(), "autobuild-tmphome-"));
  const savedTmp = process.env.TMPDIR;
  t.after(() => {
    if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp;
    rmSync(root, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  });
  const config = loadConfig(root, {});
  config.logsDir = "visible-logs"; // not in .gitignore, so the pool falls back to a temp dir
  config.runners.unit.command = "true"; // the fixture's own feature test needs a built feature
  config.gateConcurrency = 2;
  config.gateMinFreeMb = 0;
  config.gate = ["a", "b"].map((name) => ({ name, command: "true", resources: [] }));
  // os.tmpdir() reads TMPDIR on every call, so the fallback dir lands in tempHome.
  process.env.TMPDIR = tempHome;
  const summary = runGate(config, { featureId: "current" });
  assert.equal(summary.ok, true, "BUGHUNT-F8 the pooled gate itself must pass");
  const leftovers = readdirSync(tempHome).filter((entry) => entry.startsWith("autobuild-gate-"));
  assert.deepEqual(leftovers, [], `BUGHUNT-F8 a pooled gate run left its step-log temp directory behind: ${leftovers.join(", ")}`);
  assert.equal(execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" }), "");
});
