// A pooled gate run prunes old step-log run directories under <logsDir>/gate. If a session has
// planted <logsDir>/gate as a symlink to a directory outside the project, pruning must not delete
// anything there.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.AUTOBUILD_STATE_HOME = mkdtempSync(path.join(tmpdir(), "autobuild-state-"));

const { project } = await import("../test-fixtures/project.mjs");
const { loadConfig } = await import("../lib/config.mjs");
await import("../lib/gate-pool.mjs");
const { runGate } = await import("../lib/gate.mjs");

test("pool log pruning does not delete through a symlinked logs/gate directory", (t) => {
  const root = project(["current", "prior"]);
  const outside = mkdtempSync(path.join(tmpdir(), "autobuild-outside-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  const names = [];
  for (let i = 0; i < 15; i += 1) {
    const name = `precious-${String(i).padStart(2, "0")}`;
    names.push(name);
    mkdirSync(path.join(outside, name));
    writeFileSync(path.join(outside, name, "data.txt"), "keep me\n");
  }
  mkdirSync(path.join(root, "logs"), { recursive: true }); // logs/ is gitignored by the fixture
  symlinkSync(outside, path.join(root, "logs", "gate"), "dir");

  const config = loadConfig(root, {});
  config.runners.unit.command = "true";
  config.gateConcurrency = 2;
  config.gateMinFreeMb = 0;
  config.gate = ["a", "b"].map((name) => ({ name, command: "true", resources: [] }));
  runGate(config, { featureId: "current" });

  const remaining = readdirSync(outside).filter((entry) => entry.startsWith("precious-"));
  assert.deepEqual(remaining, names, `BUGHUNT-F10 log pruning deleted ${names.length - remaining.length} entries outside the project through the logs/gate symlink`);
});
