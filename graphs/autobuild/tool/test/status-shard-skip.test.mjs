// `autobuild status` must not say a step left to another shard was skipped for "no path match".
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.AUTOBUILD_STATE_HOME = mkdtempSync(path.join(tmpdir(), "autobuild-state-"));

const { project } = await import("../test-fixtures/project.mjs");
const { loadConfig } = await import("../lib/config.mjs");
const { runGate } = await import("../lib/gate.mjs");
const { readTimings } = await import("../lib/gate-timings.mjs");
const { timingReport } = await import("../lib/cli.mjs");

test("status does not label a step skipped by sharding as '(no path match)'", (t) => {
  const root = project([]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = loadConfig(root, {});
  config.gate = [{ name: "a", command: "true", shardWeight: 5 }, { name: "b", command: "true", shardWeight: 4 }];
  const summary = runGate(config, { shard: { index: 1, count: 2 } });
  const shardSkipped = summary.skipped.filter((entry) => /^runs in shard/.test(entry.reason));
  assert.equal(shardSkipped.length, 1, "exactly one step is left to the other shard");

  const records = readTimings(config);
  assert.equal(records.length, 1, "the gate run was recorded in the timings file");
  const report = timingReport(records).join("\n");
  const line = report.split("\n").find((l) => l.includes("SKIP") && l.includes(shardSkipped[0].name));
  assert.ok(line, `status lists the skipped step ${shardSkipped[0].name}:\n${report}`);
  assert.doesNotMatch(line, /no path match/, `status says "${line.trim()}" for a step skipped by sharding, though no path selection ran`);
});

test("status names the owning shard, and a record without skipReasons still reads (no path match)", () => {
  const record = { type: "gate", at: "t", caller: "check", feature: null, scope: "full", ok: true, wallSeconds: 1, steps: [], notRun: [] };
  const sharded = timingReport([{ ...record, skipped: ["b"], skipReasons: { b: "runs in shard 2/2" } }]).join("\n");
  assert.match(sharded, /SKIP +b \(runs in shard 2\/2\)/);
  const old = timingReport([{ ...record, skipped: ["b"] }]).join("\n");
  assert.match(old, /SKIP +b \(no path match\)/);
});
