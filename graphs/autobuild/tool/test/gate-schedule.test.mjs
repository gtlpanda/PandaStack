// The gate's schedule: order, fail-fast, reuse of a PASS on an unchanged tree, side-by-side steps
// with resource and memory rules, path selection, and kept timings. None of these may change
// what a default config runs, and none may report a step that did not run as passed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.AUTOBUILD_STATE_HOME = mkdtempSync(path.join(tmpdir(), "autobuild-state-"));

const { project, head, run } = await import("../test-fixtures/project.mjs");
const { loadConfig } = await import("../lib/config.mjs");
const { runGate, gateLine, reuseLines } = await import("../lib/gate.mjs");
const { cacheDigest, cacheFile, dropCache, treeDigest } = await import("../lib/gate-cache.mjs");
const { memAvailableMb, runPool } = await import("../lib/gate-pool.mjs");
const { readTimings, gateTotals, TIMINGS_FILE } = await import("../lib/gate-timings.mjs");
const { finishCodexBuilder, finishCodexReview } = await import("../lib/codex-gate.mjs");
const { loopState, timingReport } = await import("../lib/cli.mjs");

// A project whose commands record their name in a file outside the tree (so running them does not change it).
function fixture(t, { gate = ["a", "b", "c"], seconds = {} } = {}) {
  const root = project(["current", "prior"]);
  // A web/ area, so a `paths: ["web/**"]` entry names something that exists.
  execFileSync("mkdir", ["-p", path.join(root, "web")]);
  writeFileSync(path.join(root, "web", "index.js"), "1\n");
  execFileSync("git", ["-C", root, "add", "-A"]); execFileSync("git", ["-C", root, "commit", "-q", "-m", "web"]);
  const outside = mkdtempSync(path.join(tmpdir(), "autobuild-calls-"));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  const callsFile = path.join(outside, "calls");
  const say = (word, extra = "") => `${seconds[word] ? `sleep ${seconds[word]}; ` : ""}printf '%s\\n' ${word} >> ${callsFile}${extra}`;
  const config = loadConfig(root, {});
  config.runners.unit.command = `bash -c 'printf "test:%s\\n" "$@" >> ${callsFile}' _`;
  config.gate = gate.map((name) => ({ name, command: say(name) }));
  const calls = () => (existsSync(callsFile) ? readFileSync(callsFile, "utf8").trim().split("\n") : []);
  const reset = () => rmSync(callsFile, { force: true });
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  return { root, config, calls, reset, say, git, callsFile };
}
// Every full gate also checks the CI-parity configuration (instant here: the fixture has no CI); left out of the comparisons.
const PARITY = "CI parity configuration";
const names = (summary) => summary.steps.filter((step) => step.name !== PARITY).map((step) => `${step.name}:${step.ok ? "ok" : "FAIL"}${step.cached ? ":cached" : ""}`);

test("a config without the new keys runs every step, in order, every time", (t) => {
  const { config, calls } = fixture(t);
  assert.deepEqual([config.gateConcurrency, config.gateOrder, config.gateCache, config.claudeGate], [1, "config", false, "hook"]);
  const first = runGate(config, { featureId: "current", baseSha: head(config.root) });
  const second = runGate(config, { featureId: "current", baseSha: head(config.root) });
  assert.deepEqual(calls(), ["test:tests/current.test", "a", "b", "c", "test:tests/current.test", "a", "b", "c"]);
  assert.deepEqual(names(first), ["frozen files unchanged:ok", "run evidence kept out of git:ok", "current feature current: unit (1 file):ok", "a:ok", "b:ok", "c:ok"]);
  assert.deepEqual(names(second), names(first));
  assert.deepEqual([first.skipped, first.notRun], [[], []]);
});

test("gateOrder fastest: the feature's own test, then what failed last time, then the shortest recorded step", (t) => {
  const { config, calls, reset, say } = fixture(t, { gate: ["slow", "quick", "flaky"], seconds: { slow: 1.2 } });
  config.gateOrder = "fastest";
  const flag = path.join(path.dirname(config.root), `flag-${path.basename(config.root)}`);
  t.after(() => rmSync(flag, { force: true }));
  config.gate[2].command = say("flaky", `; test -e ${flag}`);
  // Nothing recorded yet: config order.
  const first = runGate(config, { featureId: "current" });
  assert.deepEqual(calls(), ["test:tests/current.test", "slow", "quick", "flaky"]);
  assert.equal(first.ok, false);
  reset();
  // flaky failed, so it leads; quick was faster than slow. With fail-fast the failure costs no slow step.
  const second = runGate(config, { featureId: "current", failFast: true });
  assert.deepEqual(calls(), ["test:tests/current.test", "flaky"]);
  assert.deepEqual(second.notRun, ["slow", "quick", PARITY]);
  assert.equal(second.ok, false);
  assert.ok(!second.steps.some((step) => ["slow", "quick"].includes(step.name)), "a step that did not run is not a step result");
  reset();
  writeFileSync(flag, "");
  const third = runGate(config, { featureId: "current", failFast: true });
  assert.deepEqual(calls(), ["test:tests/current.test", "flaky", "quick", "slow"]);
  // Reported in the gate's fixed order whatever order it ran in.
  assert.deepEqual(names(third), ["current feature current: unit (1 file):ok", "slow:ok", "quick:ok", "flaky:ok"]);
  reset();
  // It passed, so it no longer jumps the queue: quick, flaky (both instant, config order), then slow.
  runGate(config, { featureId: "current" });
  assert.equal(calls().at(-1), "slow");
});

test("fail-fast covers every kind of step: a later failing suite is reached before earlier long ones once it has failed", (t) => {
  const { config, calls, reset } = fixture(t, { gate: ["long"], seconds: { long: 1.2 } });
  const doc = JSON.parse(readFileSync(path.join(config.root, "features.json"), "utf8"));
  doc.features[1].passes = true;
  writeFileSync(path.join(config.root, "features.json"), JSON.stringify(doc));
  config.runners.unit.command = "false";
  // In config order the failing suite waits behind the long entry.
  config.gateOrder = "config";
  const serial = runGate(config, { failFast: true });
  assert.deepEqual(calls(), ["long"]);
  assert.deepEqual(names(serial), ["long:ok", "passing features: unit (1 file):FAIL"]);
  reset();
  // Fastest: it failed last time, so it runs first and stops the gate.
  config.gateOrder = "fastest";
  const second = runGate(config, { failFast: true });
  assert.deepEqual(calls(), [], "the suite that failed last time ran first and stopped the gate");
  assert.deepEqual(second.notRun, ["long", PARITY]);
  // With nothing recorded at all, the passing features' tests still go before the gate entries.
  dropCache(config);
  const fresh = runGate(config, { failFast: true });
  assert.deepEqual(calls(), []);
  assert.deepEqual(fresh.notRun, ["long"]);
});

test("gateCache reuses a PASS only while the tree's content, the step and its env are unchanged", (t) => {
  const { root, config, calls, reset, say, git } = fixture(t, { gate: ["a", "b"] });
  config.gateCache = true;
  const gateCalls = () => calls().filter((word) => !word.startsWith("test:"));
  const base = head(root);
  runGate(config, { baseSha: base });
  assert.deepEqual(calls(), ["a", "b"]);
  reset();

  const hit = runGate(config, { baseSha: base });
  assert.deepEqual(calls(), []);
  // The frozen and evidence checks are never reused.
  assert.deepEqual(names(hit), ["frozen files unchanged:ok", "run evidence kept out of git:ok", "a:ok:cached", "b:ok:cached"]);
  assert.equal(hit.steps[2].cachedFrom, base.slice(0, 12));
  assert.match(reuseLines(hit)[0], new RegExp(`reused 2 PASS result\\(s\\) from ${base.slice(0, 12)} \\(tree content unchanged\\): a, b`));

  // The progress file and the decision file are the loop's journal: a review that only appends there reuses.
  appendFileSync(path.join(root, "PROGRESS.md"), "\nREVIEW: no drift\n");
  writeFileSync(path.join(root, "DECISIONS.md"), "decided\n");
  // The loop flips `passes` after a gate; that alone is not a new tree.
  const doc = JSON.parse(readFileSync(path.join(root, "features.json"), "utf8"));
  doc.features[0].passes = true;
  writeFileSync(path.join(root, "features.json"), JSON.stringify(doc, null, 2));
  runGate(config, {});
  // The newly passing feature's suite is a new step; a and b are reused.
  assert.deepEqual(calls(), ["test:tests/current.test"]);
  reset();

  // A gate-config change: only the changed step runs again.
  config.gate[1].command = `${say("b")} # v2`;
  runGate(config, {});
  assert.deepEqual(gateCalls(), ["b"]);
  reset();
  // An env change reruns everything.
  config.env = { ...config.env, vars: { MODE: "x" } };
  runGate(config, {});
  assert.deepEqual(gateCalls(), ["a", "b"]);
  reset();
  runGate(config, {});
  assert.deepEqual(gateCalls(), []);

  // A code change, even untracked and uncommitted: miss.
  writeFileSync(path.join(root, "new-code.js"), "1\n");
  runGate(config, {});
  assert.deepEqual(gateCalls(), ["a", "b"]);
  reset();
  // Committing the same content is the same tree: hit, and the reuse names where it came from.
  git("add", "-A"); git("commit", "-q", "-m", "code");
  const committed = runGate(config, {});
  assert.deepEqual(gateCalls(), []);
  assert.match(committed.steps[0].cachedFrom, /\+uncommitted$/);
  // An edit to a tracked file: miss. A frozen test file is part of the tree too.
  writeFileSync(path.join(root, "tests", "prior.test"), "changed\n");
  runGate(config, {});
  assert.deepEqual(gateCalls(), ["a", "b"]);
  // A changed feature contract (not a passes flag): miss.
  reset();
  doc.features[0].title = "renamed";
  writeFileSync(path.join(root, "features.json"), JSON.stringify(doc, null, 2));
  runGate(config, {});
  assert.deepEqual(gateCalls(), ["a", "b"]);
});

test("a failure is never reused, and a step that changes the tree it ran on is not remembered", (t) => {
  const { root, config, calls, reset, say } = fixture(t, { gate: ["bad", "writer"] });
  config.gateCache = true;
  config.gate[0].command = say("bad", "; false");
  config.gate[1].command = say("writer", "; date +%N >> generated.txt");
  assert.equal(runGate(config, {}).ok, false);
  reset();
  assert.equal(runGate(config, {}).ok, false);
  assert.deepEqual(calls(), ["bad", "writer"]);
  assert.ok(existsSync(path.join(root, "generated.txt")));
  // With the cache off the file is never read for passes.
  config.gateCache = false;
  config.gate = [{ name: "a", command: say("a") }];
  runGate(config, {}); runGate(config, {});
  assert.deepEqual(calls().filter((word) => word === "a"), ["a", "a"]);
});

test("the gate's memory lives outside the project, and dropping it forgets every pass", (t) => {
  const { root, config, calls, reset } = fixture(t, { gate: ["a"] });
  config.gateCache = true;
  runGate(config, {});
  assert.ok(!path.resolve(cacheFile(config)).startsWith(`${path.resolve(root)}${path.sep}`));
  assert.equal(typeof cacheDigest(config), "string");
  assert.equal(typeof treeDigest(config), "string");
  dropCache(config);
  assert.equal(cacheDigest(config), null);
  reset();
  runGate(config, {});
  assert.deepEqual(calls(), ["a"]);
  // A corrupt file is no pass.
  writeFileSync(cacheFile(config), "{not json");
  reset();
  runGate(config, {});
  assert.deepEqual(calls(), ["a"]);
});

test("Codex: the post-review gate reuses the passes of the tree the review did not change, and says from which commit", (t) => {
  const { root, config, calls, reset } = fixture(t, { gate: ["a", "b"] });
  config.gateCache = true;
  config.backend = "codex";
  const base = head(root);
  runGate(config, { baseSha: base });
  reset();
  appendFileSync(path.join(root, "PROGRESS.md"), "\nREVIEW 2026-11-12: no drift or defects found\n");
  const logs = [];
  finishCodexReview(config, { base, exitCode: 0, result: { subtype: "success" }, log: (line) => logs.push(line) });
  assert.deepEqual(calls(), [], "no gate command ran again for a progress-only review");
  assert.match(logs.join("\n"), new RegExp(`review gate: reused 2 PASS result\\(s\\) from ${base.slice(0, 12)}`));
  assert.match(execFileSync("git", ["-C", root, "log", "-1", "--format=%s"], { encoding: "utf8" }), /^chore\(review\)/);
});

// ---------- side by side ----------

// A fake step runner: records overlap and finishes each job after its `ms`.
function poolHarness() {
  const active = new Set();
  const overlaps = [];
  let peak = 0;
  const run = (job) => new Promise((resolve) => {
    for (const other of active) overlaps.push([other, job.id].sort().join("+"));
    active.add(job.id);
    peak = Math.max(peak, active.size);
    setTimeout(() => { active.delete(job.id); resolve({ ok: job.ok !== false, status: job.ok === false ? 1 : 0, ms: job.ms ?? 20 }); }, job.ms ?? 20);
  });
  return { run, overlaps, peak: () => peak };
}
const job = (id, extra = {}) => ({ id, resources: [], memoryMb: 0, ...extra });

test("pool: at most gateConcurrency steps at once, and steps sharing a resource never overlap", async () => {
  const harness = poolHarness();
  const jobs = [job("p21-a", { resources: ["db:p21"] }), job("p21-b", { resources: ["db:p21"] }), job("p22", { resources: ["db:p22"] }), job("free-1"), job("free-2"), job("p21-c", { resources: ["db:p21", "port:5173"] }), job("port", { resources: ["port:5173"] })];
  const { results } = await runPool(jobs, { concurrency: 3, run: harness.run, memAvailable: () => null });
  assert.equal(Object.keys(results).length, jobs.length);
  assert.ok(harness.peak() <= 3 && harness.peak() >= 2, `peak ${harness.peak()}`);
  const forbidden = ["p21-a+p21-b", "p21-a+p21-c", "p21-b+p21-c", "p21-c+port"];
  assert.deepEqual(harness.overlaps.filter((pair) => forbidden.includes(pair)), []);
  assert.ok(harness.overlaps.length > 0, "unrelated steps did overlap");
});

test("pool: a step that declares no resources runs alone and keeps its place in the order", async () => {
  const harness = poolHarness();
  const { events } = await runPool([job("before"), job("legacy", { resources: null }), job("after-1"), job("after-2")], { concurrency: 4, run: harness.run, memAvailable: () => null });
  assert.deepEqual(harness.overlaps.filter((pair) => pair.includes("legacy")), []);
  const starts = events.filter((event) => event.type === "start").map((event) => event.id);
  assert.deepEqual(starts, ["before", "legacy", "after-1", "after-2"]);
  assert.ok(harness.overlaps.includes("after-1+after-2"));
});

test("pool: no new step starts under the memory floor; one step always runs; declared memory is reserved", async () => {
  // Free memory drops below the floor while anything runs.
  let free = 5000;
  const harness = poolHarness();
  const run = (j) => { free = 500; return harness.run(j).then((result) => { free = 5000; return result; }); };
  const { results, events } = await runPool([job("a"), job("b"), job("c")], { concurrency: 3, minFreeMb: 1024, run, memAvailable: () => free, pollMs: 5, startGapMs: 0 });
  assert.equal(Object.keys(results).length, 3, "the gate finishes: with nothing running a step is always admitted");
  assert.deepEqual(harness.overlaps, []);
  assert.equal(harness.peak(), 1);
  assert.ok(events.some((event) => event.type === "memory-wait"));

  // Plenty of memory: side by side.
  const roomy = poolHarness();
  await runPool([job("a"), job("b"), job("c")], { concurrency: 3, minFreeMb: 1024, run: roomy.run, memAvailable: () => 8000, startGapMs: 0 });
  assert.equal(roomy.peak(), 3);

  // 4000 MiB free, floor 1024: two 1500 MiB steps fit (the first one's share is reserved before it shows up), a third does not.
  const sized = poolHarness();
  await runPool([job("a", { memoryMb: 1500 }), job("b", { memoryMb: 1500 }), job("c", { memoryMb: 1500 })], { concurrency: 3, minFreeMb: 1024, run: sized.run, memAvailable: () => 4000, pollMs: 5, settleMs: 60_000, startGapMs: 0 });
  assert.ok(sized.peak() <= 2, `peak ${sized.peak()}`);

  // Memory frees up with no step ending: the waiting step still starts (the pool polls).
  let late = 100;
  const polled = poolHarness();
  setTimeout(() => { late = 9000; }, 30);
  const out = await runPool([job("a", { ms: 150 }), job("b")], { concurrency: 2, minFreeMb: 1024, run: polled.run, memAvailable: () => late, pollMs: 5, startGapMs: 0 });
  assert.ok(polled.overlaps.includes("a+b"));
  assert.equal(Object.keys(out.results).length, 2);

  // With a floor set, starts are spaced out so a burst cannot outrun the memory reading; with none, they are not.
  const spaced = poolHarness();
  const spacedRun = await runPool([job("a", { ms: 200 }), job("b", { ms: 200 }), job("c", { ms: 200 })], { concurrency: 3, minFreeMb: 1, run: spaced.run, memAvailable: () => 8000, pollMs: 5, startGapMs: 60 });
  const startTimes = spacedRun.events.filter((event) => event.type === "start").map((event) => event.at);
  assert.ok(startTimes[1] - startTimes[0] >= 55 && startTimes[2] - startTimes[1] >= 55, `starts ${startTimes.map((at) => at - startTimes[0])}`);
  assert.equal(spaced.peak(), 3);
  const burst = await runPool([job("a"), job("b"), job("c")], { concurrency: 3, minFreeMb: 0, run: poolHarness().run, memAvailable: () => 8000 });
  const burstTimes = burst.events.filter((event) => event.type === "start").map((event) => event.at);
  assert.ok(burstTimes[2] - burstTimes[0] < 50);

  assert.equal(memAvailableMb("/nonexistent/meminfo"), null);
  const meminfo = path.join(mkdtempSync(path.join(tmpdir(), "meminfo-")), "meminfo");
  writeFileSync(meminfo, "MemTotal:       16000000 kB\nMemAvailable:    2048000 kB\n");
  assert.equal(memAvailableMb(meminfo), 2000);
});

test("pool: fail-fast starts nothing new after the first failure, and results do not depend on completion order", async () => {
  const harness = poolHarness();
  const { results } = await runPool([job("bad", { ok: false, ms: 10 }), job("slow", { ms: 60 }), job("never-1"), job("never-2")], { concurrency: 2, failFast: true, run: harness.run, memAvailable: () => null });
  assert.deepEqual(Object.keys(results).sort(), ["bad", "slow"], "the running step finished; the rest never started");
  assert.equal(results.bad.ok, false);

  const order = async (lengths) => {
    const h = poolHarness();
    const { results: r } = await runPool(Object.entries(lengths).map(([id, ms]) => job(id, { ms, ok: id !== "y" })), { concurrency: 3, run: h.run, memAvailable: () => null });
    return Object.fromEntries(Object.entries(r).sort().map(([id, result]) => [id, result.ok]));
  };
  assert.deepEqual(await order({ x: 5, y: 30, z: 60 }), await order({ x: 60, y: 30, z: 5 }));
});

test("gateConcurrency through the real gate: shorter wall clock, same report, one log per step", (t) => {
  const words = ["a", "b", "c", "d", "e", "f"];
  const { root, config, calls } = fixture(t, { gate: words, seconds: Object.fromEntries(words.map((word) => [word, 1])) });
  config.gateConcurrency = 6;
  config.gateMinFreeMb = 0;
  for (const entry of config.gate) entry.resources = [];
  config.gate[4].resources = ["db:x"];
  config.gate[5].resources = ["db:x"];
  const started = Date.now();
  const summary = runGate(config, { featureId: "current" });
  const wall = Date.now() - started;
  assert.equal(summary.ok, true);
  assert.ok(wall < 4500, `six 1 s steps took ${wall} ms side by side`);
  assert.ok(wall >= 2000, "the two steps sharing db:x ran one after the other");
  assert.deepEqual(names(summary), ["current feature current: unit (1 file):ok", ...words.map((word) => `${word}:ok`)]);
  assert.deepEqual([...calls()].sort(), ["a", "b", "c", "d", "e", "f", "test:tests/current.test"]);
  const runs = readdirSync(path.join(root, "logs", "gate"));
  assert.equal(runs.length, 1);
  assert.equal(readdirSync(path.join(root, "logs", "gate", runs[0])).length, 7);
  assert.equal(execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" }), "", "step logs stay out of the tree");

  // A failing step among them: reported with its output, and the gate fails.
  config.gate[2].command = "echo boom-output; exit 3";
  const failed = runGate(config, { featureId: "current" });
  assert.equal(failed.ok, false);
  assert.match(failed.steps.find((step) => step.name === "c").tail, /boom-output[\s\S]*step log: /);
  // Entries without `resources` still run alone, in place.
  for (const entry of config.gate) delete entry.resources;
  config.gate[2].command = "true";
  const alone = Date.now();
  assert.equal(runGate(config, {}).ok, true);
  assert.ok(Date.now() - alone >= 5000, "undeclared entries were not run side by side");
});

// ---------- path selection ----------

test("scope affected runs the feature's test, entries whose paths the change touches and entries without paths; the rest are skipped, never passed", (t) => {
  const { root, config, calls, reset } = fixture(t, { gate: ["api", "web", "always"] });
  config.gate[0].paths = ["server/**", "shared/*.js"];
  config.gate[1].paths = ["web/**"];
  const base = head(root);
  execFileSync("mkdir", ["-p", path.join(root, "server", "routes")]);
  writeFileSync(path.join(root, "server", "routes", "a.js"), "1\n");
  const affected = runGate(config, { featureId: "current", baseSha: base, scope: "affected" });
  assert.deepEqual(calls(), ["test:tests/current.test", "api", "always"]);
  assert.deepEqual(affected.skipped, [{ name: "web", reason: "skipped (no path match)" }]);
  assert.ok(!affected.steps.some((step) => step.name === "web"));
  assert.equal(affected.scope, "affected");
  assert.match(gateLine(affected), /6 run, 0 cached, 1 skipped/);
  reset();
  // Committed changes count too, and near-miss paths do not match.
  execFileSync("git", ["-C", root, "add", "-A"]); execFileSync("git", ["-C", root, "commit", "-q", "-m", "wip"]);
  writeFileSync(path.join(root, "webby.js"), "1\n");
  execFileSync("mkdir", ["-p", path.join(root, "shared", "deep")]);
  writeFileSync(path.join(root, "shared", "deep", "x.js"), "1\n");
  runGate(config, { featureId: "current", baseSha: base, scope: "affected" });
  assert.deepEqual(calls(), ["test:tests/current.test", "api", "always"]);
  reset();
  // The full scope ignores paths; so does a gate with no base to diff against, or one git cannot diff.
  assert.deepEqual(runGate(config, { featureId: "current", baseSha: base }).skipped, []);
  assert.deepEqual(runGate(config, { featureId: "current", scope: "affected" }).skipped, []);
  assert.deepEqual(runGate(config, { featureId: "current", baseSha: "0".repeat(40), scope: "affected" }).skipped, []);
  assert.deepEqual(calls().filter((word) => word === "web").length, 3);
  assert.throws(() => runGate(config, { scope: "some" }), /Unknown gate scope/);
});

test("path selection: a moved file counts at its old path, a plain directory covers what is under it, and a glob matching nothing never skips", (t) => {
  const { root, config, calls, reset, git } = fixture(t, { gate: ["web", "api", "typo", "docs"] });
  config.gate[0].paths = ["web/**"];
  config.gate[1].paths = ["server/"];
  config.gate[2].paths = ["sever/**"];
  config.gate[3].paths = ["docs"];
  execFileSync("mkdir", ["-p", path.join(root, "web"), path.join(root, "server", "deep"), path.join(root, "docs")]);
  writeFileSync(path.join(root, "web", "page.js"), "export const page = 1; // a file long enough for git to see the move as a rename\n".repeat(5));
  writeFileSync(path.join(root, "web", "keep.js"), "1\n");
  writeFileSync(path.join(root, "server", "deep", "a.js"), "1\n");
  writeFileSync(path.join(root, "docs", "guide.md"), "guide\n");
  writeFileSync(path.join(root, "docs-extra.md"), "not under docs\n");
  git("add", "-A"); git("commit", "-q", "-m", "layout");
  const base = head(root);
  // Moved out of web/: only the new path would show with rename detection on.
  git("mv", "web/page.js", "elsewhere.js"); git("commit", "-q", "-m", "move");
  const moved = runGate(config, { featureId: "current", baseSha: base, scope: "affected" });
  assert.deepEqual(calls().filter((word) => !word.startsWith("test:")), ["web", "typo"]);
  assert.deepEqual(moved.skipped.map((entry) => entry.name), ["api", "docs"]);
  assert.match(moved.warnings.join("\n"), /typo: paths "sever\/\*\*" matches no file in the repository, so the step was run instead of skipped; fix the glob/);
  assert.ok(!moved.warnings.some((line) => /^(web|api|docs):/.test(line)), "a glob that matches a tracked or changed file is not called a typo");
  reset();
  // A plain directory name, with or without the slash, covers the tree under it and nothing beside it.
  const next = head(root);
  writeFileSync(path.join(root, "server", "deep", "a.js"), "2\n");
  writeFileSync(path.join(root, "docs-extra.md"), "changed\n");
  const deep = runGate(config, { featureId: "current", baseSha: next, scope: "affected" });
  assert.deepEqual(calls().filter((word) => !word.startsWith("test:")), ["api", "typo"]);
  assert.deepEqual(deep.skipped.map((entry) => entry.name), ["web", "docs"]);
});

test("the Stop hook's block reason keeps the failing output when later steps were not run", (t) => {
  const root = project(["F-1"]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const many = Array.from({ length: 60 }, (_, i) => ({ name: `a long descriptive step name number ${i} `.repeat(3).trim(), command: "true" }));
  const file = path.join(root, "autobuild.json");
  const doc = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...doc, gate: [{ name: "first", command: "seq 1 4000; echo THE-REAL-FAILURE-LINE; exit 1" }, ...many] }));
  execFileSync("git", ["-C", root, "commit", "-q", "-am", "config"]);
  execFileSync("mkdir", ["-p", path.join(root, ".harness")]);
  writeFileSync(path.join(root, ".harness", "session.json"), JSON.stringify({ role: "builder", featureId: "F-1", baseSha: head(root), stopAttempts: 0 }));
  writeFileSync(path.join(root, "F-1.done"), "built\n");
  const hook = path.resolve(import.meta.dirname, "..", "hooks", "stop-gate.mjs");
  const out = execFileSync(process.execPath, [hook], { cwd: root, input: "{}", encoding: "utf8", env: { ...process.env, AUTOBUILD_ACTIVE: "1", CLAUDE_PROJECT_DIR: root } });
  const reason = JSON.parse(out).reason;
  assert.ok(reason.length <= 9000);
  assert.match(reason, /60 later step\(s\) were not run after this failure\./);
  assert.match(reason, /THE-REAL-FAILURE-LINE\s*$/, "the end of the reason is the end of the failing output");
});

test("Codex host gate: an affected-scope pass commits the feature and logs what it skipped", (t) => {
  const { root, config, calls } = fixture(t, { gate: ["api", "web"] });
  config.gate[1].paths = ["web/**"];
  config.backend = "codex";
  execFileSync("mkdir", ["-p", path.join(root, config.stateDir)]);
  const docBefore = JSON.parse(readFileSync(path.join(root, "features.json"), "utf8"));
  const base = head(root), logs = [];
  writeFileSync(path.join(root, "PROGRESS.md"), "# progress\n## current — built\n");
  writeFileSync(path.join(root, "impl.js"), "1\n");
  const summary = finishCodexBuilder(config, { feature: docBefore.features[0], base, docBefore, exitCode: 0, result: { subtype: "success" }, log: (line) => logs.push(line), scope: "affected" });
  assert.equal(summary.scope, "affected");
  assert.deepEqual(calls(), ["test:tests/current.test", "api"]);
  assert.match(logs.join("\n"), /Codex host gate: web: skipped \(no path match\)/);
  assert.match(logs.join("\n"), /Codex host gate: PASS \(\d+s; 5 run, 0 cached, 1 skipped/);
  assert.notEqual(head(root), base);
});

// ---------- timings ----------

test("every gate run is appended to the timings file; a logs dir git does not ignore gets nothing", (t) => {
  const { root, config, say } = fixture(t, { gate: ["a", "b"] });
  config.gate[1].paths = ["web/**"];
  config.gateCache = true;
  const base = head(root);
  runGate(config, { featureId: "current", baseSha: base, scope: "affected", caller: "codex-host" });
  runGate(config, { featureId: "current", baseSha: base, caller: "final" });
  const records = readTimings(config);
  assert.equal(records.length, 2);
  assert.deepEqual(records[0].steps.map((step) => step.name), ["frozen files unchanged", "run evidence kept out of git", "current feature current: unit (1 file)", "a", PARITY]);
  assert.deepEqual([records[0].type, records[0].caller, records[0].feature, records[0].scope, records[0].ok, records[0].skipped], ["gate", "codex-host", "current", "affected", true, ["b"]]);
  assert.ok(records[0].steps.every((step) => Number.isInteger(step.seconds) && step.ok === true));
  assert.deepEqual(records[1].steps.filter((step) => step.cached).map((step) => step.name), ["current feature current: unit (1 file)", "a"]);
  assert.deepEqual(gateTotals(records, { feature: "current", sinceIso: records[0].at }), { runs: 2, seconds: records[0].wallSeconds + records[1].wallSeconds, run: 9, cached: 2, skipped: 1 });
  assert.equal(gateTotals(records, { feature: "other", sinceIso: records[0].at }).runs, 0);

  const report = timingReport([...records, { type: "iteration", feature: "current", outcome: "PASSED", sessionSeconds: 120, gateSeconds: 3600, run: 46, cached: 0, skipped: 0 }]).join("\n");
  assert.match(report, /current PASSED: session 120s, gate 3600s \(46 run, 0 cached, 0 skipped\)\s+WARNING: checking took longer than building/);
  assert.match(report, /last gate run .*final, current, full\): PASS/);

  // A link planted where the timings file goes is never written through.
  const linked = fixture(t, { gate: ["a"] });
  const target = path.join(mkdtempSync(path.join(tmpdir(), "autobuild-outside-")), "victim.txt");
  writeFileSync(target, "untouched\n");
  execFileSync("mkdir", ["-p", path.join(linked.root, "logs")]);
  execFileSync("ln", ["-s", target, path.join(linked.root, "logs", TIMINGS_FILE)]);
  assert.equal(runGate(linked.config, {}).ok, true);
  assert.equal(readFileSync(target, "utf8"), "untouched\n");

  // Not ignored: the file would be an untracked change in the tree under test.
  const bare = fixture(t, { gate: ["a"] });
  bare.config.logsDir = "visible-logs";
  runGate(bare.config, {});
  assert.ok(!existsSync(path.join(bare.root, "visible-logs")));
  assert.deepEqual(readTimings(bare.config), []);
  void say;
});

test("status reports a loop as running only while its pid is a live autobuild loop", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "autobuild-pid-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pidFile = path.join(dir, "loop.pid");
  assert.equal(loopState(pidFile), "no");
  writeFileSync(pidFile, "999999999");
  assert.match(loopState(pidFile), /^no \(stale pid file: pid 999999999 is not a running autobuild loop\)/);
  // A live pid that is not an autobuild loop (this test runner) is not one either.
  writeFileSync(pidFile, String(process.pid));
  assert.match(loopState(pidFile), /^no \(stale/);
  writeFileSync(pidFile, "garbage");
  assert.match(loopState(pidFile), /^no \(stale pid file: pid unreadable/);
});

// ---------- config ----------

test("malformed scheduling keys are refused when the config loads", (t) => {
  const root = project(["F-1"]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "autobuild.json");
  const original = JSON.parse(readFileSync(file, "utf8"));
  const load = (patch) => { writeFileSync(file, JSON.stringify({ ...original, ...patch })); return loadConfig(root, {}); };
  const step = (extra) => [{ name: "a", command: "true", ...extra }];
  assert.throws(() => load({ gateConcurrency: 0 }), /gateConcurrency/);
  assert.throws(() => load({ gateConcurrency: "4" }), /gateConcurrency/);
  assert.throws(() => load({ gateConcurrency: 2.5 }), /gateConcurrency/);
  assert.throws(() => load({ gateMinFreeMb: -1 }), /gateMinFreeMb/);
  assert.throws(() => load({ gateOrder: "random" }), /gateOrder/);
  assert.throws(() => load({ gateCache: "yes" }), /gateCache/);
  assert.throws(() => load({ claudeGate: "both" }), /claudeGate/);
  assert.throws(() => load({ gateCacheIgnore: "PROGRESS.md" }), /gateCacheIgnore/);
  assert.throws(() => load({ limits: { fullGateEvery: 0 } }), /fullGateEvery/);
  assert.throws(() => load({ limits: { stopHookTimeoutSeconds: 0 } }), /stopHookTimeoutSeconds/);
  assert.throws(() => load({ gate: step({ resources: "db" }) }), /gate\[0\]\.resources/);
  assert.throws(() => load({ gate: step({ resources: [""] }) }), /gate\[0\]\.resources/);
  assert.throws(() => load({ gate: step({ paths: [] }) }), /gate\[0\]\.paths must name at least one glob/);
  assert.throws(() => load({ gate: step({ paths: [1] }) }), /gate\[0\]\.paths/);
  assert.throws(() => load({ gate: step({ memoryMb: -5 }) }), /gate\[0\]\.memoryMb/);
  assert.throws(() => load({ runners: { unit: { command: "true", resources: 1 } } }), /runners\.unit\.resources/);
  assert.throws(() => load({ browser: { runner: "e2e", paths: "web" } }), /browser\.paths/);
  assert.throws(() => load({ gateCache: true, gate: [...step(), ...step()] }), /two entries named "a"/);
  // Duplicate names stay legal for a config that sets none of the keys.
  assert.equal(load({ gate: [...step(), ...step()] }).gate.length, 2);
  const ok = load({ gateConcurrency: 4, gateOrder: "fastest", gateCache: true, claudeGate: "host", gateMinFreeMb: 2048, limits: { fullGateEvery: 3 }, gate: step({ resources: ["db:x"], paths: ["src/**"], memoryMb: 512 }) });
  assert.deepEqual([ok.gateConcurrency, ok.limits.fullGateEvery, ok.limits.stopHookTimeoutSeconds, ok.gate[0].memoryMb], [4, 3, 2700, 512]);
});

// ---------- the loop, Claude backend ----------

// Rewrites the project's autobuild.json (committed, since the file is frozen for sessions).
function configure(root, patch) {
  const file = path.join(root, "autobuild.json");
  const doc = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...doc, ...patch, limits: { ...doc.limits, ...(patch.limits ?? {}) } }, null, 2));
  execFileSync("git", ["-C", root, "commit", "-q", "-am", "config"]);
}
const hookRuns = (root) => (existsSync(path.join(root, ".harness-script.json.hook")) ? readFileSync(path.join(root, ".harness-script.json.hook"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);
const passesOf = (root, id) => JSON.parse(readFileSync(path.join(root, "features.json"), "utf8")).features.find((feature) => feature.id === id).passes;

test("Claude: a gate longer than the Stop hook's timeout cannot let a feature pass unchecked", (t) => {
  const root = project(["F-1"], { maxIterations: 1, stopHookTimeoutSeconds: 1 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // The gate outlasts the 1 s hook, and it fails.
  configure(root, { gate: [{ name: "slow regression", command: "sleep 3; echo regression-broke; exit 1" }], limits: { maxIterations: 1, stopHookTimeoutSeconds: 1 } });
  const { code, loopLog } = run(root, [{ build: "F-1", stopHook: true }]);
  assert.deepEqual(hookRuns(root).map((entry) => entry.timedOut), [true], "the hook was killed at its timeout, as Claude Code does");
  assert.match(loopLog, /the Stop hook's gate did not finish and pass on the committed tree .*running the gate host-side/);
  assert.match(loopLog, /host gate: FAIL[\s\S]*slow regression: [\s\S]*regression-broke/);
  assert.match(loopLog, /iteration 1: F-1 FLAG_REVERTED/);
  assert.doesNotMatch(loopLog, /F-1 PASSED|every feature passes/);
  assert.equal(passesOf(root, "F-1"), false);
  assert.notEqual(code, 0);
  assert.match(execFileSync("git", ["-C", root, "log", "-1", "--format=%s"], { encoding: "utf8" }), /F-1 fails the gate after the session; passes reverted/);
  // The failure reaches the next session.
  const saved = JSON.parse(readFileSync(path.join(root, ".harness", "gate-feedback.json"), "utf8"));
  assert.equal(saved.feature, "F-1");
  assert.match(saved.feedback, /slow regression: [\s\S]*regression-broke/);
});

test("Claude: a hook that timed out on a passing gate is finished host-side, and the feature then passes", (t) => {
  const root = project(["F-1"], { stopHookTimeoutSeconds: 1 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  configure(root, { gate: [{ name: "slow regression", command: "sleep 3" }] });
  const { code, loopLog } = run(root, [{ build: "F-1", stopHook: true }]);
  assert.equal(code, 0, loopLog);
  assert.deepEqual(hookRuns(root).map((entry) => entry.timedOut), [true]);
  assert.match(loopLog, /running the gate host-side[\s\S]*host gate: PASS \(\d+s; 4 run, 0 cached, 0 skipped[\s\S]*iteration 1: F-1 PASSED/);
  assert.match(loopLog, /iteration 1: session \d+s, gate \d+s \(\d+ run, 0 cached, 0 skipped\)/);
});

test("Claude: a Stop hook gate that finished and passed on the committed tree is not run again", (t) => {
  const root = project(["F-1"]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const counter = path.join(mkdtempSync(path.join(tmpdir(), "autobuild-count-")), "count");
  configure(root, { bughunt: false, gate: [{ name: "regression", command: `echo run >> ${counter}` }] });
  const { code, loopLog } = run(root, [{ build: "F-1", stopHook: true }]);
  assert.equal(code, 0, loopLog);
  assert.deepEqual(hookRuns(root).map((entry) => [entry.timedOut, entry.stdout]), [[false, ""]], "the hook allowed the stop");
  assert.doesNotMatch(loopLog, /host-side/);
  assert.match(loopLog, /iteration 1: F-1 PASSED/);
  // Once in the hook, once in the loop's final full gate: no extra per-feature run.
  assert.equal(readFileSync(counter, "utf8").trim().split("\n").length, 2);
  const records = readTimings(loadConfig(root, {}));
  assert.deepEqual(records.filter((record) => record.type === "gate").map((record) => record.caller), ["stop-hook", "final"]);
  assert.equal(records.filter((record) => record.type === "iteration").length, 1);
});

test("Claude, claudeGate host: the hook runs only the feature's own test; the host runs the full gate and feeds a failure to the next session", (t) => {
  const root = project(["F-1"], { maxIterations: 3 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const flag = path.join(mkdtempSync(path.join(tmpdir(), "autobuild-flag-")), "fixed");
  configure(root, { claudeGate: "host", gateCache: true, gate: [{ name: "regression", command: `test -e ${flag} || { echo first-run-fails; touch ${flag}; exit 1; }` }] });
  const { code, calls, loopLog } = run(root, [{ build: "F-1", stopHook: true }, { build: "F-1", stopHook: true }]);
  assert.equal(code, 0, loopLog);
  const records = readTimings(loadConfig(root, {})).filter((record) => record.type === "gate");
  const hook = records.find((record) => record.caller === "stop-hook");
  assert.deepEqual(hook.steps.map((step) => step.name), ["frozen files unchanged", "run evidence kept out of git", "current feature F-1: unit (1 file)"]);
  assert.equal(hook.focused, true);
  assert.match(loopLog, /iteration 1: running the gate host-side\n[\s\S]*host gate: FAIL[\s\S]*first-run-fails[\s\S]*iteration 1: F-1 FLAG_REVERTED/);
  assert.match(loopLog, /iteration 2: running the gate host-side[\s\S]*host gate: PASS[\s\S]*iteration 2: F-1 PASSED/);
  assert.match(loopLog, /final full gate: reused \d+ PASS result\(s\) from [0-9a-f]{12}/);
  assert.equal(passesOf(root, "F-1"), true);
  assert.ok(calls.length >= 2);
  assert.ok(!existsSync(path.join(root, ".harness", "gate-feedback.json")), "feedback is cleared once the gate passes");
});

test("Claude: per-feature gates narrow by paths, and the whole gate still runs every fullGateEvery features and for the last one", (t) => {
  const ids = ["F-1", "F-2", "F-3", "F-4"];
  const root = project(ids, { maxIterations: 6, fullGateEvery: 3 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const counter = path.join(mkdtempSync(path.join(tmpdir(), "autobuild-count-")), "count");
  execFileSync("mkdir", ["-p", path.join(root, "web")]);
  writeFileSync(path.join(root, "web", "index.js"), "1\n");
  execFileSync("git", ["-C", root, "add", "-A"]);
  configure(root, { bughunt: false, gate: [{ name: "web suite", command: `echo web >> ${counter}`, paths: ["web/**"] }, { name: "core suite", command: `echo core >> ${counter}` }] });
  const { code, loopLog } = run(root, ids.map((id) => ({ build: id, stopHook: true })));
  assert.equal(code, 0, loopLog);
  const gates = readTimings(loadConfig(root, {})).filter((record) => record.type === "gate" && record.caller === "stop-hook");
  // First feature after a start: full. Then two narrowed... the third since the last full gate is full again; the last pending one is always full.
  assert.deepEqual(gates.map((record) => [record.feature, record.scope, record.skipped]), [["F-1", "full", []], ["F-2", "affected", ["web suite"]], ["F-3", "affected", ["web suite"]], ["F-4", "full", []]]);
  assert.match(loopLog, /iteration 2: session \d+s, gate \d+s \(\d+ run, 0 cached, 1 skipped\)/);
});

// ---------- the loop, Codex backend ----------

test("Codex loop: the host gate narrows by paths, runs whole every fullGateEvery features and for the last, reuses passes after a review, and logs build against check time", (t) => {
  const ids = ["F-1", "F-2", "F-3", "F-4"];
  const root = project(ids, { maxIterations: 6, fullGateEvery: 3, reviewEvery: 2, finalReview: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const counter = path.join(mkdtempSync(path.join(tmpdir(), "autobuild-count-")), "count");
  execFileSync("mkdir", ["-p", path.join(root, "web")]);
  writeFileSync(path.join(root, "web", "index.js"), "1\n");
  execFileSync("git", ["-C", root, "add", "-A"]);
  configure(root, { bughunt: false, gateCache: true, gate: [{ name: "web suite", command: `echo web >> ${counter}`, paths: ["web"] }, { name: "core suite", command: `echo core >> ${counter}` }] });
  const KIT = path.resolve(import.meta.dirname, "..");
  const codexEnv = { AUTOBUILD_BACKEND: "codex", AUTOBUILD_CODEX_BIN: path.join(KIT, "test-fixtures", "fake-codex.mjs"), AUTOBUILD_CLAUDE_BIN: "/no/claude" };
  const { code, loopLog } = run(root, [{ build: "F-1" }, { build: "F-2" }, { review: true }, { build: "F-3" }, { build: "F-4" }, { review: true }], codexEnv);
  assert.equal(code, 0, loopLog);
  const records = readTimings(loadConfig(root, {}));
  const host = records.filter((record) => record.type === "gate" && record.caller === "codex-host");
  assert.deepEqual(host.map((record) => [record.feature, record.scope, record.skipped]), [["F-1", "full", []], ["F-2", "affected", ["web suite"]], ["F-3", "affected", ["web suite"]], ["F-4", "full", []]]);
  for (const id of ids) assert.match(loopLog, new RegExp(`Codex host gate: PASS \\(\\d+s; \\d+ run, \\d+ cached, \\d+ skipped.*\\); committed ${id}`));
  assert.match(loopLog, /Codex host gate: web suite: skipped \(no path match\)/);
  // A review changes only the progress file: its gate reuses the suites instead of running them.
  const review = records.filter((record) => record.type === "gate" && record.caller === "codex-review");
  assert.equal(review.length, 2);
  assert.ok(review.every((record) => record.steps.filter((step) => step.cached).map((step) => step.name).includes("core suite")), JSON.stringify(review));
  assert.match(loopLog, /review gate: reused \d+ PASS result\(s\) from [0-9a-f]{12}/);
  assert.match(loopLog, /final full gate: reused \d+ PASS result\(s\) from/);
  // The web suite ran for the whole gates on a tree it had not passed on: F-1, the review after F-2
  // (F-2's own gate skipped it), and F-4. Nothing reran it on an unchanged tree.
  assert.equal(readFileSync(counter, "utf8").trim().split("\n").filter((word) => word === "web").length, 3);
  assert.equal(readFileSync(counter, "utf8").trim().split("\n").filter((word) => word === "core").length, 4);
  const iterations = records.filter((record) => record.type === "iteration");
  assert.deepEqual(iterations.map((record) => [record.feature, record.outcome, record.skipped]), [["F-1", "PASSED", 0], ["F-2", "PASSED", 1], ["F-3", "PASSED", 1], ["F-4", "PASSED", 0]]);
  assert.match(loopLog, /iteration 2: session \d+s, gate \d+s \(\d+ run, \d+ cached, 1 skipped\)/);
});
