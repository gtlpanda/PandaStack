// ci-optimizer CO-05 implementation tests: the edges the frozen acceptance file does not pin
// (whole-number weights from fractional timings, own-property lookups, placement order, malformed
// profiles, stale or non-improving plans, a linked autobuild.json, file mode, a config root below
// the git top level, and the human dry-run output).
// Offline: throwaway git repos and a private AUTOBUILD_STATE_HOME per test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CLI } from "../test-fixtures/project.mjs";
import { applyShardWeights, configIsCommitted, measuredSeconds, planShardWeights, shardCountFromProfile } from "../lib/ci/apply.mjs";
import { loadConfig } from "../lib/config.mjs";

const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LANG: "C",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
};

function tempDir(t, prefix = "ci-apply-") {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd, ...args) {
  const r = spawnSync("git", ["-c", "init.defaultBranch=main", ...args], { cwd, env: { ...process.env, ...GIT_ENV }, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
}

/** A git repo holding `files`, committed unless `commit` is false. */
function gitRepo(t, files, { commit = true } = {}) {
  const dir = tempDir(t);
  writeFiles(dir, files);
  git(dir, "init", "-q");
  if (commit) {
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "fixture");
  }
  return dir;
}

function runCi(cwd, args, stateHome) {
  const r = spawnSync(process.execPath, [CLI, "ci", ...args], { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV, AUTOBUILD_STATE_HOME: stateHome }, timeout: 120_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const fullRecord = (steps) => ({ at: "2026-11-22T10:00:00.000Z", type: "gate", phase: "full", ok: true, wallSeconds: 10, steps });
const jsonl = (records) => `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
const GATE = [
  { name: "A", command: "true", shardWeight: 6 }, { name: "B", command: "true", shardWeight: 1 },
  { name: "C", command: "true", shardable: true }, { name: "D", command: "true" },
];
const TIMINGS = [fullRecord([{ name: "A", ok: true, seconds: 10 }, { name: "B", ok: true, seconds: 50 }, { name: "C", ok: true, seconds: 30 }, { name: "D", ok: true, seconds: 5 }])];

/** autobuild.json with GATE, logs/ ignored, timings written; `dir` puts the project below the git top. */
function shardProject(t, { dir = "" } = {}) {
  const repo = gitRepo(t, {
    ".gitignore": "logs/\n",
    [path.join(dir, "autobuild.json")]: { backend: "claude", gate: GATE, gateCache: false },
  });
  writeFiles(repo, { [path.join(dir, "logs", "gate-timings.jsonl")]: jsonl(TIMINGS) });
  return path.join(repo, dir);
}

// ---------- measuredSeconds ----------

test("measuredSeconds: malformed records and steps are skipped; non-string names never become keys", () => {
  const records = [
    null, "text", fullRecord("not a list"),
    fullRecord([{ name: 7, seconds: 4 }, { seconds: 4 }, { name: "ok", seconds: "9" }, { name: "ok", seconds: 3 }, null]),
  ];
  assert.deepEqual(measuredSeconds(records), { ok: 3 });
});

// ---------- planShardWeights ----------

test("planShardWeights: a fractional measurement becomes a whole-number weight of at least 1", () => {
  const entries = [{ name: "A", shardWeight: 1 }, { name: "B", shardWeight: 1 }, { name: "Z", shardWeight: 2 }];
  const plan = planShardWeights(entries, { A: 12.6, B: 0.2, Z: 2 }, 2);
  assert.deepEqual(plan.changes, [{ step: "A", from: 1, to: 13 }]);
  for (const change of plan.changes) assert.ok(Number.isInteger(change.to) && change.to >= 1);
  // B's 0.2 s rounds to weight 1, which it already has: no change.
  assert.equal(plan.changes.some((c) => c.step === "B"), false);
});

test("planShardWeights: names are looked up as own properties, so a step called constructor is unmeasured", () => {
  const plan = planShardWeights([{ name: "constructor", shardWeight: 2 }, { name: "toString" }], {}, 2);
  assert.deepEqual(plan.unmeasured, ["constructor", "toString"]);
  assert.deepEqual(plan.changes, []);
  assert.equal(plan.before.maxShardSeconds, 2, "an unmeasured job counts its weight");
});

test("planShardWeights: shards list ids in placement order (heaviest weight first) and omit shardable ids", () => {
  const entries = [{ name: "light", shardWeight: 1 }, { name: "S", shardable: true }, { name: "heavy", shardWeight: 9 }, { name: "mid", shardWeight: 5 }];
  const plan = planShardWeights(entries, {}, 1);
  assert.deepEqual(plan.before.shards, [["heavy", "mid", "light"]]);
  assert.equal(plan.before.maxShardSeconds, 15, "an unmeasured shardable entry adds 0 seconds");
});

test("planShardWeights: no gate entries and nothing measured gives empty shards and no improvement", () => {
  const plan = planShardWeights([], {}, 3);
  assert.deepEqual(plan.before, { maxShardSeconds: 0, shards: [[], [], []] });
  assert.equal(plan.improves, false);
});

test("planShardWeights: a shard count that is not a whole number of at least 1 throws", () => {
  for (const bad of [0, -1, 1.5, "2", null]) assert.throws(() => planShardWeights(GATE, {}, bad), TypeError);
});

// ---------- shardCountFromProfile ----------

test("shardCountFromProfile: malformed profiles and non-positive matrix sizes give null", () => {
  const job = (matrixSize, steps) => ({ id: "j", matrixSize, steps });
  const sharded = [{ kind: "test", run: "x --shard 1/2" }];
  const profile = (...jobs) => ({ ci: { workflows: [{ jobs }] } });
  for (const value of [null, undefined, {}, { ci: null }, { ci: { workflows: "x" } }, { ci: { workflows: [null, { jobs: null }] } }]) {
    assert.equal(shardCountFromProfile(value), null);
  }
  assert.equal(shardCountFromProfile(profile(job(0, sharded))), null);
  assert.equal(shardCountFromProfile(profile(job("3", sharded))), null);
  assert.equal(shardCountFromProfile(profile(job(3, [{ kind: "test", run: null }]))), null);
  assert.equal(shardCountFromProfile(profile(null, job(3, sharded))), 3);
});

// ---------- applyShardWeights ----------

test("applyShardWeights: refuses a plan that does not improve, and writes nothing", (t) => {
  const repo = shardProject(t);
  const before = readFileSync(path.join(repo, "autobuild.json"), "utf8");
  const plan = { ...planShardWeights(GATE, { A: 10, B: 50, C: 30, D: 5 }, 2), improves: false };
  assert.throws(() => applyShardWeights(repo, plan), (error) => error.code === "NO_IMPROVEMENT" && error.exit === 1);
  assert.equal(readFileSync(path.join(repo, "autobuild.json"), "utf8"), before);
});

test("applyShardWeights: a plan the file no longer matches is PLAN_STALE and nothing is written", (t) => {
  const repo = shardProject(t);
  const plan = planShardWeights(GATE, { A: 10, B: 50, C: 30, D: 5 }, 2);
  writeFiles(repo, { "autobuild.json": { backend: "claude", gate: [{ ...GATE[0], shardWeight: 7 }, ...GATE.slice(1)] } });
  const edited = readFileSync(path.join(repo, "autobuild.json"), "utf8");
  assert.throws(() => applyShardWeights(repo, plan), (error) => error.code === "PLAN_STALE");
  assert.equal(readFileSync(path.join(repo, "autobuild.json"), "utf8"), edited);
  writeFiles(repo, { "autobuild.json": { backend: "claude", gate: GATE.filter((entry) => entry.name !== "B") } });
  assert.throws(() => applyShardWeights(repo, plan), (error) => error.code === "PLAN_STALE" && /"B"/.test(error.message));
});

test("applyShardWeights: a linked autobuild.json is refused and the link target is untouched", (t) => {
  const repo = shardProject(t);
  const target = path.join(tempDir(t, "ci-apply-target-"), "real.json");
  writeFileSync(target, readFileSync(path.join(repo, "autobuild.json")));
  rmSync(path.join(repo, "autobuild.json"));
  symlinkSync(target, path.join(repo, "autobuild.json"));
  const before = readFileSync(target, "utf8");
  const plan = planShardWeights(GATE, { A: 10, B: 50, C: 30, D: 5 }, 2);
  assert.throws(() => applyShardWeights(repo, plan), (error) => error.code === "CONFIG_UNSAFE");
  assert.equal(readFileSync(target, "utf8"), before);
});

test("applyShardWeights: the rewritten file keeps its mode and still loads as a valid config", (t) => {
  const repo = shardProject(t);
  chmodSync(path.join(repo, "autobuild.json"), 0o640);
  const plan = planShardWeights(GATE, { A: 10.4, B: 50, C: 30, D: 5 }, 2);
  assert.equal(plan.improves, true);
  applyShardWeights(repo, plan);
  assert.equal(statSync(path.join(repo, "autobuild.json")).mode & 0o777, 0o640);
  const loaded = loadConfig(repo, {});
  assert.deepEqual(loaded.gate.map((entry) => entry.shardWeight), [10, 50, undefined, 5]);
});

// ---------- configIsCommitted ----------

test("configIsCommitted: no HEAD, a staged edit, and a clean tracked file", (t) => {
  const fresh = gitRepo(t, { "autobuild.json": "{}\n" }, { commit: false });
  git(fresh, "add", "autobuild.json");
  assert.equal(configIsCommitted(fresh), false, "tracked but no HEAD to compare against");
  const repo = gitRepo(t, { "autobuild.json": "{}\n" });
  assert.equal(configIsCommitted(repo), true);
  writeFileSync(path.join(repo, "autobuild.json"), '{"a":1}\n');
  git(repo, "add", "autobuild.json");
  assert.equal(configIsCommitted(repo), false, "a staged edit still differs from HEAD");
  writeFileSync(path.join(repo, "autobuild.json"), "{}\n");
  assert.equal(git(repo, "diff", "--quiet", "HEAD", "--", "autobuild.json"), "", "fixture guard: the working tree matches HEAD again");
  assert.equal(configIsCommitted(repo), false, "a staged edit reverted only in the working tree is still not clean");
});

// ---------- CLI ----------

test("ci apply --dry-run prints the plan and a dry-run line, and writes nothing", (t) => {
  const repo = shardProject(t);
  const before = readFileSync(path.join(repo, "autobuild.json"), "utf8");
  const result = runCi(repo, ["apply", "--dry-run", "--shards", "2"], tempDir(t, "ci-apply-state-"));
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.stdout.trimEnd().split("\n"), [
    "shards: 2",
    "slowest shard before: 85s, after: 80s (computed from measured durations)",
    "  A: shardWeight 6 -> 10",
    "  B: shardWeight 1 -> 50",
    "  D: shardWeight unset -> 5",
    "unmeasured: none",
    "apply: dry run (nothing written)",
  ]);
  assert.equal(readFileSync(path.join(repo, "autobuild.json"), "utf8"), before);
});

test("ci apply works when autobuild.json sits below the git top level", (t) => {
  const project = shardProject(t, { dir: "service" });
  const result = runCi(project, ["apply", "--shards", "2"], tempDir(t, "ci-apply-state-"));
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^apply: wrote autobuild\.json$/m);
  assert.deepEqual(JSON.parse(readFileSync(path.join(project, "autobuild.json"), "utf8")).gate.map((e) => e.shardWeight), [10, 50, undefined, 5]);
  assert.equal(git(project, "status", "--porcelain"), "M service/autobuild.json");
});

test("ci apply: a repeated --shards is a usage error; loop-only timings are NO_TIMINGS", (t) => {
  const state = tempDir(t, "ci-apply-state-");
  const repo = shardProject(t);
  const twice = runCi(repo, ["apply", "--shards", "2", "--shards", "3"], state);
  assert.equal(twice.code, 2);
  assert.match(twice.stderr, /^autobuild ci: USAGE: /m);
  writeFiles(repo, { "logs/gate-timings.jsonl": jsonl([{ type: "loop", iteration: 1 }]) });
  const none = runCi(repo, ["apply", "--shards", "2"], state);
  assert.equal(none.code, 2);
  assert.match(none.stderr, /^autobuild ci: NO_TIMINGS: /m);
});
