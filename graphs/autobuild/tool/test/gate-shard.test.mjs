// `autobuild check --shard i/n`: n shards together run every gate step exactly once (a
// shardable step runs in each shard and learns its part from AUTOBUILD_SHARD); a step left
// to another shard is reported as skipped, never as passed; the split depends on the config
// alone, and one shard's cached PASS is never reused for another.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.AUTOBUILD_STATE_HOME = mkdtempSync(path.join(tmpdir(), "autobuild-state-"));

const { project } = await import("../test-fixtures/project.mjs");
const { loadConfig } = await import("../lib/config.mjs");
const { runGate, parseShard, shardPlan } = await import("../lib/gate.mjs");

// Each gate command appends "<name>:<AUTOBUILD_SHARD or ->" to a file outside the tree.
function fixture(t, entries) {
  const root = project([]);
  const outside = mkdtempSync(path.join(tmpdir(), "autobuild-shard-calls-"));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  const callsFile = path.join(outside, "calls");
  const config = loadConfig(root, {});
  config.gate = entries.map(({ name, ...keys }) => ({ name, command: `printf '%s:%s\\n' ${name} "\${AUTOBUILD_SHARD:--}" >> ${callsFile}`, ...keys }));
  const calls = () => (existsSync(callsFile) ? readFileSync(callsFile, "utf8").trim().split("\n") : []);
  const reset = () => rmSync(callsFile, { force: true });
  return { config, calls, reset };
}
const PARITY = "CI parity configuration";
const ran = (summary) => summary.steps.filter((step) => step.name !== PARITY).map((step) => step.name);

test("three shards run every whole step exactly once and the shardable step in each, with its part", (t) => {
  const { config, calls, reset } = fixture(t, [
    { name: "a", shardWeight: 5 }, { name: "b", shardWeight: 4 }, { name: "c", shardWeight: 3 },
    { name: "d", shardWeight: 3 }, { name: "e" }, { name: "w", shardable: true },
  ]);
  const seen = [];
  for (let index = 1; index <= 3; index++) {
    reset();
    const summary = runGate(config, { shard: { index, count: 3 } });
    assert.equal(summary.ok, true);
    assert.equal(summary.shard, `${index}/3`);
    assert.ok(summary.steps.some((step) => step.name === PARITY), "the configuration check runs in every shard");
    assert.ok(calls().includes(`w:${index}/3`), `the shardable step ran with AUTOBUILD_SHARD=${index}/3`);
    for (const line of calls().filter((l) => !l.startsWith("w:"))) assert.match(line, /:-$/, "a whole step does not see AUTOBUILD_SHARD");
    // Reported steps and executed commands agree; every other step is skipped with its owner named.
    assert.deepEqual(ran(summary).sort(), calls().map((l) => l.split(":")[0]).sort());
    for (const entry of summary.skipped) assert.match(entry.reason, /^runs in shard [1-3]\/3$/);
    assert.equal(ran(summary).length + summary.skipped.length, 6);
    seen.push(...calls().map((l) => l.split(":")[0]).filter((name) => name !== "w"));
  }
  assert.deepEqual(seen.sort(), ["a", "b", "c", "d", "e"], "each whole step ran in exactly one shard");
});

test("a failing step fails only the shard that owns it; the others report it skipped", (t) => {
  const { config } = fixture(t, [{ name: "ok1" }, { name: "ok2" }]);
  config.gate.push({ name: "broken", command: "exit 3", shardWeight: 9 });
  const results = [1, 2].map((index) => runGate(config, { shard: { index, count: 2 } }));
  const owner = results.findIndex((summary) => summary.steps.some((step) => step.name === "broken"));
  assert.notEqual(owner, -1, "some shard ran the failing step");
  assert.equal(results[owner].ok, false);
  assert.equal(results[1 - owner].ok, true);
  assert.ok(results[1 - owner].skipped.some((entry) => entry.name === "broken" && entry.reason === `runs in shard ${owner + 1}/2`));
});

test("the split is a pure function of the jobs: deterministic and balanced by shardWeight", () => {
  const jobs = [["a", 5], ["b", 4], ["c", 3], ["d", 3], ["e", 2], ["f", 1]].map(([id, shardWeight]) => ({ id, name: id, spec: {}, shardWeight }));
  const plan = shardPlan(jobs, 2);
  assert.deepEqual(Object.fromEntries(plan), { a: 1, b: 2, c: 2, d: 1, e: 2, f: 1 });
  assert.deepEqual(Object.fromEntries(shardPlan(jobs, 2)), Object.fromEntries(plan), "same input, same split");
  const loads = [0, 0];
  for (const job of jobs) loads[plan.get(job.id) - 1] += job.shardWeight;
  assert.deepEqual(loads, [9, 9]);
  // One shard per step when there are more shards than steps; the extra shards get none.
  assert.deepEqual([...shardPlan(jobs.slice(0, 2), 4).values()], [1, 2]);
  // Settled and shardable jobs belong to every shard (0).
  assert.deepEqual(Object.fromEntries(shardPlan([{ id: "cfg", result: { ok: true } }, { id: "w", spec: {}, shardable: true }, { id: "x", spec: {} }], 3)), { cfg: 0, w: 0, x: 1 });
});

test("with gateCache, one shard's PASS of the shardable step is not reused for another shard", (t) => {
  const { config, calls, reset } = fixture(t, [{ name: "w", shardable: true }]);
  config.gateCache = true;
  runGate(config, { shard: { index: 1, count: 2 } });
  reset();
  const second = runGate(config, { shard: { index: 2, count: 2 } });
  assert.deepEqual(calls(), ["w:2/2"], "shard 2 ran its own part");
  assert.equal(second.steps.find((step) => step.name === "w").cached, undefined);
  reset();
  const again = runGate(config, { shard: { index: 2, count: 2 } });
  assert.deepEqual(calls(), [], "the same shard on the same tree may reuse its own PASS");
  assert.equal(again.steps.find((step) => step.name === "w").cached, true);
});

test("parseShard accepts i/n with 1 <= i <= n and nothing else", () => {
  assert.equal(parseShard(undefined), null);
  assert.deepEqual(parseShard("1/1"), { index: 1, count: 1 });
  assert.deepEqual(parseShard("2/3"), { index: 2, count: 3 });
  assert.deepEqual(parseShard("12/12"), { index: 12, count: 12 });
  for (const bad of ["0/3", "4/3", "1/0", "01/3", "1/03", "a/b", "1/3x", " 1/3", "1/3 ", "1", "1/2/3", "-1/3", ""]) {
    assert.throws(() => parseShard(bad), /--shard must be i\/n/, bad);
  }
});

test("--shard is refused outside the full gate, and shard keys are validated", (t) => {
  const { config } = fixture(t, [{ name: "a" }]);
  assert.throws(() => runGate(config, { focused: true, shard: { index: 1, count: 2 } }), /only to the full gate/);
  const root = config.root;
  for (const [entry, message] of [
    [{ name: "x", command: "true", shardable: "yes" }, /shardable must be true or false/],
    [{ name: "x", command: "true", shardWeight: 0 }, /shardWeight must be a whole number of at least 1/],
    [{ name: "x", command: "true", shardWeight: 1.5 }, /shardWeight must be a whole number of at least 1/],
    [{ name: "x", command: "true", shardable: true, shardWeight: 3 }, /shardWeight applies only to a step that is not shardable/],
  ]) {
    const file = path.join(root, "autobuild.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), gate: [entry] }));
    assert.throws(() => loadConfig(root, {}), message, JSON.stringify(entry));
  }
});

test("shard keys on a runner are ignored: only gate entries can be shardable or weighted", (t) => {
  const { config } = fixture(t, [{ name: "a" }]);
  // One passing feature, so the gate has a "passing features: unit" runner job.
  const featuresFile = path.join(config.root, "features.json");
  writeFileSync(featuresFile, JSON.stringify({ features: [{ id: "done", title: "done", dependencies: [], test: "tests/done.test", testKind: "unit", passes: true }] }));
  mkdirSync(path.join(config.root, "tests"), { recursive: true });
  writeFileSync(path.join(config.root, "tests", "done.test"), "");
  config.runners.unit.command = "true";
  config.runners.unit.shardable = true;
  const results = [1, 2].map((index) => runGate(config, { shard: { index, count: 2 } }));
  for (const summary of results) assert.equal(summary.ok, true, JSON.stringify(summary.steps));
  const owners = results.filter((summary) => summary.steps.some((step) => step.name.startsWith("passing features")));
  assert.equal(owners.length, 1, "the runner job runs in exactly one shard, not every shard");
});
